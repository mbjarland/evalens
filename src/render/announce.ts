/**
 * What an annotation says out loud, for a reader who cannot see it.
 *
 * The whole product surface of this extension is an `after` decoration, and
 * `DecorationRenderOptions` has no accessibility hook -- no `label`, no `role`,
 * nothing. That is the API's shape rather than an oversight to route around:
 * `AccessibilityInformation` exists in `@types/vscode` and is accepted by
 * `StatusBarItem`, `TreeItem` and `NotebookCellStatusBarItem`, and by nothing
 * on the decoration types. Nor is there a general way out: VS Code announces
 * its own things through an internal `aria.alert` helper, and the request to
 * expose that to extensions (microsoft/vscode#114718) was closed as out of
 * scope. So a screen-reader user pressing the evaluate key gets silence, which
 * is indistinguishable from a dead keybinding -- the failure this project has
 * already shipped twice, in the wedged kernel and the stolen key.
 *
 * The fix therefore has to be a second channel, and this module is the part of
 * it with a right answer: **what the second channel says.** Nothing here
 * imports `vscode`, so the wording, the caveats and the truncation are checked
 * by a test rather than by somebody with a screen reader on -- which matters,
 * because nobody on this project can run that check.
 *
 * ## The answer still goes on the line
 *
 * Design rule 7 is not weakened by any of this. The decoration is untouched;
 * speech is an *addition* for people the decoration cannot reach, and never a
 * replacement or a panel. Nothing here changes what is painted, and nothing
 * here is consulted by the painter.
 *
 * ## Why this is not simply the painted string
 *
 * The painted string is built for columns and a screen reader does not have
 * any. Four things survive the eye and not the ear:
 *
 * - **`GAP` is three non-breaking spaces.** Runs of whitespace are collapsed
 *   into a single pause, so `v: 1, 2, 3   x: [1, 2, 3]` is heard as one
 *   undivided list and the reader cannot tell where the loop ends and the name
 *   begins.
 * - **`=>` is punctuation.** At the default verbosity every major screen
 *   reader either skips it or spells it out as "equals greater than". Neither
 *   is the word "result".
 * - **A colon is silent.** `x: 5` and `x 5` sound the same, so the relation
 *   between the label and the value has to be carried by a word.
 * - **The gutter marker is a picture.** Staleness -- the one thing this
 *   project treats as its defining bug class -- has no spoken form at all
 *   unless it is said, so it is said, and it is said *first*: a caveat that
 *   arrives after the value arrives after the reader has believed the value.
 *
 * ## Why the label-dropping rule does not carry over
 *
 * `format.slotSegments` drops a label the value already states, so `greet:
 * def greet(name)` is painted `def greet(name)`. That rule buys columns, and
 * columns are the scarce thing on a line. Speech is scarce in *time*, and one
 * repeated word costs a fraction of a second, while the label is what tells a
 * listener which of several values is being reported. So the label is always
 * spoken. This is a deliberate divergence from the painted text and the only
 * one: everything else here is built from `paintedSlots` and `outputPieces`
 * precisely so the two channels cannot drift into describing the same response
 * differently.
 */

import { BindingTrace, LoopTrace, NamedValue } from '../kernel/protocol';
import { Printed, outputPieces, paintedSlots } from './format';
import { markerFor } from './registry';

/**
 * The parts of an annotation this channel reads.
 *
 * Declared structurally rather than importing `Annotation`, which carries a
 * `vscode.Range` -- the same split `repeats.ts` makes, and for the same
 * reason: the decision is testable without an editor and the editor is the one
 * place it could not be tested.
 */
export interface Announceable {
  readonly value?: string | null;
  readonly display?: string | null;
  readonly loop?: LoopTrace;
  readonly bindings?: readonly BindingTrace[];
  readonly names?: readonly NamedValue[];
  readonly printed?: Printed;
  /** How many further names the kernel's per-line cap left out. */
  readonly more?: number;
  readonly error?: { readonly type: string; readonly message: string };
  /** The 0-based line the file stopped parsing at, when it did. */
  readonly partialFrom?: number;
  /** The value no longer describes the code beside it. */
  readonly stale?: boolean;
  /** Set while the statement has not finished; its message says what for. */
  readonly pending?: { readonly message?: string };
}

/**
 * How much of an answer is spoken before it is cut off.
 *
 * A screen reader delivers roughly fifteen characters a second, so this is
 * about twenty seconds of speech -- already long for something a user
 * triggered with one key and may be about to trigger again. The kernel will
 * happily send an 8,192-character `repr` (`WIRE_REPR_LIMIT`), and reading nine
 * minutes of list elements is not an accessible answer, it is a denial of
 * service with good intentions.
 *
 * The cut is announced rather than silent, because an answer that stops early
 * without saying so asserts more than we know -- the reader would take the
 * fragment for the whole value.
 */
export const SPOKEN_LIMIT = 300;

/** What the on-request read says when the line carries no annotation. */
export const NOTHING_HERE = 'no result on this line';

/** What it says while the statement under the cursor is still running. */
export const STILL_RUNNING = 'still running';

/**
 * Who is speaking, on the front of everything that gets said.
 *
 * Three syllables on every announcement is a real cost to someone stepping
 * down a file, and it is paid anyway. A toast reading `Info: [1, 2, 3]` names
 * nobody, and a window with a dozen extensions in it raises toasts from all of
 * them -- an answer whose source has to be guessed is worse than an answer
 * three syllables later. Every other notification this extension raises is
 * prefixed the same way, and a channel that attributed itself differently from
 * the rest would be one more thing to learn.
 */
export function announcement(spoken: string): string {
  return `Evalens: ${spoken}`;
}

/**
 * Lead with the caveat, in words.
 *
 * "Stale" is the project's own term and appears in the README and the gutter
 * legend, so it is kept -- but it is a term of art, and a listener who has not
 * read the README needs the gloss the picture never had to give them.
 */
const STALE = 'stale, edited since it ran';

/** Joins one answer to the next: a full stop is the longest pause going. */
const BREAK = '. ';

export type AnnounceSetting = 'auto' | 'always' | 'never';

/**
 * Whether an explicitly triggered result speaks for itself, unasked.
 *
 * The three-way setting exists because there is no fourth option. **VS Code
 * exposes no way for an extension to learn that a screen reader is attached**
 * -- there is no `env.isScreenReaderOptimized`, nothing on `window`, and
 * nothing proposed that would answer it. The closest thing is the user's own
 * `editor.accessibilitySupport`, and that is a *setting* rather than a
 * detection result. VS Code does detect one internally, and the editor
 * substitutes that detected value wherever the setting reads `"auto"` -- but
 * it substitutes it into a Monaco editor option, and no part of the resolved
 * answer is on the extension API. `getConfiguration('editor')` hands back the
 * literal `"auto"` either way, so `"auto"` tells us nothing.
 *
 * What `"on"` tells us is a lot, though. It is what VS Code's accessibility
 * documentation instructs a screen-reader user to set when detection fails,
 * and setting it is a deliberate statement that a screen reader is in use. So
 * `auto` follows it, and a user in that state gets a spoken result without
 * configuring anything -- which is design rule 6 honoured for the part of the
 * audience it can be honoured for.
 *
 * The rest of that audience has to set `always`, and saying so plainly is the
 * point of the setting's description. A default of `always` is not available:
 * the announced surface is a notification, and a notification on every
 * keypress would make the extension unusable for everyone who does not need
 * it, which is the same "worse than announcing nothing" argument that keeps
 * bulk annotation silent.
 */
export function announcesAutomatically(
  setting: AnnounceSetting, accessibilitySupport: string | undefined
): boolean {
  if (setting === 'always') {
    return true;
  }
  if (setting === 'never') {
    return false;
  }
  return accessibilitySupport === 'on';
}

/**
 * Cut `text` to something a listener will sit through, and say that it is cut.
 *
 * On a word boundary where there is one within reach, because a screen reader
 * pronounces a severed word as a severed word and the listener spends the next
 * second wondering what it was. The count is of the original, following the
 * kernel's own `_capped` wording, so the two truncations a value can survive
 * read the same way.
 */
export function capSpoken(text: string, limit = SPOKEN_LIMIT): string {
  if (text.length <= limit) {
    return text;
  }
  const head = text.slice(0, limit);
  const space = head.lastIndexOf(' ');
  const cut = space > limit - 40 ? head.slice(0, space) : head;
  return `${cut}… truncated from ${text.length} characters`;
}

/**
 * One spoken clause per value the line paints.
 *
 * `paintedSlots` is the shared half: it decides which values appear and in
 * what order -- a binding leads, the names it read follow, a produced `None`
 * gives way to anything better on the line -- and this module only decides how
 * each one sounds. Deriving the slots a second time here is how the two
 * channels would come to disagree about the same response, which is the defect
 * `repeats.ts` already exists to avoid.
 */
function spokenSlots(annotation: Announceable): string[] {
  const slots = paintedSlots(
    annotation.value ?? null, annotation.display, annotation.loop,
    annotation.names, annotation.bindings, annotation.printed);
  const said = slots.map(
    (slot) => slot.name === null ? slot.value : `${slot.name} is ${slot.value}`);
  said.push(...outputPieces(annotation.printed));
  // The same guard the painted footnote carries: it counts names, so it needs
  // a name on the line to be a footnote to.
  if ((annotation.more ?? 0) > 0 && slots.some((slot) => !slot.own)) {
    said.push(`and ${annotation.more} more names`);
  }
  return said;
}

/**
 * What this annotation says out loud, or nothing when it has nothing to say.
 *
 * The order is fixed and the caveats bracket the answer: what is wrong with
 * this value first, the value itself next, what was missing when it was
 * computed last. A listener hears the qualification before they can act on the
 * number, which is the whole of why the gutter marker is not simply
 * transliterated -- a picture in the margin is available to a glance at any
 * moment, and speech is available once, in order.
 */
export function spokenText(annotation: Announceable): string | undefined {
  if (annotation.pending) {
    return annotation.pending.message
      ? `${STILL_RUNNING}: ${capSpoken(annotation.pending.message)}`
      : STILL_RUNNING;
  }

  const lead: string[] = [];
  if (markerFor(annotation) === 'stale') {
    // Read off `markerFor` rather than off `stale` directly, so the spoken
    // state and the icon in the gutter are the same decision. The ranking it
    // encodes matters here too: a failure whose statement has since been
    // edited is not this code's failure, and saying "error" of it would assert
    // something nobody has checked.
    lead.push(STALE);
  }

  const tail: string[] = [];
  if (annotation.partialFrom !== undefined) {
    // The full sentence rather than the line's `(partial: line 19)`, and the
    // same sentence the hover already uses. Speech has the room the line does
    // not, and the abbreviation exists only because the line does not.
    tail.push(`evaluated without line ${annotation.partialFrom + 1} onwards`);
  }

  let body: string;
  if (annotation.error) {
    // The word, not the colour. Red is the only thing that distinguishes a
    // failure on screen, and it is exactly as invisible as the rest of the
    // decoration.
    const message = annotation.error.message.trim();
    body = message
      ? `error, ${annotation.error.type}: ${message}`
      : `error, ${annotation.error.type}`;
  } else {
    const slots = spokenSlots(annotation);
    if (slots.length === 0) {
      // It ran and produced nothing to report -- a `del`, a bare `pass`. The
      // caveats still stand on their own if there are any; an empty answer is
      // not this function's to invent.
      const only = [...lead, ...tail];
      return only.length > 0 ? only.join(BREAK) : undefined;
    }
    body = slots.join(BREAK);
  }

  // Only the body is capped. A caveat cut off by the length limit would leave
  // an answer that asserts more than we know -- the exact failure the caveat
  // was added to prevent -- and both of them together are one short sentence,
  // so there is nothing to be gained by risking it.
  return [...lead, capSpoken(body), ...tail].join(BREAK);
}

/**
 * A shorter form of the same answer, for a surface with a width.
 *
 * The status bar is the one place in the API that takes an
 * `AccessibilityInformation` label, and it is also a strip of chrome a few
 * dozen characters wide. So the item shows this and is *labelled* with the
 * full `spokenText`: the same answer, twice, at the two lengths the two
 * consumers can take.
 */
export function statusText(spoken: string, limit = 60): string {
  const collapsed = spoken.replace(/\s+/g, ' ').trim();
  return collapsed.length <= limit
    ? collapsed
    : `${collapsed.slice(0, limit - 1)}…`;
}

/** The shape `annotationAt` needs; `vscode.Range` satisfies it structurally. */
export interface Spanned {
  readonly range: {
    readonly start: { readonly line: number };
    readonly end: { readonly line: number };
  };
  /** The line the value is painted on, when that is not the range's end. */
  readonly anchor?: number;
}

/**
 * The annotation the cursor is asking about.
 *
 * Two candidates and a rule to choose between them. The line the value is
 * *painted* on wins outright: a reader who asks what is on this line means the
 * line they are on, and for a compound statement that is the header, where the
 * annotation actually sits. Failing that, the innermost statement covering the
 * line answers -- putting the cursor inside a twenty-line `def` and asking is
 * a reasonable thing to do, and the alternative is silence on nineteen lines
 * out of twenty.
 *
 * Narrowest wins the second case so that a nested annotation, if one ever
 * survives `merge`, is not shadowed by the block it sits in. Nothing here
 * re-reads the buffer or asks the kernel anything: this reports what is
 * already painted, and a trace does not become a watch by being read aloud.
 */
export function annotationAt<T extends Spanned>(
  annotations: readonly T[], line: number
): T | undefined {
  let containing: T | undefined;
  for (const annotation of annotations) {
    if ((annotation.anchor ?? annotation.range.end.line) === line) {
      return annotation;
    }
    if (annotation.range.start.line <= line
        && line <= annotation.range.end.line) {
      const width = annotation.range.end.line - annotation.range.start.line;
      const best = containing === undefined
        ? Infinity
        : containing.range.end.line - containing.range.start.line;
      if (width < best) {
        containing = annotation;
      }
    }
  }
  return containing;
}
