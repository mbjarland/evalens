import { EvalResponse, LoopTrace, NamedValue, Range } from '../kernel/protocol';
import { hoverText } from './format';

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
      /** What the names on the line held when it ran. */
      readonly names?: readonly NamedValue[];
      readonly hover?: string;
    }
  | {
      readonly kind: 'error';
      readonly range: Range;
      readonly anchor?: number;
      readonly type: string;
      readonly message: string;
      readonly hover: string;
    };

function atLine(line: number): Range {
  return { start: { line, character: 0 }, end: { line, character: 0 } };
}

export function present(response: EvalResponse, cursorLine: number): Presentation {
  if (response.ok === false) {
    return {
      kind: 'error',
      // A protocol-level failure carries no range; anchor it where the user
      // was looking rather than dropping it silently.
      range: response.range ?? atLine(cursorLine),
      ...(response.anchor === undefined ? {} : { anchor: response.anchor }),
      type: response.error.type,
      message: response.error.message,
      hover: response.error.traceback || response.error.message,
    };
  }

  if (response.resolved === false) {
    // A blank line. Not an error, and not a reason to paint anything -- but
    // the user pressed a key and deserves to know it was received.
    return { kind: 'nothing', message: 'Evalens: nothing to evaluate here' };
  }

  // A loop that ran zero times has no value and still has something to say --
  // that it ran zero times. Treating "no value" as "nothing to paint" would
  // leave the previous run's binding on screen as the answer. An `if` that
  // bound a name is the same shape: no value of its own, and an answer.
  const speaks = response.value !== null
    || response.loop !== undefined
    || (response.names?.length ?? 0) > 0;

  return {
    kind: 'value',
    range: response.range,
    ...(response.anchor === undefined ? {} : { anchor: response.anchor }),
    value: response.value,
    display: response.display,
    ...(response.loop === undefined ? {} : { loop: response.loop }),
    ...(response.names === undefined ? {} : { names: response.names }),
    ...(speaks
      ? {
          hover: hoverFor(
            response.display, response.value, response.repr, response.loop,
            response.names
          ),
        }
      : {}),
  };
}

/**
 * The hover text for a value.
 *
 * The hover shows the full, unwrapped value; the inline annotation is a
 * one-line summary of it. `repr` is where that stays true for the values the
 * kernel describes rather than reprs: the line reads `area(w, h)`, and the
 * `<function area at 0x…>` it replaced is one hover away rather than gone.
 *
 * The substitution is the only decision made here; `hoverText` still does the
 * rendering, including a loop's sequence, so the cursor path and the file-load
 * path cannot drift into saying different things about the same response.
 */
export function hoverFor(
  display: string | null, value: string | null, repr?: string,
  loop?: LoopTrace | null, names?: readonly NamedValue[]
): string {
  return hoverText(display, repr ?? value, loop, names);
}


/**
 * What a file load did, said as an outcome rather than as an abort.
 *
 * "load stopped after 13 statements" described the abort, and was read as
 * "nothing loaded" -- when in fact thirteen statements' bindings were sitting
 * in the namespace, ready to use.
 */
export function describeLoad(
  ran: number, total: number, failed: number
): string {
  if (failed === 0) {
    return `Evalens: loaded ${total} statement${total === 1 ? '' : 's'}`;
  }
  return `Evalens: loaded ${ran} of ${total} statements, ${failed} failed`;
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
 */
export function describeRun(
  ran: number, total: number, failed: number, widened: boolean
): string {
  if (total === 0) {
    // Not an error. A selection holding only comments is the same answer as a
    // blank line under the cursor: there was nothing there to run.
    return 'Evalens: nothing to run in the selection';
  }
  const counted = failed === 0
    ? `ran ${total} statement${total === 1 ? '' : 's'}`
    : `ran ${ran} of ${total} statements, ${failed} failed`;
  return widened
    ? `Evalens: ${counted}, widened to whole statements`
    : `Evalens: ${counted}`;
}
