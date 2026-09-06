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
import {
  Printed, STDERR_LABEL, Segment, SegmentRole, collapseLines, grouped,
  isStreamGroup, resultGroups,
} from '../render/format';
import {
  Marker, markerFor, normalizeSource, staleReasonText,
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
  readonly range: {
    readonly start: { readonly line: number };
    readonly end: { readonly line: number };
  };
  readonly anchor?: number;
  readonly staleReason?: 'edited' | 'dependency';
}

/** Which of the panel's four row states one row is in -- `Marker`'s three,
 * plus `'pending'` for a statement that has not finished. */
export type RowState = Marker | 'pending';

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
  /** Chip groups exactly as `resultGroups` builds them, at full length --
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
  const staleReason = state === 'stale' ? { staleReason: annotation.staleReason } : {};

  if (annotation.error !== undefined) {
    const summary = collapseLines(annotation.error.message);
    return {
      ...base,
      state,
      ...staleReason,
      errorText: summary
        ? `${annotation.error.type}: ${summary}` : annotation.error.type,
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

  return {
    ...base,
    state,
    ...staleReason,
    ...(groups.length > 0 ? { groups } : {}),
    ...(streams.length > 0 ? { streams } : {}),
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
  border: { id: 'evalens.annotationBorder', fallback: '#e0a3ff' },
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
  + 'the line. Nothing here is re-evaluated.';

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

/**
 * One chip -- `inline` beside the others on the row, or `block`, under them
 * on a line of its own, for printed output (#116 review).
 *
 * `leading` puts a `.bar` element immediately before the chip rather than a
 * border on the chip itself: a border is part of the box
 * `box-decoration-break: clone` clones onto every fragment a wrapped inline
 * element paints, so the old single-element chip repeated its bar on every
 * wrapped line. A `.bar` is its own small element with nothing to wrap, so
 * it can only ever appear once, beside the chip's own first line, exactly
 * where "the accent bar on the first chip of the row" belongs.
 */
function chip(
  innerHtml: string, tone: Tone, leading: boolean, variant: 'inline' | 'block' = 'inline'
): string {
  const bar = leading ? `<span class="bar tone-${tone}"></span>` : '';
  const classes = ['chip', `tone-${tone}`, ...(variant === 'block' ? ['block'] : [])];
  return `${bar}<span class="${classes.join(' ')}">${innerHtml}</span>`;
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
// Line count, never visual width. Whether a line wraps in the panel's own
// column depends on a font and a container width this module has no way to
// ask about without a browser, and asserting a count it cannot know is
// exactly what design rule 1 rules out -- so the fold, and the exact count in
// its footer, are always decided by splitting on `\n`, the one measure this
// module can state truthfully with no DOM at all.

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
  line: number, blockId: string, remaining: number | undefined
): string {
  const action = (label: string, kind: 'expand' | 'open'): string =>
    `<span class="fold-action" data-fold-action="${kind}" `
    + `data-fold-line="${line}" data-fold-id="${escapeHtml(blockId)}">${label}</span>`;
  if (remaining === undefined) {
    return `<div class="fold-footer">${action('Show less', 'expand')}</div>`;
  }
  const more = `… ${grouped(remaining)} more line${remaining === 1 ? '' : 's'}`;
  return `<div class="fold-footer">${escapeHtml(more)} · `
    + `${action('Show all', 'expand')} · ${action('Open in editor', 'open')}</div>`;
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
  const lines = text.split('\n');
  if (lines.length <= outputLines) {
    return {
      foldable: false,
      html: `<span class="seg-value">${escapeHtml(text)}</span>`,
    };
  }
  if (!expanded) {
    const shown = lines.slice(0, outputLines).join('\n');
    const remaining = lines.length - outputLines;
    return {
      foldable: true,
      html: `<span class="seg-value">${escapeHtml(shown)}</span>`
        + foldFooterHtml(line, blockId, remaining),
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
 * full text after it, as one `block` chip under the line's value chips
 * (#116 review) -- `white-space: pre-wrap` on the chip itself keeps every
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
function streamChipHtml(
  stream: FullStream, tone: Tone, leading: boolean, line: number,
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
  return chip(labelHtml + fold.html, tone, leading, 'block');
}

/**
 * One `resultGroups` group, as a `block` chip if its own value segment runs
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
  group: readonly Segment[], tone: Tone, leading: boolean, line: number,
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
  return chip(before + fold.html, tone, leading, 'block');
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
function staleReasonHtml(reason: 'edited' | 'dependency'): string {
  const clause = staleReasonText(reason);
  const sentence = `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`;
  return `<div class="stale-reason">${escapeHtml(sentence)}</div>`;
}

/** The VALUE column's whole content for one row, folding any block --
 * stream or value group -- past `outputLines` lines (#155), open exactly
 * where `expandedLines` names this row's own line. */
function valueCellHtml(
  row: ValuesRow, outputLines: number, expandedLines: ReadonlySet<number>
): string {
  if (row.state === 'pending') {
    return chip(
      `<span class="pending-text">${escapeHtml(row.pendingText ?? '')}</span>`,
      'pending', true);
  }

  if (row.errorText !== undefined) {
    // Stale outranks error here exactly as `markerFor` says it does
    // everywhere else: a failed statement that has since been edited is not
    // reporting the current code's failure, so the surface recedes to grey
    // while the message -- still in the error colour -- says what it was.
    const tone: Tone = row.state === 'stale' ? 'stale' : 'error';
    const errorChip = chip(
      `<span class="error-text">${escapeHtml(row.errorText)}</span>`, tone, true);
    return row.state === 'stale' && row.staleReason !== undefined
      ? errorChip + staleReasonHtml(row.staleReason)
      : errorChip;
  }

  // Inline value chips share one line, space-separated; a stream is its own
  // block underneath, so the two are built into separate lists rather than
  // one -- joining them the same way would put a stream chip on the value
  // chips' own line. A value group long enough to fold joins the streams in
  // the block list instead (#155): once it needs a footer of its own it can
  // no longer share a line with anything else. `leading` still tracks across
  // all three: whichever chip is built first overall -- ordinarily a value
  // chip, but a bare `print()` with no name to report has only a stream chip
  // -- carries the bar, and the fold state is one flag per row (`expanded`)
  // rather than one per block: `Show all` on any block in a row opens every
  // foldable block in it, matching the one `{ expand: line }` message the
  // webview ever posts.
  const tone: Tone = row.state === 'stale' ? 'stale' : 'evaluated';
  const expanded = expandedLines.has(row.line);
  let leadingTaken = false;
  const takeLeading = (): boolean => {
    const first = !leadingTaken;
    leadingTaken = true;
    return first;
  };
  const inlineChips: string[] = [];
  const blockChips: string[] = [];
  (row.groups ?? []).forEach((group, index) => {
    const leading = takeLeading();
    const folded = foldableGroupHtml(
      group, tone, leading, row.line, `value-${index}`, outputLines, expanded);
    if (folded === undefined) {
      inlineChips.push(chip(groupHtml(group), tone, leading));
    } else {
      blockChips.push(folded);
    }
  });
  for (const stream of row.streams ?? []) {
    blockChips.push(streamChipHtml(
      stream, tone, takeLeading(), row.line, outputLines, expanded));
  }
  // A statement with nothing to show at all -- an `if`, a `del` -- paints no
  // chip, the same as the inline annotation does.
  const value = inlineChips.join(' ') + blockChips.join('');
  return row.state === 'stale' && row.staleReason !== undefined
    ? value + staleReasonHtml(row.staleReason)
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
  readonly outputLines: number;
  readonly expandedLines: ReadonlySet<number>;
}

/** One `<tr>`, carrying the line data the embedded script needs to move the
 * cursor highlight and to jump to a click without a rebuild. */
function rowHtml(
  row: ValuesRow, cursorLine: number | undefined, fold: FoldRenderOptions
): string {
  const isCursor = cursorLine !== undefined
    && cursorLine >= row.startLine && cursorLine <= row.endLine;
  const cursorClass = isCursor ? ' cursor' : '';
  return `<tr class="row${cursorClass}" data-goto="${row.line}" `
    + `data-start="${row.startLine}" data-end="${row.endLine}">`
    + `<td class="line-cell"><span class="line-num">${row.line + 1}</span></td>`
    + `<td class="code-cell">${codeCellHtml(row)}</td>`
    + `<td class="value-cell">`
    + `${valueCellHtml(row, fold.outputLines, fold.expandedLines)}</td>`
    + `</tr>`;
}

function emptyStateHtml(message: string): string {
  return `<p class="empty">${escapeHtml(message)}</p>`;
}

function tableHtml(
  fileName: string, rows: readonly ValuesRow[], cursorLine: number | undefined,
  fold: FoldRenderOptions
): string {
  const summary =
    `<div class="summary">${escapeHtml(summaryLine(fileName, rows))}</div>`;
  const body = rows.map((row) => rowHtml(row, cursorLine, fold)).join('\n');
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
  padding: 2px 6px;
  border-bottom: 1px solid var(--vscode-panel-border, transparent);
}
tr.row { cursor: pointer; }
tr.row:hover { background: var(--vscode-list-hoverBackground, transparent); }
.line-cell {
  text-align: right;
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
  background: color-mix(in srgb, ${cssVar('border')} 15%, transparent);
}
tr.cursor .line-cell {
  border-left-color: ${cssVar('border')};
  color: ${cssVar('border')};
}
.chip {
  display: inline;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
  padding: 0 6px;
  border-radius: 3px;
  font-style: italic;
  background: ${cssVar('tint')};
}
.chip.tone-stale { background: ${cssVar('staleTint')}; }
/* Printed output (#116 review): a block of its own under the line's value
   chips, not one more inline chip beside them -- so it never shares a line
   with them and never needs box-decoration-break to keep its own shape. */
.chip.block {
  display: block;
  white-space: pre-wrap;
  width: fit-content;
  max-width: 100%;
  margin-top: 4px;
}
/* The accent bar (#116 review): its own element immediately before the
   leading chip, not a border on the chip itself -- a border is part of the
   box that box-decoration-break: clone clones onto every wrapped line, and
   the bar belongs on the first line only. Sized to one line of text and
   placed inline, so it appears once, beside the chip's own first line, and
   never reappears when that chip wraps. */
.bar {
  display: inline-block;
  width: 3px;
  height: 1.3em;
  vertical-align: middle;
  border-radius: 1px;
  background: ${cssVar('border')};
}
.bar.tone-stale { background: ${cssVar('staleBorder')}; }
.bar.tone-error { background: ${cssVar('error')}; }
.bar.tone-pending { background: ${cssVar('pending')}; }
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
 * The messages this view ever posts to the extension, handled entirely on
 * this side without a rebuild: `{ cursor }` moves the highlighted row,
 * `{ goto }` (a click on a row) is sent up for `panel/values.ts` to act on.
 * The `cursor` handler only ever toggles a class -- it must never scroll
 * (#149): moving the cursor is not a change, and the row it lands on may
 * already be off screen on purpose, because the reader scrolled there
 * themselves.
 *
 * `{ expand: line }` (#155) is *Show all*, *Show less* and a click on a
 * foldable block's own label -- all three are the same toggle, so all three
 * post the same message and let `panel/values.ts` decide which way it
 * flips. `{ open: line, stream }` is *Open in editor*. Both are found by
 * the one `data-fold-action` attribute `html.ts` puts on every fold
 * control, rather than three separate listeners -- and both call
 * `stopPropagation`, or the click would also bubble up to the row's own
 * `goto` handler and jump the cursor to code the reader never asked to
 * leave.
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
function script(revealLine: number | undefined): string {
  const literal = revealLine === undefined ? 'null' : String(revealLine);
  return `
(function () {
  var vscode = acquireVsCodeApi();
  var rows = Array.prototype.slice.call(document.querySelectorAll('tr.row'));
  rows.forEach(function (row) {
    row.addEventListener('click', function () {
      vscode.postMessage({ goto: Number(row.getAttribute('data-goto')) });
    });
  });
  var foldControls = Array.prototype.slice.call(
    document.querySelectorAll('[data-fold-action]'));
  foldControls.forEach(function (control) {
    control.addEventListener('click', function (event) {
      event.stopPropagation();
      var line = Number(control.getAttribute('data-fold-line'));
      if (control.getAttribute('data-fold-action') === 'open') {
        vscode.postMessage({ open: line, stream: control.getAttribute('data-fold-id') });
      } else {
        vscode.postMessage({ expand: line });
      }
    });
  });
  window.addEventListener('message', function (event) {
    var message = event.data;
    if (!message || typeof message.cursor !== 'number') {
      return;
    }
    var line = message.cursor;
    rows.forEach(function (row) {
      var start = Number(row.getAttribute('data-start'));
      var end = Number(row.getAttribute('data-end'));
      row.classList.toggle('cursor', line >= start && line <= end);
    });
  });
  var revealLine = ${literal};
  if (revealLine !== null) {
    var target = rows.filter(function (row) {
      var start = Number(row.getAttribute('data-start'));
      var end = Number(row.getAttribute('data-end'));
      return revealLine >= start && revealLine <= end;
    })[0];
    if (target) {
      target.scrollIntoView({ block: 'nearest' });
    }
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
 * `evalens.valuesPanel.follow` setting; this function only ever bakes
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
  revealLine?: number, fold?: FoldState
): string {
  const foldOptions: FoldRenderOptions = {
    outputLines: fold?.outputLines ?? DEFAULT_OUTPUT_LINES,
    expandedLines: fold?.expandedLines ?? NO_EXPANDED_LINES,
  };
  const body = data.fileName === undefined
    ? emptyStateHtml(NO_EDITOR_MESSAGE)
    : data.rows.length === 0
      ? emptyStateHtml(NO_ANNOTATIONS_MESSAGE)
      : tableHtml(data.fileName, data.rows, cursorLine, foldOptions);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; `
    + `style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Evalens Values</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
${body}
<script nonce="${nonce}">${script(revealLine)}</script>
</body>
</html>`;
}
