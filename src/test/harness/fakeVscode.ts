/**
 * A fake `vscode` module, so the four files that `import * as vscode` --
 * `extension.ts`, `evaluate.ts`, `decorations.ts`, `annotations.ts` -- and the
 * three that joined them since, `config.ts`, `prompt.ts`, `announcer.ts`, can
 * be required and driven outside an Extension Development Host.
 *
 * This proves the wiring: that `activate` registers what the manifest
 * contributes, that a command handler reaches the kernel and paints an
 * annotation, that disposal actually disposes. It does not and cannot prove
 * that a human sees the result -- no pixel is ever drawn, and a `ThemeColor`
 * resolves to nothing more than the string it was given. See #42 and
 * `extension.test.ts` for what each test asks of it and what it cannot
 * answer.
 *
 * `Module._load` is the trick, and it is legacy-but-functional rather than
 * documented API: every `require`, including the nested ones the compiled
 * output makes of `./evaluate`, `./render/decorations` and so on, is routed
 * through it, so intercepting the single string `'vscode'` here is enough to
 * make every one of those files loadable. It is installed only for the
 * duration of one `require` of the compiled entry point -- once that call
 * returns, every module that needed `vscode` has already bound its own
 * reference to the fake and closed over it, so the interception is removed
 * immediately rather than left live for the rest of the process.
 */

import * as path from 'node:path';
import Module = require('node:module');

// -- geometry ---------------------------------------------------------------

export class FakePosition {
  constructor(
    public readonly line: number,
    public readonly character: number
  ) {}
}

export class FakeRange {
  readonly start: FakePosition;
  readonly end: FakePosition;

  constructor(
    startLineOrPosition: number | FakePosition,
    startCharacterOrEnd: number | FakePosition,
    endLine?: number,
    endCharacter?: number
  ) {
    if (typeof startLineOrPosition === 'number') {
      this.start = new FakePosition(
        startLineOrPosition, startCharacterOrEnd as number);
      this.end = new FakePosition(endLine!, endCharacter!);
    } else {
      this.start = startLineOrPosition;
      this.end = startCharacterOrEnd as FakePosition;
    }
  }
}

export class FakeSelection extends FakeRange {
  readonly anchor: FakePosition;
  readonly active: FakePosition;

  constructor(
    anchorOrLine: FakePosition | number,
    activeOrCharacter: FakePosition | number,
    activeLine?: number,
    activeCharacter?: number
  ) {
    // The four-number overload is never used in this codebase, but is kept
    // here so this class is a drop-in for `vscode.Selection` wherever a test
    // wants it.
    super(
      anchorOrLine as number, activeOrCharacter as number,
      activeLine, activeCharacter);
    if (typeof anchorOrLine === 'number') {
      this.anchor = new FakePosition(anchorOrLine, activeOrCharacter as number);
      this.active = new FakePosition(activeLine!, activeCharacter!);
    } else {
      this.anchor = anchorOrLine;
      this.active = activeOrCharacter as FakePosition;
    }
  }
}

export class FakeThemeColor {
  constructor(public readonly id: string) {}
}

export class FakeThemeIcon {
  constructor(public readonly id: string) {}
}

export class FakeMarkdownString {
  value: string;
  isTrusted?: boolean | { readonly enabledCommands: readonly string[] };

  constructor(value?: string) {
    this.value = value ?? '';
  }
}

/** Enough of `vscode.Hover` for `render/hover.ts`'s `ValueHoverProvider`,
 * which builds one from a `FakeMarkdownString` and a range. */
export class FakeHover {
  constructor(
    public readonly contents: FakeMarkdownString,
    public readonly range?: FakeRange
  ) {}
}

/**
 * Enough of `vscode.QuickPickItem` and the `showQuickPick` overload
 * `render/explorer.ts` calls -- a single pick, resolved by a test rather
 * than a person, from a queue set up in advance. `undefined` in the queue is
 * `Escape`: nothing picked, the same answer a real cancelled QuickPick gives.
 */
export interface FakeQuickPickItem {
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly [key: string]: unknown;
}

export class FakeTabInputText {
  constructor(public readonly uri: FakeUri) {}
}
export class FakeTabInputTextDiff {
  constructor(public readonly original: FakeUri, public readonly modified: FakeUri) {}
}

export interface FakeUri {
  readonly fsPath: string;
  readonly path: string;
  toString(): string;
}

function makeUri(fsPath: string): FakeUri {
  return {
    fsPath,
    path: fsPath,
    toString: () => `file://${fsPath}`,
  };
}

// -- documents and editors ---------------------------------------------------

export interface FakeTextLine {
  readonly text: string;
  readonly range: FakeRange;
  readonly lineNumber: number;
}

export class FakeDocument {
  private lines: string[];
  version = 1;

  constructor(
    public readonly uri: FakeUri,
    text: string,
    public readonly languageId: string = 'python'
  ) {
    this.lines = text.split('\n');
  }

  get lineCount(): number {
    return this.lines.length;
  }

  /** Replace the whole buffer, the way an edit already applied by the time
   * `onDidChangeTextDocument` fires would leave it. */
  setText(text: string): void {
    this.lines = text.split('\n');
    this.version += 1;
  }

  getText(range?: FakeRange): string {
    if (!range) {
      return this.lines.join('\n');
    }
    const { start, end } = range;
    if (start.line === end.line) {
      return (this.lines[start.line] ?? '').slice(start.character, end.character);
    }
    const parts: string[] = [(this.lines[start.line] ?? '').slice(start.character)];
    for (let line = start.line + 1; line < end.line; line += 1) {
      parts.push(this.lines[line] ?? '');
    }
    parts.push((this.lines[end.line] ?? '').slice(0, end.character));
    return parts.join('\n');
  }

  lineAt(line: number): FakeTextLine {
    const text = this.lines[line] ?? '';
    return {
      text,
      range: new FakeRange(line, 0, line, text.length),
      lineNumber: line,
    };
  }
}

interface PaintedOptions {
  readonly range?: FakeRange;
  readonly renderOptions?: {
    readonly after?: { readonly contentText?: string };
  };
}

export class FakeEditor {
  selection: FakeSelection;
  readonly options: { tabSize: number } = { tabSize: 4 };
  readonly revealed: FakeRange[] = [];
  /** The reveal type passed alongside each `revealed` entry, same index --
   * `undefined` for a call that left it at the API's own default (#169). */
  readonly revealTypes: Array<number | undefined> = [];
  /** The latest `setDecorations` call for each type, keyed by the type. */
  readonly painted = new Map<FakeDecorationType, readonly PaintedOptions[]>();
  /**
   * Every `setDecorations` call, in order, `painted`'s latest-only view
   * loses. `Flash` reuses one decoration type per colour and calls
   * `setDecorations` on it repeatedly -- clear, then show the next range --
   * so a test asking "did this flash more than once" (#102's sweep) needs
   * the history, not just where things ended up.
   */
  readonly decorationCalls: Array<{
    readonly type: FakeDecorationType;
    readonly options: readonly PaintedOptions[];
  }> = [];

  constructor(public document: FakeDocument, selection?: FakeSelection) {
    this.selection = selection
      ?? new FakeSelection(new FakePosition(0, 0), new FakePosition(0, 0));
  }

  setDecorations(type: FakeDecorationType, options: readonly PaintedOptions[]): void {
    this.painted.set(type, options);
    this.decorationCalls.push({ type, options });
  }

  revealRange(range: FakeRange, revealType?: number): void {
    this.revealed.push(range);
    this.revealTypes.push(revealType);
  }
}

/**
 * Every `range: { contentText }` pair currently painted on `editor`, across
 * every decoration type -- which is to say, every piece of text an
 * annotation would show on screen right now, wherever it landed.
 *
 * Deliberately not reconstructed into "one string per annotation": a single
 * annotation is painted across several segment types (`decorations.ts`
 * chooses how many), and re-deriving which pieces belong together would be
 * asserting a layout detail this harness has no business knowing. What can be
 * asked without that knowledge is exactly what this answers -- which ranges
 * carry text, and what the text at each one contains.
 */
export function paintedTexts(
  editor: FakeEditor
): ReadonlyArray<{ readonly range: FakeRange; readonly text: string }> {
  const found: Array<{ range: FakeRange; text: string }> = [];
  for (const options of editor.painted.values()) {
    for (const option of options) {
      const contentText = option.renderOptions?.after?.contentText;
      if (option.range !== undefined && typeof contentText === 'string'
          && contentText !== '') {
        found.push({ range: option.range, text: contentText });
      }
    }
  }
  return found;
}

/** `paintedTexts`, grouped by the line the text sits on and joined in the
 * order the decoration types were created -- which is the order the
 * annotation's own segments are meant to read in. */
export function paintedLineText(editor: FakeEditor, line: number): string {
  const onLine = paintedTexts(editor).filter((entry) => entry.range.start.line === line);
  return onLine.map((entry) => entry.text).join('');
}

/** The distinct lines something with text is painted on right now. */
export function paintedLines(editor: FakeEditor): readonly number[] {
  return [...new Set(paintedTexts(editor).map((entry) => entry.range.start.line))]
    .sort((a, b) => a - b);
}

// -- webview views (#116) -----------------------------------------------------

/**
 * Enough of `vscode.Webview` for `panel/values.ts`'s `ValuesViewProvider`: an
 * `html` setter/getter a test can read back, `postMessage` recorded rather
 * than sent anywhere, and `onDidReceiveMessage` driven by the test through
 * `fireMessage` the way a real webview's own script would call
 * `acquireVsCodeApi().postMessage(...)`.
 */
export class FakeWebview {
  private htmlValue = '';
  options: { enableScripts?: boolean; localResourceRoots?: readonly FakeUri[] } = {};
  readonly cspSource = 'vscode-webview://fake-instance';
  readonly posted: unknown[] = [];
  private readonly messages = new FakeEmitter<unknown>();

  onDidReceiveMessage = this.messages.event;

  get html(): string {
    return this.htmlValue;
  }

  set html(value: string) {
    this.htmlValue = value;
  }

  postMessage(message: unknown): Thenable<boolean> {
    this.posted.push(message);
    return Promise.resolve(true);
  }

  asWebviewUri(uri: FakeUri): FakeUri {
    return uri;
  }

  /** Test-only: simulate the webview's own script posting `message` back. */
  fireMessage(message: unknown): void {
    this.messages.fire(message);
  }
}

/**
 * Enough of `vscode.WebviewView` for `resolveWebviewView` to be driven the
 * way `window.registerWebviewViewProvider`'s real caller drives it -- a
 * `webview`, a `visible` flag, and the two lifecycle events a provider is
 * free to ignore but must not be required to subscribe to.
 */
export class FakeWebviewView {
  readonly webview = new FakeWebview();
  visible = true;
  private readonly disposeEmitter = new FakeEmitter<void>();
  private readonly visibilityEmitter = new FakeEmitter<void>();

  onDidDispose = this.disposeEmitter.event;
  onDidChangeVisibility = this.visibilityEmitter.event;

  /** Test-only: simulate hiding or revealing the panel. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.visibilityEmitter.fire(undefined);
  }

  /** Test-only: simulate VS Code tearing this view down. */
  fireDispose(): void {
    this.disposeEmitter.fire(undefined);
  }
}

export interface FakeWebviewViewProvider {
  resolveWebviewView(
    webviewView: FakeWebviewView, context: unknown, token: unknown
  ): unknown;
}

// -- opening a document (#155) ------------------------------------------------

/** One `showTextDocument` call -- recorded rather than acted on, since this
 * harness has no real editor group to move anything into or out of focus
 * within. `preserveFocus` is kept exactly as the caller passed it so a test
 * can check *Open in editor* asked for `false`, the way a click that should
 * take the reader there does. */
export interface FakeShownDocument {
  readonly document: FakeDocument;
  readonly preserveFocus: boolean | undefined;
}

// -- disposables and channels -------------------------------------------------

export class FakeDecorationType {
  disposed = false;
  constructor(public readonly options: unknown) {}
  dispose(): void {
    this.disposed = true;
  }
}

export interface FakeOutputChannel {
  readonly name: string;
  readonly lines: string[];
  shown: boolean;
  disposed: boolean;
  appendLine(value: string): void;
  append(value: string): void;
  show(preserveFocus?: boolean): void;
  hide(): void;
  clear(): void;
  dispose(): void;
}

function makeOutputChannel(name: string): FakeOutputChannel {
  const channel: FakeOutputChannel = {
    name,
    lines: [],
    shown: false,
    disposed: false,
    appendLine: (value) => channel.lines.push(value),
    append: (value) => channel.lines.push(value),
    show: () => { channel.shown = true; },
    hide: () => { channel.shown = false; },
    clear: () => { channel.lines.length = 0; },
    dispose: () => { channel.disposed = true; },
  };
  return channel;
}

export interface FakeStatusBarItem {
  text: string;
  tooltip: string | undefined;
  command: string | undefined;
  accessibilityInformation: { label: string } | undefined;
  visible: boolean;
  disposed: boolean;
  show(): void;
  hide(): void;
  dispose(): void;
}

function makeStatusBarItem(): FakeStatusBarItem {
  const item: FakeStatusBarItem = {
    text: '',
    tooltip: undefined,
    command: undefined,
    accessibilityInformation: undefined,
    visible: false,
    disposed: false,
    show: () => { item.visible = true; },
    hide: () => { item.visible = false; },
    dispose: () => { item.disposed = true; },
  };
  return item;
}

interface FakeInputBox {
  title: string | undefined;
  prompt: string | undefined;
  placeholder: string | undefined;
  password: boolean;
  ignoreFocusOut: boolean;
  value: string;
  buttons: readonly unknown[];
  show(): void;
  hide(): void;
  dispose(): void;
  onDidAccept(listener: () => void): { dispose(): void };
  onDidTriggerButton(listener: () => void): { dispose(): void };
  onDidHide(listener: () => void): { dispose(): void };
}

function makeInputBox(): FakeInputBox {
  const hideEmitter = new FakeEmitter<void>();
  const box: FakeInputBox = {
    title: undefined,
    prompt: undefined,
    placeholder: undefined,
    password: false,
    ignoreFocusOut: false,
    value: '',
    buttons: [],
    show: () => undefined,
    hide: () => hideEmitter.fire(undefined),
    dispose: () => undefined,
    onDidAccept: () => ({ dispose: () => undefined }),
    onDidTriggerButton: () => ({ dispose: () => undefined }),
    onDidHide: (listener) => hideEmitter.event(listener),
  };
  return box;
}

// -- events -------------------------------------------------------------------

export class FakeEmitter<T> {
  private listeners: Array<(value: T) => void> = [];

  event = (listener: (value: T) => void): { dispose(): void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((each) => each !== listener);
      },
    };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }
}

/**
 * Stands in for `vscode.EventEmitter`, which `render/annotations.ts` now
 * constructs directly (`new vscode.EventEmitter<void>()`, #116) rather than
 * only ever consuming an `.event` this harness already owned. Wraps a
 * `FakeEmitter` instead of extending it, so the fake's own public shape --
 * `.event`, `.fire`, `.dispose` -- matches the three members every caller of
 * the real class actually uses.
 */
export class FakeEventEmitter<T> {
  private readonly emitter = new FakeEmitter<T>();

  readonly event = this.emitter.event;

  fire(value: T): void {
    this.emitter.fire(value);
  }

  dispose(): void {
    // Nothing owns a resource beyond its listeners, and disposing a real
    // `vscode.EventEmitter` does not silently unsubscribe them either --
    // only stops it from being fired again correctly. Callers here always
    // drop their own reference after disposing, so a no-op is faithful
    // enough for what this harness is asked to prove.
  }
}

// -- configuration --------------------------------------------------------

export class FakeConfig {
  private readonly sections = new Map<string, Map<string, unknown>>();

  set(section: string, key: string, value: unknown): void {
    if (!this.sections.has(section)) {
      this.sections.set(section, new Map());
    }
    this.sections.get(section)!.set(key, value);
  }

  getConfiguration(section: string): {
    get<T>(key: string, fallback?: T): T;
    update(key: string, value: unknown, target?: unknown): Promise<void>;
  } {
    const store = this.sections.get(section);
    return {
      get: <T>(key: string, fallback?: T): T =>
        store?.has(key) ? (store.get(key) as T) : (fallback as T),
      // #149: the values panel's follow toggle is the first setting this
      // extension ever writes rather than only reads -- `target` (a real
      // `vscode.ConfigurationTarget`) is accepted and ignored, the same way
      // a real `WorkspaceConfiguration.update` would ignore an
      // incompatible one for an `"application"`-scoped setting, since this
      // fake has no notion of separate user/workspace stores to route it
      // to.
      update: (key: string, value: unknown): Promise<void> => {
        this.set(section, key, value);
        return Promise.resolve();
      },
    };
  }
}

// -- the fake module itself -------------------------------------------------

export interface FakeVscode {
  /** The object to hand back for every `require('vscode')`. */
  readonly module: unknown;
  /**
   * Every `languages.registerHoverProvider` call activation made.
   *
   * #46 moved the hover off the decoration -- a `hoverMessage` cannot be
   * reached from a zero-width `after` attachment -- so registering a provider
   * is now part of the wiring, and something that fails to register is the
   * same silent nothing an unregistered command is.
   */
  readonly hoverProviders: ReadonlyArray<{
    readonly selector: unknown; readonly provider: unknown;
  }>;
  /**
   * Every `window.registerWebviewViewProvider` call activation made, keyed
   * by view id -- #116's values panel. A provider that never registers is
   * the same silent nothing an unregistered command or hover provider is:
   * the contributed view exists in `package.json` and opens to a blank pane.
   */
  readonly webviewViewProviders: ReadonlyMap<string, FakeWebviewViewProvider>;
  readonly commands: {
    readonly registered: ReadonlyMap<string, (...args: unknown[]) => unknown>;
    readonly executed: ReadonlyArray<{ readonly id: string; readonly args: readonly unknown[] }>;
  };
  /**
   * `vscode.commands.executeCommand`, exposed directly rather than through
   * `module`, so a test can invoke a command the way the palette and a
   * keybinding both do -- by id, rejecting if nothing registered it -- without
   * reaching past the fake's own typing to get at it.
   */
  readonly executeCommand: (id: string, ...args: unknown[]) => Promise<unknown>;
  /**
   * Every `workspace.openTextDocument({ content, language })` call (#155) --
   * *Open in editor*'s own path, and the only shape this fake implements:
   * opening an existing file by `Uri` is not something any production code
   * here does yet, so it is left unimplemented rather than half-faked.
   */
  readonly openedDocuments: readonly FakeDocument[];
  readonly contentProviders: ReadonlyMap<string, { provideTextDocumentContent(uri: FakeUri): string }>;
  readonly tabs: { all: { tabs: { input: unknown }[] }[] };
  /** Every `window.showTextDocument` call, in order -- see
   * `FakeShownDocument` for what each entry records and why. */
  readonly shownDocuments: readonly FakeShownDocument[];
  readonly outputChannels: FakeOutputChannel[];
  readonly decorationTypes: FakeDecorationType[];
  readonly statusBarItems: FakeStatusBarItem[];
  /**
   * Every `setStatusBarMessage` call, in order.
   *
   * The real API answers with a disposable and nothing else -- there is no
   * shared item here to inspect the way `statusBarItems` inspects
   * `createStatusBarItem`'s -- so a test that needs to know what a load's
   * summary said reads this instead of the (transient, never-recorded)
   * real status bar text.
   */
  readonly statusBarMessages: string[];
  readonly messages: {
    readonly error: Array<{ readonly message: string; readonly items: readonly string[] }>;
    readonly warning: Array<{ readonly message: string; readonly items: readonly string[] }>;
    readonly information: Array<{ readonly message: string; readonly items: readonly string[] }>;
  };
  /** What each of the three message kinds should answer with, in order. */
  readonly responses: {
    error: Array<string | undefined>;
    warning: Array<string | undefined>;
    information: Array<string | undefined>;
  };
  readonly clipboard: { readonly written: string[] };
  readonly config: FakeConfig;
  readonly extensions: Map<string, unknown>;
  /**
   * What `showQuickPick` should answer with, in order -- a queue of labels
   * a test pushes onto before triggering the pick, since a real person is
   * not here to read the list and choose one. `undefined` is `Escape`.
   */
  readonly quickPick: {
    readonly picks: Array<string | undefined>;
    readonly calls: ReadonlyArray<{
      readonly title: string | undefined;
      readonly placeHolder: string | undefined;
      readonly labels: readonly string[];
    }>;
  };
  /**
   * What `showInputBox` should answer with, in order -- a queue of typed
   * strings a test pushes onto before triggering the box, since a real
   * person is not here to type one. `undefined` is Escape, the close
   * button, or anything else that dismisses the box unanswered -- the same
   * "nothing was typed" `showInputBox` itself returns.
   */
  readonly inputBox: {
    readonly answers: Array<string | undefined>;
    readonly calls: ReadonlyArray<{
      readonly title: string | undefined;
      readonly prompt: string | undefined;
      readonly value: string | undefined;
      readonly placeHolder: string | undefined;
    }>;
  };
  readonly setContextCalls: Array<{ readonly key: string; readonly value: unknown }>;
  window: {
    activeTextEditor: FakeEditor | undefined;
    visibleTextEditors: FakeEditor[];
  };
  readonly emitters: {
    readonly onDidChangeTextDocument: FakeEmitter<{
      readonly document: FakeDocument;
      readonly contentChanges: readonly {
        readonly range: FakeRange;
        readonly text: string;
      }[];
    }>;
    readonly onDidCloseTextDocument: FakeEmitter<FakeDocument>;
    readonly onDidChangeTabs: FakeEmitter<{ closed: { input: unknown }[] }>;
    readonly onDidChangeActiveTextEditor: FakeEmitter<FakeEditor | undefined>;
    readonly onDidChangeVisibleTextEditors: FakeEmitter<readonly FakeEditor[]>;
    readonly onDidChangeConfiguration: FakeEmitter<{
      affectsConfiguration(section: string): boolean;
    }>;
    /** #116: the values panel's own cursor sync. */
    readonly onDidChangeTextEditorSelection: FakeEmitter<{
      readonly textEditor: FakeEditor;
      readonly selections: readonly FakeSelection[];
    }>;
  };
}

/** A fresh fake, independent of any other test's. */
export function createFakeVscode(): FakeVscode {
  const registered = new Map<string, (...args: unknown[]) => unknown>();
  const executed: Array<{ id: string; args: unknown[] }> = [];
  const outputChannels: FakeOutputChannel[] = [];
  const decorationTypes: FakeDecorationType[] = [];
  const statusBarItems: FakeStatusBarItem[] = [];
  const statusBarMessages: string[] = [];
  const setContextCalls: Array<{ key: string; value: unknown }> = [];
  const messages: FakeVscode['messages'] = { error: [], warning: [], information: [] };
  const responses: FakeVscode['responses'] = { error: [], warning: [], information: [] };
  const clipboardWritten: string[] = [];
  const config = new FakeConfig();
  const extensions = new Map<string, unknown>();
  const quickPickPicks: Array<string | undefined> = [];
  const quickPickCalls: Array<{
    readonly title: string | undefined;
    readonly placeHolder: string | undefined;
    readonly labels: readonly string[];
  }> = [];
  const inputBoxAnswers: Array<string | undefined> = [];
  const inputBoxCalls: Array<{
    readonly title: string | undefined;
    readonly prompt: string | undefined;
    readonly value: string | undefined;
    readonly placeHolder: string | undefined;
  }> = [];
  const openedDocuments: FakeDocument[] = [];
  const contentProviders = new Map<string, { provideTextDocumentContent(uri: FakeUri): string }>();
  const tabs = { all: [] as { tabs: { input: unknown }[] }[] };
  const shownDocuments: FakeShownDocument[] = [];
  let untitledCount = 0;

  const windowState: FakeVscode['window'] = {
    activeTextEditor: undefined,
    visibleTextEditors: [],
  };

  const emitters: FakeVscode['emitters'] = {
    onDidChangeTextDocument: new FakeEmitter(),
    onDidCloseTextDocument: new FakeEmitter(),
    onDidChangeTabs: new FakeEmitter(),
    onDidChangeActiveTextEditor: new FakeEmitter(),
    onDidChangeVisibleTextEditors: new FakeEmitter(),
    onDidChangeConfiguration: new FakeEmitter(),
    onDidChangeTextEditorSelection: new FakeEmitter(),
  };

  const webviewViewProviders = new Map<string, FakeWebviewViewProvider>();

  function showMessage(
    kind: 'error' | 'warning' | 'information',
    message: string,
    items: string[]
  ): Promise<string | undefined> {
    messages[kind].push({ message, items });
    return Promise.resolve(responses[kind].shift());
  }

  /**
   * VS Code's own commands that the impure files reach for -- never
   * something this extension registers, so keeping them out of `registered`
   * matters: that map is also what "activation registers exactly the
   * commands package.json contributes" compares against the manifest, and a
   * built-in stand-in in it would make that comparison pass for the wrong
   * reason. `executeCommand` still has to answer them, or every path through
   * `conflicts.ts` and `config.ts` that reaches for one fails here for a
   * reason no real VS Code window would ever produce.
   */
  const builtins = new Set([
    'python.setInterpreter',
    'workbench.action.openSettings',
    'workbench.action.openWalkthrough',
    'workbench.action.openGlobalKeybindings',
    'workbench.action.openGlobalKeybindingsFile',
    // Auto-generated by VS Code for every contributed view, never registered
    // by this extension -- the values panel's `Evalens: Show Values Panel`
    // command (#116) runs it to reveal and focus the view.
    'evalens.values.focus',
  ]);

  async function executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
    executed.push({ id, args });
    if (id === 'setContext') {
      setContextCalls.push({ key: args[0] as string, value: args[1] });
      return undefined;
    }
    const handler = registered.get(id);
    if (handler) {
      return handler(...args);
    }
    if (builtins.has(id)) {
      return undefined;
    }
    // The same shape a real palette invocation fails with: a rejection, not
    // a thrown exception, and a message naming the command.
    throw new Error(`command '${id}' not found`);
  }

  const hoverProviders: { selector: unknown; provider: unknown }[] = [];

  const vscodeModule = {
    Position: FakePosition,
    Range: FakeRange,
    Selection: FakeSelection,
    ThemeColor: FakeThemeColor,
    ThemeIcon: FakeThemeIcon,
    MarkdownString: FakeMarkdownString,
    Hover: FakeHover,
    EventEmitter: FakeEventEmitter,
    TabInputText: FakeTabInputText,
    TabInputTextDiff: FakeTabInputTextDiff,
    Uri: {
      from: (value: { scheme: string; path: string }) => ({
        fsPath: value.path, path: value.path,
        toString: () => `${value.scheme}:${value.path}`,
      }),
      file: (fsPath: string) => makeUri(fsPath),
      joinPath: (base: FakeUri, ...segments: string[]) =>
        makeUri(path.join(base.fsPath, ...segments)),
    },
    DecorationRangeBehavior: { ClosedOpen: 1, OpenOpen: 2, ClosedClosed: 3, OpenClosed: 0 },
    OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
    TextEditorRevealType: {
      Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3,
    },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    // #149: `toggleFollowValuesPanel` (config.ts) passes this to `update`,
    // the same real enum a `WorkspaceConfiguration.update` call takes --
    // this fake's `update` ignores the value (see `FakeConfig`, above) but
    // the identifier still has to exist for the compiled extension to read.
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    commands: {
      registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
        registered.set(id, handler);
        return { dispose: () => registered.delete(id) };
      },
      executeCommand,
    },
    window: {
      tabGroups: { get all() { return tabs.all; }, onDidChangeTabs: emitters.onDidChangeTabs.event },
      get activeTextEditor() {
        return windowState.activeTextEditor;
      },
      get visibleTextEditors() {
        return windowState.visibleTextEditors;
      },
      createOutputChannel: (name: string) => {
        const channel = makeOutputChannel(name);
        outputChannels.push(channel);
        return channel;
      },
      createTextEditorDecorationType: (options: unknown) => {
        const type = new FakeDecorationType(options);
        decorationTypes.push(type);
        return type;
      },
      createStatusBarItem: () => {
        const item = makeStatusBarItem();
        statusBarItems.push(item);
        return item;
      },
      createInputBox: () => makeInputBox(),
      setStatusBarMessage: (message: string) => {
        statusBarMessages.push(message);
        return { dispose: () => undefined };
      },
      showErrorMessage: (message: string, ...rest: unknown[]) =>
        showMessage('error', message, stringItems(rest)),
      showWarningMessage: (message: string, ...rest: unknown[]) =>
        showMessage('warning', message, stringItems(rest)),
      showInformationMessage: (message: string, ...rest: unknown[]) =>
        showMessage('information', message, stringItems(rest)),
      showInputBox: (options?: {
        title?: string; prompt?: string; value?: string; placeHolder?: string;
      }) => {
        inputBoxCalls.push({
          title: options?.title, prompt: options?.prompt,
          value: options?.value, placeHolder: options?.placeHolder,
        });
        return Promise.resolve(inputBoxAnswers.shift());
      },
      // Resolves against whatever list `render/explorer.ts` actually passed
      // in, by label, rather than against a fixed index -- the item order
      // changes with `trail.length` (the "Back" row only appears below the
      // root), and matching by label is what a person clicking one does too.
      showQuickPick: async (
        items: readonly FakeQuickPickItem[] | Thenable<readonly FakeQuickPickItem[]>,
        options?: { title?: string; placeHolder?: string }
      ): Promise<FakeQuickPickItem | undefined> => {
        const resolved = await items;
        quickPickCalls.push({
          title: options?.title, placeHolder: options?.placeHolder,
          labels: resolved.map((item) => item.label),
        });
        const label = quickPickPicks.shift();
        return label === undefined
          ? undefined
          : resolved.find((item) => item.label === label);
      },
      withProgress: async (
        _options: unknown,
        task: (
          progress: { report(): void },
          token: { onCancellationRequested(cb: () => void): void }
        ) => Promise<unknown>
      ) => task({ report: () => undefined }, { onCancellationRequested: () => undefined }),
      onDidChangeActiveTextEditor: emitters.onDidChangeActiveTextEditor.event,
      onDidChangeVisibleTextEditors: emitters.onDidChangeVisibleTextEditors.event,
      onDidChangeTextEditorSelection: emitters.onDidChangeTextEditorSelection.event,
      // #116: the values panel's own registration, on the same terms
      // `registerHoverProvider` below already documents -- a provider that
      // fails to register is a contributed view that opens to a blank pane,
      // silently.
      registerWebviewViewProvider: (
        viewId: string, provider: FakeWebviewViewProvider
      ) => {
        webviewViewProviders.set(viewId, provider);
        return { dispose: () => webviewViewProviders.delete(viewId) };
      },
      // #155: *Open in editor* opens the document `openTextDocument`
      // (below) just created. No real editor group exists here to move
      // focus into, so this only records the call -- `preserveFocus`
      // included, since a test checks the panel asked to keep it `false`.
      showTextDocument: (
        document: FakeDocument, options?: { readonly preserveFocus?: boolean }
      ) => {
        shownDocuments.push({ document, preserveFocus: options?.preserveFocus });
        return Promise.resolve(new FakeEditor(document));
      },
    },
    workspace: {
      registerTextDocumentContentProvider: (scheme: string,
        provider: { provideTextDocumentContent(uri: FakeUri): string }) => {
        contentProviders.set(scheme, provider);
        return { dispose: () => contentProviders.delete(scheme) };
      },
      getConfiguration: (section: string) => config.getConfiguration(section),
      onDidChangeTextDocument: emitters.onDidChangeTextDocument.event,
      onDidCloseTextDocument: emitters.onDidCloseTextDocument.event,
      onDidChangeConfiguration: emitters.onDidChangeConfiguration.event,
      // #155: *Open in editor*'s own path -- an untitled document holding
      // exactly the `content` it was given, the same shape
      // `panel/values.ts`'s `openInEditor` calls this with. Real VS Code
      // names an untitled document itself; this fake only needs each call
      // to produce a distinct one.
      openTextDocument: (
        options?: FakeUri | { readonly content?: string; readonly language?: string }
      ) => {
        if (options && 'fsPath' in options) {
          const scheme = options.toString().split(':')[0]!;
          const provider = contentProviders.get(scheme);
          if (!provider) throw new Error(`No content provider for ${scheme}`);
          const document = new FakeDocument(options,
            provider.provideTextDocumentContent(options), 'plaintext');
          openedDocuments.push(document);
          return Promise.resolve(document);
        }
        untitledCount += 1;
        const document = new FakeDocument(
          makeUri(`untitled:Untitled-${untitledCount}`),
          options?.content ?? '', options?.language ?? 'plaintext');
        openedDocuments.push(document);
        return Promise.resolve(document);
      },
    },
    languages: {
      // #46 moved the hover off the decoration and onto a real provider,
      // because a decoration's `hoverMessage` can never be reached from a
      // zero-width `after` attachment. Registering is all the wiring layer
      // does with it, so that is all this records -- what the provider
      // actually returns is covered where it is pure.
      registerHoverProvider: (
        selector: unknown, provider: unknown
      ) => {
        hoverProviders.push({ selector, provider });
        return { dispose: () => undefined };
      },
    },
    extensions: {
      getExtension: (id: string) => extensions.get(id),
    },
    env: {
      clipboard: {
        writeText: (text: string) => {
          clipboardWritten.push(text);
          return Promise.resolve();
        },
      },
    },
  };

  return {
    module: vscodeModule,
    hoverProviders,
    webviewViewProviders,
    commands: { registered, executed },
    executeCommand,
    openedDocuments, contentProviders, tabs,
    shownDocuments,
    outputChannels,
    decorationTypes,
    statusBarItems,
    statusBarMessages,
    messages,
    responses,
    clipboard: { written: clipboardWritten },
    config,
    extensions,
    quickPick: { picks: quickPickPicks, calls: quickPickCalls },
    inputBox: { answers: inputBoxAnswers, calls: inputBoxCalls },
    setContextCalls,
    window: windowState,
    emitters,
  };
}

function stringItems(rest: readonly unknown[]): string[] {
  return rest.filter((each): each is string => typeof each === 'string');
}

/** A one-document editor, visible and active, ready to hand to a command. */
export function createEditor(
  text: string, fsPath = '/fake/example.py', languageId = 'python'
): FakeEditor {
  const document = new FakeDocument(makeUri(fsPath), text, languageId);
  return new FakeEditor(document);
}

/** A minimal `vscode.ExtensionContext`, rooted at the real repository so the
 * kernel it points `activate` at is the one this checkout actually ships. */
export function createExtensionContext(extensionRootFsPath: string): {
  subscriptions: Array<{ dispose(): void }>;
  extensionUri: FakeUri;
  globalState: {
    get<T>(key: string, fallback?: T): T | undefined;
    update(key: string, value: unknown): Promise<void>;
  };
} {
  const subscriptions: Array<{ dispose(): void }> = [];
  const store = new Map<string, unknown>();
  return {
    subscriptions,
    extensionUri: makeUri(extensionRootFsPath),
    globalState: {
      get: <T>(key: string, fallback?: T) =>
        store.has(key) ? (store.get(key) as T) : fallback,
      update: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    },
  };
}

// -- loading the compiled extension against the fake -------------------------

/**
 * Drop every cached module under `outRoot` so the next `require` re-executes
 * them against a fresh fake, rather than reusing `extension.ts`'s
 * module-level `client`, `output` and `annotations` from a previous test.
 */
function purge(outRoot: string): void {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(outRoot + path.sep)) {
      delete require.cache[key];
    }
  }
}

export interface CompiledExtension {
  activate(context: unknown): void;
  deactivate(): void;
}

/**
 * `require(modulePath)` with `'vscode'` resolved to `fake.module`.
 *
 * The override is installed only for this one synchronous `require` call --
 * everything the compiled extension needs from `vscode` is bound once, at the
 * top of each compiled file, when it is first evaluated, so nothing later
 * calls `require('vscode')` again. Restoring the loader immediately keeps the
 * interception from leaking into whatever else runs in this test process.
 */
export function loadCompiledExtension(
  outRoot: string, fake: FakeVscode
): CompiledExtension {
  purge(outRoot);
  const moduleWithLoad = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = moduleWithLoad._load;
  moduleWithLoad._load = function (
    this: unknown, request: string, parent: unknown, isMain: boolean
  ): unknown {
    if (request === 'vscode') {
      return fake.module;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(path.join(outRoot, 'extension.js')) as CompiledExtension;
  } finally {
    moduleWithLoad._load = originalLoad;
  }
}
