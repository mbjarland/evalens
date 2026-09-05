import { Range } from './kernel/protocol';

/**
 * Turning a selection into a request, and judging what came back against it.
 *
 * Nothing here imports `vscode`, so the geometry can be checked without an
 * extension host. A `vscode.Selection` is structurally a `Range` -- two
 * positions with a line and a character -- which is all any of this needs.
 */

/** The 0-based inclusive line range an `eval_file` request should run. */
export interface LineRange {
  readonly start_line: number;
  readonly end_line: number;
}

/**
 * The lines a selection asks for, or nothing when there is no selection.
 *
 * Nothing means the whole file, which is what Evaluate File has always done
 * and still does when the user has only a cursor.
 *
 * The one adjustment is the last line. Dragging down the gutter, or pressing
 * `Shift+Down` at the end of a line, leaves the selection ending at character
 * 0 of the line *after* the last one highlighted -- nothing of that line is
 * selected, and the user can see that nothing of it is. Taking it at face
 * value would run a statement they did not touch, which is the same mistake
 * as running a fragment, made in the other direction.
 */
export function selectedLines(selection: Range): LineRange | undefined {
  const { start, end } = selection;
  if (start.line === end.line && start.character === end.character) {
    return undefined;
  }
  return {
    start_line: start.line,
    end_line: end.character === 0 && end.line > start.line
      ? end.line - 1
      : end.line,
  };
}

/** Whether `first` comes before `second` in the document. */
function before(
  first: Range['start'], second: Range['start']
): boolean {
  return first.line < second.line
    || (first.line === second.line && first.character < second.character);
}

/**
 * Did the run reach outside what the user highlighted?
 *
 * The comparison is against the raw selection rather than the lines that were
 * asked for, so a widening inside a single line -- selecting `right` out of
 * `left = 'a'; right = 'b'` -- counts as one too. The user needs telling
 * whenever more code ran than they pointed at, and how far the run had to
 * reach is not something the size of the jump changes.
 */
export function widenedBeyond(executed: Range, selection: Range): boolean {
  return before(executed.start, selection.start)
    || before(selection.end, executed.end);
}
