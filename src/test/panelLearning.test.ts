import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { valuesHtml, ValuesRow } from '../panel/html';
import {
  INTRO_DISMISSED_KEY, LEARNING_SCRIPT, evaluationShortcuts,
} from '../panel/learningHelp';
import {
  FakeWebviewView, createEditor, createExtensionContext, createFakeVscode,
  loadCompiledExtension,
} from './harness/fakeVscode';

const root = path.resolve(__dirname, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function fixture(context = createExtensionContext(root)) {
  const fake = createFakeVscode();
  Object.assign(fake.module as object, { ViewColumn: { Beside: -2 } });
  const editor = createEditor('answer = 42\nnext_answer = 43\n');
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = loadCompiledExtension(path.join(root, 'out'), fake);
  extension.activate(context as never);
  const provider = fake.webviewViewProviders.get('evalens.values')!;
  const view = new FakeWebviewView();
  provider.resolveWebviewView(view, {}, {});
  const revision = () => Number(/var revision = (\d+)/.exec(view.webview.html)![1]);
  const post = (message: object) => view.webview.fireMessage({ ...message, revision: revision() });
  const rebuild = () => fake.emitters.onDidChangeActiveTextEditor.fire(fake.window.activeTextEditor);
  const dispose = () => {
    extension.deactivate();
    for (const subscription of context.subscriptions) subscription.dispose();
  };
  return { fake, editor, context, view, post, rebuild, dispose };
}

test('empty panel shows the correct default evaluation shortcuts on each platform', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const html = valuesHtml({ fileName: 'example.py', rows: [] }, undefined, 'n',
      undefined, undefined, true, 0, true, false, { platform });
    const keys = evaluationShortcuts(platform);
    const commands = ['evaluateAtCursor', 'evaluateAndAdvance'];
    for (const [index, shortcut] of [keys.evaluate, keys.advance].entries()) {
      const binding = manifest.contributes.keybindings.find((item: { command: string }) =>
        item.command === `evalens.${commands[index]}`);
      assert.equal(shortcut.toLowerCase(), platform === 'darwin' ? binding.mac : binding.key);
      assert.ok(html.includes(`<kbd>${shortcut}</kbd>`));
    }
    assert.match(html, /Try a guided example/);
    assert.match(html, /default shortcuts/);
    assert.match(html, /data-learning-toggle aria-controls="learning-help" aria-expanded="false"/);
    assert.match(html, /id="learning-help"[^>]* hidden/);
  }
});

test('intro dismissal persists across provider recreation and reopening is explicit', async () => {
  const first = fixture();
  first.post({ learningAction: 'dismiss-intro' });
  assert.equal(first.context.globalState.get(INTRO_DISMISSED_KEY), true);
  first.rebuild();
  assert.match(first.view.webview.html, /id="learning-intro"[^>]* hidden/);
  first.dispose();
  const nextContext = createExtensionContext(root);
  nextContext.globalState = first.context.globalState;
  const second = fixture(nextContext);
  try {
    assert.match(second.view.webview.html, /id="learning-intro"[^>]* hidden/);
    assert.match(second.view.webview.html, /id="learning-help"[^>]* hidden/);
    second.post({ learningTopic: 'help', learningOpen: true });
    second.post({ learningAction: 'show-intro' });
    second.rebuild();
    assert.doesNotMatch(second.view.webview.html, /id="learning-intro"[^>]* hidden/);
    assert.equal(second.context.globalState.get(INTRO_DISMISSED_KEY), false);
  } finally { second.dispose(); }
});

test('dismissal never hides result evidence or the three stateful preferences', () => {
  const rows: ValuesRow[] = [{ line: 0, startLine: 0, endLine: 0,
    codeLines: ['answer'], state: 'stale', staleReason: 'edited',
    errorText: 'ValueError: bad input' }];
  const render = (introDismissed: boolean) => valuesHtml({ fileName: 'old.py', rows },
    0, 'n', undefined, undefined, false, 7, false, true, { introDismissed });
  const original = render(false);
  const dismissed = render(true);
  assert.equal(/<table>[\s\S]*?<\/table>/.exec(original)?.[0],
    /<table>[\s\S]*?<\/table>/.exec(dismissed)?.[0]);
  assert.match(dismissed, /id="follow-cursor" type="checkbox" >/);
  assert.match(dismissed, /id="follow-panel" type="checkbox" >/);
  assert.match(dismissed, /id="hide-inline-values" type="checkbox" checked/);
  assert.match(dismissed, /data-learning-toggle/);
});

test('help choices survive file and result rebuilds without opening themselves', async () => {
  const f = fixture();
  try {
    await f.fake.executeCommand('evalens.evaluateAtCursor');
    assert.match(f.view.webview.html, /id="learning-help"[^>]* hidden/);
    f.post({ learningAction: 'dismiss-intro' });
    f.post({ learningTopic: 'help', learningOpen: true });
    f.post({ learningTopic: 'results', learningOpen: true });
    await f.fake.executeCommand('evalens.evaluateAtCursor');
    assert.match(f.view.webview.html, /id="learning-intro"[^>]* hidden/);
    assert.doesNotMatch(f.view.webview.html, /id="learning-help"[^>]* hidden/);
    assert.match(f.view.webview.html, /data-learning-topic="results" open/);
    f.fake.window.activeTextEditor = createEditor('another = 9', '/tmp/another.py');
    f.rebuild();
    assert.match(f.view.webview.html, /id="learning-intro"[^>]* hidden/);
    assert.match(f.view.webview.html, /data-learning-topic="results" open/);
    assert.match(f.view.webview.html, /Try a guided example/);
  } finally { f.dispose(); }
});

test('help actions are revision guarded, allowlisted, and inactive while hidden', async () => {
  const f = fixture();
  try {
    const before = f.fake.commands.executed.length;
    for (const action of ['evalens.evaluateFile', 'evalens.restartKernel', 'https://example.org', {}, null]) {
      f.post({ learningAction: action });
    }
    f.view.webview.fireMessage({ learningAction: 'dismiss-intro', revision: -1 });
    f.view.webview.fireMessage({ learningAction: 'exercise' });
    f.view.visible = false;
    f.post({ learningAction: 'walkthrough' });
    assert.equal(f.fake.commands.executed.length, before);
    assert.equal(f.context.globalState.get(INTRO_DISMISSED_KEY), undefined);
  } finally { f.dispose(); }
});

test('panel walkthrough and editable exercise actions issue no kernel request', async () => {
  const f = fixture();
  const { KernelClient } = require('../kernel/client') as typeof import('../kernel/client');
  const request = KernelClient.prototype.request;
  let requests = 0;
  KernelClient.prototype.request = function (...args) {
    requests++;
    return request.apply(this, args);
  };
  try {
    await f.fake.executeCommand('evalens.evaluateAtCursor');
    assert.ok(requests > 0, 'the probe observes the real evaluation pipe');
    const before = requests;
    f.post({ learningTopic: 'help', learningOpen: true });
    f.post({ learningAction: 'walkthrough' });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(f.fake.commands.executed.some(command => command.id === 'workbench.action.openWalkthrough'));
    f.fake.quickPick.picks.push('1. Predict a value');
    f.post({ learningAction: 'exercise' });
    for (let attempt = 0; attempt < 100 && !f.fake.openedDocuments.length; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const exercise = f.fake.openedDocuments.at(-1)!;
    assert.equal(exercise.languageId, 'python');
    assert.match(exercise.uri.toString(), /untitled:/);
    assert.match(exercise.getText(), /Predict/);
    assert.equal(requests, before, 'help and examples send no eval/reset/inspect request');
  } finally {
    KernelClient.prototype.request = request;
    f.dispose();
  }
});

test('the shipped help script updates only optional content and posts fixed action state', () => {
  type Element = { hidden?: boolean; dataset?: object; open?: boolean;
    handlers: Record<string, () => void>; addEventListener(type: string, fn: () => void): void;
    setAttribute(type: string, value: string): void; focus(): void };
  const element = (extra = {}): Element => ({ handlers: {},
    addEventListener(type, fn) { this.handlers[type] = fn; },
    setAttribute() {}, focus() {}, ...extra });
  const toggle = element();
  const intro = element({ hidden: false });
  const help = element({ hidden: true });
  const dismiss = element({ dataset: { learningAction: 'dismiss-intro' } });
  const show = element({ hidden: true, dataset: { learningAction: 'show-intro' } });
  const topic = element({ open: true, dataset: { learningTopic: 'debugger' } });
  const messages: unknown[] = [];
  const scrolls: unknown[] = [];
  Object.assign(help, { getBoundingClientRect: () => ({ top: 100 }) });
  Object.assign(intro, { getBoundingClientRect: () => ({ top: 70 }) });
  runInNewContext(LEARNING_SCRIPT, { revision: 4,
    window: { scrollY: 20, scrollTo: (position: unknown) => scrolls.push(position) },
    vscode: { postMessage: (value: unknown) => messages.push(JSON.parse(JSON.stringify(value))) },
    document: {
      querySelectorAll: (selector: string) => selector === '[data-learning-toggle]' ? [toggle]
        : selector === '[data-learning-topic]' ? [topic] : [dismiss, show],
      querySelector: (selector: string) => selector.includes('show-intro') ? show : toggle,
      getElementById: (id: string) => id === 'navigation-control'
        ? { getBoundingClientRect: () => ({ height: 30 }) }
        : id === 'learning-intro' ? intro : help,
    },
  });
  toggle.handlers.click();
  assert.equal(help.hidden, false);
  dismiss.handlers.click();
  assert.equal(intro.hidden, true);
  assert.equal(show.hidden, false);
  show.handlers.click();
  assert.equal(intro.hidden, false);
  assert.equal(scrolls.length, 2, 'explicit opening reveals guidance even from far down a result');
  topic.handlers.toggle();
  assert.deepEqual(messages, [
    { learningTopic: 'help', learningOpen: true, revision: 4 },
    { learningAction: 'dismiss-intro', revision: 4 },
    { learningAction: 'show-intro', revision: 4 },
    { learningTopic: 'debugger', learningOpen: true, revision: 4 },
  ]);
});
