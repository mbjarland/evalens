import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { ValuesRow, valuesHtml } from '../panel/html';
import {
  FakePosition, FakeRange, FakeSelection, FakeWebviewView, createEditor,
  createExtensionContext, createFakeVscode, loadCompiledExtension,
} from './harness/fakeVscode';

const root = path.resolve(__dirname, '..', '..');

/** These commands use the compiled extension and its real Python subprocess.
 * The fake owns only the editor/webview shell, not evaluation or rendering. */
function fixture(source: string) {
  const fake = createFakeVscode();
  const editor = createEditor(source);
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = loadCompiledExtension(path.resolve(__dirname, '..'), fake);
  extension.activate(createExtensionContext(root) as never);
  const provider = fake.webviewViewProviders.get('evalens.values')!;
  const view = new FakeWebviewView();
  provider.resolveWebviewView(view, {}, {});
  const cursor = (line: number, target = editor) => {
    target.selection = new FakeSelection(new FakePosition(line, 0), new FakePosition(line, 0));
    fake.emitters.onDidChangeTextEditorSelection.fire({
      textEditor: target, selections: [target.selection],
    });
  };
  const activate = (target: typeof editor) => {
    fake.window.activeTextEditor = target;
    fake.emitters.onDidChangeActiveTextEditor.fire(target);
  };
  return { fake, editor, extension, provider, view, cursor, activate,
    evaluate: () => fake.executeCommand('evalens.evaluateAtCursor'),
    advance: () => fake.executeCommand('evalens.evaluateAndAdvance') };
}

function rowHtml(html: string, line: number): string {
  return [...html.matchAll(/<tr class="row\b[^>]*>[\s\S]*?<\/tr>/g)]
    .map((match) => match[0]).find((row) => row.includes(`data-goto="${line}"`)) ?? '';
}

function latestLine(html: string): number | undefined {
  const rows = [...html.matchAll(/<tr class="[^"]*\blatest-result\b[^"]*" data-goto="(\d+)"/g)];
  assert.ok(rows.length <= 1, 'each document has at most one latest-result cue');
  assert.equal((html.match(/>Latest result<\/span>/g) ?? []).length, rows.length);
  return rows[0] ? Number(rows[0][1]) : undefined;
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('the expected running-state event did not arrive');
}

test('latest result remains distinct from the actual cursor and rejects pending rows', () => {
  const rows: ValuesRow[] = [0, 2].map((line) => ({
    line, startLine: line, endLine: line, state: 'evaluated', codeLines: ['x'],
  }));
  const render = (cursor: number, latest: number, currentRows = rows) => valuesHtml({
    fileName: 'example.py', rows: currentRows, latestResultLine: latest,
  }, cursor, 'nonce');
  assert.match(rowHtml(render(2, 0), 0), /class="row latest-result"/);
  assert.match(rowHtml(render(2, 0), 0), /aria-current="false"/);
  assert.match(rowHtml(render(2, 0), 2), /aria-current="true"/);
  assert.match(rowHtml(render(0, 0), 0), /class="row cursor latest-result"/);
  assert.equal(latestLine(render(100, 0)), 0);
  assert.equal(latestLine(render(0, 1)), undefined, 'no nearest-row guess');
  assert.equal(latestLine(render(0, 0, [{ ...rows[0], state: 'pending' }])), undefined);
});

test('evaluate and advance marks its completed result, including out-of-order evaluation', async () => {
  const { fake, editor, extension, view, cursor, advance, evaluate } =
    fixture('value = 6 * 7\nnext_value = value + 1\nlast_value = next_value + 1\n');
  try {
    await advance();
    assert.equal(editor.selection.active.line, 1);
    assert.equal(latestLine(view.webview.html), 0);
    assert.match(rowHtml(view.webview.html, 0), /aria-current="false"/);
    assert.match(rowHtml(view.webview.html, 0), />42</);
    await advance();
    assert.equal(editor.selection.active.line, 2);
    assert.equal(latestLine(view.webview.html), 1);
    assert.match(rowHtml(view.webview.html, 1), />43</);
    cursor(0);
    await advance();
    assert.equal(latestLine(view.webview.html), 0, 'completion order is not file order');
    assert.match(rowHtml(view.webview.html, 1), /aria-current="true"/);
    assert.match(rowHtml(view.webview.html, 0), /aria-current="false"/);
    cursor(0);
    await evaluate();
    assert.match(rowHtml(view.webview.html, 0), /class="row cursor latest-result"/);
    assert.equal(fake.window.activeTextEditor, editor);
    assert.equal(fake.shownDocuments.length, 0, 'result marking never opens an editor');
  } finally { extension.deactivate(); }
});

test('pending preserves another result but never labels a running replacement as complete', async () => {
  const { extension, view, cursor, evaluate, advance } = fixture(
    'value = 42\nslow_value = (__import__("time").sleep(0.4), 43)[1]\nlast_value = 44\n');
  try {
    await evaluate();
    cursor(1);
    let running = advance();
    await until(() => rowHtml(view.webview.html, 1).includes('tone-pending'));
    assert.equal(latestLine(view.webview.html), 0);
    assert.doesNotMatch(rowHtml(view.webview.html, 1), /Latest result/);
    await running;
    assert.equal(latestLine(view.webview.html), 1);
    cursor(1);
    running = advance();
    await until(() => rowHtml(view.webview.html, 1).includes('tone-pending'));
    assert.equal(latestLine(view.webview.html), undefined,
      'the previous latest result was replaced, so no completed row owns its cue');
    await running;
    assert.equal(latestLine(view.webview.html), 1);
  } finally { extension.deactivate(); }
});

test('latest identity reanchors with source edits and disappears when its result is deleted', async () => {
  const source = 'value = 42\nnext_value = 43\n';
  const { fake, editor, extension, view, cursor, evaluate } = fixture(source);
  try {
    await evaluate();
    editor.document.setText('\n\n' + source);
    fake.emitters.onDidChangeTextDocument.fire({ document: editor.document,
      contentChanges: [{ range: new FakeRange(0, 0, 0, 0), text: '\n\n' }] });
    assert.equal(latestLine(view.webview.html), 2);
    editor.document.setText('\n\nvalue = 99\nnext_value = 43\n');
    fake.emitters.onDidChangeTextDocument.fire({ document: editor.document,
      contentChanges: [{ range: new FakeRange(2, 8, 2, 10), text: '99' }] });
    assert.equal(latestLine(view.webview.html), 2);
    assert.match(rowHtml(view.webview.html, 2), /tone-stale/);
    assert.match(rowHtml(view.webview.html, 2), />42</, 'editing never re-reads the value');
    editor.document.setText('\n\nnext_value = 43\n');
    fake.emitters.onDidChangeTextDocument.fire({ document: editor.document,
      contentChanges: [{ range: new FakeRange(2, 0, 3, 0), text: '' }] });
    assert.equal(latestLine(view.webview.html), undefined);
    cursor(2);
    await evaluate();
    assert.equal(latestLine(view.webview.html), 2, 'a new result can reuse the removed row number');
    await fake.executeCommand('evalens.clearResults');
    assert.equal(latestLine(view.webview.html), undefined);
  } finally { extension.deactivate(); }
});

test('latest result survives visibility, view recreation and unmatched cursor movement', async () => {
  const { fake, editor, extension, provider, view, cursor, advance } =
    fixture('value = 42\nnext_value = 43\n\n');
  try {
    fake.config.set('evalens', 'valuesPanel.follow', false);
    fake.config.set('evalens', 'valuesPanel.followCursor', false);
    view.setVisible(false);
    await advance();
    view.setVisible(true);
    assert.equal(latestLine(view.webview.html), 0);
    assert.match(view.webview.html, /var revealLine = null;/,
      'the result cue does not override either follow setting');
    cursor(3);
    assert.equal(latestLine(view.webview.html), 0);
    assert.deepEqual(view.webview.posted.at(-1), { cursor: 3, reveal: false });
    view.fireDispose();
    const reopened = new FakeWebviewView();
    provider.resolveWebviewView(reopened, {}, {});
    assert.equal(latestLine(reopened.webview.html), 0);
    assert.match(rowHtml(reopened.webview.html, 0), /aria-current="false"/);
    assert.equal(fake.window.activeTextEditor, editor);
  } finally { extension.deactivate(); }
});

test('a result arriving for an inactive document cannot become another file’s latest result', async () => {
  const { fake, editor, extension, view, cursor, activate, evaluate, advance } = fixture(
    'first_value = 42\nslow_value = (__import__("time").sleep(0.4), 44)[1]\nnext_value = 45\n');
  const other = createEditor('other_value = 43\n', '/fake/other.py');
  try {
    activate(other);
    await evaluate();
    activate(editor);
    await evaluate();
    cursor(1);
    const running = advance();
    await until(() => rowHtml(view.webview.html, 1).includes('tone-pending'));
    activate(other);
    await running;
    assert.equal(latestLine(view.webview.html), 0);
    assert.match(rowHtml(view.webview.html, 0), />43</);
    activate(editor);
    assert.equal(latestLine(view.webview.html), 1);
    assert.match(rowHtml(view.webview.html, 1), />44</);
    fake.emitters.onDidCloseTextDocument.fire(editor.document);
    const reopened = createEditor(editor.document.getText());
    activate(reopened);
    assert.equal(latestLine(view.webview.html), undefined,
      'a newly opened document at the same URI does not inherit a completed result');
    activate(other);
    assert.equal(latestLine(view.webview.html), 0);
    await fake.executeCommand('evalens.clearResults');
    activate(reopened);
    assert.equal(latestLine(view.webview.html), undefined);
    activate(other);
    assert.equal(latestLine(view.webview.html), undefined);
  } finally { extension.deactivate(); }
});

test('loop folds and pages preserve the completed loop cue after the cursor advances', async () => {
  const { editor, extension, view, advance } = fixture(
    'for n in range(25):\n    print("row\\n" * 100)\nnext_value = 43\n');
  try {
    await advance();
    assert.equal(editor.selection.active.line, 2);
    assert.equal(latestLine(view.webview.html), 0);
    assert.match(rowHtml(view.webview.html, 0), /class="row loop-row latest-result"/);
    assert.match(rowHtml(view.webview.html, 0), /aria-current="false"/);
    const send = (node: number, action: string, value = 0) => {
      const revision = Number(/var revision = (\d+);/.exec(view.webview.html)![1]);
      view.webview.fireMessage({ loop: 0, node, action, value, revision });
    };
    send(1, 'page', 1);
    assert.match(view.webview.html, /Iterations 21–25 of 25/);
    send(22, 'toggle');
    assert.equal(latestLine(view.webview.html), 0);
    send(22, 'text:0:0', 1);
    assert.match(view.webview.html, /Output part 2 of/);
    assert.equal(latestLine(view.webview.html), 0);
    assert.equal(editor.selection.active.line, 2, 'reading captured output does not navigate source');
    assert.match(view.webview.html,
      /tr\.loop-row\.cursor, \.loop-row \.result-surface \{ background: transparent; \}/);
  } finally { extension.deactivate(); }
});

test('an error is a completed result and dependency marking cannot move the cue', async () => {
  const { extension, view, cursor, evaluate } = fixture(
    'value = 42\nnext_value = value + 1\n1 / 0\n');
  try {
    await evaluate();
    cursor(1);
    await evaluate();
    cursor(0);
    await evaluate();
    assert.equal(latestLine(view.webview.html), 0);
    assert.match(rowHtml(view.webview.html, 1), /tone-stale/);
    cursor(2);
    await evaluate();
    assert.equal(latestLine(view.webview.html), 2);
    assert.match(rowHtml(view.webview.html, 2), /ZeroDivisionError/);
  } finally { extension.deactivate(); }
});
