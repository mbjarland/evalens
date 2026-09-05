import * as vscode from 'vscode';

import {
  BindingTrace, LoopTrace, NamedValue, Range as KernelRange,
} from '../kernel/protocol';
import { alignmentGap, columnWidth, errorText, resultText } from './format';
import { Marker, Traced, markerFor, normalizeSource } from './registry';
import { Pending, pendingText } from './status';

/**
 * Theme colour ids contributed in package.json. Colours come from the theme
 * rather than literals so results adapt to the user's and stay overridable
 * through `workbench.colorCustomizations`.
 *
 * A `ThemeColor` naming an id that is not contributed resolves to nothing and
 * paints invisibly, which is why a test checks these against the manifest.
 */
export const COLOR_RESULT = 'evalens.resultForeground';
export const COLOR_RESULT_BG = 'evalens.resultBackground';
export const COLOR_ERROR = 'evalens.errorForeground';
export const COLOR_ERROR_BG = 'evalens.errorBackground';
export const COLOR_REGION = 'evalens.evaluatedRegionBackground';
export const COLOR_PENDING = 'evalens.pendingForeground';
export const COLOR_PENDING_REGION = 'evalens.pendingRegionBackground';
export const COLOR_FLASH_REGION = 'evalens.flashRegionBackground';

/** Columns between the code and its annotation when the line overruns. */
const MINIMUM_GAP = 2;

/**
 * Padding and rounding for the annotation's background, smuggled through
 * `textDecoration` -- the decoration API exposes no padding of its own. Both
 * background colours default to transparent, following Rider, which gets its
 * separation from italics and a warm colour rather than from a chip; this
 * only takes effect if someone sets one through
 * `workbench.colorCustomizations`.
 */
const CHIP = 'none; padding: 0 5px; border-radius: 3px;';

/**
 * Where the three state markers live, relative to the extension root.
 *
 * Files rather than theme colours, because `gutterIconPath` takes an image and
 * there is no `ThemeColor` equivalent for the gutter -- so the light and dark
 * variants are two files rather than two defaults. A test checks that every
 * one of them exists, since a missing icon paints nothing at all and reports
 * nothing at all.
 */
const GUTTER_DIR = ['media', 'gutter'];

/** The three states, in the order they are painted. */
const MARKERS: readonly Marker[] = ['evaluated', 'stale', 'error'];

export interface Annotation extends Traced {
  readonly range: vscode.Range;
  /**
   * The line to write the value on, when that is not the end of `range`.
   *
   * A compound statement's value belongs beside the line that introduces it --
   * `def greet(name):`, `for p in squares:` -- and not beside the last line of
   * its body, which with a twenty-line body is twenty lines from the thing it
   * describes and inside a folded region is not visible at all. The range is
   * left covering the whole statement, because that is what the region
   * highlight uses to show how much code ran.
   */
  readonly anchor?: number;
  /** The value's `repr()`, or the error to show in its place. */
  readonly value?: string;
  /** The expression whose value this is, when it names a binding. */
  readonly display?: string | null;
  /** Every value a loop's target held; displaces `value` when present. */
  readonly loop?: LoopTrace;
  /** Every value the loop's body bound, per name; painted after the target. */
  readonly bindings?: readonly BindingTrace[];
  /** What the names on the line held; painted beside `value`, not instead. */
  readonly names?: readonly NamedValue[];
  /**
   * How many further names the kernel's per-line cap left out, so the line
   * can say so rather than look as though it lost one.
   */
  readonly more?: number;
  readonly error?: { readonly type: string; readonly message: string };
  readonly hover?: string;
  /**
   * Set while the statement has not finished, displacing everything above.
   *
   * Its presence is the state; the message it carries is what the statement is
   * waiting for, when that is something more specific than time. Not a
   * boolean, because "still running" and "waiting for you to type an answer to
   * `Enter a value:`" are different things the reader has to tell apart, and a
   * flag can only say that one of them is true.
   */
  readonly pending?: Pending;
}

/**
 * Paints evaluation results into an editor.
 *
 * Three decoration layers rather than one, following Calva for two of them:
 * the result text hangs off the end of the line as an `after` decoration, and
 * the region that was evaluated gets its own background. Keeping them separate
 * is what makes the display legible -- one says what the answer is, the other
 * says what question was asked.
 *
 * The third is the state marker in the gutter, and where it goes is the whole
 * of the decision. Marking the annotation itself -- dimming it, greying it,
 * striking it through -- makes the value compete with a claim about the value,
 * in the one place on screen the reader is trying to read. A mark in the
 * gutter sits outside the reading path and answers a question that is only
 * ever asked deliberately. CIDER puts it in the fringe, Mathematica has put it
 * in the cell bracket since 1996, and JupyterLab's review of the same feature
 * turned down a request to mark the output. Three independent arrivals at the
 * margin is not a coincidence.
 *
 * A statement that has not finished displaces all three with the pending mark
 * and a greyed region. That is a state rather than a remark, which is why it
 * lives here and the brief emphasis on a statement that just *did* finish does
 * not -- that one is a gesture on a timer and belongs to `Flash`.
 */
export class Decorator implements vscode.Disposable {
  private readonly resultType = vscode.window.createTextEditorDecorationType({
    // ClosedOpen: the decoration does not absorb text typed at its boundary,
    // so an annotation does not smear along the line as the user keeps
    // editing.
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
    after: {
      color: new vscode.ThemeColor(COLOR_RESULT),
      backgroundColor: new vscode.ThemeColor(COLOR_RESULT_BG),
      textDecoration: CHIP,
      // Italic is what makes an annotation legible as not-code at a glance,
      // before colour is even processed. Rider leans on this and it carries
      // most of the separation.
      fontStyle: 'italic',
    },
  });

  private readonly errorType = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
    after: {
      color: new vscode.ThemeColor(COLOR_ERROR),
      backgroundColor: new vscode.ThemeColor(COLOR_ERROR_BG),
      textDecoration: CHIP,
      fontStyle: 'italic',
    },
  });

  /**
   * The unfinished state: no colour of its own beyond a muted one, because
   * what it has to say is that there is nothing to read here yet.
   */
  private readonly pendingType = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
    after: {
      color: new vscode.ThemeColor(COLOR_PENDING),
      textDecoration: CHIP,
      fontStyle: 'italic',
    },
  });

  private readonly regionType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor(COLOR_REGION),
    isWholeLine: false,
    // The scrollbar mark is what makes evaluated regions findable in a file
    // longer than a screen.
    overviewRulerColor: new vscode.ThemeColor(COLOR_REGION),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });

  /** The same region, greyed, while the kernel has not answered for it. */
  private readonly pendingRegionType =
    vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor(COLOR_PENDING_REGION),
      isWholeLine: false,
      overviewRulerColor: new vscode.ThemeColor(COLOR_PENDING_REGION),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });

  /** One decoration type per state, because each carries a different icon. */
  private readonly markerTypes: ReadonlyMap<
    Marker, vscode.TextEditorDecorationType>;

  constructor(extensionUri: vscode.Uri) {
    this.markerTypes = new Map(MARKERS.map((marker) => [
      marker,
      vscode.window.createTextEditorDecorationType({
        gutterIconSize: 'contain',
        // Light and dark are separate images rather than separate colours:
        // the gutter takes an icon, and an icon carries its own palette.
        dark: { gutterIconPath: iconFor(extensionUri, marker, 'dark') },
        light: { gutterIconPath: iconFor(extensionUri, marker, 'light') },
      }),
    ]));
  }

  /** Replace this editor's annotations with `annotations`. */
  show(editor: vscode.TextEditor, annotations: readonly Annotation[]): void {
    const results: vscode.DecorationOptions[] = [];
    const errors: vscode.DecorationOptions[] = [];
    const waiting: vscode.DecorationOptions[] = [];
    const regions: vscode.DecorationOptions[] = [];
    const pendingRegions: vscode.DecorationOptions[] = [];
    const markers = new Map<Marker, vscode.DecorationOptions[]>(
      MARKERS.map((marker) => [marker, []]));

    const targetColumn = vscode.workspace
      .getConfiguration('evalens')
      .get<number>('alignColumn', 80);
    const tabSize = typeof editor.options.tabSize === 'number'
      ? editor.options.tabSize
      : 4;

    for (const annotation of annotations) {
      // Greyed rather than evaluated, and the two lists are separate so that
      // a statement cannot be painted as both at once.
      (annotation.pending ? pendingRegions : regions)
        .push({ range: annotation.range });

      // End of the LINE, not end of the statement. Anchoring mid-line would
      // insert the annotation before any trailing comment and shove it
      // right, and there would be no column to align to.
      const host = editor.document.lineAt(
        annotation.anchor ?? annotation.range.end.line);
      const at = new vscode.Range(host.range.end, host.range.end);

      // On the line the value is written on, not on every line the statement
      // covers: the marker is a claim about that value, and a twenty-line
      // `def` with twenty markers down its side would read as twenty claims.
      //
      // A statement still running gets no marker at all. The three states are
      // claims about how a value stands against the code beside it, and a
      // statement that has not produced one yet is in none of them -- a green
      // `evaluated` there would say the kernel had answered when it has not.
      if (!annotation.pending) {
        markers.get(markerFor(annotation))?.push({
          range: new vscode.Range(host.range.start, host.range.start),
        });
      }

      // The gap goes in the margin rather than in the content, so it stays
      // outside the annotation's background. Padding the content instead
      // would render sixty columns of coloured block.
      const gap = alignmentGap(
        columnWidth(host.text, tabSize), targetColumn, MINIMUM_GAP);
      const margin = `0 0 0 ${gap}ch`;

      const hoverMessage = annotation.hover
        ? new vscode.MarkdownString(
            ['```', annotation.hover, '```'].join('\n'))
        : undefined;

      if (annotation.pending) {
        // First, and displacing whatever the statement said last time. Taking
        // the old value away is half the transition: an evaluation that
        // produces the same string again has still visibly happened, because
        // the string left and came back.
        waiting.push({
          range: at,
          renderOptions: {
            after: { margin, contentText: pendingText(annotation.pending) },
          },
        });
      } else if (annotation.error) {
        errors.push({
          range: at,
          hoverMessage,
          renderOptions: {
            after: {
              margin,
              contentText: errorText(
                annotation.error.type, annotation.error.message),
            },
          },
        });
      } else if (annotation.value !== undefined
                 || annotation.loop !== undefined
                 || (annotation.names?.length ?? 0) > 0) {
        results.push({
          range: at,
          hoverMessage,
          renderOptions: {
            after: {
              margin,
              // A loop that ran zero times has a trace and no value, and
              // still has something to report. So does an `if` that bound a
              // name: no value of its own, and the name is the answer.
              contentText: resultText(
                annotation.value ?? null, annotation.display, annotation.loop,
                annotation.names, annotation.bindings, annotation.more),
            },
          },
        });
      }
      // A statement with nothing to show -- an `if`, a `del` -- still gets its
      // region highlighted. It ran; there is simply no value to report.
    }

    editor.setDecorations(this.resultType, results);
    editor.setDecorations(this.errorType, errors);
    editor.setDecorations(this.pendingType, waiting);
    editor.setDecorations(this.regionType, regions);
    editor.setDecorations(this.pendingRegionType, pendingRegions);
    for (const [marker, type] of this.markerTypes) {
      // Every state is set on every paint, empty included: leaving one out
      // leaves its previous icons in the gutter, so a marker that has gone
      // amber would keep a green twin underneath it.
      editor.setDecorations(type, markers.get(marker) ?? []);
    }
  }

  clear(editor: vscode.TextEditor): void {
    this.show(editor, []);
  }

  dispose(): void {
    this.resultType.dispose();
    this.errorType.dispose();
    this.pendingType.dispose();
    this.regionType.dispose();
    this.pendingRegionType.dispose();
    for (const type of this.markerTypes.values()) {
      type.dispose();
    }
  }
}

/** Kernel coordinates are already VS Code's; this only changes the type. */
export function toVsCodeRange(range: KernelRange): vscode.Range {
  return new vscode.Range(
    range.start.line, range.start.character,
    range.end.line, range.end.character
  );
}

/** Where one state's icon lives, for one theme kind. */
export function iconFor(
  extensionUri: vscode.Uri, marker: Marker, theme: 'dark' | 'light'
): vscode.Uri {
  return vscode.Uri.joinPath(
    extensionUri, ...GUTTER_DIR, `${marker}-${theme}.svg`);
}

/**
 * What the lines an annotation covers say right now, folded for comparison.
 *
 * Whole lines rather than the statement's exact range, and that is the point
 * rather than a shortcut: an edit that changes a line's indentation moves
 * every column on it, so a range-precise read would start mid-token and
 * report a change that is not one. A top-level statement owns its lines.
 *
 * Clamped, because an edit can shorten the document under an annotation that
 * is on its way out.
 */
export function sourceAt(
  document: vscode.TextDocument, range: vscode.Range
): string {
  const last = Math.min(range.end.line, document.lineCount - 1);
  const first = Math.min(Math.max(range.start.line, 0), last);
  return normalizeSource(document.getText(
    new vscode.Range(first, 0, last, document.lineAt(last).text.length)));
}
