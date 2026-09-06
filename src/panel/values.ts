import * as path from 'node:path';
import * as vscode from 'vscode';

import {
  followValuesCursor, followValuesPanel, printedLabel as printedLabelSetting,
  setFollowValuesCursor,
} from '../config';
import { AnnotationChangeEvent, Annotations } from '../render/annotations';
import { PanelAnnotation, ValuesPanelData, rowsFor, valuesHtml } from './html';

/**
 * Contributed in `package.json`'s `contributes.views.evalens`.
 *
 * The command that reveals it (`evalens.showValuesPanel`) is registered by
 * its own literal id in `extension.ts`, on the same terms every other
 * command there is -- see that call site's comment -- so it is not
 * duplicated as a constant here.
 */
export const VALUES_VIEW_ID = 'evalens.values';

const NONCE_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** A fresh CSP nonce for one render -- the standard, undocumented-but-
 * universal recipe every VS Code webview sample uses: 32 characters wide
 * enough that guessing one before it is used is not a workable attack. */
function nonce(): string {
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += NONCE_CHARS.charAt(Math.floor(Math.random() * NONCE_CHARS.length));
  }
  return text;
}

/**
 * `Evalens Values`: the active Python file's annotations, full width,
 * wrapping, in the bottom panel (#116).
 *
 * Reads `Annotations` and nothing else -- design rule 3 governs this exactly
 * as it governs `render/hover.ts`'s `ValueHoverProvider`, and nothing here
 * ever reaches the kernel. `resolveWebviewView` may be called more than once
 * in the life of one window -- closing the panel and reopening it re-resolves
 * -- so the view's own listeners are torn down and rebuilt each time,
 * separately from the ones this provider holds for its whole life.
 */
export class ValuesViewProvider
implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];
  private viewSubscriptions: vscode.Disposable[] = [];

  private revision = 0;
  private renderedData: ValuesPanelData = { fileName: undefined, rows: [] };
  private markedEditor: vscode.TextEditor | undefined;
  private readonly navigation = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderWidth: '1px 0 1px 3px',
    borderStyle: 'solid',
    borderColor: new vscode.ThemeColor('focusBorder'),
    backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });

  constructor(private readonly annotations: Annotations) {
    this.subscriptions.push(
      // The one non-polling trigger design rule 6's spirit asks for: the
      // registry's own mutation points say when they changed, rather than
      // this provider guessing by re-reading on a timer. #149 extends this
      // to say *which line* changed, so the rebuild below can also reveal
      // it -- see `revealLineFor`.
      annotations.onDidChange((event) => this.rebuild(this.revealLineFor(event))),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('evalens.valuesPanel.followCursor')) {
          void this.view?.webview.postMessage({ followCursor: followValuesCursor() });
        }
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.rebuild(this.cursorRevealLine())),
      // Cursor movement never rebuilds -- it only moves the highlighted row,
      // in the webview's own script, from the one number `onSelection` posts.
      vscode.window.onDidChangeTextEditorSelection(
        (event) => this.onSelection(event))
    );
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    for (const subscription of this.viewSubscriptions) {
      subscription.dispose();
    }
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    this.viewSubscriptions = [
      webviewView.onDidDispose(() => {
        this.clearMarker();
        this.view = undefined;
        this.viewSubscriptions = [];
      }),
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) this.rebuild(this.cursorRevealLine());
        else this.clearMarker();
      }),
      webviewView.webview.onDidReceiveMessage((message) => this.onMessage(message)),
    ];
    this.rebuild(this.cursorRevealLine());
  }

  dispose(): void {
    this.clearMarker();
    this.navigation.dispose();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
    for (const subscription of this.viewSubscriptions) {
      subscription.dispose();
    }
    this.viewSubscriptions = [];
  }

  // -- internals --------------------------------------------------------------

  private cursorRevealLine(): number | undefined {
    return followValuesCursor() ? vscode.window.activeTextEditor?.selection.active.line
      : undefined;
  }

  private clearMarker(): void {
    this.markedEditor?.setDecorations(this.navigation, []);
    this.markedEditor = undefined;
  }

  private mark(editor: vscode.TextEditor, line: number): void {
    this.clearMarker();
    const annotation = this.annotations.at(editor.document, line);
    if (annotation) {
      editor.setDecorations(this.navigation, [annotation.range]);
      this.markedEditor = editor;
    }
  }

  /** Navigation reads captured annotations only, and never focuses a pane. */
  private onSelection(event: vscode.TextEditorSelectionChangeEvent): void {
    if (!this.view?.visible || event.textEditor !== vscode.window.activeTextEditor
      || event.textEditor.document.languageId !== 'python') return;
    const active = event.selections[0]?.active.line;
    if (active === undefined) return;
    this.mark(event.textEditor, active);
    void this.view.webview.postMessage({
      cursor: active, reveal: followValuesCursor(),
    });
  }

  private onMessage(message: unknown): void {
    if (!message || typeof message !== 'object' || !this.view?.visible) return;
    const data = message as {
      goto?: unknown; revision?: unknown; followCursor?: unknown; explicit?: unknown;
    };
    if (data.revision !== this.revision) return;
    if (typeof data.followCursor === 'boolean') {
      void setFollowValuesCursor(data.followCursor);
      return;
    }
    if (!followValuesCursor() && data.explicit !== true) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'python'
      || typeof data.goto !== 'number' || !Number.isInteger(data.goto)) return;
    // Ignore queued messages from previous HTML and nonexistent rows.
    const row = this.renderedData.rows.find((row) => row.line === data.goto);
    if (!row) return;
    const position = new vscode.Position(row.line, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position));
    this.mark(editor, row.line);
  }

  /**
   * Which row to scroll into view for one `onDidChange` event (#149), or
   * `undefined` for none -- always `undefined` while
   * `evalens.valuesPanel.follow` is off, which is the whole of what that
   * setting and its title-bar lock toggle do: they never change what is
   * painted, only whether a rebuild is allowed to move the reader's eye.
   *
   * `event.line` is already exactly the right answer whenever the mutation
   * that fired it could name one -- see `Annotations.onDidChange`'s own doc
   * comment for which those are. When it cannot -- a bulk edit, a clear --
   * the active editor's cursor is what is left to go on: for **Evaluate at
   * Cursor** and **Evaluate and Advance** that is the line just evaluated
   * or the one right after it, which in both cases is where the reader is
   * already looking.
   */
  private revealLineFor(event: AnnotationChangeEvent): number | undefined {
    if (!followValuesPanel()) {
      return undefined;
    }
    return event.line ?? vscode.window.activeTextEditor?.selection.active.line;
  }

  private rebuild(revealLine?: number): void {
    if (!this.view) {
      return;
    }
    this.clearMarker();
    const editor = vscode.window.activeTextEditor;
    const cursorLine = editor?.selection.active.line;
    this.renderedData = this.dataFor(editor);
    this.view.webview.html =
      valuesHtml(this.renderedData, cursorLine, nonce(), revealLine,
        followValuesCursor(), ++this.revision);
    if (editor && this.view.visible && cursorLine !== undefined) {
      this.mark(editor, cursorLine);
    }
  }

  /** What `valuesHtml` renders from, for whatever the active editor is right
   * now -- `undefined` short of a Python one, which is `valuesHtml`'s own
   * cue for the "no active Python editor" empty state. */
  private dataFor(editor: vscode.TextEditor | undefined): ValuesPanelData {
    if (!editor || editor.document.languageId !== 'python') {
      return { fileName: undefined, rows: [] };
    }
    const annotations: readonly PanelAnnotation[] =
      this.annotations.all(editor.document);
    return {
      fileName: path.basename(editor.document.uri.fsPath),
      rows: rowsFor(editor.document, annotations, printedLabelSetting()),
    };
  }
}
