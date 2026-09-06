/**
 * How a prompt from the running code is worded in the box that asks for it,
 * and -- since #104 -- how the box that asks the reader to nominate a watch
 * expression is titled before anything has run at all.
 *
 * Separated from the editor so the wording can be checked without one, and
 * because the interesting case is the one with nothing to say: beginner code
 * writes `input()` with no argument at all, and a box with an empty label is
 * a box with no explanation of why the editor suddenly wants something.
 *
 * Nothing here imports `vscode`.
 */

/**
 * Longest prompt shown above the box before it is trimmed.
 *
 * Not a setting. The box belongs to VS Code and stops showing the label at
 * whatever width the window is, well short of this; raising the number would
 * only move where an already-invisible string is cut. A preference has to be
 * for something the person setting it can see.
 */
const LABEL_LIMIT = 200;

/**
 * What Escape does, said where the user can read it before pressing it.
 *
 * Cancelling is deliberate rather than a dead end: it sends end-of-file, the
 * code raises `EOFError`, and the session carries on. A student who cannot
 * get out of a prompt is worse off than one whose program errors, so the way
 * out is signposted rather than discovered.
 */
export const ESCAPE_HINT =
  'Enter a value, or press Escape to send end-of-file (EOFError)';

/** The prompt the code printed, or a sentence saying it printed none. */
export function promptLabel(prompt: string): string {
  const asked = prompt.trim();
  if (asked === '') {
    return 'The evaluated code is waiting for input';
  }
  if (asked.length <= LABEL_LIMIT) {
    return asked;
  }
  return `${asked.slice(0, LABEL_LIMIT)}…`;
}

/**
 * What the marker beside the blocked line says, which is not what the box
 * says.
 *
 * The box has the width of the window and can afford a sentence; the line
 * shares its width with the user's code. Where the code printed no prompt this
 * says what is happening instead of restating an empty string.
 */
export function waitingLabel(prompt: string): string {
  const asked = prompt.trim();
  return asked === '' ? 'waiting for input' : asked;
}

/**
 * The box's title, tying it to the statement that opened it.
 *
 * `showInputBox` puts the box at the top of the window; the statement that
 * asked may be anywhere in the file, and during a load it may not even be on
 * screen. `line 13 · x = input("give me a value: ")` identifies itself,
 * which is what closes the gap between a question and the code asking it --
 * the caller already has the line number and the line's own text, both from
 * the same coordinates the blocked-line marker uses.
 *
 * `line` is 0-based, matching every other coordinate on the wire; this is the
 * one place it is shown to a human, so it is shifted here rather than asking
 * every caller to remember to.
 */
export function locatedTitle(line: number, code: string): string {
  const trimmed = code.length > LABEL_LIMIT
    ? `${code.slice(0, LABEL_LIMIT)}…`
    : code;
  return `line ${line + 1} · ${trimmed}`;
}

/** Does this trimmed line open a `for` or `async for` statement? */
function opensLoop(trimmed: string): boolean {
  return /^(async\s+)?for\b/.test(trimmed);
}

/**
 * The 0-based line of the `for`/`async for` that a plain indentation scan
 * finds enclosing `fromLine`, or `undefined` when the scan finds none --
 * #104's answer to putting the loop's header on the watch box's title
 * *before* the reader has typed the expression that would let
 * `eval_watch` resolve it for real.
 *
 * A text scan rather than a parse, deliberately: the one thing this feeds is
 * a title, and getting it wrong there costs a title that undersells or omits
 * the loop, never a wrong watch. `eval_watch` re-resolves the loop it
 * actually attaches to from the real tree once the request carries an
 * expression (`loops.innermost_loop_at`), and answers `NoLoop` on its own
 * account when there is none -- this has no way to make that answer wrong,
 * only the box that asked for the expression less informative than it could
 * have been.
 *
 * The scan walks upward tracking the shallowest indentation seen so far (the
 * "ceiling"): a line indented at or past it is nested inside something
 * already passed and cannot be what encloses `fromLine`, so it is skipped;
 * a shallower line is a candidate ancestor, checked for `for`/`async for`
 * and, if it is not one, becomes the new ceiling. That is also this scan's
 * one known blind spot: a `for` header broken across physical lines --
 * a trailing backslash, or a parenthesized iterable on its own line -- has a
 * continuation line at the *same* indentation as the header itself, which
 * looks like a sibling statement and lowers the ceiling to it, ending the
 * scan one line short of the header that opened it. `resolver.py`'s own
 * parser does not have this problem and is exactly the reach #48 and #104
 * both decline to duplicate here for a title. The blind spot only ever
 * costs a plainer title (see `Evaluator`'s fallback to the nomination's own
 * line); it cannot mis-name a loop, because a false positive would require
 * this to call something a loop that a `for`/`async for` scan disagrees
 * with, and it never overrides that check.
 */
export function enclosingLoopHeader(
  lineText: (line: number) => string, fromLine: number
): number | undefined {
  let ceiling = Number.POSITIVE_INFINITY;
  for (let line = fromLine; line >= 0; line -= 1) {
    const trimmed = lineText(line).trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const indent = lineText(line).length - lineText(line).trimStart().length;
    if (indent >= ceiling) {
      continue;
    }
    if (opensLoop(trimmed)) {
      return line;
    }
    ceiling = indent;
    if (ceiling === 0) {
      // Nothing shallower than the left margin exists, so nothing above
      // this line could still be its ancestor.
      return undefined;
    }
  }
  return undefined;
}

/**
 * Whether this prompt is the one offered a way out of the rest.
 *
 * `asked` is how many prompts this load has already put up. Not the first: a
 * file with a single prompt would be asked whether it wants to skip the
 * nineteen it does not have, which is a question about a problem the reader
 * has not got. By the second, a file with twenty prompts and no way out is a
 * real prospect, and that is the moment to say there is one.
 *
 * A single evaluation never offers it. Nothing follows the statement the user
 * pointed at, so "the rest" is empty.
 */
export function offersSkip(asked: number): boolean {
  return asked >= 1;
}

/** The way out of a whole file's worth of prompts. */
export const SKIP_LABEL = 'Skip the rest of this load';

/**
 * What skipping does, in the same terms as cancelling one prompt.
 *
 * Both send end-of-file and both raise `EOFError`: skipping is cancelling
 * every prompt still to come, not a different mechanism. Saying so is what
 * stops it reading as "abandon the load", which it is not -- the statements
 * that do not prompt still run.
 */
export const SKIP_HINT =
  'answer no more prompts while this file loads — each raises EOFError, and '
  + 'the rest of the file still runs';

/**
 * One load's prompts: how many there have been, and whether to stop asking.
 *
 * Small enough to inline and kept out here anyway, because it is the whole of
 * "skip the rest" and the only part of it that can be checked without an
 * editor. Two rules, both easy to get subtly wrong: the offer appears from the
 * second prompt rather than the first, and once taken it holds for every
 * prompt in *this* load and no longer -- the next Load File asks again,
 * because the user chose to run it.
 */
export class LoadPrompts {
  private asked = 0;
  private skipping = false;

  /** Answer without asking: the user already said not to. */
  get quiet(): boolean {
    return this.skipping;
  }

  /** Whether this prompt is the one carrying the way out of the rest. */
  get offerSkip(): boolean {
    return offersSkip(this.asked);
  }

  /** What the user did with the box that was just up. */
  record(kind: 'value' | 'eof' | 'skip'): void {
    this.asked += 1;
    this.skipping ||= kind === 'skip';
  }
}
