/**
 * Turning a `repr()` into the string that gets painted after a line.
 *
 * Pure on purpose: this is the part with a right answer that can be checked
 * without an editor, and the part with the one non-obvious rule.
 */

/** Reads as annotation rather than as code the user wrote. */
export const SEPARATOR = '=>';

const NBSP = ' ';

/**
 * VS Code collapses runs of ordinary spaces in a decoration's `contentText`.
 *
 * Without substituting non-breaking spaces, `{'a': 1, 'b': 2}` renders as
 * `{'a':1,'b':2}` and a padded or aligned value loses its shape entirely --
 * the annotation stops being a faithful `repr()` and starts being an
 * approximation of one. Calva hit this and solves it the same way; it looks
 * like a mistake to anyone who has not.
 */
export function preserveSpacing(text: string): string {
  return text.replace(/ /g, NBSP);
}

/**
 * A decoration is one line. A `repr()` containing newlines -- a dataclass, a
 * DataFrame -- would otherwise render as undefined behaviour rather than as
 * anything readable.
 *
 * Collapsing is the minimum that keeps it truthful; #12 gives long and
 * multi-line values a proper treatment with the full text on hover.
 */
export function collapseLines(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/** The painted annotation for a successful evaluation. */
export function resultText(value: string): string {
  return preserveSpacing(`${SEPARATOR} ${collapseLines(value)}`);
}

/**
 * The painted annotation for a failure: type and message, never the
 * traceback. The traceback goes on hover, where it does not shove the code
 * sideways.
 */
export function errorText(type: string, message: string): string {
  const summary = collapseLines(message);
  return preserveSpacing(summary ? `${SEPARATOR} ${type}: ${summary}` : `${SEPARATOR} ${type}`);
}
