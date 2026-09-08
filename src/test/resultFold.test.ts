import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { ResultFolds, ResultFoldRow } from '../panel/resultFold';
import { resultFoldSummary, rowsFor, valuesHtml } from '../panel/html';
import {
  FakePosition, FakeRange, FakeSelection, FakeWebviewView, createEditor,
  createExtensionContext, createFakeVscode, loadCompiledExtension,
} from './harness/fakeVscode';

const root = path.resolve(__dirname, '..', '..');
const row = (extra: Partial<ResultFoldRow> = {}): ResultFoldRow => ({
  resultIdentity: {}, capturedSource: 'for n in range(30):\n    print(n)',
  startLine: 0, endLine: 1, line: 0, state: 'complete', ...extra,
});

test('whole-result choices follow capture identity across prefix edits and staleness', () => {
  const folds = new ResultFolds();
  const document = {};
  const first = row();
  const state = folds.sync(document, [first]).get(0)!;
  state.collapsed = true;
  state.expanded = true;
  const moved = { ...first, startLine: 4, endLine: 5, line: 4, staleReason: 'dependency' };
  assert.equal(folds.sync(document, [moved]).get(4), state);
  assert.equal(folds.sync(document, [{ ...moved, staleReason: 'edited' }]).get(4), state);
  assert.equal(folds.sync({}, [moved]).get(4)!.collapsed, false);
});

test('only a safely matched replacement inherits collapsed choice and never inner expansion', () => {
  const folds = new ResultFolds();
  const document = {};
  const first = row();
  const old = folds.sync(document, [first]).get(0)!;
  old.collapsed = true;
  old.expanded = true;
  const fresh = folds.sync(document, [row()]).get(0)!;
  assert.equal(fresh.collapsed, true);
  assert.equal(fresh.expanded, undefined);
  assert.notEqual(fresh.identity, old.identity);
  assert.equal(folds.sync(document, [row({ capturedSource: 'different' })]).get(0)!.collapsed, false);
  const edited = row({ staleReason: 'edited' });
  folds.sync(document, [edited]).get(0)!.collapsed = true;
  assert.equal(folds.sync(document, [row()]).get(0)!.collapsed, false);
});

test('pending replacement remembers only the previous choice until full source can be compared', () => {
  const folds = new ResultFolds();
  const document = {};
  folds.sync(document, [row()]).get(0)!.collapsed = true;
  const pending = row({ resultIdentity: undefined, capturedSource: undefined, state: 'pending' });
  folds.sync(document, [pending]);
  folds.sync(document, [pending]);
  assert.equal(folds.sync(document, [row()]).get(0)!.collapsed, true);
  folds.sync(document, [pending]);
  assert.equal(folds.sync(document, [row({ capturedSource: 'different' })]).get(0)!.collapsed, false);
});

test('clear, displacement and document close release whole-result preferences', () => {
  const folds = new ResultFolds();
  const document = {};
  const first = row();
  for (const remove of [() => folds.sync(document, []), () => folds.close(document), () => folds.clear()]) {
    folds.sync(document, [first]).get(0)!.collapsed = true;
    remove();
    assert.equal(folds.sync(document, [first]).get(0)!.collapsed, false);
  }
  folds.sync(document, [first]).get(0)!.collapsed = true;
  folds.sync(document, [row({ startLine: 4, endLine: 5, line: 4 })]);
  assert.equal(folds.sync(document, [first]).get(0)!.collapsed, false);
});

test('folded summaries keep error, stale, partial and stream-capture facts separate', () => {
  const base = { line: 0, startLine: 0, endLine: 0, codeLines: ['print()'], state: 'evaluated' as const };
  assert.deepEqual(resultFoldSummary({ ...base, streams: [{ label: 'printed', text: 'one\ntwo' }] }),
    { text: '2 printed lines', status: '' });
  assert.deepEqual(resultFoldSummary({ ...base, state: 'stale', errorText: 'ValueError: message',
    partialFrom: 9, streams: [{ label: 'printed', text: 'one\n… <99 characters omitted from trace>' }] }),
  { text: 'ValueError: message · captured printed output', status: 'Stale · Error · Partial run · Output truncated' });
});

test('collapsed stale error keeps essential facts in text and keyboard description', () => {
  const rows = rowsFor({ lineAt: () => ({ text: 'raise ValueError("old")' }) }, [{
    range: { start: { line: 0 }, end: { line: 0 } },
    error: { type: 'ValueError', message: 'old' }, stale: true,
    staleReason: 'edited', partialFrom: 9,
    printed: { stdout: 'one\n… <99 characters omitted from trace>' },
  }], 'printed');
  const html = valuesHtml({ fileName: 'test.py', rows }, 0, 'n', undefined,
    { resultFolds: new Map([[0, { identity: 42, collapsed: true }]]) });
  assert.match(html, /class="result-summary-status error-text">Stale · Error · Partial run · Output truncated/);
  assert.match(html, /aria-description="[^"<>]*Stale · Error · Partial run · Output truncated[^"<>]*Recorded during evaluation; not live state/);
});

test('generic folded stream counts include intentional trailing blank lines exactly once', () => {
  const summaryFor = (stdout: string) => resultFoldSummary(rowsFor({ lineAt: () => ({ text: 'print()' }) }, [{
    range: { start: { line: 0 }, end: { line: 0 } }, printed: { stdout },
  }], 'printed')[0]!).text;
  assert.equal(summaryFor('reading\n'.repeat(80) + '\n'), '81 printed lines');
  assert.equal(summaryFor('\n\n'), '2 printed lines');
  assert.equal(summaryFor('\n'), '1 printed line');
});

test('whole-result markup has one disclosure and the complete source and latest label outside its detail', () => {
  const rows = rowsFor({ lineAt: () => ({ text: 'print("output")' }) }, [{
    range: { start: { line: 0 }, end: { line: 0 } }, printed: { stdout: 'line\n'.repeat(30) },
  }], 'printed');
  const html = valuesHtml({ fileName: 'test.py', rows, latestResultLine: 0 }, 0, 'n', undefined,
    { resultFolds: new Map([[0, { identity: 42, collapsed: true }]]) });
  assert.equal((html.match(/class="result-disclosure"/g) ?? []).length, 1);
  assert.match(html, /class="source-content">[\s\S]*Latest result<\/span><\/div><\/td>/);
  assert.match(html, /class="whole-result result-collapsed" data-result-line="0" data-result-token="42"/);
  assert.match(html, /aria-expanded="false" aria-controls="result-detail-0"/);
  assert.match(html, /class="result-detail" id="result-detail-0" hidden/);
  assert.match(html, /new ResizeObserver/);
  assert.doesNotMatch(html, /setInterval/);
});

function fixture(source = 'for n in range(30):\n    print(n)\nnext_value = 42\n') {
  const fake = createFakeVscode();
  const editor = createEditor(source);
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = loadCompiledExtension(path.resolve(__dirname, '..'), fake);
  extension.activate(createExtensionContext(root) as never);
  const provider = fake.webviewViewProviders.get('evalens.values')!;
  const view = new FakeWebviewView();
  provider.resolveWebviewView(view, {}, {});
  const cursor = (line: number) => {
    editor.selection = new FakeSelection(new FakePosition(line, 0), new FakePosition(line, 0));
    fake.emitters.onDidChangeTextEditorSelection.fire({ textEditor: editor, selections: [editor.selection] });
  };
  const rebuild = () => fake.emitters.onDidChangeActiveTextEditor.fire(editor);
  const revision = () => Number(/var revision = (\d+);/.exec(view.webview.html)![1]);
  const token = (line = 0) => Number(new RegExp(`data-result-line="${line}" data-result-token="(\\d+)"`).exec(view.webview.html)![1]);
  const fold = (line = 0, collapsed = true) => view.webview.fireMessage({
    resultFold: line, collapsed, token: token(line), revision: revision(),
  });
  return { fake, editor, extension, provider, view, cursor, rebuild, revision, token, fold,
    evaluate: () => fake.executeCommand('evalens.evaluateAtCursor') };
}

test('whole-fold messages persist without rebuilding, navigating or accepting old captures', async () => {
  const { fake, editor, extension, view, cursor, rebuild, revision, token, fold, evaluate } = fixture();
  try {
    await evaluate();
    cursor(2);
    const oldHtml = view.webview.html;
    fold();
    assert.equal(view.webview.html, oldHtml, 'the actual webview handles immediate visual toggling');
    assert.equal(editor.selection.active.line, 2);
    rebuild();
    assert.match(view.webview.html, /class="whole-result result-collapsed"/);
    view.webview.fireMessage({ resultFold: 0, collapsed: false, token: token(), revision: revision() - 1 });
    view.webview.fireMessage({ resultFold: 0, collapsed: false, token: token() + 100, revision: revision() });
    rebuild();
    assert.match(view.webview.html, /class="whole-result result-collapsed"/);
    assert.equal(fake.shownDocuments.length, 0);
  } finally { extension.deactivate(); }
});

test('whole folds keep nested pages across view recreation, reset inner IDs on replacement and clear', async () => {
  const { fake, extension, provider, view, rebuild, revision, token, fold, evaluate } = fixture();
  try {
    await evaluate();
    view.webview.fireMessage({ loop: 0, node: 1, action: 'page', value: 1, revision: revision() });
    assert.match(view.webview.html, /21–30/);
    const oldToken = token();
    fold();
    rebuild();
    assert.match(view.webview.html, /21–30/);
    view.fireDispose();
    const reopened = new FakeWebviewView();
    provider.resolveWebviewView(reopened, {}, {});
    assert.match(reopened.webview.html, /class="whole-result result-collapsed"/);
    assert.match(reopened.webview.html, /21–30/);
    await evaluate();
    assert.match(reopened.webview.html, /class="whole-result result-collapsed"/);
    assert.match(reopened.webview.html, /1–20/);
    assert.notEqual(Number(/data-result-token="(\d+)"/.exec(reopened.webview.html)![1]), oldToken);
    await fake.executeCommand('evalens.clearResults');
    await evaluate();
    assert.doesNotMatch(reopened.webview.html, /class="whole-result result-collapsed"/);
  } finally { extension.deactivate(); }
});

test('whole fold and generic Show all survive a prefix edit, while own-code replacement resets choice', async () => {
  const { fake, editor, extension, view, token, fold, evaluate } = fixture('print("row\\n" * 100)\n');
  try {
    await evaluate();
    view.webview.fireMessage({ expand: 0 });
    const oldToken = token();
    fold();
    const prefix = '# note\n';
    editor.document.setText(prefix + editor.document.getText());
    fake.emitters.onDidChangeTextDocument.fire({ document: editor.document, contentChanges: [{
      range: new FakeRange(0, 0, 0, 0), text: prefix,
    }] });
    assert.equal(token(1), oldToken);
    assert.match(view.webview.html, /class="whole-result result-collapsed"/);
    assert.match(view.webview.html, /class="fold-scroll"/);
    editor.document.setText('# note\nprint("different\\n" * 100)\n');
    fake.emitters.onDidChangeTextDocument.fire({ document: editor.document, contentChanges: [{
      range: new FakeRange(1, 7, 1, 10), text: 'different',
    }] });
    editor.selection = new FakeSelection(new FakePosition(1, 0), new FakePosition(1, 0));
    await evaluate();
    assert.doesNotMatch(view.webview.html, /class="whole-result result-collapsed"/);
  } finally { extension.deactivate(); }
});

test('clearing a pending replacement immediately releases its remembered collapsed choice', async () => {
  const { fake, extension, view, fold, evaluate } = fixture(
    'for n in range(3):\n    __import__("time").sleep(0.05)\n    print(n)\n');
  try {
    await evaluate();
    fold();
    const running = evaluate();
    await fake.executeCommand('evalens.clearResults');
    await running;
    assert.doesNotMatch(view.webview.html, /class="whole-result/);
    await evaluate();
    assert.doesNotMatch(view.webview.html, /class="whole-result result-collapsed"/);
  } finally { extension.deactivate(); }
});
