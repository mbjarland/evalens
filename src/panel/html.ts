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
  isStreamGroup, paintedSlots, resultGroups,
} from '../render/format';
import {
  Marker, markerFor, normalizeSource, staleReasonText, DependencyCause,
} from '../render/registry';
import { pendingText } from '../render/status';
import {
  LearningHelpState, LEARNING_SCRIPT, LEARNING_STYLE, learningEmptyHtml,
  learningHelpHtml, learningToggleHtml,
} from './learningHelp';
import { ResultFoldState } from './resultFold';
import { KEYBOARD_SCRIPT } from './keyboard';

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
  readonly source?: string;
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
  /** Original captured stream, including its final newline. */
  readonly recordedText?: string;
}

/** One row of the panel's table, already resolved from an annotation and a
 * line of source -- everything `valuesHtml` needs and nothing it has to ask
 * `vscode` for. */
export interface ValuesRow {
  readonly partialFrom?: number;
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
  /** Bounded preview of the source captured with this result, never the edited buffer. */
  readonly recordedSource?: string;
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
    streams.push({ label: printedLabel, text: fullStreamText(printed!.stdout!), recordedText: printed!.stdout! });
  }
  if (nonEmpty(printed?.stderr)) {
    streams.push({ label: STDERR_LABEL, text: fullStreamText(printed!.stderr!), recordedText: printed!.stderr! });
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
    ...(annotation.source === undefined ? {} : { recordedSource:
      annotation.source.length > 2000
        ? annotation.source.slice(0, 1999).replace(/[\uD800-\uDBFF]$/, '') + '\n…'
        : annotation.source }),
    ...(annotation.partialFrom === undefined ? {} : { partialFrom: annotation.partialFrom }),
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
  // The inline formatter collapses repr whitespace and substitutes NBSPs.
  // Recover raw captured representations by the same slot order; never try
  // to reverse those lossy substitutions in the recording or ask Python.
  const slots = paintedSlots(annotation.value ?? null, annotation.display,
    annotation.loop, annotation.names, annotation.bindings, annotation.printed,
    annotation.isBinding);
  let slotIndex = 0;
  const recordedGroups = groups.map(group => {
    if (!group.some(segment => segment.role === 'value')) return group;
    const slot = slots[slotIndex++]!;
    const history = slot.iterations !== undefined
      || (annotation.bindings ?? []).some(binding => binding.name === slot.name)
      || (slot.own && annotation.loop);
    const raw = history ? slot.value : slot.own ? annotation.value
      : annotation.names?.find(name => name.name === slot.name)?.value;
    return group.map(segment => segment.role === 'value' && raw != null
      ? { ...segment, text: raw } : segment);
  });
  const streams = streamsFor(annotation.printed, printedLabel);
  const loopExplorer = prepareLoopExplorer(annotation.loopExplorer,
    annotation.printed?.stdout, annotation.printed?.stderr);

  return {
    ...base,
    state,
    ...staleReason,
    ...(recordedGroups.length > 0 ? { groups: recordedGroups } : {}),
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
  readonly sourceUri?: string;
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
  readonly resultFolds?: ReadonlyMap<number, ResultFoldState>;
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

const FOOTER_TEXT =
  'Values are what each line produced when it ran. Click a row to jump to '
  + 'the line. Use Up/Down or Home/End to browse, Enter or Space to reveal '
  + 'source. Use Focus Active Editor Group to return to editing. Nothing here is re-evaluated.';

function pluralize(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** `basics.py · 8 recorded results · 1 stale · 1 error` -- zero counts
 * say nothing, the way `format.ts`'s own `…+N more` only appears at all
 * when there is one. Before #181 this also appended `· inline values
 * hidden` while `evalens.inlineValues` was `whenPanelHidden` and this very
 * panel was what was hiding them; the "Hide inline values while this panel
 * is visible" checkbox right above the table now says the same thing with
 * its own checked state, so the note was dropped rather than said twice. */
function summaryLine(fileName: string, rows: readonly ValuesRow[]): string {
  const stale = rows.filter((row) => row.state === 'stale').length;
  const error = rows.filter((row) => row.state === 'error').length;
  const pending = rows.filter((row) => row.state === 'pending').length;
  const parts = [pluralize(rows.length - pending, 'recorded result')];
  if (pending > 0) parts.push(`${pending} running`);
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
  const tag = extra ? 'button' : 'span';
  return `<${tag}${extra ? ' type="button"' : ''} class="${className}"${attrs}>${escapeHtml(segment.text)}</${tag}>`;
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

function openRecordingLabel(blockId: string): string {
  return blockId.startsWith('value-') ? 'Open recorded value'
    : blockId === STDERR_LABEL ? 'Open statement stderr output'
      : 'Open statement printed output';
}
const OPEN_RECORDING_HINT = 'Opens the available recording in a read-only editor. '
  + 'Use native Find and copy; text that was not captured cannot be recovered.';

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
    `<button type="button" class="fold-action" data-fold-action="${kind}" `
    + `data-fold-line="${line}" data-fold-id="${escapeHtml(blockId)}"${kind === 'open' ? ` title="${OPEN_RECORDING_HINT}"` : ''}>${label}</button>`;
  if (remaining === undefined) {
    return `<div class="fold-footer">${action('Show less', 'expand')}</div>`;
  }
  const more = `… ${grouped(remaining)} more line${remaining === 1 ? '' : 's'}`;
  return `<div class="fold-footer">${escapeHtml(more)} · `
    + `${action(fullyExpandable ? 'Show all' : 'Show more', 'expand')} · ${action(openRecordingLabel(blockId), 'open')}</div>`;
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
        `<button type="button" class="fold-action" data-fold-action="${kind}" data-fold-line="${line}" `
        + `data-fold-id="${escapeHtml(blockId)}"${kind === 'open' ? ` title="${OPEN_RECORDING_HINT}"` : ''}>${label}</button>`;
      const footer = `<div class="fold-footer">… ${grouped(text.length - end)} more characters · `
        + action(expanded ? 'Show less' : (text.length > 16000 ? 'Show more' : 'Show all'), 'expand')
        + ` · ${action(openRecordingLabel(blockId), 'open')}</div>`;
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
function foldLabelAttrs(line: number, blockId: string, expanded: boolean): string {
  return `data-fold-action="expand" data-fold-line="${line}" `
    + `data-fold-id="${escapeHtml(blockId)}" aria-expanded="${expanded}" `
    + `aria-label="${expanded ? 'Show less' : 'Show more'} of ${escapeHtml(blockId.startsWith('value-') ? 'recorded value' : blockId + ' output')} for line ${line + 1}"`;
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
      ? { className: 'fold-label', attrs: foldLabelAttrs(line, blockId, expanded) }
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
      ? { className: 'fold-label', attrs: foldLabelAttrs(line, blockId, expanded) }
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
    return stream.recordedText ?? stream.text;
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
    ? ` <button type="button" data-stale-cause="${row.staleCause.id}" `
      + 'title="Reveal the statement that rebound these names. Their values may be unchanged.">'
      + 'Go to variable change</button>' : '';
  return `<div class="stale-reason">${escapeHtml(sentence)}${link}</div>`;
}

/** The VALUE column's whole content for one row, folding any block --
 * stream or value group -- past `outputLines` lines (#155), open exactly
 * where `expandedLines` names this row's own line. */
function valueDetailHtml(
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
      row.line, loopStates?.get(row.loopExplorer.wire), outputLines,
      [row.state === 'stale' ? 'Stale recorded result' : '',
        row.partialFrom !== undefined ? `Partial run: source incomplete from line ${row.partialFrom + 1}` : '']
        .filter(Boolean).join(' · ')), tone);
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

/** Concise facts for the closed disclosure. Metadata omissions and missing
 * output are different facts: the former cannot turn a captured-output line
 * count into a claim that all iteration readings were retained. */
export function resultFoldSummary(row: ValuesRow): { text: string; status: string } {
  const parts: string[] = [];
  const status: string[] = [];
  const number = (n: number) => n.toLocaleString('en-US');
  const count = (n: number, noun: string) => `${number(n)} ${noun}${n === 1 ? '' : 's'}`;
  const lineCount = (text: string) => text === '' ? 0
    : (text.match(/\n/g)?.length ?? 0) + (text.endsWith('\n') ? 0 : 1);
  if (row.state === 'stale') status.push('Stale');
  if (row.errorText) status.push('Error');
  if (row.partialFrom !== undefined) status.push('Partial run');
  if (row.loopExplorer) {
    const model = row.loopExplorer;
    const firstRoot = model.roots[0];
    if (firstRoot) parts.push(model.sites.get(firstRoot.site)!.source);
    parts.push(count(model.roots.reduce((n, root) => n + root.count, 0), 'iteration'));
    if (model.wire.omitted_iterations || model.wire.omitted_invocations) status.push('Limited detail');
    const clipped = model.wire.totals.some((n, i) => n > model.wire.retained[i]!);
    if (clipped) status.push('Output truncated');
    for (const stream of [0, 1] as const) {
      if (!model.wire.totals[stream]) continue;
      const label = stream === 0 ? 'printed' : 'stderr';
      parts.push(model.wire.totals[stream] > model.wire.retained[stream]
        ? `captured ${label} output`
        : count(lineCount(model.streams[stream]), `${label} line`));
    }
    if (!model.wire.totals.some((n) => n > 0)) parts.push('No output');
  } else {
    if (row.errorText) parts.push(row.errorText);
    else if (row.groups?.length) parts.push(count(row.groups.length, 'value'));
    for (const stream of row.streams ?? []) {
      const clipped = /\n… <[\d,]+ characters omitted from trace>$/.test(stream.text);
      if (clipped && !status.includes('Output truncated')) status.push('Output truncated');
      const label = stream.label === STDERR_LABEL ? 'stderr' : 'printed';
      parts.push(clipped ? `captured ${label} output`
        // FullStream already removed print's final newline. A remaining
        // trailing newline is an intentional blank line, not another
        // terminator to strip (unlike the raw explorer streams above).
        : count((stream.text.match(/\n/g)?.length ?? 0) + 1, `${label} line`));
    }
    if (row.groups?.some((group) => group.some((segment) =>
      /… <truncated from \d+ chars>$/.test(segment.text)))) status.push('Value truncated');
  }
  return { text: parts.join(' · ') || 'Values', status: status.join(' · ') };
}

/** The same mounted control serves both states, positioned beside the first
 * value heading. Only the body is hidden: no duplicate heading or focusable
 * hidden copy of the disclosure. Ordinary short results have no visible
 * control; the webview measures actual overflow after fonts and wrapping. */
function valueCellHtml(
  row: ValuesRow, fold: FoldRenderOptions
): string {
  const detail = valueDetailHtml(row, fold.outputLines, fold.expandedLines, fold.loopStates);
  if (!detail || row.state === 'pending') return detail;
  const state = fold.resultFolds?.get(row.line);
  const collapsed = state?.collapsed ?? false;
  const summary = resultFoldSummary(row);
  const description = [summary.status, summary.text].filter(Boolean).join(' · ');
  const title = `${description}${row.state === 'stale' ? '. '
    + staleReasonText(row.staleReason, row.staleCause) : ''}`;
  const tone: Tone = row.state === 'stale' ? 'stale' : row.errorText ? 'error' : 'evaluated';
  return `<div class="whole-result${collapsed ? ' result-collapsed' : ''}" `
    + `data-result-line="${row.line}" data-result-token="${state?.identity ?? row.line}">`
    + `<button type="button" class="result-disclosure" hidden `
    + `aria-expanded="${!collapsed}" aria-controls="result-detail-${row.line}" `
    + `aria-label="${collapsed ? 'Show' : 'Collapse'} values for line ${row.line + 1}; ${escapeHtml(description)}" `
    + `data-result-description="${escapeHtml(description)}" `
    + `aria-description="${escapeHtml(title)}. Recorded during evaluation; not live state." `
    + `title="${collapsed ? 'Show' : 'Collapse'} values">`
    + `<span aria-hidden="true">${collapsed ? '▸' : '▾'}</span></button>`
    + `<div class="result-summary result-surface tone-${tone}"${collapsed ? '' : ' hidden'} `
    + `title="${escapeHtml(title)}"><div class="result-summary-line">`
    + (summary.status ? `<span class="result-summary-status${row.errorText ? ' error-text' : ''}">${escapeHtml(summary.status)}</span>` : '')
    + `<span class="result-summary-text">${escapeHtml(summary.text)}</span></div></div>`
    + `<div class="result-detail" id="result-detail-${row.line}"${collapsed ? ' hidden' : ''}>${detail}</div></div>`;
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
  readonly resultFolds?: ReadonlyMap<number, ResultFoldState>;
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
    + `tabindex="${isCursor ? 0 : -1}" aria-current="${isCursor}" `
    + `aria-label="Line ${row.line + 1}${isCursor ? '; matches the editor cursor' : ''}${isLatest ? '; latest recorded result' : ''}" `
    + `aria-description="Enter or Space reveals this source line. Arrow keys browse results.">`
    + `<td class="line-cell"><span class="navigation-arrow" aria-hidden="true" title="Matches the editor cursor">→</span>`
    + `<span class="line-num">${row.line + 1}</span></td>`
    + `<td class="code-cell"><div class="source-content">${codeCellHtml(row)}${latestLabel}</div></td>`
    + `<td class="value-cell">`
    + `${valueCellHtml(row, fold)}</td>`
    + `</tr>`;
}

function tableHtml(
  fileName: string, rows: readonly ValuesRow[], cursorLine: number | undefined,
  fold: FoldRenderOptions, latestResultLine?: number
): string {
  const summary = `<div class="summary">`
    + `${escapeHtml(summaryLine(fileName, rows))}</div>`;
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
/* Reserve the widest displayed line number plus an arrow, its gap, and
   cell padding in the code font's metrics. The accent border stays 3px. */
col.col-line { width: calc(var(--line-number-width) + 2.5ch + 3px); }
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
  padding-left: 0.5ch;
  padding-right: 0.5ch;
}
.line-num {
  display: inline-block;
  min-width: var(--line-number-width);
  font-variant-numeric: tabular-nums;
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
.navigation-arrow {
  display: inline-block;
  width: 1ch;
  margin-right: 0.5ch;
  text-align: center;
  visibility: hidden;
}
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
  display: flex;
  flex-wrap: wrap;
  column-gap: 16px;
  row-gap: 2px;
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 4px 0 8px;
  background: var(--vscode-panel-background, #1e1e1e);
}
.navigation-control label {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  max-width: 100%;
}
.navigation-control input { flex: none; }
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
.whole-result { position: relative; }
.result-disclosure {
  position: absolute;
  top: 3px;
  left: calc(3px + .4em);
  z-index: 1;
  border: 0;
  padding: 0;
  width: 1em;
  background: transparent;
  color: var(--vscode-textLink-foreground, currentColor);
  font: inherit;
  font-style: normal;
  line-height: inherit;
  cursor: pointer;
}
.loop-row .result-disclosure { top: calc(3px + .15em); }
.result-disclosure:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, currentColor);
  outline-offset: 1px;
}
.result-foldable .result-detail > .result-surface { padding-left: calc(8px + 1.5em); }
.result-summary {
  height: var(--source-height);
  max-height: var(--source-height);
  padding: 0 8px 0 calc(8px + 1.5em);
  overflow: hidden;
  font-style: normal;
}
.result-summary-line { display: flex; gap: .6em; white-space: nowrap; }
.result-summary-status { flex: 0 0 auto; font-weight: 600; }
.result-summary-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.result-collapsed .result-disclosure { top: 0; }
.result-disclosure[hidden], .result-summary[hidden],
.result-detail[hidden] { display: none; }
/* Measure the existing bounded detail at its real available width, without
   letting it enlarge a closed row or creating an extra copy of the output. */
.result-measuring .result-detail {
  display: block;
  position: absolute;
  width: 100%;
  top: 0;
  visibility: hidden;
}
.result-measuring .result-detail > .result-surface { padding-left: 8px; }
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
  border: 0; padding: 0; background: transparent; font: inherit;
  cursor: pointer;
  text-decoration: underline;
  text-decoration-style: dotted;
  text-underline-offset: 2px;
}
.fold-action { color: inherit; }
.fold-action:focus-visible, .fold-label:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, currentColor); outline-offset: 2px;
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
/* Keep the source/result pair together when there is no useful room for
   the ordinary 300px source column. The source gutter retains its font
   metrics; results use the whole width below it rather than disappearing
   into the fixed table's remainder. Navigation still targets this row. */
@media (max-width: 720px) {
  table, tbody { display: block; }
  colgroup { display: none; }
  tr.row {
    display: grid;
    grid-template-columns: calc(var(--line-number-width) + 2.5ch + 3px) minmax(0, 1fr);
    border-bottom: 1px solid var(--vscode-panel-border, currentColor);
  }
  td { display: block; min-width: 0; border-bottom: 0; }
  .value-cell { grid-column: 1 / -1; padding-top: 0; }
  .vscode-high-contrast tr.row,
  .vscode-high-contrast-light tr.row { border-bottom-width: 2px; }
  .vscode-high-contrast td,
  .vscode-high-contrast-light td { border-bottom-width: 0; }
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
 * The `#navigation-control` row holds three checkboxes (#181), each
 * round-tripping the same way: a change posts `{ <name>, revision }`, and a
 * `{ <name> }` message from the extension (a setting changed from the
 * palette, the Settings UI, or `settings.json`) updates the checkbox back
 * without a rebuild. `follow-cursor` posts `followCursor`
 * (`evalens.valuesPanel.followCursor`); `follow-panel` posts `followPanel`
 * (`evalens.valuesPanel.follow`, #149's follow-newest-value lock, formerly a
 * title-bar icon); `hide-inline-values` posts `hideInlineValues`
 * (`evalens.inlineValues`, #178's eye, also formerly a title-bar icon) --
 * VS Code gives an extension-contributed title-bar item no toggled
 * appearance, so both moved into the panel as checkboxes, which already
 * carry their own state legibly.
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
  revealLine: number | undefined, followCursor: boolean, revision: number,
  followPanel: boolean, hideInlineValues: boolean
): string {
  const literal = revealLine === undefined ? 'null' : String(revealLine);
  return `
(function () {
  var vscode = acquireVsCodeApi();
  var followCursor = ${followCursor};
  var followPanel = ${followPanel};
  var hideInlineValues = ${hideInlineValues};
  var revision = ${revision};
  ${LEARNING_SCRIPT}
  // Local evidence disclosures are native controls: reading them never
  // navigates source or posts an evaluation/provider message.
  document.querySelectorAll('[data-local-disclosure]').forEach(function (details) {
    details.addEventListener('click', function (event) {
      event.stopPropagation();
      if (!details.classList.contains('loop-recording-details')
        || !event.target.closest('summary')) return;
      var summary = details.querySelector('summary');
      var before = summary.getBoundingClientRect().top;
      // Opening help restores ordinary document scrolling. Keep the control
      // at the point the reader chose when its sticky offset is removed.
      requestAnimationFrame(function () {
        measureLoopContexts();
        window.scrollBy({ top: summary.getBoundingClientRect().top - before,
          behavior: 'instant' });
      });
    });
    details.addEventListener('keydown', function (event) { event.stopPropagation(); });
  });
  var navigationControl = document.getElementById('navigation-control');
  var loopContexts = Array.prototype.slice.call(document.querySelectorAll('.loop-context'));
  loopContexts.forEach(function (context) {
    context.style.setProperty('--loop-depth', context.dataset.loopDepth);
  });
  var contextQueued = false;
  function measureLoopContexts() {
    var top = navigationControl.getBoundingClientRect().bottom;
    document.documentElement.style.setProperty('--loop-context-top', top + 'px');
    var unpinnedExplorers = new Set();
    loopContexts.forEach(function (context) {
      var explorer = context.closest('.loop-explorer');
      var openHelp = explorer.querySelector('.loop-recording-details[open]');
      var tall = context.getBoundingClientRect().height > (window.innerHeight - top) / 2;
      if (openHelp || tall) unpinnedExplorers.add(explorer);
    });
    loopContexts.forEach(function (context) {
      context.classList.toggle('loop-context-unpinned',
        unpinnedExplorers.has(context.closest('.loop-explorer')));
    });
    var stuck = loopContexts.filter(function (context) {
      return !context.classList.contains('loop-context-unpinned')
        && context.getBoundingClientRect().top <= top + 1
        && context.closest('.loop-invocation').getBoundingClientRect().bottom > top;
    });
    // Keep only the innermost current context visible in the sticky slot.
    // Hidden ancestor headers retain their flow height, so scrolling never
    // shifts the result; source, parent iteration and timing travel together.
    var active = stuck.filter(function (context) {
      return context.closest('.loop-invocation').getBoundingClientRect().bottom
        >= top + context.getBoundingClientRect().height;
    }).at(-1);
    loopContexts.forEach(function (context) {
      context.classList.toggle('loop-context-covered', stuck.includes(context) && context !== active);
    });
  }
  function queueLoopContexts() {
    if (contextQueued) return;
    contextQueued = true;
    requestAnimationFrame(function () { contextQueued = false; measureLoopContexts(); });
  }
  if (loopContexts.length) {
    measureLoopContexts();
    window.addEventListener('scroll', queueLoopContexts, { passive: true });
    window.addEventListener('resize', queueLoopContexts);
    var contextObserver = new ResizeObserver(queueLoopContexts);
    contextObserver.observe(navigationControl);
    loopContexts.forEach(function (context) { contextObserver.observe(context); });
  }
  var resultControls = Array.prototype.slice.call(document.querySelectorAll('.whole-result'));
  function paintResultFold(result, collapsed) {
    var button = result.querySelector('.result-disclosure');
    result.classList.toggle('result-collapsed', collapsed);
    result.querySelector('.result-detail').hidden = collapsed;
    result.querySelector('.result-summary').hidden = !collapsed;
    button.setAttribute('aria-expanded', String(!collapsed));
    button.firstElementChild.textContent = collapsed ? '▸' : '▾';
    var action = collapsed ? 'Show values' : 'Collapse values';
    button.title = action;
    button.setAttribute('aria-label', action + ' for line '
      + (Number(result.dataset.resultLine) + 1) + '; ' + button.dataset.resultDescription);
  }
  function measureResultFold(result) {
    var source = result.closest('tr.row').querySelector('.source-content');
    var sourceHeight = source.getBoundingClientRect().height;
    var lineHeight = source.querySelector('.code-line').getBoundingClientRect().height;
    result.style.setProperty('--source-height', sourceHeight + 'px');
    result.classList.add('result-measuring');
    var detailHeight = result.querySelector('.result-detail').getBoundingClientRect().height;
    result.classList.remove('result-measuring');
    // Padding alone must not turn a trivial one-line value into a fold.
    var foldable = detailHeight > sourceHeight + Math.max(8, lineHeight / 2);
    result.classList.toggle('result-foldable', foldable);
    result.querySelector('.result-disclosure').hidden = !foldable;
    paintResultFold(result, foldable && result.dataset.resultClosed === 'true');
  }
  resultControls.forEach(function (result) {
    result.dataset.resultClosed = String(result.classList.contains('result-collapsed'));
    var button = result.querySelector('.result-disclosure');
    button.addEventListener('keydown', function (event) { event.stopPropagation(); });
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      var collapsed = result.dataset.resultClosed !== 'true';
      result.dataset.resultClosed = String(collapsed);
      paintResultFold(result, collapsed);
      vscode.postMessage({ resultFold: Number(result.dataset.resultLine),
        collapsed: collapsed, token: Number(result.dataset.resultToken), revision: revision });
    });
    measureResultFold(result);
  });
  if (resultControls.length) {
    var measureQueued = false;
    var resultObserver = new ResizeObserver(function () {
      if (measureQueued) return;
      measureQueued = true;
      requestAnimationFrame(function () {
        measureQueued = false;
        resultControls.forEach(measureResultFold);
      });
    });
    resultControls.forEach(function (result) {
      resultObserver.observe(result);
      resultObserver.observe(result.closest('tr.row').querySelector('.source-content'));
    });
  }
  document.querySelectorAll('[data-loop-action]').forEach(function (button) {
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      vscode.postMessage({ loop: Number(button.dataset.loopLine),
        action: button.dataset.loopAction, node: Number(button.dataset.loopId),
        value: Number(button.dataset.loopValue), revision: revision });
    });
    button.addEventListener('keydown', function (event) { event.stopPropagation(); });
  });
  var rows = Array.prototype.slice.call(document.querySelectorAll('tr.row'));
  var control = document.getElementById('follow-cursor');
  control.addEventListener('change', function () {
    followCursor = control.checked;
    vscode.postMessage({ followCursor: followCursor, revision: revision });
  });
  var followPanelControl = document.getElementById('follow-panel');
  followPanelControl.addEventListener('change', function () {
    followPanel = followPanelControl.checked;
    vscode.postMessage({ followPanel: followPanel, revision: revision });
  });
  var hideInlineValuesControl = document.getElementById('hide-inline-values');
  hideInlineValuesControl.addEventListener('change', function () {
    hideInlineValues = hideInlineValuesControl.checked;
    vscode.postMessage({ hideInlineValues: hideInlineValues, revision: revision });
  });
  var foldControls = Array.prototype.slice.call(
    document.querySelectorAll('[data-fold-action]'));
  foldControls.forEach(function (foldControl) {
    foldControl.addEventListener('keydown', function (event) { event.stopPropagation(); });
    foldControl.addEventListener('click', function (event) {
      event.stopPropagation();
      var line = Number(foldControl.getAttribute('data-fold-line'));
      if (foldControl.getAttribute('data-fold-action') === 'open') {
        vscode.postMessage({ open: line, stream: foldControl.getAttribute('data-fold-id'),
          revision: revision });
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
      row.setAttribute('aria-label', 'Line ' + (Number(row.dataset.goto) + 1)
        + (active ? '; matches the editor cursor' : '')
        + (row.classList.contains('latest-result') ? '; latest recorded result' : ''));
      row.tabIndex = active ? 0 : -1;
    });
    if (!target && rows[0]) rows[0].tabIndex = 0;
  }
  function activate(row, explicit) {
    if (followCursor || explicit) {
      mark(row);
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
      if ((event.target && event.target !== row)
        || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
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
    if (typeof message.followPanel === 'boolean') {
      followPanel = message.followPanel;
      followPanelControl.checked = followPanel;
    }
    if (typeof message.hideInlineValues === 'boolean') {
      hideInlineValues = message.hideInlineValues;
      hideInlineValuesControl.checked = hideInlineValues;
    }
    if (typeof message.cursor !== 'number') return;
    var target = matching(message.cursor);
    mark(target);
    if (message.reveal) revealCentred(target);
  });
  var revealLine = ${literal};
  if (revealLine !== null) revealCentred(matching(revealLine));
  ${KEYBOARD_SCRIPT}

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
 *
 * `followPanel` (#149) and `hideInlineValues` (#178) drive the row's other
 * two checkboxes -- "Scroll to new results" (`evalens.valuesPanel.follow`)
 * and "Hide inline values while this panel is visible"
 * (`evalens.inlineValues === 'whenPanelHidden'`). Both toggles used to be
 * title-bar icons that swapped one codicon for a near-identical one with no
 * VS-Code-native pressed appearance to say which state they were in (#181);
 * a checkbox carries its own state instead, so both moved into this row
 * beside the pre-existing cursor-following checkbox and the title-bar icons
 * are gone. Neither parameter touches what the table itself renders --
 * `hideInlineValues` no longer feeds `summaryLine`'s dropped note either --
 * so a caller passing neither gets the settings' own defaults (both on)
 * with no change to any row.
 */
export function valuesHtml(
  data: ValuesPanelData, cursorLine: number | undefined, nonce: string,
  revealLine?: number, fold?: FoldState, followCursor = true, revision = 0,
  followPanel = true, hideInlineValues = false, learning: LearningHelpState = {}
): string {
  // Keep every row aligned, including when the cursor makes its gutter
  // bold. Emit only this numeric metric into the existing nonce style;
  // inline style attributes would be rejected by the webview's CSP.
  const lineDigits = data.rows.reduce(
    (digits, row) => Math.max(digits, String(row.line + 1).length), 2);
  const foldOptions: FoldRenderOptions = {
    resultFolds: fold?.resultFolds,
    loopStates: fold?.loopStates,
    outputLines: fold?.outputLines ?? DEFAULT_OUTPUT_LINES,
    expandedLines: fold?.expandedLines ?? NO_EXPANDED_LINES,
  };
  const body = data.fileName === undefined
    ? learningEmptyHtml(false, learning.platform ?? process.platform)
    : data.rows.length === 0
      ? learningEmptyHtml(true, learning.platform ?? process.platform)
      : tableHtml(data.fileName, data.rows, cursorLine, foldOptions,
        data.latestResultLine);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; `
    + `style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Evalens Values</title>
<style nonce="${nonce}">${STYLE}${LOOP_EXPLORER_STYLE}${LEARNING_STYLE}
table { --line-number-width: ${lineDigits}ch; }
</style>
</head>
<body data-source-uri="${escapeHtml(data.sourceUri ?? data.fileName ?? '')}">
<div id="navigation-control" class="navigation-control">
<label><input id="follow-cursor" type="checkbox" ${followCursor ? 'checked' : ''}> Link code and values</label>
<label><input id="follow-panel" type="checkbox" ${followPanel ? 'checked' : ''}> Scroll to new results</label>
<label><input id="hide-inline-values" type="checkbox" ${hideInlineValues ? 'checked' : ''}> Hide inline values while this panel is visible</label>
${learningToggleHtml(learning)}
</div>
${learningHelpHtml(learning)}
${body}
<script nonce="${nonce}">${script(revealLine, followCursor, revision, followPanel, hideInlineValues)}</script>
</body>
</html>`;
}
