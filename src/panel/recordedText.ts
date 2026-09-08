import * as path from 'node:path';
import * as vscode from 'vscode';

export const RECORDING_SCHEME = 'evalens-recording';
/** Open recordings are explicit working documents, not a hidden archive.
 * Refuse another one at the bound rather than changing an open baseline. */
export const MAX_OPEN_RECORDINGS = 32;
export const MAX_RECORDING_CHARACTERS = 8 * 1024 * 1024;

export interface RecordedTextContext {
  readonly source: vscode.Uri;
  readonly startLine: number;
  readonly endLine: number;
  readonly kind: 'printed output' | 'stderr output' | 'value';
  readonly label?: string;
  readonly stale: boolean;
  readonly recordedSource?: string;
}
interface Recording {
  readonly text: string;
  readonly context: RecordedTextContext;
  readonly size: number;
  opening: boolean;
  releasePending?: boolean;
}

/** Immutable native text documents built exclusively from captured strings.
 * No kernel client, inspection callback or representation function belongs
 * here. Closing a tab releases its entry, even while VS Code caches the
 * TextDocument. onDidCloseTextDocument also covers documents without tabs. */
export class RecordedTextDocuments implements vscode.TextDocumentContentProvider,
  vscode.Disposable {
  private readonly recordings = new Map<string, Recording>();
  private readonly subscriptions: vscode.Disposable[];
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 5);
  private nextIdentity = 0;
  private characters = 0;
  private disposed = false;

  constructor() {
    this.status.name = 'Evalens recording';
    this.subscriptions = [
      vscode.workspace.registerTextDocumentContentProvider(RECORDING_SCHEME, this),
      vscode.workspace.onDidCloseTextDocument(document => {
        // A language-mode change also closes the old TextDocument while its
        // tab remains open. Only the tab's real close releases that baseline.
        if (!this.hasOpenTab(document.uri)) this.release(document.uri);
      }),
      vscode.window.tabGroups.onDidChangeTabs(event => {
        for (const tab of event.closed) {
          for (const uri of this.tabUris(tab)) {
            if (!this.hasOpenTab(uri)) {
              this.release(uri);
            }
          }
        }
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateStatus()),
    ];
  }

  get opening(): boolean {
    return [...this.recordings.values()].some(recording => recording.opening);
  }

  context(uri: vscode.Uri): RecordedTextContext | undefined {
    return this.recordings.get(uri.toString())?.context;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const recording = this.recordings.get(uri.toString());
    if (!recording) throw new Error('This Evalens recording has been closed. Open an available result from the Values panel.');
    return recording.text;
  }

  async open(text: string, context: RecordedTextContext): Promise<void> {
    if (this.disposed) return;
    const size = text.length + context.source.toString().length
      + (context.recordedSource?.length ?? 0) + (context.label?.length ?? 0);
    if (this.recordings.size >= MAX_OPEN_RECORDINGS
      || this.characters + size > MAX_RECORDING_CHARACTERS) {
      void vscode.window.showInformationMessage(
        'Close an opened Evalens recording to open another. Existing recordings stay unchanged.');
      return;
    }
    const lines = context.startLine === context.endLine
      ? `L${context.startLine + 1}` : `L${context.startLine + 1}-${context.endLine + 1}`;
    const label = context.kind === 'value' && context.label
      ? ` ${context.label.replace(/[\x00-\x1f/\\]/g, '_').slice(0, 60)}` : '';
    // The source URI remains exact in the tooltip. A filename may contain
    // separators/control characters in a custom scheme: keep the tab plain.
    const file = path.basename(context.source.path).replace(/[\x00-\x1f/\\]/g, '_');
    const identity = ++this.nextIdentity;
    const name = `${file} ${lines} — recorded ${context.kind}${label} · recording ${identity}.txt`;
    const uri = vscode.Uri.from({ scheme: RECORDING_SCHEME,
      path: `/${identity}/${name}` });
    const recording: Recording = { text, context, size, opening: true };
    this.recordings.set(uri.toString(), recording);
    this.characters += size;
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      if (this.disposed) return;
      // preview:false keeps this baseline open when a later result is opened.
      await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
      this.updateStatus();
    } catch (error) {
      this.release(uri, true);
      void vscode.window.showErrorMessage(`Could not open the Evalens recording: ${String(error)}`);
    } finally {
      recording.opening = false;
      if (recording.releasePending) this.release(uri);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.recordings.clear();
    this.characters = 0;
    this.status.dispose();
  }

  private release(uri: vscode.Uri, force = false): void {
    const key = uri.toString();
    const recording = this.recordings.get(key);
    if (!recording) return;
    if (!force && recording.opening) { recording.releasePending = true; return; }
    this.characters -= recording.size;
    this.recordings.delete(key);
    this.updateStatus();
  }

  private hasOpenTab(uri: vscode.Uri): boolean {
    return vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
      this.tabUris(tab).some(open => open.toString() === uri.toString())));
  }

  private tabUris(tab: vscode.Tab): readonly vscode.Uri[] {
    if (tab.input instanceof vscode.TabInputText) return [tab.input.uri];
    if (tab.input instanceof vscode.TabInputTextDiff) return [tab.input.original, tab.input.modified];
    return [];
  }

  private updateStatus(): void {
    if (this.disposed) return;
    const editor = vscode.window.activeTextEditor;
    const context = editor && this.context(editor.document.uri);
    if (!context) { this.status.hide(); return; }
    const kind = context.kind === 'value' ? 'Recorded value text' : `Recorded ${context.kind}`;
    const source = `${path.basename(context.source.path)}:${context.startLine + 1}`;
    const scope = context.kind === 'value' ? 'saved representation' : 'whole statement';
    this.status.text = `$(lock) ${kind} · ${source} · ${scope}${context.stale ? ' · old result' : ''}`;
    this.status.tooltip = `${kind}\nSource: ${context.source.toString()}\n`
      + `Statement lines in the panel when opened: ${context.startLine + 1}–${context.endLine + 1}\n`
      + (context.recordedSource === undefined ? 'Recorded source text unavailable.\n'
        : `Recorded source (preview):\n${context.recordedSource}\n\n`)
      + (context.kind === 'value'
        ? 'The saved value representation or history summary; this may be truncated. It is not the live Python object.\n'
        : 'The available stream for the whole statement, including all its loops; not only the selected iteration.\n')
      + (context.stale ? 'This result was already marked old when opened.\n' : '')
      + 'Find searches this opened recording, including text beyond the panel preview. Text that was never captured is unavailable.\n'
      + 'This read-only snapshot stays unchanged when code runs again. Close its tab to release it; recordings do not survive reloading VS Code.';
    this.status.show();
  }
}
