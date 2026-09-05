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
    text: string
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
  /** The latest `setDecorations` call for each type, keyed by the type. */
  readonly painted = new Map<FakeDecorationType, readonly PaintedOptions[]>();

  constructor(public document: FakeDocument, selection?: FakeSelection) {
    this.selection = selection
      ?? new FakeSelection(new FakePosition(0, 0), new FakePosition(0, 0));
  }

  setDecorations(type: FakeDecorationType, options: readonly PaintedOptions[]): void {
    this.painted.set(type, options);
  }

  revealRange(range: FakeRange): void {
    this.revealed.push(range);
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

// -- configuration --------------------------------------------------------

export class FakeConfig {
  private readonly sections = new Map<string, Map<string, unknown>>();

  set(section: string, key: string, value: unknown): void {
    if (!this.sections.has(section)) {
      this.sections.set(section, new Map());
    }
    this.sections.get(section)!.set(key, value);
  }

  getConfiguration(section: string): { get<T>(key: string, fallback?: T): T } {
    const store = this.sections.get(section);
    return {
      get: <T>(key: string, fallback?: T): T =>
        store?.has(key) ? (store.get(key) as T) : (fallback as T),
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
  readonly outputChannels: FakeOutputChannel[];
  readonly decorationTypes: FakeDecorationType[];
  readonly statusBarItems: FakeStatusBarItem[];
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
    readonly onDidChangeActiveTextEditor: FakeEmitter<FakeEditor | undefined>;
    readonly onDidChangeVisibleTextEditors: FakeEmitter<readonly FakeEditor[]>;
    readonly onDidChangeConfiguration: FakeEmitter<{
      affectsConfiguration(section: string): boolean;
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
  const setContextCalls: Array<{ key: string; value: unknown }> = [];
  const messages: FakeVscode['messages'] = { error: [], warning: [], information: [] };
  const responses: FakeVscode['responses'] = { error: [], warning: [], information: [] };
  const clipboardWritten: string[] = [];
  const config = new FakeConfig();
  const extensions = new Map<string, unknown>();

  const windowState: FakeVscode['window'] = {
    activeTextEditor: undefined,
    visibleTextEditors: [],
  };

  const emitters: FakeVscode['emitters'] = {
    onDidChangeTextDocument: new FakeEmitter(),
    onDidCloseTextDocument: new FakeEmitter(),
    onDidChangeActiveTextEditor: new FakeEmitter(),
    onDidChangeVisibleTextEditors: new FakeEmitter(),
    onDidChangeConfiguration: new FakeEmitter(),
  };

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
    'workbench.action.openGlobalKeybindings',
    'workbench.action.openGlobalKeybindingsFile',
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
    Uri: {
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
    commands: {
      registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
        registered.set(id, handler);
        return { dispose: () => registered.delete(id) };
      },
      executeCommand,
    },
    window: {
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
      setStatusBarMessage: () => ({ dispose: () => undefined }),
      showErrorMessage: (message: string, ...rest: unknown[]) =>
        showMessage('error', message, stringItems(rest)),
      showWarningMessage: (message: string, ...rest: unknown[]) =>
        showMessage('warning', message, stringItems(rest)),
      showInformationMessage: (message: string, ...rest: unknown[]) =>
        showMessage('information', message, stringItems(rest)),
      showInputBox: () => Promise.resolve(undefined),
      withProgress: async (
        _options: unknown,
        task: (
          progress: { report(): void },
          token: { onCancellationRequested(cb: () => void): void }
        ) => Promise<unknown>
      ) => task({ report: () => undefined }, { onCancellationRequested: () => undefined }),
      onDidChangeActiveTextEditor: emitters.onDidChangeActiveTextEditor.event,
      onDidChangeVisibleTextEditors: emitters.onDidChangeVisibleTextEditors.event,
    },
    workspace: {
      getConfiguration: (section: string) => config.getConfiguration(section),
      onDidChangeTextDocument: emitters.onDidChangeTextDocument.event,
      onDidCloseTextDocument: emitters.onDidCloseTextDocument.event,
      onDidChangeConfiguration: emitters.onDidChangeConfiguration.event,
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
    commands: { registered, executed },
    executeCommand,
    outputChannels,
    decorationTypes,
    statusBarItems,
    messages,
    responses,
    clipboard: { written: clipboardWritten },
    config,
    extensions,
    setContextCalls,
    window: windowState,
    emitters,
  };
}

function stringItems(rest: readonly unknown[]): string[] {
  return rest.filter((each): each is string => typeof each === 'string');
}

/** A one-document editor, visible and active, ready to hand to a command. */
export function createEditor(text: string, fsPath = '/fake/example.py'): FakeEditor {
  const document = new FakeDocument(makeUri(fsPath), text);
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
