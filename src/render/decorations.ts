import * as vscode from 'vscode';

import { Range as KernelRange } from '../kernel/protocol';
import { errorText, resultText } from './format';

/**
 * Theme colour ids contributed in package.json. Colours come from the theme
 * rather than literals so results adapt to the user's and stay overridable
 * through `workbench.colorCustomizations`.
 *
 * A `ThemeColor` naming an id that is not contributed resolves to nothing and
 * paints invisibly, which is why a test checks these against the manifest.
 */
export const COLOR_RESULT = 'evalens.resultForeground';
export const COLOR_ERROR = 'evalens.errorForeground';
export const COLOR_REGION = 'evalens.evaluatedRegionBackground';

export interface Annotation {
  readonly range: vscode.Range;
  /** The value's `repr()`, or the error to show in its place. */
  readonly value?: string;
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
      margin: '0 0 0 1.5em',
      color: new vscode.ThemeColor(COLOR_RESULT),
      fontStyle: 'normal',
    },
  });

  private readonly errorType = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
    after: {
      margin: '0 0 0 1.5em',
      color: new vscode.ThemeColor(COLOR_ERROR),
      fontStyle: 'normal',
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

    for (const annotation of annotations) {
      regions.push({ range: annotation.range });
      // The annotation hangs at the end of the evaluated region, not at the
      // cursor, so a multi-line statement annotates where it finishes.
      const at = new vscode.Range(annotation.range.end, annotation.range.end);
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
              contentText: errorText(
                annotation.error.type, annotation.error.message),
            },
          },
        });
      } else if (annotation.value !== undefined) {
        results.push({
          range: at,
          hoverMessage,
          renderOptions: {
            after: { contentText: resultText(annotation.value) },
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
