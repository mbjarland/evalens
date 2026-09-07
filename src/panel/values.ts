import * as path from 'node:path';
import * as vscode from 'vscode';

import {
  followValuesCursor, followValuesPanel, printedLabel as printedLabelSetting,
  setFollowValuesCursor, valuesPanelOutputLines,
} from '../config';
import { AnnotationChangeEvent, Annotations } from '../render/annotations';
import { LoopExplorerWire, LoopInvocation } from '../kernel/protocol';
import { LoopViewState, LOOP_PAGE_SIZE, invocationExpanded, loopExpanded, newLoopViewState } from './loopExplorer';
import {
  PanelAnnotation, ValuesPanelData, ValuesRow, fullTextFor, rowsFor, valuesHtml,
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
  /** Capture object identity survives unrelated annotation/source shifts;
   * each new evaluation gets a new object and therefore fresh fold IDs. */
  private readonly loopStates = new WeakMap<LoopExplorerWire, LoopViewState>();
  private nextLoopIdentity = 0;

  /** Incremented on every rebuild (#154); a message from the webview that
   * does not echo the current value is a click queued against HTML that
   * has since been replaced, and `onMessage` drops it rather than acting on
   * rows that may no longer mean the same thing. */
  private revision = 0;
  /** What the webview was last rendered from -- `onMessage`'s own source of
   * truth for whether a `goto` still names a row that exists, since the
   * document's own annotations can have changed between the render and the
   * click landing. */
  private renderedData: ValuesPanelData = { fileName: undefined, rows: [] };
  private markedEditor: vscode.TextEditor | undefined;
  /** The source-side half of linked navigation (#154): a frame around the
   * statement the panel's current row belongs to, independent of the
   * inline annotation's own decorations. */
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
      // it -- see `revealLineFor`. #155 uses the same line to drop that
      // row's own fold state before the rebuild: a fresh value replacing
      // the old one is not the text the reader chose to see in full, so
      // `Show all` does not carry over to it.
      annotations.onDidChange((event) => {
        this.dropExpandedFor(event);
        this.rebuild(this.revealLineFor(event));
      }),
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

  /**
   * Every message the webview posts (#116, #154, #155): `{ goto, revision,
   * explicit }` from a clicked or keyboard-activated row, `{ followCursor,
   * revision }` from the panel's own checkbox, `{ expand: line }` from
   * *Show all*, *Show less* or a click on a foldable block's label, and
   * `{ open: line, stream }` from *Open in editor*. None of the four
   * evaluates anything or touches the kernel.
   *
   * `revision` guards the first two: `rebuild` increments it on every
   * render and a message carrying any other value is a click queued
   * against HTML that has since been replaced, dropped rather than acted
   * on against rows that may no longer mean what they did. The fold
   * messages carry no revision of their own -- toggling or opening a block
   * that has since been re-evaluated is harmless, since `pruneExpanded`
   * (see `rebuild`, below) already drops whatever line no longer has a row
   * to belong to.
   *
   * A hidden panel acts on none of these: there is no reader looking at it
   * to have produced the message.
   */
  private onMessage(message: unknown): void {
    if (!message || typeof message !== 'object' || !this.view?.visible) {
      return;
    }
    const data = message as {
      cause?: unknown; goto?: unknown; revision?: unknown; followCursor?: unknown;
      explicit?: unknown; expand?: unknown; open?: unknown; stream?: unknown;
      loop?: unknown; action?: unknown; node?: unknown; value?: unknown;
    };

    if (typeof data.expand === 'number') {
      this.toggleExpanded(data.expand);
      return;
    }
    if (typeof data.open === 'number') {
      void this.openInEditor(
        data.open, typeof data.stream === 'string' ? data.stream : undefined);
      return;
    }

    if (data.revision !== this.revision) {
      return;
    }
    if (typeof data.loop === 'number' && typeof data.node === 'number'
      && typeof data.action === 'string' && typeof data.value === 'number'
      && Number.isSafeInteger(data.value) && data.value >= 0) {
      this.onLoopAction(data.loop, data.node, data.action, data.value);
      return;
    }
    if (typeof data.cause === 'number') {
      const editor = vscode.window.activeTextEditor;
      if (editor && this.renderedData.rows.some((row) => row.staleCause?.id === data.cause)) {
        void this.annotations.revealDependency(editor.document.uri.toString(), data.cause);
      }
      return;
    }
    if (typeof data.followCursor === 'boolean') {
      void setFollowValuesCursor(data.followCursor);
      return;
    }
    if (!followValuesCursor() && data.explicit !== true) {
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'python'
      || typeof data.goto !== 'number' || !Number.isInteger(data.goto)) {
      return;
    }
    // Ignore queued messages from previous HTML and nonexistent rows.
    const row = this.renderedData.rows.find((row) => row.line === data.goto);
    if (!row) {
      return;
    }
    const position = new vscode.Position(row.line, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position));
    this.mark(editor, row.line);
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

  private onLoopAction(line: number, id: number, action: string, value: number): void {
    const row = this.renderedData.rows.find((r) => r.line === line);
    const model = row?.loopExplorer;
    if (!row || !model) return;
    const entry = model.entries.get(id);
    if (action === 'open') {
      if (value > 1 || (id !== 0 && !entry)) return;
      const text = model.streams[value as 0 | 1];
      void vscode.workspace.openTextDocument({ content: text, language: 'plaintext' })
        .then((document) => vscode.window.showTextDocument(document));
      return;
    }
    if (!entry && id !== 0) return;
    const state = this.loopStates.get(model.wire) ?? newLoopViewState(++this.nextLoopIdentity);
    this.loopStates.set(model.wire, state);
    if (action === 'toggle' && entry?.kind === 'iteration') {
      state.expanded.set(id, !loopExpanded(model, entry, state));
    } else if (action === 'toggle-invocation' && entry?.kind === 'invocation') {
      state.expanded.set(id, !invocationExpanded(model, entry, state));
    } else if (action === 'page' && entry) {
      const pages = Math.ceil((model.children.get(id)?.length ?? 0) / LOOP_PAGE_SIZE);
      if (value >= pages) return;
      state.pages.set(id, value);
    } else if (/^gap:\d+$/.test(action)) {
      const gap = Number(action.slice(4));
      if (gap !== (model.children.get(id)?.length ?? (id === 0 ? model.roots.length : 0))
        || !(entry?.incomplete ?? (id === 0 && model.wire.omitted_invocations > 0))) return;
      const key = `${id}:${gap}`;
      if (state.expandedGaps.has(key)) state.expandedGaps.delete(key);
      else state.expandedGaps.add(key);
    } else if (/^text:\d+:[01]$/.test(action) && value <= 65536) {
      const [, gap, stream] = action.split(':');
      if (Number(gap) > (model.children.get(id)?.length ?? model.roots.length)) return;
      state.textPages.set(`${id}:${gap}:${stream}`, value);
    } else if (action === 'select' && entry?.kind === 'iteration') {
      state.selected = id;
      const editor = vscode.window.activeTextEditor;
      const invocation = model.entries.get(entry.invocation) as LoopInvocation;
      const site = model.sites.get(invocation.site)!;
      const sourceLine = row.startLine + site.line - model.wire.statement_line;
      // Metadata is a historical source position. Reanchor disjoint prefix
      // edits, and withdraw navigation if this statement itself was edited.
      if (editor && row.staleReason !== 'edited' && sourceLine >= row.startLine
        && sourceLine <= row.endLine && sourceLine < editor.document.lineCount) {
        const position = new vscode.Position(sourceLine, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    } else return;
    this.rebuild();
  }

  /**
   * *Open in editor* (#155): the full text `blockId` names, as a new
   * untitled plaintext document beside the panel. `fullTextFor` only ever
   * reads text this provider already rendered from -- the same text the
   * kernel sent when the statement ran -- so nothing here evaluates
   * anything or asks the kernel a second time. Silently does nothing for a
   * `blockId` the current row no longer recognises: the row can have
   * rebuilt between the click landing in the webview and this message
   * reaching the extension, and there is no code beside it to report an
   * error about.
   */
  private async openInEditor(line: number, blockId: string | undefined): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || blockId === undefined) {
      return;
    }
    const row = this.dataFor(editor).rows.find((each) => each.line === line);
    const text = row && fullTextFor(row, blockId);
    if (text === undefined) {
      return;
    }
    const document = await vscode.workspace.openTextDocument({
      content: text, language: 'plaintext',
    });
    await vscode.window.showTextDocument(document, { preserveFocus: false });
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
    this.clearMarker();
    const editor = vscode.window.activeTextEditor;
    const cursorLine = editor?.selection.active.line;
    this.renderedData = this.dataFor(editor);
    const expandedLines = this.pruneExpanded(editor, this.renderedData.rows);
    const loopStates = new Map<LoopExplorerWire, LoopViewState>();
    for (const row of this.renderedData.rows) {
      if (row.loopExplorer) {
        const state = this.loopStates.get(row.loopExplorer.wire)
          ?? newLoopViewState(++this.nextLoopIdentity);
        this.loopStates.set(row.loopExplorer.wire, state);
        loopStates.set(row.loopExplorer.wire, state);
      }
    }
    this.view.webview.html = valuesHtml(
      this.renderedData, cursorLine, nonce(), revealLine,
      { outputLines: valuesPanelOutputLines(), expandedLines, loopStates },
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
