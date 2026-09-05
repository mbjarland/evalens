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

/**
 * A bare or dotted identifier -- something that now exists in the namespace,
 * as opposed to an expression that is already on screen.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/**
 * The painted annotation for a successful evaluation.
 *
 * Names the binding when there is one, following Rider's inline values:
 * `lst: [1, 2, 3]` rather than `=> [1, 2, 3]`. The name is information the
 * arrow throws away, and it matters most exactly where the line does not
 * make it obvious -- a `for` target, a `with` variable, an import alias.
 *
 * An expression is not a binding, so `sum([10, 20])` keeps the arrow.
 * Labelling it `sum([10, 20]): 30` would repeat the line back at the reader
 * and crowd out the only new information on it.
 */
export function resultText(value: string, display?: string | null): string {
  const label = display && IDENTIFIER.test(display)
    ? `${display}:`
    : SEPARATOR;
  return preserveSpacing(`${label} ${collapseLines(value)}`);
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

/**
 * How wide `text` is on screen, in columns.
 *
 * Not `text.length`: a tab is worth however many columns it takes to reach
 * the next tab stop, so a file indented with tabs would otherwise align to a
 * column that is nowhere near where its code actually ends.
 */
export function columnWidth(text: string, tabSize: number): number {
  let column = 0;
  for (const character of text) {
    column += character === '\t' ? tabSize - (column % tabSize) : 1;
  }
  return column;
}

/**
 * Columns of gap between the end of a line and its annotation.
 *
 * A line already past the target gets `minimumGap` instead of being dragged
 * further right. Aligning to the longest line in the file would let one long
 * statement push every other result off the screen -- the ragged case is the
 * cheap one to accept.
 */
export function alignmentGap(
  lineWidth: number, targetColumn: number, minimumGap: number
): number {
  if (targetColumn <= 0) {
    return minimumGap;
  }
  return Math.max(targetColumn - lineWidth, minimumGap);
}
