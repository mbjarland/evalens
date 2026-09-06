import * as path from 'node:path';
import * as vscode from 'vscode';

import {
  followValuesPanel, printedLabel as printedLabelSetting,
  valuesPanelOutputLines,
} from '../config';
import { AnnotationChangeEvent, Annotations } from '../render/annotations';
import {
  PanelAnnotation, ValuesPanelData, ValuesRow, rowsFor, valuesHtml,
} from './html';

/** No document has anything expanded -- the common case, and the one that
 * must not allocate a `Set` just to be handed to `valuesHtml`. */
const NO_EXPANDED_LINES: ReadonlySet<number> = new Set();

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

  /**
   * Which rows the reader has expanded with *Show all* or a block's own
   * label (#155), by document URI and then by `ValuesRow.line` -- the same
   * key `revealLine` and the cursor highlight already use. Kept here rather
   * than in `html.ts`, which never remembers anything between one render
   * and the next: a rebuild is a pure function of whatever this provider
   * hands it, and this map is the one place that decides what to hand it
   * this time.
   *
   * A document with nothing expanded has no entry at all, so the common
   * case -- nobody has clicked *Show all* in this file -- costs one map
   * lookup rather than an ever-growing empty `Set` per document ever
   * opened.
   */
  private readonly expandedLines = new Map<string, Set<number>>();

  constructor(private readonly annotations: Annotations) {
    this.subscriptions.push(
      // The one non-polling trigger design rule 6's spirit asks for: the
      // registry's own mutation points say when they changed, rather than
      // this provider guessing by re-reading on a timer. #149 extends this
      // to say *which line* changed, so the rebuild below can also reveal
      // it -- see `revealLineFor`. #155 uses the same line to drop that
      // row's own fold state before the rebuild: a fresh value replacing
      // the old one is not the text the reader chose to see in full, so
      // `Show all` does not carry over to it.
      annotations.onDidChange((event) => {
        this.dropExpandedFor(event);
        this.rebuild(this.revealLineFor(event));
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.rebuild()),
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
        this.view = undefined;
        this.viewSubscriptions = [];
      }),
      webviewView.webview.onDidReceiveMessage((message) => this.onMessage(message)),
    ];
    this.rebuild();
  }

  dispose(): void {
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

  /** `{ cursor: line }`, so the webview's own script moves the highlight
   * without a rebuild -- posting the HTML again on every keystroke of
   * cursor movement would be the polling design rule 6 rules out, aimed at
   * the wrong target. */
  private onSelection(event: vscode.TextEditorSelectionChangeEvent): void {
    if (!this.view) {
      return;
    }
    if (event.textEditor !== vscode.window.activeTextEditor) {
      return;
    }
    if (event.textEditor.document.languageId !== 'python') {
      return;
    }
    const active = event.selections[0]?.active.line;
    if (active === undefined) {
      return;
    }
    void this.view.webview.postMessage({ cursor: active });
  }

  /**
   * The messages the webview posts (#116, #155). `{ goto: line }` from a
   * clicked row reveals that line and puts the cursor there -- the panel
   * never evaluates anything, clicking included, this only moves the reader
   * to the code the row is about. `{ expand: line }` is *Show all*, *Show
   * less* or a click on a foldable block's own label, all one toggle, and
   * never moves the reader anywhere.
   */
  private onMessage(message: unknown): void {
    const payload = message as {
      readonly goto?: unknown; readonly expand?: unknown;
    } | undefined;

    if (typeof payload?.expand === 'number') {
      this.toggleExpanded(payload.expand);
      return;
    }
    if (typeof payload?.goto !== 'number') {
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const position = new vscode.Position(payload.goto, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position));
  }

  /**
   * Flip whether `line` is shown in full (#155) -- the one toggle behind
   * *Show all*, *Show less* and a click on the block's own label. Never
   * reveals anything: the reader clicked something already on screen and
   * knows exactly where they are, unlike an evaluation landing somewhere
   * they were not looking.
   */
  private toggleExpanded(line: number): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const key = editor.document.uri.toString();
    const lines = this.expandedLines.get(key) ?? new Set<number>();
    if (lines.has(line)) {
      lines.delete(line);
    } else {
      lines.add(line);
    }
    if (lines.size === 0) {
      this.expandedLines.delete(key);
    } else {
      this.expandedLines.set(key, lines);
    }
    this.rebuild();
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

  /**
   * Drop `event.line`'s own fold state, for the half of #155's "dropped
   * when the row's annotation is replaced or cleared" that `onDidChange`'s
   * payload can name directly: `add` and the still-running `pending` mark
   * both fire with the exact line whatever just landed there occupies (see
   * `AnnotationChangeEvent`'s own doc comment), and a fresh value replacing
   * the old one is not the text the reader chose to see in full. The other
   * half -- a whole document cleared, or a row whose line moved to where no
   * row exists any more -- has no single line to name and is instead
   * pruned in `rebuild`, below, once the fresh rows are known.
   *
   * An edit that only marks a row stale (`reanchor`, `markDependents`) also
   * carries no line, and deliberately: it is the "unrelated annotation
   * change" #155 asks the state to survive, since the row's own displayed
   * text has not actually changed underneath the reader.
   */
  private dropExpandedFor(event: AnnotationChangeEvent): void {
    if (event.line === undefined) {
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    this.expandedLines.get(editor.document.uri.toString())?.delete(event.line);
  }

  /**
   * This document's expanded rows, pruned to the ones `rows` still has
   * (#155) -- the other half of "dropped when the row's annotation is
   * replaced or cleared": a whole-document clear leaves no row at all, and
   * an edit that shifts a statement to a different line leaves no row at
   * the old one, either way with nothing left here to keep open. A
   * document with nothing expanded costs one map lookup and allocates
   * nothing.
   */
  private pruneExpanded(
    editor: vscode.TextEditor | undefined, rows: readonly ValuesRow[]
  ): ReadonlySet<number> {
    if (!editor) {
      return NO_EXPANDED_LINES;
    }
    const key = editor.document.uri.toString();
    const lines = this.expandedLines.get(key);
    if (!lines || lines.size === 0) {
      return NO_EXPANDED_LINES;
    }
    const valid = new Set(rows.map((row) => row.line));
    for (const line of [...lines]) {
      if (!valid.has(line)) {
        lines.delete(line);
      }
    }
    if (lines.size === 0) {
      this.expandedLines.delete(key);
      return NO_EXPANDED_LINES;
    }
    return lines;
  }

  private rebuild(revealLine?: number): void {
    if (!this.view) {
      return;
    }
    const editor = vscode.window.activeTextEditor;
    const cursorLine = editor?.selection.active.line;
    const data = this.dataFor(editor);
    const expandedLines = this.pruneExpanded(editor, data.rows);
    this.view.webview.html = valuesHtml(
      data, cursorLine, nonce(), revealLine,
      { outputLines: valuesPanelOutputLines(), expandedLines });
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
