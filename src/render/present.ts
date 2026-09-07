import {
  BindingTrace, EvalResponse, LoopExplorerWire, LoopTrace, NamedValue, PartialParse, Range,
  TableWire,
} from '../kernel/protocol';
import { Printed, hasOutput, hoverText, printedFrom } from './format';
import { ErrorDetails, errorDetails } from './errorGuidance';

/**
 * A failure to show: the kernel's, or the break that stopped it parsing.
 *
 * Named rather than inlined into `Presentation` because both reach the same
 * annotation, and a syntax error painted on the line that caused it is not a
 * different kind of thing from one painted under the cursor.
 */
export type ErrorPresentation = ErrorDetails & {
  readonly printed?: Printed;
  readonly kind: 'error';
  readonly range: Range;
  readonly anchor?: number;
  /**
   * The module-level names the statement bound and read.
   *
   * Carried through unchanged and unread by anything here: they say nothing
   * about what to show, only about which *other* annotations this one has just
   * put out of date. A failure binds too -- a statement that raised halfway
   * may already have written a name.
   */
  readonly binds?: readonly string[];
  readonly reads?: readonly string[];
  readonly hover: string;
  /** The file did not parse whole, and this answer was computed without it. */
  readonly partial?: PartialParse;
};

/**
 * What to show for a kernel response.
 *
 * Separated from the editor so the decision -- which of the kernel's four
 * answer shapes maps to which of three presentations -- can be checked
 * without one. The shapes are easy to get subtly wrong: "ran, nothing to
 * show" and "nothing to run" look alike in a response and must not look alike
 * on screen.
 */
export type Presentation =
  | { readonly kind: 'nothing'; readonly message: string }
  | {
      readonly kind: 'value';
      readonly range: Range;
      /**
       * The line to paint on, when that is not the end of `range` -- a
       * compound statement's header.
       */
      readonly anchor?: number;
      /** null when the statement ran but has nothing to display. */
      readonly value: string | null;
      /** The expression the value came from, for labelling. */
      readonly display: string | null;
      /** Every value a loop's target held, when the statement was a loop. */
      readonly loop?: LoopTrace;
      readonly loopExplorer?: LoopExplorerWire;
      /**
       * Every value the loop's body bound, per name.
       *
       * Kept beside `loop` rather than folded into it: the sequences are
       * recorded by one statement and are not the same length, because an
       * iteration that took an early exit computed no result.
       */
      readonly bindings?: readonly BindingTrace[];
      /** What the names on the line held when it ran. */
      readonly names?: readonly NamedValue[];
      /** How many further names the kernel's per-line cap left out. */
      readonly more?: number;
      /**
       * Whether `display` names a place this statement bound (#81).
       *
       * Present only when true, matching the wire. Absent means either a
       * bare expression, whose value is its own answer, or a kernel too old
       * to say -- and `isBoundTarget` falls back to the identifier regex for
       * the second, which is why this stays optional rather than defaulted.
       */
      readonly isBinding?: boolean;
      /**
       * A bounded table description of `value`, when it duck-types as one
       * of the shapes #24 covers -- see `TableWire`. Never rendered here:
       * `render/table.ts`'s `tableMarkdown` is the one place that turns it
       * into text, so there is exactly one answer for what a table looks
       * like, reached from wherever ends up showing one.
       */
      readonly table?: TableWire;
      /**
       * What the statement printed, when it printed anything.
       *
       * Absent rather than empty, so a caller never has to tell "wrote
       * nothing" from "wrote an empty string" by inspecting two fields.
       */
      readonly printed?: Printed;
      /**
       * The module-level names the statement bound and read.
       *
       * Carried through unchanged and unread by anything here: they say
       * nothing about what to show, only about which *other* annotations this
       * one has just put out of date.
       */
      readonly binds?: readonly string[];
      readonly reads?: readonly string[];
      readonly hover?: string;
      /**
       * The file did not parse whole, and this value was computed without the
       * part that did not. It is a weaker claim than an ordinary value and is
       * painted as one -- see `format.partialNote`.
       */
      readonly partial?: PartialParse;
    }
  | ErrorPresentation;

function atLine(line: number): Range {
  return { start: { line, character: 0 }, end: { line, character: 0 } };
}

/**
 * The break that reduced the context, as an annotation of its own.
 *
 * The complaint this answers is that a break on line 19 used to surface as a
 * failed evaluation on line 1: the message named a line the reader was not
 * looking at, and there was nothing on line 19 to look at. So the cause is
 * painted where it is, in red, beside the line that caused it -- which is also
 * half the answer to "which mode answered", because the reason the context was
 * reduced is on screen next to the reason it had to be.
 */
export function partialCause(partial: PartialParse): ErrorPresentation {
  return {
    kind: 'error',
    range: partial.range,
    ...errorDetails(partial.error),
    hover: partial.error.traceback || partial.error.message,
  };
}

/**
 * What the kernel left out of this answer, if anything.
 *
 * Reads off every answer shape, including the one that resolved to nothing:
 * the break belongs to the file rather than to the keypress, so a cursor on a
 * blank line in a broken file still has something to be told.
 */
export function partialOf(response: EvalResponse): PartialParse | undefined {
  return response.partial;
}

export function present(response: EvalResponse, cursorLine: number): Presentation {
  const partial = partialOf(response);
  const caveat = partial === undefined ? {} : { partial };

  if (response.ok === false) {
    return {
      kind: 'error',
      // A protocol-level failure carries no range; anchor it where the user
      // was looking rather than dropping it silently.
      range: response.range ?? atLine(cursorLine),
      ...(response.anchor === undefined ? {} : { anchor: response.anchor }),
      ...(response.binds === undefined ? {} : { binds: response.binds }),
      ...(response.reads === undefined ? {} : { reads: response.reads }),
      ...errorDetails(response.error),
      ...(hasOutput(printedFrom(response.stdout, response.stderr))
        ? { printed: printedFrom(response.stdout, response.stderr) } : {}),
      hover: response.error.traceback || response.error.message,
      ...caveat,
    };
  }

  if (response.resolved === false) {
    // A blank line. Not an error, and not a reason to paint anything -- but
    // the user pressed a key and deserves to know it was received. The break
    // that reduced the context is still painted, by the caller: it is about
    // the file rather than about this keypress.
    return { kind: 'nothing', message: 'Evalens: nothing to evaluate here' };
  }

  const printed = printedFrom(response.stdout, response.stderr);

  // A loop that ran zero times has no value and still has something to say --
  // that it ran zero times. Treating "no value" as "nothing to paint" would
  // leave the previous run's binding on screen as the answer. An `if` that
  // bound a name is the same shape: no value of its own, and an answer. So is
  // an `if` whose body printed: the output is what the branch had to say.
  const speaks = response.value !== null
    || response.loop !== undefined
    || (response.names?.length ?? 0) > 0
    || hasOutput(printed);

  return {
    kind: 'value',
    range: response.range,
    ...(response.anchor === undefined ? {} : { anchor: response.anchor }),
    value: response.value,
    display: response.display,
    ...(response.loop === undefined ? {} : { loop: response.loop }),
    ...(response.loop_explorer === undefined
      ? {} : { loopExplorer: response.loop_explorer }),
    ...(response.bindings === undefined
      ? {}
      : { bindings: response.bindings }),
    ...(response.names === undefined ? {} : { names: response.names }),
    ...(printed === undefined ? {} : { printed }),
    // Renamed on the way in: the wire says which cap it was, and the line
    // only has to say that something was left off it.
    ...(response.more_names === undefined
      ? {}
      : { more: response.more_names }),
    ...(response.is_binding === undefined
      ? {}
      : { isBinding: response.is_binding }),
    ...(response.table === undefined ? {} : { table: response.table }),
    ...(response.binds === undefined ? {} : { binds: response.binds }),
    ...(response.reads === undefined ? {} : { reads: response.reads }),
    ...(speaks
      ? {
          hover: hoverFor(
            response.display, response.value, response.repr, response.loop,
            response.names, response.bindings, printed, partial
          ),
        }
      : {}),
    ...caveat,
  };
}

/**
 * The hover text for a value.
 *
 * The hover shows the full, unwrapped value; the inline annotation is a
 * one-line summary of it. `repr` is where that stays true for the values the
 * kernel describes rather than reprs: the line reads `def area(w, h)`, and
 * the `<function area at 0x…>` it replaced is one hover away rather than
 * gone.
 *
 * The substitution is the only decision made here; `hoverText` still does the
 * rendering, including a loop's sequence, so the cursor path and the file-load
 * path cannot drift into saying different things about the same response.
 */
export function hoverFor(
  display: string | null, value: string | null, repr?: string,
  loop?: LoopTrace | null, names?: readonly NamedValue[],
  bindings?: readonly BindingTrace[], printed?: Printed,
  partial?: PartialParse
): string {
  return hoverText({
    display, value: repr ?? value, loop, names, bindings, printed,
    ...(partial === undefined
      ? {}
      : {
          partial: {
            truncated_at: partial.truncated_at,
            message: partial.error.message,
          },
        }),
  });
}


/**
 * What a file load did, said as an outcome rather than as an abort.
 *
 * "load stopped after 13 statements" described the abort, and was read as
 * "nothing loaded" -- when in fact thirteen statements' bindings were sitting
 * in the namespace, ready to use.
 *
 * `asScript` says which of the two commands this was. The annotations a
 * script run and a load leave behind can look nearly identical -- a
 * `__main__` guard that used to sit there quietly now has a body that ran,
 * but a file with no guard at all produces the same values either way -- so
 * this status line is the one place that always says which one just
 * happened. See issue #78.
 */
export function describeLoad(
  ran: number, total: number, failed: number, partialFrom?: number,
  asScript = false
): string {
  const verb = asScript ? 'ran' : 'loaded';
  const suffix = asScript ? ' as a script' : '';
  const counted = failed === 0
    ? `Evalens: ${verb} ${total} statement${total === 1 ? '' : 's'}${suffix}`
    : `Evalens: ${verb} ${ran} of ${total} statements${suffix}, ${failed} failed`;
  if (partialFrom === undefined) {
    return counted;
  }
  // "loaded 18 statements" on a file with 30 in it is true and reads as
  // complete. What the user has to know is that the count is a count of the
  // part that parsed, and where the rest starts.
  return `${counted}; line ${partialFrom + 1} onwards did not parse`;
}

/**
 * How many of a load's residue names are listed before the rest are elided.
 *
 * Not a setting: this is a status-bar sentence, not a display any load ever
 * repeats, and the honest answer to "how many names would make this
 * unreadable" is the same for everyone the way `MAX_LOAD_ANNOTATIONS` is.
 */
const RESIDUE_DISPLAY_CAP = 8;

/**
 * #100: what a non-resetting load's namespace holds that the file just run
 * does not bind anywhere in its own text.
 *
 * Deliberately not a sentence of its own carrying its own "Evalens: " --
 * `evaluateFile` appends this to `describeLoad`'s own summary, the way a
 * `partialFrom` caveat is appended, so the reader gets one status-bar line
 * rather than the second one clobbering the first.
 */
export function describeResidue(residue: readonly string[]): string {
  const count = residue.length;
  const shown = residue.slice(0, RESIDUE_DISPLAY_CAP);
  const remaining = count - shown.length;
  const listed = remaining > 0
    ? `${shown.join(', ')}, and ${remaining} more`
    : shown.join(', ');
  const verb = count === 1 ? 'is' : 'are';
  return `${count} name${count === 1 ? '' : 's'} from an earlier session ` +
    `${verb} still present (${listed})`;
}

/**
 * What running a selection did, including whether it ran more than was asked.
 *
 * "ran" rather than "loaded", because a selection is not the command that
 * sets a session up -- and because the count is of the selection, so a load
 * that says the same number about a different thing would be indistinguishable
 * from a whole file that happened to be short.
 *
 * `widened` is the part that cannot be left out. A statement runs whole or not
 * at all, so a selection starting inside a `def` executed the entire `def`;
 * a reader who is not told that has been shown a count they will attribute to
 * the lines they highlighted.
 *
 * `partialFrom` is the other thing that cannot be left out, and it matters
 * most in the case that says nothing ran. A selection is narrowed inside the
 * part of the file that parsed, so one lying below the break matches no
 * statement and runs nothing -- and "nothing to run in the selection" on its
 * own reads as "you selected comments" when the selection was full of code.
 * The reason has to travel with the count, exactly as it does for a load.
 */
export function describeRun(
  ran: number, total: number, failed: number, widened: boolean,
  partialFrom?: number
): string {
  const caveat = partialFrom === undefined
    ? ''
    : `; line ${partialFrom + 1} onwards did not parse`;
  if (total === 0) {
    // Not an error. A selection holding only comments is the same answer as a
    // blank line under the cursor: there was nothing there to run.
    return `Evalens: nothing to run in the selection${caveat}`;
  }
  const counted = failed === 0
    ? `ran ${total} statement${total === 1 ? '' : 's'}`
    : `ran ${ran} of ${total} statements, ${failed} failed`;
  return widened
    ? `Evalens: ${counted}, widened to whole statements${caveat}`
    : `Evalens: ${counted}${caveat}`;
}

/**
 * What `evaluateAbove` did (#13), for the status bar.
 *
 * Modeled on `describeLoad` and `describeRun` above, but neither's wording
 * fits. `describeRun` talks about "the selection" and about `widened` --
 * a user-drawn range snapping outward to whole statements -- and neither
 * concept exists here: `evaluateAbove`'s range is derived from the cursor,
 * never highlighted and never widened. `describeLoad`'s "ran X of Y
 * statements, Z failed" phrasing assumes every one of Y was at least
 * attempted, which is exactly what a run-above cannot promise: it stops at
 * the first failure rather than running through the rest of the file the
 * way a load does, so anything after that failure was never attempted at
 * all, not merely uncounted. Saying "Z failed" there would read as a full
 * sweep that happened to find one problem, when what actually happened is
 * that the run stopped and the rest of the file above the cursor is
 * unexamined. This says so plainly instead.
 */
export function describeAbove(
  ran: number, total: number, failed: number, partialFrom?: number
): string {
  const caveat = partialFrom === undefined
    ? ''
    : `; line ${partialFrom + 1} onwards did not parse`;
  if (total === 0) {
    // Not an error: the cursor sits on or before the first statement in the
    // file, so there is nothing above it to run -- the same non-error the
    // other two report for an empty selection or an empty file.
    return `Evalens: nothing above the cursor${caveat}`;
  }
  const counted = failed === 0
    ? `ran ${total} statement${total === 1 ? '' : 's'} above the cursor`
    : `ran ${ran} of ${total} statements above the cursor, stopped at a `
      + 'failure';
  return `Evalens: ${counted}${caveat}`;
}
