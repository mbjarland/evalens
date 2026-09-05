import * as vscode from 'vscode';

import {
  LoopTrace, NamedValue, Range as KernelRange,
} from '../kernel/protocol';
import { alignmentGap, columnWidth, errorText, resultText } from './format';

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

export interface Annotation {
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
  /** What the names on the line held; painted beside `value`, not instead. */
  readonly names?: readonly NamedValue[];
  readonly error?: { readonly type: string; readonly message: string };
  readonly hover?: string;
}

/**
 * Paints evaluation results into an editor.
 *
 * Two decoration layers rather than one, following Calva: the result text
 * hangs off the end of the line as an `after` decoration, and the region that
 * was evaluated gets its own background. Keeping them separate is what makes
 * the display legible -- one says what the answer is, the other says what
 * question was asked.
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

  private readonly regionType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor(COLOR_REGION),
    isWholeLine: false,
    // The scrollbar mark is what makes evaluated regions findable in a file
    // longer than a screen.
    overviewRulerColor: new vscode.ThemeColor(COLOR_REGION),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });

  /** Replace this editor's annotations with `annotations`. */
  show(editor: vscode.TextEditor, annotations: readonly Annotation[]): void {
    const results: vscode.DecorationOptions[] = [];
    const errors: vscode.DecorationOptions[] = [];
    const regions: vscode.DecorationOptions[] = [];

    const targetColumn = vscode.workspace
      .getConfiguration('evalens')
      .get<number>('alignColumn', 80);
    const tabSize = typeof editor.options.tabSize === 'number'
      ? editor.options.tabSize
      : 4;

    for (const annotation of annotations) {
      regions.push({ range: annotation.range });

      // End of the LINE, not end of the statement. Anchoring mid-line would
      // insert the annotation before any trailing comment and shove it
      // right, and there would be no column to align to.
      const host = editor.document.lineAt(
        annotation.anchor ?? annotation.range.end.line);
      const at = new vscode.Range(host.range.end, host.range.end);

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

      if (annotation.error) {
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
                annotation.names),
            },
          },
        });
      }
      // A statement with nothing to show -- an `if`, a `del` -- still gets its
      // region highlighted. It ran; there is simply no value to report.
    }

    editor.setDecorations(this.resultType, results);
    editor.setDecorations(this.errorType, errors);
    editor.setDecorations(this.regionType, regions);
  }

  clear(editor: vscode.TextEditor): void {
    this.show(editor, []);
  }

  dispose(): void {
    this.resultType.dispose();
    this.errorType.dispose();
    this.regionType.dispose();
  }
}

/** Kernel coordinates are already VS Code's; this only changes the type. */
export function toVsCodeRange(range: KernelRange): vscode.Range {
  return new vscode.Range(
    range.start.line, range.start.character,
    range.end.line, range.end.character
  );
}
