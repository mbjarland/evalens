/**
 * The inline object explorer (#23): turning one `Inspected` response into
 * text a hover can show and items a QuickPick can walk.
 *
 * Free of `vscode`, on the same reasoning `announce.ts` gives for the
 * channel next door: what a table says and which row a pick corresponds to
 * are decisions with a right answer that does not need an editor to check,
 * and the editor shell is the one place that could not be tested. The
 * vscode-touching driver that calls `showQuickPick` in a loop is
 * `render/explorer.ts`; this module only decides what it would show.
 *
 * Design rule 7 is why there are two surfaces rather than one: the table
 * built here is what a hover shows *on the line*, unprompted by anything
 * beyond the hover VS Code already offers. The QuickPick is the fallback
 * for going a level deeper, which nothing inline can do -- VS Code gives a
 * decoration no chevron and a hover no interaction beyond a command link --
 * and the issue's own recommendation is what settles that this, rather than
 * a panel, is the shape to build.
 */

import { InspectChild, Inspected } from '../kernel/protocol';

/**
 * Is `display` a namespace name an `inspect` request can be aimed at?
 *
 * Everything the kernel's own `inspect_value` accepts is exactly what
 * Python's `str.isidentifier()` accepts, and this mirrors that check on
 * this side so a hover never pays for a round trip it can already tell
 * will answer `InvalidRequest` -- `self.x`, `d['key']`, `a, b`, a bare
 * literal. Deliberately ASCII-only rather than the full Unicode identifier
 * grammar Python actually allows: every name this project's own examples
 * and its stated first-year audience use is ASCII, and the cost of the
 * narrower check is that a hover over a name written in another script's
 * letters shows only the plain repr it always showed, not that anything
 * is described wrongly.
 */
const BARE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isInspectableName(
  display: string | null | undefined
): display is string {
  return typeof display === 'string' && BARE_NAME.test(display);
}

/** A table cell, safe to place inside a GitHub-flavoured markdown table. */
function cell(text: string): string {
  // Backslash first, or escaping `|` would double-escape one that started
  // as `\|`. Newlines become spaces because a table row is one line of
  // markdown; a value that carried its own line breaks (a multi-line
  // string, most often) is still fully present, just no longer laid out
  // the way it was written.
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

/** `{type}`, following Rider: braces around the word, not around anything
 * else on the row. */
function braced(type: string): string {
  return `{${cell(type)}}`;
}

function valueCell(child: InspectChild): string {
  if (child.evaluated === false) {
    // A property, shown per the ticket's own requirement rather than
    // called to find out what it holds.
    return '*not evaluated*';
  }
  return cell(child.value ?? '');
}

/**
 * The one-level table a hover shows beside an inspectable value's own repr,
 * or `undefined` when there is nothing to add -- a leaf, or a container
 * whose kernel-side walk found no describable children.
 *
 * A GitHub-flavoured markdown table, which is what VS Code's hover renderer
 * already supports without `supportHtml`, so nothing here has to reach for
 * raw HTML to lay out three columns.
 */
export function inspectionTable(inspected: Inspected): string | undefined {
  if (inspected.children.length === 0) {
    return undefined;
  }
  const rows = inspected.children.map((child) => (
    `| ${cell(child.name)} | ${braced(child.type)} | ${valueCell(child)} |`
  ));
  const table = [
    '| Field | Type | Value |',
    '| --- | --- | --- |',
    ...rows,
  ].join('\n');
  if (!inspected.truncated) {
    return table;
  }
  const left = inspected.count - inspected.children.length;
  return `${table}\n\n*… and ${left.toLocaleString()} more*`;
}

/**
 * Whether the table alone tells the whole story, or there is a reason to
 * offer the drill-down command as well: a row cut off by the per-level cap,
 * or a row that itself has children one more `inspect` would reach.
 *
 * A flat `{'host': ..., 'port': ...}` answers false -- the table already
 * shows everything there is -- so the hover for the common case gains a
 * table and nothing else, rather than a command link with nowhere further
 * to usefully go.
 */
export function hasMoreToExplore(inspected: Inspected): boolean {
  return inspected.truncated
    || inspected.children.some((child) => child.expandable);
}

/** One row of the drill-down QuickPick, carrying the child it came from. */
export interface InspectPickItem {
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  /** Absent only for the synthetic "back" row `explorer.ts` prepends. */
  readonly child?: InspectChild;
}

/**
 * `inspected.children`, shaped for `vscode.window.showQuickPick` -- label,
 * a `{type}` description, and the value (or "not evaluated") as the detail
 * line QuickPick shows beneath it.
 *
 * Every item keeps its originating `InspectChild`, `step` included, so the
 * driver can extend the current path with exactly what the kernel handed
 * out rather than reconstructing an address from the label text.
 */
export function quickPickItems(inspected: Inspected): InspectPickItem[] {
  return inspected.children.map((child) => ({
    label: child.expandable ? `$(chevron-right) ${child.name}` : child.name,
    description: braced(child.type),
    detail: child.evaluated === false ? 'not evaluated' : (child.value ?? ''),
    child,
  }));
}

/** The QuickPick title, a breadcrumb of every name picked to get here. */
export function breadcrumbTitle(trail: readonly string[]): string {
  return trail.join(' › ');
}
