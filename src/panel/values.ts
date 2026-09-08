import * as path from 'node:path';
import * as vscode from 'vscode';

import {
  followValuesCursor, followValuesPanel, inlineValues,
  printedLabel as printedLabelSetting, resetOnLoad, setFollowValuesCursor,
  setFollowValuesPanel, setInlineValues, valuesPanelOutputLines,
} from '../config';
import { AnnotationChangeEvent, Annotations } from '../render/annotations';
import { LoopExplorerWire, LoopInvocation } from '../kernel/protocol';
import { LoopViewState, LOOP_PAGE_SIZE, invocationExpanded, loopExpanded, newLoopViewState } from './loopExplorer';
import {
  ValuesPanelData, fullTextFor, rowsFor, valuesHtml,
} from './html';
import { ResultFolds, ResultFoldState } from './resultFold';
import { INTRO_DISMISSED_KEY, LearningTopic, isLearningTopic } from './learningHelp';

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
export const COLOR_CURRENT_LINE = 'evalens.currentLineBackground';

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

  /** Capture object identity survives unrelated annotation/source shifts;
   * each new evaluation gets a new object and therefore fresh fold IDs. */
  private readonly loopStates = new WeakMap<LoopExplorerWire, LoopViewState>();
  private readonly resultFolds = new ResultFolds();
  private renderedResultFolds: ReadonlyMap<number, ResultFoldState> = new Map();
  private nextLoopIdentity = 0;
  private introDismissed: boolean;
  private readonly openLearningTopics = new Set<LearningTopic>();
  /** One opaque result identity per live document. A row number cannot carry
   * this fact across edits, and cursor movement is independent of completion. */
  private latestResults = new WeakMap<vscode.TextDocument, object>();

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
  /**
   * `evalens.inlineValues === 'whenPanelHidden' && this.view.visible` (#178)
   * -- recomputed on `resolveWebviewView`, on visibility change, on the
   * setting changing, and on the view being disposed, which is the only
   * place this is forced back to `false` rather than recomputed: a
   * disposed view is not visible by any definition, but `webviewView.visible`
   * is not safe to read once the view it belonged to has gone.
   *
   * Kept here, not just inferred from `this.view?.visible` at paint time,
   * because it is also the flag `setInlineHidden` compares against to skip
   * a redundant repaint of the editor's own chips. `valuesHtml`'s own
   * "Hide inline values" checkbox (#181) is driven separately, straight
   * from `inlineValues()` in `rebuild` -- it reflects the setting itself,
   * not this visibility-gated flag, since the checkbox's own label already
   * says "while this panel is visible".
   */
  private inlineHidden = false;
  private markedEditor: vscode.TextEditor | undefined;
  /** Linked navigation marks the actual source line, not every line of its
   * owning statement. The gutter tick is composed with the annotation's
   * state icon by the decorator, so neither icon can hide the other. */
  private readonly navigation = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor(COLOR_CURRENT_LINE),
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });

  constructor(
    private readonly annotations: Annotations,
    private readonly uiState?: Pick<vscode.Memento, 'get' | 'update'>
  ) {
    this.introDismissed = uiState?.get<boolean>(INTRO_DISMISSED_KEY, false) === true;
    this.subscriptions.push(
      // The one non-polling trigger design rule 6's spirit asks for: the
      // registry's own mutation points say when they changed, rather than
      // this provider guessing by re-reading on a timer. #149 extends this
      // to say *which line* changed, so the rebuild below can also reveal
      // it -- see `revealLineFor`. Capture identity also keeps generic
      // Show all state scoped to its original result: a fresh capture is
      // not the text the reader chose to see in full.
      annotations.onDidChange((event) => {
        this.trackLatestResult(event);
        // Also prune inactive documents and pending/displaced rows. A hidden
        // view is not a reason to retain preferences for cleared captures.
        if (event.document && event.pendingWithdrawn) {
          // evaluateAtCursor withdraws its cursor-line placeholder before
          // synchronously settling the enclosing statement. Give only that
          // transition until the end of this turn to match its replacement.
          // Failed/empty runs are then pruned; clear/edit events never defer.
          const document = event.document;
          queueMicrotask(() => this.syncResultFolds(document));
        } else if (event.document) this.syncResultFolds(event.document);
        else this.resultFolds.clear();
        this.rebuild(this.revealLineFor(event), event.pendingWithdrawn
          && event.document === vscode.window.activeTextEditor?.document);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.latestResults.delete(document);
        this.resultFolds.close(document);
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('evalens.valuesPanel.followCursor')) {
          void this.view?.webview.postMessage({ followCursor: followValuesCursor() });
        }
        // #181: a reader flips `evalens.valuesPanel.follow` from the
        // command palette or the Settings UI -- the same setting the
        // panel's own "Scroll to new results" checkbox writes -- and the
        // checkbox has to follow without waiting for an unrelated rebuild,
        // exactly like the followCursor checkbox just above.
        if (event.affectsConfiguration('evalens.valuesPanel.follow')) {
          void this.view?.webview.postMessage({ followPanel: followValuesPanel() });
        }
        // #178: a reader flips `evalens.inlineValues` from the command
        // palette or the settings UI while the panel already happens to be
        // visible -- the same case the panel's own "Hide inline values"
        // checkbox drives through `setInlineValues`, reached here too since
        // both write the same setting and this handler cannot tell which
        // one moved it. The rebuild below regenerates the whole page, which
        // is what updates that checkbox's own checked state.
        if (event.affectsConfiguration('evalens.inlineValues')) {
          this.setInlineHidden(
            inlineValues() === 'whenPanelHidden' && (this.view?.visible ?? false));
          this.rebuild(this.cursorRevealLine());
        }
        // Read existing configuration only; explaining a session must not
        // start Python or inspect its namespace. Keep this fact visible even
        // after the optional introduction has been dismissed.
        if (event.affectsConfiguration('evalens.resetOnLoad')) this.rebuild();
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
        // #178: a disposed panel is not visible to anyone, so whatever it
        // was hiding comes back, exactly like closing it while `always` is
        // already the setting always looked -- the mode never leaves the
        // editor silent by construction.
        this.setInlineHidden(false);
      }),
      webviewView.onDidChangeVisibility(() => {
        this.setInlineHidden(
          inlineValues() === 'whenPanelHidden' && webviewView.visible);
        if (webviewView.visible) this.rebuild(this.cursorRevealLine());
        else this.clearMarker();
      }),
      webviewView.webview.onDidReceiveMessage((message) => this.onMessage(message)),
    ];
    this.setInlineHidden(
      inlineValues() === 'whenPanelHidden' && webviewView.visible);
    this.rebuild(this.cursorRevealLine());
  }

  dispose(): void {
    this.resultFolds.clear();
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

  private trackLatestResult(event: AnnotationChangeEvent): void {
    if (!event.document) {
      this.latestResults = new WeakMap();
      return;
    }
    if (event.resultIdentity) {
      this.latestResults.set(event.document, event.resultIdentity);
    }
    const identity = this.latestResults.get(event.document);
    if (identity && !this.annotations.all(event.document)
      .some((annotation) => annotation.resultIdentity === identity && !annotation.pending)) {
      this.latestResults.delete(event.document);
    }
  }

  private cursorRevealLine(): number | undefined {
    return followValuesCursor() ? vscode.window.activeTextEditor?.selection.active.line
      : undefined;
  }

  /**
   * Apply `hide` (#178): record it for `rebuild`'s own `summaryLine` note,
   * and tell `Annotations` to repaint every visible editor with or without
   * its inline chips. A no-op when `hide` already matches, so a config
   * change and a visibility change landing for the same reason -- both
   * fire when the setting is flipped while the panel is visible -- do not
   * repaint twice.
   */
  private setInlineHidden(hide: boolean): void {
    if (hide === this.inlineHidden) {
      return;
    }
    this.inlineHidden = hide;
    this.annotations.setInlineHidden(hide);
  }

  private clearMarker(): void {
    if (this.markedEditor) {
      this.markedEditor.setDecorations(this.navigation, []);
      this.annotations.markCurrentLine(this.markedEditor, undefined);
    }
    this.markedEditor = undefined;
  }

  private mark(editor: vscode.TextEditor, line: number): void {
    this.clearMarker();
    const annotation = this.annotations.at(editor.document, line);
    if (annotation) {
      editor.setDecorations(this.navigation, [new vscode.Range(line, 0, line, 0)]);
      this.annotations.markCurrentLine(editor, line);
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
   * Every message the webview posts (#116, #154, #155, #181): `{ goto,
   * revision, explicit }` from a clicked or keyboard-activated row,
   * `{ followCursor, revision }`, `{ followPanel, revision }` and
   * `{ hideInlineValues, revision }` from the panel's own three checkboxes,
   * `{ expand: line }` from *Show all*, *Show less* or a click on a
   * foldable block's label, and `{ open: line, stream }` from *Open in
   * editor*. None of these evaluates anything or touches the kernel.
   *
   * `revision` guards the first two: `rebuild` increments it on every
   * render and a message carrying any other value is a click queued
   * against HTML that has since been replaced, dropped rather than acted
   * on against rows that may no longer mean what they did. The fold
   * messages carry no revision of their own -- toggling or opening a block
   * that has since been re-evaluated cannot resurrect the old capture:
   * its state is dropped when result identity changes.
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
      followPanel?: unknown; hideInlineValues?: unknown;
      explicit?: unknown; expand?: unknown; open?: unknown; stream?: unknown;
      loop?: unknown; action?: unknown; node?: unknown; value?: unknown;
      resultFold?: unknown; collapsed?: unknown; token?: unknown;
      learningAction?: unknown; learningTopic?: unknown; learningOpen?: unknown;
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
    if (isLearningTopic(data.learningTopic) && typeof data.learningOpen === 'boolean') {
      if (data.learningOpen) this.openLearningTopics.add(data.learningTopic);
      else this.openLearningTopics.delete(data.learningTopic);
      return;
    }
    if (data.learningAction !== undefined) {
      // This is an action allowlist, never a command or URI supplied by HTML.
      if (data.learningAction === 'dismiss-intro' || data.learningAction === 'show-intro') {
        this.introDismissed = data.learningAction === 'dismiss-intro';
        void this.uiState?.update(INTRO_DISMISSED_KEY, this.introDismissed);
      } else if (data.learningAction === 'walkthrough') {
        void vscode.commands.executeCommand('evalens.openLearningWalkthrough');
      } else if (data.learningAction === 'exercise') {
        void vscode.commands.executeCommand('evalens.openLearningExercise');
      }
      return;
    }
    if (typeof data.resultFold === 'number' && typeof data.collapsed === 'boolean') {
      const state = this.renderedResultFolds.get(data.resultFold);
      if (state && state.identity === data.token
        && this.renderedData.rows.some((row) => row.line === data.resultFold)) {
        // The webview already toggled its existing DOM. Persist without a
        // rebuild, so nested folds, text pages and focus remain untouched.
        state.collapsed = data.collapsed;
      }
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
    if (typeof data.followPanel === 'boolean') {
      void setFollowValuesPanel(data.followPanel);
      return;
    }
    if (typeof data.hideInlineValues === 'boolean') {
      void setInlineValues(data.hideInlineValues ? 'whenPanelHidden' : 'always');
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
    // Always centred (#169): a row activation is a navigation, not a nudge,
    // and the maintainer's rule is the editor's own Go to Line convention.
    editor.revealRange(new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenter);
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
    const state = this.renderedResultFolds.get(line);
    if (!state) return;
    state.expanded = !state.expanded;
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
        // Always centred (#169), matching the goto handler above.
        editor.revealRange(new vscode.Range(position, position),
          vscode.TextEditorRevealType.InCenter);
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

  private rebuild(revealLine?: number, pendingWithdrawn = false): void {
    if (!this.view) {
      return;
    }
    this.clearMarker();
    const editor = vscode.window.activeTextEditor;
    const cursorLine = editor?.selection.active.line;
    this.renderedData = this.dataFor(editor);
    if (!editor) this.renderedResultFolds = new Map();
    else if (!pendingWithdrawn) this.renderedResultFolds = this.syncResultFolds(editor.document);
    const expanded = [...this.renderedResultFolds].filter(([, state]) => state.expanded);
    const expandedLines = expanded.length
      ? new Set(expanded.map(([line]) => line)) : NO_EXPANDED_LINES;
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
      { outputLines: valuesPanelOutputLines(), expandedLines, loopStates,
        resultFolds: this.renderedResultFolds },
      followValuesCursor(), ++this.revision, followValuesPanel(),
      inlineValues() === 'whenPanelHidden', {
        introDismissed: this.introDismissed, openTopics: this.openLearningTopics,
        resetOnLoad: resetOnLoad(),
      });
    if (editor && this.view.visible && cursorLine !== undefined) {
      this.mark(editor, cursorLine);
    }
  }

  private syncResultFolds(document: vscode.TextDocument): ReadonlyMap<number, ResultFoldState> {
    return this.resultFolds.sync(document, this.annotations.all(document).map((annotation) => ({
      resultIdentity: annotation.resultIdentity, capturedSource: annotation.source,
      line: annotation.anchor ?? annotation.range.end.line,
      startLine: annotation.range.start.line, endLine: annotation.range.end.line,
      state: annotation.pending ? 'pending' : 'complete', staleReason: annotation.staleReason,
    })));
  }

  /** What `valuesHtml` renders from, for whatever the active editor is right
   * now -- `undefined` short of a Python one, which is `valuesHtml`'s own
   * cue for the "no active Python editor" empty state. */
  private dataFor(editor: vscode.TextEditor | undefined): ValuesPanelData {
    if (!editor || editor.document.languageId !== 'python') {
      return { fileName: undefined, rows: [] };
    }
    const annotations = this.annotations.all(editor.document);
    const identity = this.latestResults.get(editor.document);
    const latest = identity && annotations.find((annotation) =>
      annotation.resultIdentity === identity && !annotation.pending);
    return {
      fileName: path.basename(editor.document.uri.fsPath),
      latestResultLine: latest ? latest.anchor ?? latest.range.end.line : undefined,
      rows: rowsFor(editor.document, annotations, printedLabelSetting()),
    };
  }
}
