import * as vscode from 'vscode';

import { COLOR_REGION } from './decorations';

/** How long the highlight stays up. Long enough to read, short enough to ignore. */
const FLASH_MS = 1500;

/**
 * A brief highlight over a region of code.
 *
 * It exists for one thing: showing that a run covered more than the user
 * selected. A selection that starts halfway through a `def` runs the whole
 * `def`, and a status message saying so is a sentence about code that is
 * already on screen -- the cheaper answer is to point at it. Painting the span
 * the kernel reports says exactly how far the snap reached, in the place the
 * reader is already looking.
 *
 * It fades on its own rather than clearing on the next keystroke, because it
 * is a remark about what just happened and not a state the editor is in. The
 * annotations are the lasting record; this is the gesture.
 */
export class Flash implements vscode.Disposable {
  private readonly type = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor(COLOR_REGION),
    // Same mark the evaluated region uses, so a widened span that reaches off
    // the top of the viewport is still findable while it lasts.
    overviewRulerColor: new vscode.ThemeColor(COLOR_REGION),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });

  private timer: ReturnType<typeof setTimeout> | undefined;

  show(editor: vscode.TextEditor, range: vscode.Range, ms = FLASH_MS): void {
    this.stop();
    editor.setDecorations(this.type, [{ range }]);
    const document = editor.document;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // By document rather than by editor: the tab may have been split, or
      // closed entirely, in the second and a half since. Painting through a
      // `TextEditor` that is no longer visible is not something to do.
      for (const open of vscode.window.visibleTextEditors) {
        if (open.document === document) {
          open.setDecorations(this.type, []);
        }
      }
    }, ms);
  }

  dispose(): void {
    this.stop();
    this.type.dispose();
  }

  private stop(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
