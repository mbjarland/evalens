import * as vscode from 'vscode';

import { COLOR_FLASH_REGION, COLOR_REGION } from './decorations';
import { FLASH } from './status';

/** How long a snap highlight stays up: long enough to read, short enough to
 * ignore. */
const SNAP_MS = 1500;

/**
 * One kind of flash: what it paints and how long it lasts.
 *
 * Both are parameters rather than two classes because the mechanism is
 * identical -- paint a decoration, take it away on a timer -- and the two
 * differ only in what they are saying. Writing that twice is how two timers
 * end up fighting over the same editor.
 */
export interface FlashStyle {
  /** Theme colour id, contributed in package.json. */
  readonly color: string;
  readonly ms: number;
}

/**
 * How far a selection snap reached.
 *
 * A selection that starts halfway through a `def` runs the whole `def`, and a
 * status message saying so is a sentence about code that is already on screen
 * -- the cheaper answer is to point at it. The evaluated-region colour on
 * purpose: what is being shown is a region that ran, which is what that colour
 * already means.
 */
export const SNAP: FlashStyle = { color: COLOR_REGION, ms: SNAP_MS };

/**
 * A statement that just finished.
 *
 * After a file load every line already carries an annotation, so a permanent
 * success colour distinguishes nothing; what carries the information is the
 * emphasis decaying -- something happened *here*, a moment ago. Julia's
 * extension flashes the evaluated range for about 200ms and that is the shape
 * adopted, so this is brighter and much shorter-lived than a snap.
 */
export const SETTLED: FlashStyle = { color: COLOR_FLASH_REGION, ms: FLASH };

/**
 * A brief highlight over a region of code.
 *
 * Two things want this and they arrived independently: showing that a run
 * covered more than the user selected (#62), and showing that the statement
 * under the cursor just re-ran (#10). They are different remarks and the same
 * gesture -- so they are one class with a colour and a duration rather than
 * two classes with two timers. Two timers is not a tidiness complaint: a snap
 * flash and a success flash can land on the same statement in the same editor,
 * and whichever expired second would clear a decoration the other had just
 * painted.
 *
 * One instance, therefore one timer, and the newest flash cancels whatever was
 * up. The newest is the one being reported on, which is the rule either caller
 * would have wanted on its own.
 *
 * It fades rather than clearing on the next keystroke, because it is a remark
 * about what just happened and not a state the editor is in. The annotations
 * are the lasting record; this is the gesture.
 */
export class Flash implements vscode.Disposable {
  /**
   * One decoration type per colour, built once and kept.
   *
   * Lazily, so a session that never snaps never makes the snap type -- and by
   * colour id rather than per call, because a type rebuilt to change its
   * colour takes every decoration painted through it with it.
   */
  private readonly types =
    new Map<string, vscode.TextEditorDecorationType>();

  private timer: ReturnType<typeof setTimeout> | undefined;
  /** What is on screen now: the type painted, and where. */
  private showing: {
    readonly type: vscode.TextEditorDecorationType;
    readonly documents: readonly vscode.TextDocument[];
  } | undefined;

  /**
   * Paint `ranges` in `editors`, and take it away again after `style.ms`.
   *
   * `editors` rather than one editor: a document open in a split view is two
   * editors showing the same statement, and flashing one of them would say
   * something happened in one pane and not the other.
   */
  show(
    editors: readonly vscode.TextEditor[],
    ranges: readonly vscode.Range[],
    style: FlashStyle
  ): void {
    this.stop();
    if (editors.length === 0 || ranges.length === 0) {
      return;
    }
    const type = this.typeFor(style.color);
    const options = ranges.map((range) => ({ range }));
    for (const editor of editors) {
      editor.setDecorations(type, options);
    }
    // Remembered by document rather than by editor: the tab may have been
    // split, or closed entirely, in the second and a half since. Painting
    // through a `TextEditor` that is no longer visible is not something to do.
    this.showing = {
      type,
      documents: [...new Set(editors.map((editor) => editor.document))],
    };
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.stop();
    }, style.ms);
  }

  dispose(): void {
    this.stop();
    for (const type of this.types.values()) {
      type.dispose();
    }
    this.types.clear();
  }

  private typeFor(color: string): vscode.TextEditorDecorationType {
    const existing = this.types.get(color);
    if (existing) {
      return existing;
    }
    const type = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor(color),
      isWholeLine: false,
      // The same mark the evaluated region uses, so a widened span that
      // reaches off the top of the viewport is still findable while it lasts.
      overviewRulerColor: new vscode.ThemeColor(color),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
    this.types.set(color, type);
    return type;
  }

  /** Take down whatever is up, whichever kind it was. */
  private stop(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const showing = this.showing;
    if (showing === undefined) {
      return;
    }
    this.showing = undefined;
    for (const editor of vscode.window.visibleTextEditors) {
      if (showing.documents.includes(editor.document)) {
        editor.setDecorations(showing.type, []);
      }
    }
  }
}
