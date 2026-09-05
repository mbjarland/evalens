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

/** Longest prompt shown above the box before it is trimmed. */
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
