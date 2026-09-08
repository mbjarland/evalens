import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { fullTextFor, rowsFor, valuesHtml } from '../panel/html';
import {
  FakeEditor, FakePosition, FakeSelection, FakeTabInputText,
  FakeTabInputTextDiff, FakeWebviewView, createEditor,
  createExtensionContext, createFakeVscode, loadCompiledExtension,
} from './harness/fakeVscode';

const root = path.resolve(__dirname, '../..');
const settled = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(source: string) {
  const fake = createFakeVscode();
  const editor = createEditor(source, '/tmp/recorded-å.py');
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = loadCompiledExtension(path.join(root, 'out'), fake);
  const context = createExtensionContext(root);
  extension.activate(context as never);
  const view = new FakeWebviewView();
  fake.webviewViewProviders.get('evalens.values')!.resolveWebviewView(view, {}, {});
  const revision = () => Number(/var revision = (\d+)/.exec(view.webview.html)![1]);
  const post = (data: object) => view.webview.fireMessage({ ...data, revision: revision() });
  const activate = (target: FakeEditor) => {
    fake.window.activeTextEditor = target;
    fake.emitters.onDidChangeActiveTextEditor.fire(target);
  };
  const dispose = () => {
    extension.deactivate();
    for (const disposable of context.subscriptions) disposable.dispose();
  };
  return { fake, editor, view, post, revision, activate, dispose };
}

test('recorded payloads preserve blank lines, trailing newlines and original repr whitespace', () => {
  const text = '  padded\tåäö 🐍\u00a0value\r\n\nlast\n';
  const rows = rowsFor({ lineAt: () => ({ text: 'value = compute()' }) }, [{
    range: { start: { line: 0 }, end: { line: 0 } }, display: 'value',
    value: text, isBinding: true, names: [{ name: 'source', value: '\tfirst\nsecond  ' }],
    printed: { stdout: '\n', stderr: text },
  }], '»');
  const row = rows[0]!;
  assert.equal(fullTextFor(row, 'value-0'), text);
  assert.equal(fullTextFor(row, 'value-1'), '\tfirst\nsecond  ');
  assert.equal(fullTextFor(row, '»'), '\n');
  assert.equal(fullTextFor(row, 'stderr'), text);
  assert.equal(row.streams![0]!.text, '(blank line)', 'display placeholder is never the export');
});

test('real kernel streams open whole-statement Unicode recordings without a new Python request', async () => {
  const f = fixture('import sys\nfor x in range(2):\n    for y in range(25):\n'
    + '        print(f"{x} {y}: åäö 🐍")\n        print(f"warning {x} {y}", file=sys.stderr)\n');
  const { KernelClient } = require('../kernel/client') as typeof import('../kernel/client');
  const request = KernelClient.prototype.request;
  let requests = 0;
  KernelClient.prototype.request = function (...args) { requests++; return request.apply(this, args); };
  try {
    await f.fake.executeCommand('evalens.evaluateFile');
    const before = requests;
    assert.ok(before > 0);
    f.post({ loop: 1, node: 2, action: 'open', value: 0 });
    f.post({ loop: 1, node: 2, action: 'open', value: 1 });
    await settled();
    assert.equal(requests, before, 'reading captures sends no eval, inspect, reset or other request');
    const stdout = f.fake.openedDocuments[0]!;
    const stderr = f.fake.openedDocuments[1]!;
    assert.equal(stdout.getText(), [0, 1].flatMap(x => Array.from({ length: 25 },
      (_, y) => `${x} ${y}: åäö 🐍\n`)).join(''));
    assert.equal(stderr.getText(), [0, 1].flatMap(x => Array.from({ length: 25 },
      (_, y) => `warning ${x} ${y}\n`)).join(''));
    assert.match(stdout.uri.toString(), /evalens-recording:.*recorded-å.py L2-5.*recorded printed output/);
    assert.match(stderr.uri.toString(), /recorded stderr output/);
    f.activate(new FakeEditor(stdout));
    const status = f.fake.statusBarItems.find(item => item.text.includes('Recorded printed output'))!;
    assert.ok(status.visible);
    assert.match(status.tooltip!, /whole statement/);
    assert.match(status.tooltip!, /not only the selected iteration/);
    assert.match(status.tooltip!, /Find searches this opened recording/);
  } finally { KernelClient.prototype.request = request; f.dispose(); }
});

test('native inspection and source return keep the same panel DOM, folds and old baseline', async () => {
  const f = fixture('for x in range(25):\n    print(x)\n');
  try {
    await f.fake.executeCommand('evalens.evaluateAtCursor');
    f.post({ loop: 0, node: 1, action: 'page', value: 1 });
    assert.match(f.view.webview.html, /Iterations 21–25/);
    f.post({ loop: 0, node: 23, action: 'select', value: 0 });
    const token = Number(/data-result-token="(\d+)"/.exec(f.view.webview.html)![1]);
    f.post({ resultFold: 0, collapsed: true, token });
    f.post({ loop: 0, node: 0, action: 'open', value: 0 });
    await settled();
    const recording = f.fake.openedDocuments[0]!;
    const before = f.view.webview.html;
    f.activate(new FakeEditor(recording));
    assert.equal(f.view.webview.html, before, 'native focus does not rebuild the DOM');
    f.activate(f.editor);
    assert.equal(f.view.webview.html, before, 'return does not rebuild the DOM');
    f.editor.document.setText('for x in range(2):\n    print(x * 10)\n');
    f.editor.selection = new FakeSelection(new FakePosition(0, 0), new FakePosition(0, 0));
    await f.fake.executeCommand('evalens.evaluateAtCursor');
    assert.equal(f.fake.contentProviders.get('evalens-recording')!
      .provideTextDocumentContent(recording.uri), Array.from({ length: 25 }, (_, i) => `${i}\n`).join(''));
    assert.ok(recording.getText().endsWith('24\n'));
    assert.match(f.view.webview.html, /data-result-closed="false"|class="whole-result"/);
  } finally { f.dispose(); }
});

test('repr export uses the previously captured multiline string and leaves stale evidence intact', async () => {
  const f = fixture('class Text:\n    def __repr__(self):\n'
    + '        return "  å 🐍\\tvalue\\n" * 120\nvalue = Text()\n');
  const { KernelClient } = require('../kernel/client') as typeof import('../kernel/client');
  const request = KernelClient.prototype.request;
  let requests = 0;
  KernelClient.prototype.request = function (...args) { requests++; return request.apply(this, args); };
  try {
    await f.fake.executeCommand('evalens.evaluateFile');
    assert.match(f.view.webview.html, /Open recorded value/);
    const before = requests;
    const range = new FakeSelection(new FakePosition(3, 0), new FakePosition(3, 0));
    f.editor.document.setText(f.editor.document.getText().replace('value = Text()', 'value = Text() # edited'));
    f.fake.emitters.onDidChangeTextDocument.fire({ document: f.editor.document,
      contentChanges: [{ range, text: '#' }] });
    f.post({ open: 3, stream: 'value-0' });
    await settled();
    assert.equal(requests, before);
    const recording = f.fake.openedDocuments[0]!;
    assert.equal(recording.getText(), '  å 🐍\tvalue\n'.repeat(120));
    assert.match(f.view.webview.html, /marked|edited|stale/);
    f.activate(new FakeEditor(recording));
    const status = f.fake.statusBarItems.find(item => item.text.includes('Recorded value text'))!;
    assert.match(status.tooltip!, /already marked old/);
    assert.match(status.tooltip!, /Recorded source \(preview\):\nvalue = Text\(\)/);
    assert.doesNotMatch(status.tooltip!, /# edited/);
    assert.match(status.tooltip!, /not the live Python object/);
  } finally { KernelClient.prototype.request = request; f.dispose(); }
});

test('closed native and diff tabs release recordings; open baselines are never evicted at the bound', async () => {
  const f = fixture('print("kept")\n');
  try {
    await f.fake.executeCommand('evalens.evaluateAtCursor');
    for (let index = 0; index < 32; index++) f.post({ open: 0, stream: 'printed' });
    await settled();
    assert.equal(f.fake.openedDocuments.length, 32);
    f.post({ open: 0, stream: 'printed' });
    await settled();
    assert.equal(f.fake.openedDocuments.length, 32);
    assert.match(f.fake.messages.information.at(-1)!.message, /Close an opened Evalens recording/);
    const first = f.fake.openedDocuments[0]!;
    const provider = f.fake.contentProviders.get('evalens-recording')!;
    const textTab = { input: new FakeTabInputText(first.uri) };
    const diffTab = { input: new FakeTabInputTextDiff(first.uri, f.editor.document.uri) };
    f.fake.tabs.all = [{ tabs: [diffTab] }];
    f.fake.emitters.onDidCloseTextDocument.fire(first);
    assert.equal(provider.provideTextDocumentContent(first.uri), 'kept\n', 'language-mode close does not evict open baseline');
    f.fake.emitters.onDidChangeTabs.fire({ closed: [textTab] });
    assert.equal(provider.provideTextDocumentContent(first.uri), 'kept\n', 'diff still owns baseline');
    f.fake.tabs.all = [];
    f.fake.emitters.onDidChangeTabs.fire({ closed: [diffTab] });
    assert.throws(() => provider.provideTextDocumentContent(first.uri), /has been closed/);
    f.post({ open: 0, stream: 'printed' });
    await settled();
    assert.equal(f.fake.openedDocuments.length, 33);
    const second = f.fake.openedDocuments[1]!;
    f.fake.emitters.onDidCloseTextDocument.fire(second);
    assert.throws(() => provider.provideTextDocumentContent(second.uri), /has been closed/);
    f.dispose();
    assert.equal(f.fake.contentProviders.size, 0);
  } finally { f.dispose(); }
});

test('queued exports cannot silently open a replacement result', async () => {
  const f = fixture('print("old")\n');
  try {
    await f.fake.executeCommand('evalens.evaluateAtCursor');
    const oldRevision = f.revision();
    await f.fake.executeCommand('evalens.evaluateAtCursor');
    f.view.webview.fireMessage({ open: 0, stream: 'printed', revision: oldRevision });
    await settled();
    assert.equal(f.fake.openedDocuments.length, 0);
    f.post({ open: 0, stream: 'printed' });
    await settled();
    assert.equal(f.fake.openedDocuments.length, 1);
  } finally { f.dispose(); }
});

test('value preview retains captured truncation notice and original representation when opened', () => {
  const value = `${'a'.repeat(12000)}… <truncated from 50000 chars>`;
  const rows = rowsFor({ lineAt: () => ({ text: 'value' }) }, [{
    range: { start: { line: 0 }, end: { line: 0 } }, value,
  }], 'printed');
  const html = valuesHtml({ fileName: 'text.py', rows }, 0, 'n', undefined,
    { expandedLines: new Set([0]) });
  assert.match(html, /truncated from 50000 chars/);
  assert.equal(fullTextFor(rows[0]!, 'value-0'), value);
});


test('source navigation from a recording reveals Python without moving the text recording cursor', async () => {
  const f = fixture('print("one")\nprint("two")\n');
  try {
    await f.fake.executeCommand('evalens.evaluateFile');
    f.post({ open: 1, stream: 'printed' });
    await settled();
    const reading = new FakeEditor(f.fake.openedDocuments[0]!);
    f.activate(reading);
    f.post({ goto: 1, explicit: true });
    await settled();
    const shown = f.fake.shownDocuments.at(-1)!;
    assert.equal(shown.document, f.editor.document);
    assert.equal(shown.preserveFocus, true, 'panel navigation retains panel focus');
    assert.equal(reading.selection.active.line, 0);
  } finally { f.dispose(); }
});


test('the compiled flat Open click dispatch reaches the provider with its render revision', async () => {
  const f = fixture('print("åäö 🐍\\n" * 60, end="")\n');
  const { KernelClient } = require('../kernel/client') as typeof import('../kernel/client');
  const request = KernelClient.prototype.request;
  let requests = 0;
  KernelClient.prototype.request = function (...args) { requests++; return request.apply(this, args); };
  try {
    await f.fake.executeCommand('evalens.evaluateAtCursor');
    const html = f.view.webview.html;
    const attrs = /<(?:span|button)\b([^>]*data-fold-action="open"[^>]*)>/.exec(html)![1]!;
    const attributes = new Map([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)]
      .map(match => [match[1]!, match[2]!]));
    let click: ((event: { stopPropagation(): void }) => void) | undefined;
    const control = {
      getAttribute: (name: string) => attributes.get(name),
      addEventListener: (event: string, listener: typeof click) => {
        if (event === 'click') click = listener;
      },
    };
    // Execute the actual compiled webview listener. A hand-built message
    // with a revision would miss a sender/receiver contract break entirely.
    const start = html.indexOf('var foldControls =');
    const end = html.indexOf("document.querySelectorAll('[data-stale-cause]')", start);
    assert.ok(start > 0 && end > start);
    runInNewContext(/var revision = \d+;/.exec(html)![0] + html.slice(start, end), {
      document: { querySelectorAll: (selector: string) => {
        assert.equal(selector, '[data-fold-action]'); return [control];
      } },
      vscode: { postMessage: (message: unknown) => f.view.webview.fireMessage(message) },
    });
    assert.ok(click);
    let stopped = false;
    const before = requests;
    click({ stopPropagation: () => { stopped = true; } });
    await settled();
    assert.ok(stopped, 'export does not also navigate the source row');
    assert.equal(requests, before, 'opening the recording adds no Python request');
    assert.equal(f.fake.openedDocuments.length, 1);
    assert.equal(f.fake.openedDocuments[0]!.getText(), 'åäö 🐍\n'.repeat(60));
    await f.fake.executeCommand('evalens.evaluateAtCursor');
    click({ stopPropagation() {} });
    await settled();
    assert.equal(f.fake.openedDocuments.length, 1, 'a queued click from the replaced render is rejected');
  } finally { KernelClient.prototype.request = request; f.dispose(); }
});


test('one-group recording transitions keep a preview source through undefined editor events', async () => {
  const f = fixture('print("preview source")\n');
  try {
    await f.fake.executeCommand('evalens.evaluateAtCursor');
    const sourceTab = { input: new FakeTabInputText(f.editor.document.uri), isPreview: true };
    f.fake.tabs.all = [{ tabs: [sourceTab] }];
    const original = f.view.webview.html;
    f.post({ open: 0, stream: 'printed' });
    f.fake.window.activeTextEditor = undefined;
    f.fake.window.visibleTextEditors = [];
    f.fake.emitters.onDidChangeActiveTextEditor.fire(undefined);
    assert.equal(f.view.webview.html, original, 'the intermediate empty editor is not a source close');
    await settled();
    const reading = new FakeEditor(f.fake.openedDocuments[0]!);
    f.fake.tabs.all[0]!.tabs.push({ input: new FakeTabInputText(reading.document.uri) });
    f.activate(reading);
    assert.equal(f.view.webview.html, original, 'the source preview remains the panel context');
    f.fake.window.activeTextEditor = undefined;
    f.fake.emitters.onDidChangeActiveTextEditor.fire(undefined);
    assert.equal(f.view.webview.html, original, 'the source-return transition keeps the same DOM');
    const returned = new FakeEditor(f.editor.document);
    f.activate(returned);
    assert.equal(f.view.webview.html, original, 'a new editor handle for the same document preserves DOM');
    f.activate(reading);
    f.fake.tabs.all = [{ tabs: [{ input: new FakeTabInputText(reading.document.uri) }] }];
    f.fake.emitters.onDidChangeTabs.fire({ closed: [sourceTab] });
    assert.match(f.view.webview.html, /<p>Open a Python file\.<\/p>/);
    assert.doesNotMatch(f.view.webview.html, /<tr class="row/,
      'closing the source tab releases context even if VS Code caches its document');
    assert.equal(reading.document.getText(), 'preview source\n', 'the explicit recording remains readable');
  } finally { f.dispose(); }
});
