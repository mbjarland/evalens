/**
 * Turning a kernel's bounded table description into markdown for a hover.
 *
 * A grid does not fit on a line -- design rule 7 says the answer goes on the
 * line, and a table is the one shape that structurally cannot. So this is a
 * second surface rather than a wider first line: #46's `HoverProvider`
 * (`render/hover.ts`) is already anchored to the statement, keyboard
 * reachable and accessible, and `vscode.MarkdownString` already renders a
 * GitHub-flavoured table, so nothing here needs its own webview. What this
 * module owns is turning `TableWire` -- the kernel's own bounded sample, see
 * `kernel/tabular.py` and `TableWire` in `kernel/protocol.ts` -- into that
 * markdown, and nothing about *when* or *where* it is shown.
 *
 * `tableMarkdown` is the one entry point. It is pure and it is total: any
 * `TableWire` a real kernel can produce renders to a string, and there is no
 * value for which this module decides to run anything -- the decision about
 * *whether* a value is tabular already happened in the kernel, duck-typed and
 * bounded there (see #24), and this only ever renders what it is handed.
 *
 * Kept apart from `format.ts` on purpose. `format.ts` turns a value into the
 * one line beside the code and the fenced block a hover already showed for
 * it; a table is never either of those; it is always the elaboration named
 * above it. And kept apart from #23's object explorer for the same reason
 * `render/hover.ts` gives for staying thin: two features that both want the
 * hover should compose there rather than each acquiring their own paragraph
 * of markdown-building logic. If dict expansion (#23) and the table view end
 * up wanting the same "here is more than fits on the line" surface, that is
 * an argument for one shared elaboration mechanism, not two, and this module
 * is written so that folding it into such a thing costs one call site, not a
 * rewrite: it does not touch `Annotation`, does not read from the registry,
 * and takes only the data it needs to do its own job.
 */

import { TableWire } from '../kernel/protocol';
import { literalCell } from './markdown';

/**
 * Markdown-escape one cell or header, and flatten it to a single line.
 *
 * `|` would otherwise close the column early -- a cell holding the repr
 * `{'a': 1}` has none, but a string cell like `'a|b'` does, and a `repr()` is
 * never guaranteed not to contain one. A newline inside a cell (a multi-line
 * repr, cut short by the kernel's own per-cell bound) would break the table's
 * row structure outright, so it becomes a visible marker rather than silently
 * merging two rows into garbled markdown.
 */
function escapeCell(text: string): string {
  return literalCell(text, ' ⏎ ');
}

function row(cells: readonly string[]): string {
  return `| ${cells.map(escapeCell).join(' | ')} |`;
}

/**
 * How the caption states what was left out, in the same voice
 * `kernel/evalens_kernel.py`'s own elision marker uses for a collection --
 * "how much is not on screen", not just "there is more".
 */
function omittedNote(shown: number, total: number, noun: string): string {
  return total === shown
    ? `${total} ${noun}${total === 1 ? '' : 's'}`
    : `${shown} of ${total.toLocaleString()} ${noun}s shown`;
}

const KIND_LABEL: Record<TableWire['kind'], string> = {
  dataframe: 'DataFrame',
  records: 'records',
  namedtuples: 'namedtuples',
  rows: 'rows',
};

/**
 * The table, as GitHub-flavoured markdown for a `vscode.MarkdownString`.
 *
 * A caption line states the real size before the grid does, because the grid
 * alone cannot: fifteen rows on screen says nothing about whether they are
 * the whole value or a sample of a million, and design rule 1 -- an
 * annotation must never assert more than it knows -- applies exactly as much
 * to a hover as to the line above it. `more_cols` gets the same treatment as
 * a trailing column of its own, so a table truncated sideways says so beside
 * the columns it did keep rather than only in the caption above them.
 *
 * The two-row header (labels, then a separator per column) is what
 * markdown requires to recognise a table at all. Every separator is
 * `:---`, requesting explicit left alignment rather than the bare `---`
 * this emitted before #105 -- `.monaco-hover` has no stylesheet rule of
 * its own for a table cell, so an unaligned column fell through to the
 * browser's default, a centred `th` over a left `td`, and the header
 * stopped sitting over its own column. `inspector.ts`'s `inspectionTable`
 * carries the same requirement and the same reasoning: two tables can
 * share one hover, and one aligning while the other did not would read
 * worse than either aligning badly alone.
 */
export function tableMarkdown(table: TableWire): string {
  const rowsNote = omittedNote(table.shown_rows, table.row_count, 'row');
  const colsNote = table.more_cols
    ? `, ${table.shown_cols} of ${table.col_count} columns shown`
    : '';
  const caption = `*${KIND_LABEL[table.kind]} — ${rowsNote}${colsNote}*`;

  const columns = table.more_cols
    ? [...table.columns, `… (+${table.more_cols} more)`]
    : table.columns;
  const lines = [
    caption,
    '',
    row(columns),
    row(columns.map(() => ':---')),
    ...table.rows.map((cells) => row(
      table.more_cols ? [...cells, ''] : cells)),
  ];
  return lines.join('\n');
}
