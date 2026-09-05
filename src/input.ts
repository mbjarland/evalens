/**
 * How a prompt from the running code is worded in the box that asks for it.
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
