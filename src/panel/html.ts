/**
 * The Values panel's content, built and testable with no webview (#116).
 *
 * The panel is the trace, full width, in the bottom panel -- what a narrow
 * editor cannot show beside the code, shown under it instead. It reads
 * `Annotations` and nothing else: design rule 3 governs it exactly as it
 * governs the hover, and this module never reaches for the kernel. Every
 * value here is a `repr()` already captured, never re-read.
 *
 * Kept free of `vscode` on purpose, the same split `format.ts`, `layers.ts`
 * and `announce.ts` already make: `rowsFor` needs only `LineSource`, a
 * one-method structural stand-in for `vscode.TextDocument`, and
 * `PanelAnnotation`, a structural stand-in for `render/decorations.ts`'s
 * `Annotation` built from `announce.ts`'s own `Announceable` -- a real
 * `Annotation` satisfies both without a cast, and a test can build one from
 * a plain object literal without an editor. `panel/values.ts` is the only
 * file here that imports `vscode`; it translates a real `vscode.TextEditor`
 * into these two shapes and calls `valuesHtml` for the rest.
 */

import { Announceable } from '../render/announce';
import { LoopExplorerWire } from '../kernel/protocol';
import {
  LoopExplorer, LoopViewState, LOOP_EXPLORER_STYLE, loopExplorerHtml,
  prepareLoopExplorer,
} from './loopExplorer';
import {
  Printed, STDERR_LABEL, Segment, SegmentRole, collapseLines, grouped,
  isStreamGroup, resultGroups,
} from '../render/format';
import {
  Marker, markerFor, normalizeSource, staleReasonText, DependencyCause,
} from '../render/registry';
import { pendingText } from '../render/status';

// -- building rows from annotations ------------------------------------------

/**
 * The minimum `rowsFor` needs to read a line's own source text. A real
 * `vscode.TextDocument` satisfies this structurally; `panel/values.ts` never
 * has to build anything to hand one over.
 */
export interface LineSource {
  lineAt(line: number): { readonly text: string };
}

/**
 * The parts of an annotation the panel reads, kept structural for the same
 * reason `registry.ts`'s `Traced`/`Anchored` are: a real `render/decorations
 * .ts` `Annotation` satisfies this without a cast (its `range` is a
 * `vscode.Range`, which has `.start.line`/`.end.line`), and a test can build
 * one from a plain object with no `vscode.Range` in sight. `Announceable`
 * already carries everything about *what a statement produced* -- value,
 * display, loop, bindings, names, printed, more, error, partialFrom, stale,
 * pending -- because the panel and the announced-result channel read the
 * same trace; only `range`, `anchor` and `staleReason` are this module's own
 * addition, for the two things `announce.ts` never needed: where a row
 * belongs, and why a stale one is stale.
 */
export interface PanelAnnotation extends Announceable {
  readonly loopExplorer?: LoopExplorerWire;
  readonly range: {
    readonly start: { readonly line: number };
    readonly end: { readonly line: number };
  };
  readonly anchor?: number;
  readonly staleReason?: 'edited' | 'dependency';
  readonly staleCause?: DependencyCause;
}

/** Which of the panel's four row states one row is in -- `Marker`'s three,
 * plus `'pending'` for a statement that has not finished. */
export type RowState = Marker | 'pending';

/**
 * Where a navigated-to row should land along the page's one scroll axis
 * (#169). `viewTop`/`viewBottom` bound the space below the sticky
 * `#navigation-control` -- the part of the window a row can actually be
 * read in; `rectTop`/`rectHeight` are the row's own position and height,
 * document-relative (`getBoundingClientRect().top` plus the page's current
 * `scrollY`); `maxScroll` is the furthest the page can scroll at all
 * (`document.documentElement.scrollHeight - window.innerHeight`, never
 * negative).
 *
 * Centred -- the row's vertical middle at the view's middle -- when it fits
 * comfortably, at most 80% of the view's own height; a row taller than
 * that is top-aligned instead, its own top edge placed a small margin
 * below `viewTop`, so the reader starts at its beginning rather than
 * somewhere in its middle. Both are then clamped to `[0, maxScroll]`: the
 * result is never a request to scroll past either end of the document,
 * even when the rule's own arithmetic would ask for that on the file's
 * last few rows.
 *
 * A plain function of six numbers, so it is unit-tested directly with no
 * DOM at all -- and its `.toString()` is what the page script below
 * actually runs, embedded verbatim rather than retyped, so there is
 * exactly one copy of this arithmetic rather than two that could drift
 * apart.
 */
export function placeScroll(
  rectTop: number, rectHeight: number, scrollY: number,
  viewTop: number, viewBottom: number, maxScroll: number
): number {
  const viewSpan = viewBottom - viewTop;
  const margin = 8;
  const target = rectHeight <= 0.8 * viewSpan
    ? scrollY + rectTop + rectHeight / 2 - (viewTop + viewSpan / 2)
    : scrollY + rectTop - (viewTop + margin);
  return Math.max(0, Math.min(maxScroll, target));
}

/** One stream a statement wrote to, in full -- never the line's own
 * first-line-plus-count summary, per the ticket: the panel has the room. */
export interface FullStream {
  readonly label: string;
  readonly text: string;
}

/** One row of the panel's table, already resolved from an annotation and a
 * line of source -- everything `valuesHtml` needs and nothing it has to ask
 * `vscode` for. */
export interface ValuesRow {
  readonly loopExplorer?: LoopExplorer;
  /** 0-based line the value is painted on -- `anchor` when set, matching
   * where `decorations.ts` paints the inline chip. */
  readonly line: number;
  /** 0-based first and last line of the statement, so a cursor anywhere
   * inside a multi-line statement -- not only on `line` -- highlights this
   * row, the same containment `Annotations.at` already applies. */
  readonly startLine: number;
  readonly endLine: number;
  /**
   * Every line of the statement's own source that fits the CODE cell's cap
   * -- `range.start.line` through `range.end.line` (the same whole-line
   * range `sourceAt` in `render/decorations.ts` reads for this annotation),
   * in order, indentation as written and only trailing whitespace stripped.
   * A single-line statement has exactly one entry. Capped at
   * `MAX_CODE_LINES - 1` real lines when the statement runs longer than
   * that -- `codeMoreCount` then says how many were left out, so a
   * 200-line `def` cannot dominate the panel.
   */
  readonly codeLines: readonly string[];
  /** Set only when `codeLines` left lines out past the cap; the count the
   * CODE cell's own final `… (+N lines)` line reports. */
  readonly codeMoreCount?: number;
  readonly state: RowState;
  /** Present only when `state` is `'stale'`. */
  readonly staleReason?: 'edited' | 'dependency';
  readonly staleCause?: DependencyCause;
  /** Value groups exactly as `resultGroups` builds them, at full length --
   * absent for a pending or error row, which paint their own message
   * instead, and absent for a row with nothing to show at all. */
  readonly groups?: readonly (readonly Segment[])[];
  /** Every stream the statement wrote to, in full. Absent when it wrote
   * nothing. */
  readonly streams?: readonly FullStream[];
  /** `"TypeName: message"`, present only when the annotation carries an
   * error -- whether or not `state` is `'error'`: a stale annotation that
   * was also an error still shows the error text, greyed by the stale
   * surface rather than displaced by it (`markerFor`'s own ranking). */
  readonly errorText?: string;
  /** Present only when `state` is `'pending'`. */
  readonly pendingText?: string;
}

/** How wide a value is shown before it is cut -- effectively never, for the
 * panel: `format.truncateValue`'s cut exists for the inline chip's column,
 * and the whole point of a panel is the room a column does not have. */
const FULL_VALUE_LENGTH = Number.MAX_SAFE_INTEGER;

function nonEmpty(text: string | undefined): boolean {
  return (text ?? '') !== '';
}

/** `format.preserveSpacing`'s non-breaking spaces, undone (#116 review):
 * see the comment where this is called, in `rowFor`. */
function ordinarySpacing(text: string): string {
  return text.split(' ').join(' ');
}

/**
 * A stream's text, in full and with its own trailing newline removed -- the
 * same rule `format.streamPiece` applies to the one-line inline summary, for
 * the same reason: the newline `print` writes is how a line ends, not a line
 * of its own. Unlike the inline summary, every remaining line survives,
 * including embedded blank ones -- only a *wholly* empty result reads as a
 * bug rather than as the answer, so that one case alone is named.
 */
function fullStreamText(raw: string): string {
  const stripped = raw.replace(/\r?\n$/, '');
  return stripped === '' ? '(blank line)' : stripped;
}

/** Every stream a statement wrote to, labelled and in full -- stdout first,
 * on the same terms `format.ts`'s own (private) `streamsOf` uses. */
function streamsFor(
  printed: Printed | undefined, printedLabel: string
): readonly FullStream[] {
  const streams: FullStream[] = [];
  if (nonEmpty(printed?.stdout)) {
    streams.push({ label: printedLabel, text: fullStreamText(printed!.stdout!) });
  }
  if (nonEmpty(printed?.stderr)) {
    streams.push({ label: STDERR_LABEL, text: fullStreamText(printed!.stderr!) });
  }
  return streams;
}

/** How many source lines the CODE cell shows before the rest folds into one
 * final `… (+N lines)` marker -- capping the cell's own height so a
 * 200-line `def` cannot push every other row on the panel out of view. */
const MAX_CODE_LINES = 12;

/**
 * The statement's own source lines, `startLine` through `endLine` inclusive
 * -- the same whole-line range `sourceAt` (`render/decorations.ts`) reads
 * for the same annotation. Each line goes through `normalizeSource` on its
 * own, which strips only trailing whitespace: a body line's leading
 * indentation is exactly what makes a multi-line statement legible in the
 * cell, and `white-space: pre` in the stylesheet (`codeCellHtml`, below) is
 * what keeps it once there.
 *
 * Never reads more than `MAX_CODE_LINES` lines: past `MAX_CODE_LINES - 1`
 * real lines, the rest is reported back as `moreCount` rather than read at
 * all, so a caller never has to slice what this already capped.
 */
function sourceLines(
  document: LineSource, startLine: number, endLine: number
): { readonly lines: readonly string[]; readonly moreCount?: number } {
  const total = endLine - startLine + 1;
  const shown = total > MAX_CODE_LINES ? MAX_CODE_LINES - 1 : total;
  const lines = Array.from(
    { length: shown },
    (_, i) => normalizeSource(document.lineAt(startLine + i).text));
  return total > MAX_CODE_LINES ? { lines, moreCount: total - shown } : { lines };
}

/**
 * One annotation, as a row.
 *
 * `resultGroups` already builds the value/name/binding/more/partial chips at
 * whatever width it is asked for, so a full-length call to it is reused for
 * everything but the printed streams -- which it can only elide to a single
 * line plus a count, never what this ticket asks for. So it is called with
 * the real `printed` (its presence still decides whether a produced `None`
 * gets suppressed -- see `paintedSlots`), and the elided stream groups it
 * produces are then dropped in favour of `streamsFor`'s full rebuild below.
 *
 * Dropped by role, not by position (#152). An earlier version cut
 * `allGroups` by index, trusting the statement's own slots to come first and
 * the streams right after them -- true until #118 started hoisting a shared
 * `×N` count to the front of the line, which shifted every index by one and
 * dropped a value group instead of a stream. `isStreamGroup` asks what a
 * group *is* -- whether its first segment carries `streamPiece`'s own
 * `streamLabel` role -- so the cut keeps working whatever `resultGroups`
 * puts first.
 */
function rowFor(
  document: LineSource, annotation: PanelAnnotation, printedLabel: string
): ValuesRow {
  const line = annotation.anchor ?? annotation.range.end.line;
  const startLine = annotation.range.start.line;
  const endLine = annotation.range.end.line;
  const { lines: codeLines, moreCount: codeMoreCount } =
    sourceLines(document, startLine, endLine);
  const base = {
    line, startLine, endLine, codeLines,
    ...(codeMoreCount === undefined ? {} : { codeMoreCount }),
  };

  if (annotation.pending) {
    return { ...base, state: 'pending', pendingText: pendingText(annotation.pending) };
  }

  const state = markerFor(annotation);
  const staleReason = state === 'stale' ? { staleReason: annotation.staleReason, staleCause: annotation.staleCause } : {};

  if (annotation.error !== undefined) {
    const summary = collapseLines(annotation.error.message);
    return {
      ...base,
      state,
      ...staleReason,
      errorText: summary
        ? `${annotation.error.type}: ${summary}` : annotation.error.type,
      ...(annotation.printed
        ? { streams: streamsFor(annotation.printed, printedLabel) } : {}),
    };
  }

  // `resultGroups` substitutes non-breaking spaces throughout
  // (`format.preserveSpacing`), because the inline chip is a VS Code
  // decoration `contentText` and VS Code collapses runs of ordinary spaces
  // there. A webview has no such problem -- this is real HTML -- and an
  // NBSP is, by definition, never a line-break opportunity: left in place,
  // a long list becomes one unbreakable word and `overflow-wrap: anywhere`
  // shreds it mid-number instead of wrapping at its own ", " boundaries
  // (#116 review). So every segment's text is put back to ordinary spaces
  // before it is ever rendered.
  const allGroups = resultGroups({
    value: annotation.value ?? null,
    display: annotation.display,
    loop: annotation.loop,
    names: annotation.names,
    bindings: annotation.bindings,
    printed: annotation.printed,
    more: annotation.more,
    isBinding: annotation.isBinding,
    partialFrom: annotation.partialFrom,
    maxValueLength: FULL_VALUE_LENGTH,
  }).map((group) => group.map(
    (segment) => ({ ...segment, text: ordinarySpacing(segment.text) })));
  // A stream group is exactly the "first line …(N lines)" summary this
  // ticket asks the panel not to show, since `streamsFor` rebuilds the same
  // streams in full below -- dropped by asking `isStreamGroup` what each
  // group is, never by where it sits in `allGroups` (#152).
  const groups = allGroups.filter(
    (group) => group.length > 0 && !isStreamGroup(group));
  const streams = streamsFor(annotation.printed, printedLabel);
  const loopExplorer = prepareLoopExplorer(annotation.loopExplorer,
    annotation.printed?.stdout, annotation.printed?.stderr);

  return {
    ...base,
    state,
    ...staleReason,
    ...(groups.length > 0 ? { groups } : {}),
    ...(streams.length > 0 ? { streams } : {}),
    ...(loopExplorer ? { loopExplorer } : {}),
  };
}

/**
 * Every annotation of a document, as rows in document order.
 *
 * `AnnotationRegistry` (`registry.ts`) holds annotations in the order
 * `merge` last touched them, not the order they sit in the file -- so this
 * sorts by `line`, the row's own display line, before anything is rendered.
 */
export function rowsFor(
  document: LineSource, annotations: readonly PanelAnnotation[],
  printedLabel: string
): readonly ValuesRow[] {
  return annotations
    .map((annotation) => rowFor(document, annotation, printedLabel))
    .sort((a, b) => a.line - b.line);
}

// -- rendering ----------------------------------------------------------------

/** What the panel shows: the active Python file's rows, or `undefined` for
 * "no active Python editor" -- the one fact `valuesHtml` cannot work out for
 * itself, since an empty `rows` array is also what a Python file with no
 * annotations yet looks like. */
export interface ValuesPanelData {
  readonly fileName: string | undefined;
  readonly rows: readonly ValuesRow[];
  /** The newest retained completed result in this document, independently
   * of the editor cursor. Never a pending row or an inferred nearby line. */
  readonly latestResultLine?: number;
}

/**
 * How the panel folds a long stream or a long value, and which rows the
 * reader has already opened in full (#155) -- both decided by
 * `panel/values.ts`, never here: this module only ever bakes whatever it
 * is handed into the page, the same way it already does for `cursorLine`
 * and `revealLine`. Omitted entirely by a caller with no opinion -- every
 * existing caller that never mentions folding gets the setting's own
 * default and nothing expanded, so no test that predates #155 had to
 * change.
 */
export interface FoldState {
  readonly loopStates?: ReadonlyMap<LoopExplorerWire, LoopViewState>;
  /** `evalens.valuesPanel.outputLines`'s current value -- the setting's
   * own manifest default, `20`, when the caller has none. */
  readonly outputLines?: number;
  /**
   * The rows (keyed by `ValuesRow.line`, the same key `revealLine` and the
   * cursor highlight already use) the reader has expanded with `Show all`
   * or a click on the block's own label. `panel/values.ts` is what keeps
   * this across a rebuild and drops a line once the row it named is
   * replaced or cleared; this module only ever reads it for the one
   * render it is handed.
   */
  readonly expandedLines?: ReadonlySet<number>;
}

const DEFAULT_OUTPUT_LINES = 20;
const NO_EXPANDED_LINES: ReadonlySet<number> = new Set();

/**
 * Theme colours this view paints with, and their dark-theme fallback.
 *
 * Declared here rather than imported from `render/decorations.ts`: that
 * module's top-level `import 'vscode'` would drag this one's own "testable
 * with no webview" claim down with it the moment anything imported from it.
 * `panel.test.ts` cross-checks every id and fallback against `package.json`
 * directly, the same "declared twice, and a test that they agree" shape
 * `colors.test.ts` and `readme.test.ts` already hold the rest of the
 * extension's colours to, rather than reading the manifest at run time from
 * inside the shipped extension.
 */
export const PANEL_PALETTE = {
  value: { id: 'evalens.resultForeground', fallback: '#d1a35c' },
  nameLabel: { id: 'evalens.labelForeground', fallback: '#8d7a5a' },
  streamLabel: { id: 'evalens.outputLabelForeground', fallback: '#5c7fa6' },
  border: { id: 'evalens.annotationBorder', fallback: '#e6ad45' },
  tint: { id: 'evalens.annotationTint', fallback: '#d1a35c1a' },
  staleTint: { id: 'evalens.staleTint', fallback: '#8c8c8c0d' },
  staleBorder: { id: 'evalens.staleBorder', fallback: '#8c8c8c' },
  error: { id: 'evalens.errorForeground', fallback: '#f14c4c' },
  pending: { id: 'evalens.pendingForeground', fallback: '#8c8c8c' },
} as const;

/**
 * `var(--vscode-<id>, <fallback>)` for a contributed colour id.
 *
 * VS Code exposes every colour it knows about to a webview as a CSS custom
 * property named for the id with its dots turned to dashes -- documented
 * behaviour for a webview's own stylesheet, and true of an id this extension
 * contributes exactly as it is of one VS Code ships. The fallback is what
 * paints if that turns out not to hold for a contributed id in some VS Code
 * version this was not checked against: never invisible, only untinted.
 */
function cssVar(key: keyof typeof PANEL_PALETTE): string {
  const { id, fallback } = PANEL_PALETTE[key];
  return `var(--vscode-${id.replace(/\./g, '-')}, ${fallback})`;
}

/** Reads as annotation rather than as any other text on the row. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const NO_EDITOR_MESSAGE = 'Open a Python file.';
const NO_ANNOTATIONS_MESSAGE =
  'Evaluate a line with ⌘⏎ (Ctrl+Enter on Windows/Linux) to see '
  + 'its values here.';
const FOOTER_TEXT =
  'Values are what each line produced when it ran. Click a row to jump to '
  + 'the line. Use Up/Down or Home/End to browse, Enter or Space to reveal '
  + 'source. Nothing here is re-evaluated.';

function pluralize(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** `basics.py · 8 values · 1 stale · 1 error` -- the counts that are zero
 * say nothing, the way `format.ts`'s own `…+N more` only appears at all
 * when there is one. */
function summaryLine(fileName: string, rows: readonly ValuesRow[]): string {
  const stale = rows.filter((row) => row.state === 'stale').length;
  const error = rows.filter((row) => row.state === 'error').length;
  const parts = [pluralize(rows.length, 'value')];
  if (stale > 0) {
    parts.push(`${stale} stale`);
  }
  if (error > 0) {
    parts.push(`${error} error`);
  }
  return `${fileName} · ${parts.join(' · ')}`;
}

type Tone = 'evaluated' | 'stale' | 'error' | 'pending';

/** One statement owns its surface and continuous accent, including wrapped
 * values and output (#163). Empty results must not leave an orphan bar. */
function resultSurface(innerHtml: string, tone: Tone): string {
  return innerHtml === '' ? ''
    : `<div class="result-surface tone-${tone}">${innerHtml}</div>`;
}

/** Inline groups keep labels directly beside their values. A folded value
 * or a stream needs its own block, but never another tint or accent bar. */
function resultGroup(innerHtml: string, block = false): string {
  return block ? `<div class="result-group block">${innerHtml}</div>`
    : `<span class="result-group">${innerHtml}</span>`;
}

/**
 * `extra` adds a class and attributes to the span without a second render
 * path -- used only by a foldable block's own label (#155), which needs to
 * be a click target exactly where an ordinary segment does not.
 */
function segmentHtml(
  segment: Segment, extra?: { readonly className: string; readonly attrs: string }
): string {
  const role: SegmentRole = segment.role;
  const className = extra ? `seg-${role} ${extra.className}` : `seg-${role}`;
  const attrs = extra ? ` ${extra.attrs}` : '';
  return `<span class="${className}"${attrs}>${escapeHtml(segment.text)}</span>`;
}

function groupHtml(group: readonly Segment[]): string {
  return group.map((segment) => segmentHtml(segment)).join('');
}

// -- folding a long block (#155) ---------------------------------------------
//
// A printed/stderr stream, or a value group long enough to need the same
// treatment, folds to its first `outputLines` lines plus a footer -- never a
// second, shorter copy of a longer one hidden in the DOM: the background
// section of #155 is explicit that a hidden ten-thousand-line block would
// still cost on every rebuild, so a folded block's HTML contains exactly the
// lines it shows and nothing past them.
//
// Logical lines and character counts, never estimated visual rows: one
// enormous line must not bypass the DOM bound. Expanded previews still cap
// their text and height; the original captured text opens in an editor.

/** `… 9,980 more lines · Show all · Open in editor`, or `Show less` alone
 * once the row is already expanded -- literally that word and nothing
 * beside it: the row is already showing everything, and `Open in editor`
 * earns its place only where there is something left folded to open
 * instead of scrolling to.
 *
 * All three actions -- `Show all`, `Show less` and (see `foldedValueHtml`)
 * a click on the block's own label -- post the same `{ expand: line }`
 * message; `panel/values.ts` is where the toggle actually happens, one flag
 * flipped whichever of the three the reader clicked. `Open in editor` posts
 * `{ open: line, stream: blockId }`, and `blockId` is resolved back to the
 * exact text this module already rendered from by `fullTextFor`, below --
 * nothing is evaluated and nothing is re-read from the kernel.
 */
function foldFooterHtml(
  line: number, blockId: string, remaining: number | undefined,
  fullyExpandable = true
): string {
  const action = (label: string, kind: 'expand' | 'open'): string =>
    `<span class="fold-action" data-fold-action="${kind}" `
    + `data-fold-line="${line}" data-fold-id="${escapeHtml(blockId)}">${label}</span>`;
  if (remaining === undefined) {
    return `<div class="fold-footer">${action('Show less', 'expand')}</div>`;
  }
  const more = `… ${grouped(remaining)} more line${remaining === 1 ? '' : 's'}`;
  return `<div class="fold-footer">${escapeHtml(more)} · `
    + `${action(fullyExpandable ? 'Show all' : 'Show more', 'expand')} · ${action('Open in editor', 'open')}</div>`;
}

/**
 * The VALUE half of one foldable block: `text`, whole when it fits
 * `outputLines`, folded to its first `outputLines` lines with a footer when
 * it does not and the row is not expanded, or whole again -- inside its own
 * capped, scrolling container -- when the row is expanded. `foldable` tells
 * the caller whether the block's own label should become a click target;
 * a block that never needed folding gets exactly the markup it always did.
 */
function foldedValueHtml(
  text: string, line: number, blockId: string, outputLines: number,
  expanded: boolean
): { readonly foldable: boolean; readonly html: string } {
  let initialLines = 1;
  for (let i = 0; i < Math.min(text.length, 2001); i++) {
    if (text[i] === '\n') initialLines++;
  }
  if (text.length <= 2000 && initialLines <= outputLines) {
    return { foldable: false,
      html: `<span class="seg-value">${escapeHtml(text)}</span>` };
  }
  const previewChars = expanded ? 16000 : 2000;
  const lineLimit = expanded ? Number.MAX_SAFE_INTEGER : outputLines;
  let end = 0;
  let lineCount = 1;
  while (end < text.length && end < previewChars) {
    if (text[end] === '\n' && lineCount++ >= lineLimit) break;
    end++;
  }
  // Do not split a surrogate pair in a long one-line value or output.
  if (end < text.length && end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  if (end < text.length) {
    const shown = text.slice(0, end);
    const charBound = end >= previewChars - 1;
    if (charBound || expanded) {
      const action = (label: string, kind: 'expand' | 'open') =>
        `<span class="fold-action" data-fold-action="${kind}" data-fold-line="${line}" `
        + `data-fold-id="${escapeHtml(blockId)}">${label}</span>`;
      const footer = `<div class="fold-footer">… ${grouped(text.length - end)} more characters · `
        + action(expanded ? 'Show less' : (text.length > 16000 ? 'Show more' : 'Show all'), 'expand')
        + ` · ${action('Open in editor', 'open')}</div>`;
      const preview = `<span class="seg-value">${escapeHtml(shown)}</span>`;
      return { foldable: true,
        html: (expanded ? `<div class="fold-scroll">${preview}</div>` : preview) + footer };
    }
    let remaining = 0;
    for (let i = end; i < text.length; i++) if (text[i] === '\n') remaining++;
    return {
      foldable: true,
      html: `<span class="seg-value">${escapeHtml(shown)}</span>`
        + foldFooterHtml(line, blockId, remaining, text.length <= 16000),
    };
  }
  return {
    foldable: true,
    html: `<div class="fold-scroll"><span class="seg-value">`
      + `${escapeHtml(text)}</span></div>`
      + foldFooterHtml(line, blockId, undefined),
  };
}

/** The attributes that make a label a fold toggle -- shared so a stream's
 * label and a value group's label become click targets the same way. */
function foldLabelAttrs(line: number, blockId: string): string {
  return `data-fold-action="expand" data-fold-line="${line}" `
    + `data-fold-id="${escapeHtml(blockId)}"`;
}

/**
 * `printed: ` (or `»` for a glyph label, per `evalens.printedLabel`) and the
 * full text after it, as one block under the line's values.
 * `white-space: pre-wrap` on the group itself keeps every
 * line the statement printed, label and all, inside the one box, rather
 * than folding them to the single space the browser's ordinary text flow
 * would otherwise collapse them to.
 *
 * A stream of more than one line puts a line break right after the label
 * (#148): with the label and the first line sharing a row, that first line
 * starts one label-width to the right of every line after it, which is
 * exactly the "how many lines were printed" count a block chip exists to
 * make easy. A single-line stream keeps the label and its one line
 * together, as before -- there is no second line to misalign against.
 *
 * Past `outputLines` lines, the text folds (#155) exactly as `sourceLines`
 * already caps a compound statement's own CODE cell, and the label becomes
 * a click target for the same toggle `Show all`/`Show less` already are --
 * JupyterLab's own gesture for a folded cell output.
 */
function streamGroupHtml(
  stream: FullStream, line: number,
  outputLines: number, expanded: boolean
): string {
  const label = /[A-Za-z0-9]$/.test(stream.label)
    ? `${stream.label}:` : stream.label;
  const said = stream.text.includes('\n') ? `${label}\n` : `${label} `;
  const blockId = stream.label;
  const fold = foldedValueHtml(stream.text, line, blockId, outputLines, expanded);
  const labelSegment: Segment = { role: 'streamLabel', text: said };
  const labelHtml = segmentHtml(
    labelSegment,
    fold.foldable
      ? { className: 'fold-label', attrs: foldLabelAttrs(line, blockId) }
      : undefined);
  return resultGroup(labelHtml + fold.html, true);
}

/**
 * One `resultGroups` group, as a block if its own value segment runs
 * past `outputLines` -- "same rule for long values as for streams" (#155)
 * -- or `undefined` when it does not, telling the caller to keep rendering
 * it inline exactly as before.
 *
 * `slotSegments` and `streamPiece` (`render/format.ts`) are the only two
 * places a group is ever built, and both produce at most one `value`-role
 * segment per group, always last -- a shared iteration count and the
 * `…+N more`/`(partial: …)` footnotes carry none at all, so they can never
 * be foldable, correctly, without this having to know anything about what
 * kind of group it was handed. The label segments ahead of the value are
 * this extension's own short chrome and are kept exactly as `segmentHtml`
 * already renders them, in front of the fold -- only the one immediately
 * before the value becomes the click target, the same label a stream's own
 * `printed:` is.
 */
function foldableGroupHtml(
  group: readonly Segment[], line: number,
  blockId: string, outputLines: number, expanded: boolean
): string | undefined {
  const valueIndex = group.findIndex((segment) => segment.role === 'value');
  if (valueIndex === -1) {
    return undefined;
  }
  const fold = foldedValueHtml(
    group[valueIndex]!.text, line, blockId, outputLines, expanded);
  if (!fold.foldable) {
    return undefined;
  }
  const before = group.slice(0, valueIndex).map((segment, index) => segmentHtml(
    segment,
    index === valueIndex - 1
      ? { className: 'fold-label', attrs: foldLabelAttrs(line, blockId) }
      : undefined)).join('');
  return resultGroup(before + fold.html, true);
}

/**
 * The full, un-folded text behind one block's own id (#155) -- a stream's
 * own `label`, or `value-<index>` for one of `row.groups`, the same ids
 * `valueCellHtml` hands out when it builds the page -- so *Open in editor*
 * can open exactly the text this module already held, never a second copy
 * and never anything re-read from the kernel. `undefined` for an id this
 * row does not recognise, which `panel/values.ts` treats as nothing to
 * open rather than an error: the row can have rebuilt between the click
 * landing in the webview and the message reaching the extension.
 */
export function fullTextFor(row: ValuesRow, blockId: string): string | undefined {
  const stream = (row.streams ?? []).find((each) => each.label === blockId);
  if (stream) {
    return stream.text;
  }
  const match = /^value-(\d+)$/.exec(blockId);
  if (!match) {
    return undefined;
  }
  const group = (row.groups ?? [])[Number(match[1])];
  return group?.find((segment) => segment.role === 'value')?.text;
}

/**
 * The hover's own words for why a stale value is stale (#109), as dimmed
 * italic prose in the UI font after the chips (#116 review) -- never
 * monospace, value-coloured text carried on inside the chip flow, which
 * reads as part of the value rather than as a remark about it. A standalone
 * sentence rather than the hover's `Stale: …`, since the row's own grey
 * surface already says "stale" once.
 */
function staleReasonHtml(row: ValuesRow): string {
  const clause = staleReasonText(row.staleReason, row.staleCause);
  const sentence = `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`;
  const link = row.staleCause?.source
    ? ` <button type="button" data-stale-cause="${row.staleCause.id}">Go to re-binding</button>` : '';
  return `<div class="stale-reason">${escapeHtml(sentence)}${link}</div>`;
}

/** The VALUE column's whole content for one row, folding any block --
 * stream or value group -- past `outputLines` lines (#155), open exactly
 * where `expandedLines` names this row's own line. */
function valueCellHtml(
  row: ValuesRow, outputLines: number, expandedLines: ReadonlySet<number>,
  loopStates?: ReadonlyMap<LoopExplorerWire, LoopViewState>
): string {
  if (row.state === 'pending') {
    return resultSurface(
      `<span class="pending-text">${escapeHtml(row.pendingText ?? '')}</span>`,
      'pending');
  }

  if (row.errorText !== undefined) {
    // Stale outranks error here exactly as `markerFor` says it does
    // everywhere else: a failed statement that has since been edited is not
    // reporting the current code's failure, so the surface recedes to grey
    // while the message -- still in the error colour -- says what it was.
    const tone: Tone = row.state === 'stale' ? 'stale' : 'error';
    const streams = (row.streams ?? []).map((stream) => streamGroupHtml(
      stream, row.line, outputLines, expandedLines.has(row.line))).join('');
    const errorSurface = resultSurface(
      `<div class="result-values"><span class="error-text">${escapeHtml(row.errorText)}</span></div>`
      + (streams ? `<div class="result-streams">${streams}</div>` : ''), tone);
    return row.state === 'stale' && row.staleReason !== undefined
      ? errorSurface + staleReasonHtml(row)
      : errorSurface;
  }

  // Values and streams are separate sections within one shared surface.
  // Only their boundary gets the quiet internal divider. Long values stay
  // with values even when they need a block and footer of their own.
  // The fold flag remains per row (#155): opening any block opens the
  // row's foldable blocks, without evaluating or capturing anything new.
  const tone: Tone = row.state === 'stale' ? 'stale' : 'evaluated';
  if (row.loopExplorer) {
    const explorer = resultSurface(loopExplorerHtml(row.loopExplorer,
      row.line, loopStates?.get(row.loopExplorer.wire), outputLines), tone);
    return row.state === 'stale' && row.staleReason !== undefined
      ? explorer + staleReasonHtml(row) : explorer;
  }
  const expanded = expandedLines.has(row.line);
  const values = (row.groups ?? []).map((group, index) => {
    const folded = foldableGroupHtml(
      group, row.line, `value-${index}`, outputLines, expanded);
    return folded ?? resultGroup(groupHtml(group));
  }).join(' ');
  const streams = (row.streams ?? []).map((stream) => streamGroupHtml(
    stream, row.line, outputLines, expanded)).join('');
  // A statement with nothing to show at all -- an `if`, a `del` -- paints no
  // chip, the same as the inline annotation does.
  const value = resultSurface(
    (values ? `<div class="result-values">${values}</div>` : '')
      + (streams ? `<div class="result-streams">${streams}</div>` : ''), tone);
  return row.state === 'stale' && row.staleReason !== undefined
    ? value + staleReasonHtml(row)
    : value;
}

/** The CODE column's whole content for one row: every line `rowFor` kept,
 * indentation preserved -- `white-space: pre` in the stylesheet is what
 * keeps it once there -- each in its own block so `text-overflow: ellipsis`
 * cuts a too-wide line on its own rather than the cell as a whole. The
 * final `… (+N lines)` line, when `row.codeMoreCount` is set, carries its
 * own class so it reads as a note rather than as code. */
function codeCellHtml(row: ValuesRow): string {
  const lines = row.codeLines
    .map((line) => `<div class="code-line">${escapeHtml(line)}</div>`);
  const more = row.codeMoreCount === undefined
    ? []
    : [`<div class="code-line code-more">`
      + `${escapeHtml(`… (+${row.codeMoreCount} lines)`)}</div>`];
  return [...lines, ...more].join('');
}

/** `outputLines` and `expandedLines` travel together from `valuesHtml` down
 * to `valueCellHtml` -- one fold configuration for the whole render, not one
 * argument each threaded through `tableHtml` and `rowHtml` in between. */
interface FoldRenderOptions {
  readonly loopStates?: ReadonlyMap<LoopExplorerWire, LoopViewState>;
  readonly outputLines: number;
  readonly expandedLines: ReadonlySet<number>;
}

/** One `<tr>`, carrying the line data the embedded script needs to move the
 * cursor highlight and to jump to a click without a rebuild. */
function rowHtml(
  row: ValuesRow, isCursor: boolean, isLatest: boolean, fold: FoldRenderOptions
): string {
  const cursorClass = isCursor ? ' cursor' : '';
  const loopClass = row.loopExplorer ? ' loop-row' : '';
  const latestClass = isLatest ? ' latest-result' : '';
  const latestLabel = isLatest
    ? '<span class="latest-result-label" title="Most recently recorded result in this file">Latest result</span>'
    : '';
  return `<tr class="row${cursorClass}${loopClass}${latestClass}" data-goto="${row.line}" `
    + `data-start="${row.startLine}" data-end="${row.endLine}" `
    + `tabindex="${isCursor ? 0 : -1}" aria-current="${isCursor}">`
    + `<td class="line-cell"><span class="navigation-arrow" aria-hidden="true">› </span>`
    + `<span class="line-num">${row.line + 1}</span></td>`
    + `<td class="code-cell">${codeCellHtml(row)}${latestLabel}</td>`
    + `<td class="value-cell">`
    + `${valueCellHtml(row, fold.outputLines, fold.expandedLines, fold.loopStates)}</td>`
    + `</tr>`;
}

function emptyStateHtml(message: string): string {
  return `<p class="empty">${escapeHtml(message)}</p>`;
}

function tableHtml(
  fileName: string, rows: readonly ValuesRow[], cursorLine: number | undefined,
  fold: FoldRenderOptions, latestResultLine?: number
): string {
  const summary =
    `<div class="summary">${escapeHtml(summaryLine(fileName, rows))}</div>`;
  const current = rows.find((row) => row.line === cursorLine)
    ?? rows.filter((row) => cursorLine !== undefined
      && cursorLine >= row.startLine && cursorLine <= row.endLine)
      .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
  const body = rows.map((row) => rowHtml(row, row === current,
    row.line === latestResultLine && row.state !== 'pending', fold)).join('\n');
  const table = '<table>'
    + '<colgroup><col class="col-line"><col class="col-code">'
    + '<col class="col-value"></colgroup>'
    + `<tbody>\n${body}\n</tbody></table>`;
  const footer = `<p class="footer">${escapeHtml(FOOTER_TEXT)}</p>`;
  return `${summary}\n${table}\n${footer}`;
}

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 6px 10px 10px;
  background: var(--vscode-panel-background, #1e1e1e);
  color: var(--vscode-foreground, #cccccc);
  font-family: var(--vscode-font-family, sans-serif);
  font-size: var(--vscode-font-size, 13px);
}
.empty, .summary, .footer {
  color: var(--vscode-descriptionForeground, #9d9d9d);
}
.empty { padding: 8px 2px; }
.summary {
  padding: 2px 2px 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.footer { font-style: italic; padding: 6px 2px 2px; }
table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 13px);
}
col.col-line { width: 44px; }
col.col-code { width: 300px; }
td {
  vertical-align: top;
  padding: 6px;
  border-bottom: 1px solid var(--vscode-panel-border, currentColor);
}
tr.row { cursor: pointer; }
tr.row:hover { background: var(--vscode-list-hoverBackground, transparent); }
.line-cell {
  text-align: right;
  white-space: nowrap;
  color: var(--vscode-descriptionForeground, #9d9d9d);
  border-left: 3px solid transparent;
  padding-left: 3px;
}
.code-cell {
  color: var(--vscode-descriptionForeground, #9d9d9d);
}
/* One line of a (possibly multi-line) statement's own source (#153): its
   own block, not the cell's whole text, so a too-wide line ellipsises on
   its own rather than the CODE cell doing it once across every line
   flattened together. white-space: pre, not nowrap, because indentation is
   exactly what makes a multi-line statement's body legible here, and
   nowrap collapses the very runs of leading spaces that carry it. */
.code-line {
  white-space: pre;
  overflow: hidden;
  text-overflow: ellipsis;
}
.code-line.code-more { font-style: italic; }
.value-cell { overflow-wrap: anywhere; }
tr.cursor {
  background: var(--vscode-list-inactiveSelectionBackground);
  outline: 2px solid var(--vscode-focusBorder, currentColor);
  outline-offset: -2px;
}
tr.cursor .line-cell {
  border-left-color: var(--vscode-focusBorder, currentColor);
  font-weight: bold;
}
.navigation-arrow { visibility: hidden; }
tr.cursor .navigation-arrow { visibility: visible; }
tr.latest-result .line-cell { border-left-color: ${cssVar('border')}; }
.latest-result-label {
  display: block;
  margin-top: 4px;
  font-family: var(--vscode-font-family, sans-serif);
  font-size: 0.85em;
  font-weight: 600;
  color: ${cssVar('border')};
}
tr.row:focus-visible {
  outline: 2px dashed var(--vscode-focusBorder, currentColor);
  outline-offset: -2px;
}
.navigation-control {
  display: block;
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 4px 0 8px;
  background: var(--vscode-panel-background, #1e1e1e);
}
.result-surface {
  padding: 3px 8px;
  border-left: 3px solid ${cssVar('border')};
  border-radius: 0;
  font-style: italic;
  background: ${cssVar('tint')};
}
.result-surface.tone-stale {
  background: ${cssVar('staleTint')};
  border-left-color: ${cssVar('staleBorder')};
}
.result-surface.tone-error { border-left-color: ${cssVar('error')}; }
.result-surface.tone-pending { border-left-color: ${cssVar('pending')}; }
/* Long traces share the panel background. Keep the statement frame and its
   status bar, reserving filled emphasis for the selected iteration. */
tr.loop-row.cursor, .loop-row .result-surface { background: transparent; }
.result-group { white-space: pre-wrap; }
.result-group.block {
  display: block;
  white-space: pre-wrap;
  max-width: 100%;
}
.result-group.block + .result-group,
.result-group + .result-group.block { margin-top: 4px; }
/* The internal rule shares the theme's statement-boundary colour, but is
   quieter and only spans the result's usable width. Source-row boundaries
   run across all three cells at full contrast; spacing reinforces that
   hierarchy without adding another frame around each result. */
.result-values + .result-streams::before {
  content: '';
  display: block;
  border-top: 1px solid var(--vscode-panel-border, currentColor);
  opacity: .6;
  margin: 5px 0;
}
.vscode-high-contrast td,
.vscode-high-contrast-light td {
  border-bottom-width: 2px;
}
.seg-value { color: ${cssVar('value')}; }
.seg-nameLabel { color: ${cssVar('nameLabel')}; }
.seg-streamLabel { color: ${cssVar('streamLabel')}; }
.error-text { color: ${cssVar('error')}; }
.pending-text { color: ${cssVar('pending')}; }
/* The stale reason (#116 review): dimmed italic prose in the UI font,
   after the chips with a margin -- never monospace value-coloured text
   inside the chip flow, which is what a plain inline span here used to be. */
.stale-reason {
  display: block;
  margin-top: 4px;
  font-family: var(--vscode-font-family, sans-serif);
  font-size: var(--vscode-font-size, 13px);
  font-style: italic;
  color: var(--vscode-descriptionForeground, #9d9d9d);
}
.stale-reason button {
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--vscode-textLink-foreground);
  font: inherit;
  cursor: pointer;
  text-decoration: underline;
}
.stale-reason button:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: 2px;
}
/* Folding a long block (#155): the footer names how much was left out and
   carries the two actions, in the UI font like the stale reason above --
   it is Evalens' own remark about the block, not part of what the program
   produced. */
.fold-footer {
  display: block;
  margin-top: 2px;
  font-family: var(--vscode-font-family, sans-serif);
  font-size: var(--vscode-font-size, 13px);
  font-style: italic;
  color: var(--vscode-descriptionForeground, #9d9d9d);
}
.fold-action, .fold-label {
  cursor: pointer;
  text-decoration: underline;
  text-decoration-style: dotted;
  text-underline-offset: 2px;
}
/* An expanded block's full text (#155): capped at roughly fourteen lines of
   the panel's own line-height and scrollable past that, so opening one very
   long block cannot push every other row on the panel out of view -- the
   same reason the CODE cell's own sourceLines caps it instead of growing
   it. */
.fold-scroll {
  display: block;
  max-height: 19.6em;
  overflow: auto;
  white-space: pre-wrap;
}
`;

/**
 * The messages this view ever posts to the extension, and what this script
 * does with one it receives, all handled without a rebuild wherever it can
 * be -- a rebuild is the one thing everything here is trying to avoid.
 *
 * Cursor navigation (#154) posts `{ goto, revision, explicit }` on a click,
 * Enter/Space, or an arrow/Home/End move that changes which row is current;
 * `mark` paints the highlight locally first so the row responds instantly,
 * and `activate` only posts when `followCursor` is on or the move was
 * explicit -- so panel-keyboard navigation is not a change worth telling
 * the extension about while cursor following is off, but a click or
 * Enter/Space always is. `matching` is the one place both a `{ cursor }`
 * message from the editor and an on-load `revealLine` resolve a target row:
 * an exact `data-goto` first, or the smallest range containing the line,
 * the same "innermost statement wins" rule `valuesHtml`'s own caller uses.
 *
 * Two scrolling paths exist, deliberately not shared (#169). `revealCentred`
 * is what every *navigation* uses -- the `{ cursor }` message and the
 * on-load `revealLine` -- and places the target with `placeScroll`
 * (exported above, embedded here by its own `.toString()` so there is one
 * copy of the arithmetic, not two that could drift apart): centred, or
 * top-aligned when the row is too tall to centre, `behavior: 'instant'`
 * because a navigation is a jump, never an animation. It also guards
 * against re-revealing the same row twice running -- `lastRevealedKey`
 * remembers the last target's own `data-goto`, so a cursor moving within
 * one statement, or the file simply being typed on, never yanks back a
 * reader who has since scrolled away on purpose; a *different* row's
 * navigation always reveals again. `revealEdge` is the pre-existing
 * nearest-edge `scrollBy`, kept only for keyboard browsing inside the panel
 * (arrow keys and Home/End moving the marked row) -- that is the reader
 * scrolling the list themselves, not a navigation to it, and #169 says
 * explicitly to leave it alone. A click never calls either: the row
 * clicked is already under the pointer.
 * The checkbox itself posts `{ followCursor, revision }` when toggled, and
 * a `{ followCursor }` message from the extension (a setting changed
 * elsewhere) updates it back without a rebuild.
 *
 * `{ expand: line }` (#155) is *Show all*, *Show less* and a click on a
 * foldable block's own label -- all three are the same toggle, so all three
 * post the same message and let `panel/values.ts` decide which way it
 * flips. `{ open: line, stream }` is *Open in editor*. Both are found by
 * the one `data-fold-action` attribute `html.ts` puts on every fold
 * control, rather than three separate listeners -- and both call
 * `stopPropagation`, or the click would also bubble up to the row's own
 * navigation handler and move the cursor to code the reader never asked to
 * leave.
 *
 * `revision` (#154) guards every message this script posts: `panel/
 * values.ts` increments it on each rebuild and echoes back only a message
 * carrying the revision it was rendered with, so a click queued against
 * HTML that has since been replaced is dropped rather than acted on against
 * rows that may no longer mean the same thing.
 *
 * `revealLine` (#149) is the one thing this script does on load rather than
 * in response to a message: `panel/values.ts` has already decided, before
 * this HTML was ever built, whether following is on and which line to
 * reveal, so there is nothing left to ask the extension here -- the same
 * "decided before the render, never re-asked afterwards" `valuesHtml` is
 * documented as being pure by, below. `null` means nothing to reveal --
 * following is off, or the change that triggered this rebuild carried no
 * line -- and the reveal step is then a no-op by construction, not by a
 * second flag threaded through.
 */
function script(
  revealLine: number | undefined, followCursor: boolean, revision: number
): string {
  const literal = revealLine === undefined ? 'null' : String(revealLine);
  return `
(function () {
  var vscode = acquireVsCodeApi();
  var followCursor = ${followCursor};
  var revision = ${revision};
  var saved = vscode.getState() || {};
  document.querySelectorAll('[data-loop-action]').forEach(function (button) {
    function rememberFocus() {
      var key = ['loopLine', 'loopAction', 'loopId', 'loopControl', 'loopToken'].map(function (name) {
        return button.dataset[name];
      }).join('/');
      vscode.setState({ loopFocus: key, scrollY: window.scrollY });
    }
    button.addEventListener('focus', rememberFocus);
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      rememberFocus();
      vscode.postMessage({ loop: Number(button.dataset.loopLine),
        action: button.dataset.loopAction, node: Number(button.dataset.loopId),
        value: Number(button.dataset.loopValue), revision: revision });
    });
    button.addEventListener('keydown', function (event) { event.stopPropagation(); });
  });
  window.addEventListener('blur', function () {
    setTimeout(function () { if (!document.hasFocus()) vscode.setState({}); }, 0);
  });
  var rows = Array.prototype.slice.call(document.querySelectorAll('tr.row'));
  var control = document.getElementById('follow-cursor');
  control.addEventListener('change', function () {
    followCursor = control.checked;
    vscode.postMessage({ followCursor: followCursor, revision: revision });
  });
  var foldControls = Array.prototype.slice.call(
    document.querySelectorAll('[data-fold-action]'));
  foldControls.forEach(function (foldControl) {
    foldControl.addEventListener('click', function (event) {
      event.stopPropagation();
      var line = Number(foldControl.getAttribute('data-fold-line'));
      if (foldControl.getAttribute('data-fold-action') === 'open') {
        vscode.postMessage({ open: line, stream: foldControl.getAttribute('data-fold-id') });
      } else {
        vscode.postMessage({ expand: line });
      }
    });
  });
  document.querySelectorAll('[data-stale-cause]').forEach(function (button) {
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      vscode.postMessage({ cause: Number(button.getAttribute('data-stale-cause')),
        revision: revision });
    });
    button.addEventListener('keydown', function (event) { event.stopPropagation(); });
  });
  function matching(line) {
    return rows.find(function (row) { return Number(row.dataset.goto) === line; })
      || rows.filter(function (row) {
      return line >= Number(row.getAttribute('data-start'))
        && line <= Number(row.getAttribute('data-end'));
    }).sort(function (a, b) {
      return (Number(a.dataset.end) - Number(a.dataset.start))
        - (Number(b.dataset.end) - Number(b.dataset.start));
    })[0];
  }
  ${placeScroll.toString()}
  // Keyboard browsing inside the panel (Up/Down/Home/End) keeps this
  // pre-#169 nearest-edge behaviour untouched: the reader is scrolling the
  // list themselves, not being navigated to a target.
  function revealEdge(row) {
    if (!row) return;
    var rect = row.getBoundingClientRect();
    var top = document.getElementById('navigation-control').getBoundingClientRect().bottom;
    var bottom = window.innerHeight;
    if ((rect.top >= top && rect.bottom <= bottom)
      || (rect.top <= top && rect.bottom >= bottom)) return;
    // Reveal only the nearest edge, allowing for the sticky setting. A tall
    // off-screen row starts at its beginning; one spanning the view stays put.
    var delta = rect.top < top || rect.bottom - rect.top > bottom - top
      ? rect.top - top : rect.bottom - bottom;
    window.scrollBy({ top: delta, behavior: 'instant' });
  }
  // Every *navigation* -- the editor's cursor message and the on-load
  // revealLine -- centres the target (#169), and never re-reveals the same
  // row a second time running.
  var lastRevealedKey = null;
  function revealCentred(row) {
    if (!row) return;
    var key = row.dataset.goto;
    if (key === lastRevealedKey) return;
    lastRevealedKey = key;
    var rect = row.getBoundingClientRect();
    var viewTop = document.getElementById('navigation-control').getBoundingClientRect().bottom;
    var viewBottom = window.innerHeight;
    var scrollY = window.pageYOffset || window.scrollY || 0;
    var maxScroll = Math.max(
      0, document.documentElement.scrollHeight - window.innerHeight);
    var target = placeScroll(
      rect.top, rect.bottom - rect.top, scrollY, viewTop, viewBottom, maxScroll);
    window.scrollTo({ top: target, behavior: 'instant' });
  }
  function mark(target) {
    rows.forEach(function (row) {
      var active = row === target;
      row.classList.toggle('cursor', active);
      row.setAttribute('aria-current', String(active));
      row.tabIndex = active ? 0 : -1;
    });
    if (!target && rows[0]) rows[0].tabIndex = 0;
  }
  function activate(row, explicit) {
    mark(row);
    if (followCursor || explicit) {
      vscode.postMessage({ goto: Number(row.dataset.goto), revision: revision,
        explicit: explicit });
    }
  }
  rows.forEach(function (row, index) {
    row.addEventListener('click', function () {
      row.focus({ preventScroll: true });
      activate(row, true);
    });
    row.addEventListener('keydown', function (event) {
      var target;
      if (event.key === 'ArrowDown') target = rows[Math.min(index + 1, rows.length - 1)];
      else if (event.key === 'ArrowUp') target = rows[Math.max(index - 1, 0)];
      else if (event.key === 'Home') target = rows[0];
      else if (event.key === 'End') target = rows[rows.length - 1];
      else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate(row, true);
        return;
      } else return;
      event.preventDefault();
      target.focus({ preventScroll: true });
      revealEdge(target);
      activate(target, false);
    });
  });
  if (!rows.some(function (row) { return row.tabIndex === 0; }) && rows[0]) {
    rows[0].tabIndex = 0;
  }
  window.addEventListener('message', function (event) {
    var message = event.data;
    if (!message) return;
    if (typeof message.followCursor === 'boolean') {
      followCursor = message.followCursor;
      control.checked = followCursor;
    }
    if (typeof message.cursor !== 'number') return;
    var target = matching(message.cursor);
    mark(target);
    if (message.reveal) revealCentred(target);
  });
  var revealLine = ${literal};
  if (revealLine !== null) revealCentred(matching(revealLine));
  if (saved.loopFocus) {
    var parts = saved.loopFocus.split('/');
    var target = Array.prototype.find.call(document.querySelectorAll('[data-loop-action]'), function (button) {
      return button.dataset.loopAction === parts[1] && button.dataset.loopId === parts[2]
        && button.dataset.loopToken === parts[4] && button.dataset.loopControl === parts[3];
    });
    if (target && target.disabled) {
      target = Array.prototype.find.call(document.querySelectorAll('[data-loop-action]'), function (button) {
        return !button.disabled && button.dataset.loopAction === parts[1]
          && button.dataset.loopId === parts[2] && button.dataset.loopToken === parts[4];
      });
    }
    if (target) {
      target.focus({ preventScroll: true });
      if (revealLine === null) window.scrollTo(0, saved.scrollY || 0);
    } else vscode.setState({});
  }
}());
`;
}

/**
 * The panel's whole HTML document, for `data` as it stands right now.
 *
 * A pure function of its arguments: no clock, no random beyond the
 * caller-supplied `nonce`, so the same inputs always produce the same
 * markup and a test never has to launch a webview to check one. CSP is
 * `default-src 'none'` plus the one nonce for both the style block and the
 * script -- every colour rides a CSS custom property or a class already in
 * that block, so nothing here ever needs an inline `style="…"` attribute,
 * which a nonce does not cover.
 *
 * `revealLine` (#149) is the line the on-load script scrolls into view, or
 * `undefined` for none -- `panel/values.ts` is the only caller that ever
 * decides this, from `Annotations.onDidChange`'s own payload and the
 * `evalens.valuesPanel.follow` setting, or the current cursor on opening
 * the panel with cursor following enabled. This function only ever bakes
 * whatever it is handed into the page, the same way it already does for
 * `cursorLine`.
 *
 * `fold` (#155) carries the fold behaviour the same way: `outputLines`
 * from `evalens.valuesPanel.outputLines`, `expandedLines` from whichever
 * rows `panel/values.ts` is still keeping open across rebuilds. Omitted
 * entirely, a caller gets the setting's own default and nothing expanded
 * -- see `FoldState`.
 */
export function valuesHtml(
  data: ValuesPanelData, cursorLine: number | undefined, nonce: string,
  revealLine?: number, fold?: FoldState, followCursor = true, revision = 0
): string {
  const foldOptions: FoldRenderOptions = {
    loopStates: fold?.loopStates,
    outputLines: fold?.outputLines ?? DEFAULT_OUTPUT_LINES,
    expandedLines: fold?.expandedLines ?? NO_EXPANDED_LINES,
  };
  const body = data.fileName === undefined
    ? emptyStateHtml(NO_EDITOR_MESSAGE)
    : data.rows.length === 0
      ? emptyStateHtml(NO_ANNOTATIONS_MESSAGE)
      : tableHtml(data.fileName, data.rows, cursorLine, foldOptions, data.latestResultLine);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; `
    + `style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Evalens Values</title>
<style nonce="${nonce}">${STYLE}${LOOP_EXPLORER_STYLE}</style>
</head>
<body>
<label id="navigation-control" class="navigation-control">
<input id="follow-cursor" type="checkbox" ${followCursor ? 'checked' : ''}> Follow cursor between code and values</label>
${body}
<script nonce="${nonce}">${script(revealLine, followCursor, revision)}</script>
</body>
</html>`;
}
