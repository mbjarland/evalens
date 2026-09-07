import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { KernelClient } from '../kernel/client';
import { Evaluated, LoopExplorerWire, LoopIteration } from '../kernel/protocol';
import { present } from '../render/present';
import { rowsFor, valuesHtml } from '../panel/html';
import {
  LOOP_VISIBLE_LIMIT, LOOP_TEXT_CHUNK, loopExplorerHtml, loopSlice,
  newLoopViewState, prepareLoopExplorer,
} from '../panel/loopExplorer';
import {
  FakePosition, FakeRange, FakeSelection, FakeWebviewView, createEditor,
  createExtensionContext, createFakeVscode, loadCompiledExtension, paintedLineText,
} from './harness/fakeVscode';

const root = path.resolve(__dirname, '..', '..');
const source = 'for x in range(2):\n    print("😀 x", x)\n    for y in range(4):\n'
  + '        if y == 0: continue\n        print("🦉", x, y)\n';
async function captured(source: string, line = 0): Promise<Evaluated> {
  const client = new KernelClient({ resolvePython: async () => 'python3',
    kernelPath: path.join(root, 'kernel', 'evalens_kernel.py') });
  try {
    const result = await client.request({ op: 'eval', source, line,
      character: 0, filename: '/tmp/evalens-loop-test.py', allow_stdin: false });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result as Evaluated;
  } finally { client.dispose(); }
}
function prepared(result: Evaluated) {
  const model = prepareLoopExplorer(result.loop_explorer, result.stdout, result.stderr);
  assert.ok(model);
  return model;
}
function contents(html: string) {
  return html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
}
function navigation(html: string, id: number): string {
  const match = new RegExp(`data-loop-navigation="${id}">([\\s\\S]*?)</div></div>`).exec(html);
  assert.ok(match, `missing navigation for invocation ${id}`);
  return match[1]!;
}

test('single-level square-print loop uses three compact target/output rows', async () => {
  const result = await captured('for n in range(3):\n    print(n * n)\n');
  const model = prepared(result);
  assert.equal(model.sites.size, 1);
  const html = loopExplorerHtml(model, 0);
  assert.equal((html.match(/class="loop-data loop-iteration"/g) ?? []).length, 3);
  assert.deepEqual([...html.matchAll(/class="loop-output">([^<]*)/g)].map((m) => m[1]),
    ['0', '1', '4']);
  assert.match(html, /for n in range\(3\)/);
  assert.match(html, /3 iterations/);
  assert.equal((html.match(/Iteration values/g) ?? []).length, 1);
  assert.equal((html.match(/Printed output/g) ?? []).length, 1);
  assert.doesNotMatch(html, /data-loop-action="toggle|loop-iteration-header/);
});

test('single-level silent, skipped, break and else output keep their actual ownership', async () => {
  const skipped = prepared(await captured('for n in range(5):\n'
    + '    if n == 0: continue\n    if n == 3: break\n    print(n)\n'
    + 'else:\n    print("unreachable")\n'));
  let html = loopExplorerHtml(skipped, 0);
  assert.match(html, /4 iterations/);
  assert.equal((html.match(/>No output<\/span>/g) ?? []).length, 2);
  assert.deepEqual([...html.matchAll(/class="loop-output">([^<]*)/g)].map((m) => m[1]),
    ['1', '2']);
  assert.doesNotMatch(html, /unreachable/);

  const empty = prepared(await captured('for n in []:\n    print("never")\n'
    + 'else:\n    print("😀 empty")\n'));
  html = loopExplorerHtml(empty, 0);
  assert.match(html, /No iterations/);
  assert.match(html, /loop-data loop-direct/);
  assert.equal((html.match(/😀 empty/g) ?? []).length, 1);
  assert.doesNotMatch(html, /data-loop-entry=/);

  const silent = prepared(await captured('for n in [0, 0]:\n    pass\n'));
  html = loopExplorerHtml(silent, 0);
  assert.equal((html.match(/>No output<\/span>/g) ?? []).length, 2);
  assert.doesNotMatch(html, /data-loop-action="toggle/);
});

test('short single-level multiline output stays compact with a combined stream bound', async () => {
  const small = prepared(await captured('for n in [0]:\n    import sys\n'
    + '    print("😀 first\\nsecond")\n    print("🦉 warning", file=sys.stderr)\n'));
  let html = loopExplorerHtml(small, 0);
  assert.doesNotMatch(html, /data-loop-action="toggle/);
  assert.match(html, /😀 first\nsecond/);
  assert.match(html, /class="loop-stream-label">stderr:/);
  assert.match(html, /🦉 warning/);
  const four = prepared(await captured('for n in [0]:\n    import sys\n'
    + '    print("one\\ntwo")\n    print("three\\nfour", file=sys.stderr)\n'));
  html = loopExplorerHtml(four, 0);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /class="loop-output"/);
});

test('single-level long iteration output folds, pages Unicode safely and exports the capture', async () => {
  const model = prepared(await captured('for n in range(2):\n'
    + '    print("😀 page line\\n" * 5000)\n'));
  const state = newLoopViewState();
  let html = loopExplorerHtml(model, 0, state);
  assert.doesNotMatch(html, /class="loop-output"/);
  assert.match(html, /printed 5,001 lines/);
  state.expanded.set(2, true);
  html = loopExplorerHtml(model, 0, state);
  assert.match(html, /More output/);
  assert.ok(html.length < 6000, String(html.length));
  assert.ok(!html.includes('😀 page line\n'.repeat(21)));
  assert.doesNotMatch(html, /\uFFFD/);
  assert.match(html, /unretained text cannot be expanded/);
  assert.ok(model.streams[0].startsWith('😀 page line\n'.repeat(5000)));
  assert.ok(model.streams[0].includes('characters omitted'));
  assert.match(html, /Open captured stdout/);
  const clipped = prepared(await captured('for n in range(2):\n'
    + '    if n == 0: print("x" * 70000)\n'));
  assert.match(loopExplorerHtml(clipped, 0), /n = 1[\s\S]*?>No output<\/span>/);
});

test('single-level million-pass trace pages bounded rows and keeps final count honest', async () => {
  const model = prepared(await captured('for n in range(1000000):\n    pass\n'));
  const state = newLoopViewState();
  assert.equal(model.wire.entries.length, 2000);
  assert.equal(model.wire.iterations, 1000000);
  assert.ok(JSON.stringify(model.wire).length < 400000);
  let html = loopExplorerHtml(model, 0, state);
  assert.ok(html.length < 20000, String(html.length));
  assert.match(html, /1,000,000 iterations/);
  assert.match(html, /Iterations 1–20 of 1,000,000/);
  assert.match(html, /Details were captured for the first 1,999 of 1,000,000 iterations/);
  assert.equal((html.match(/data-loop-entry=/g) ?? []).length, 20);
  state.pages.set(1, 99);
  html = loopExplorerHtml(model, 0, state);
  assert.match(html, /n = 1998/);
  assert.match(html, /Iterations 1,981–1,999 of 1,000,000/);
  assert.doesNotMatch(html, /n = 1979</);
});

test('single-loop loaded extension retains inline body histories, saved hover and file repeats', async () => {
  const fake = createFakeVscode();
  const editor = createEditor('for n in range(3):\n    square = n * n\n'
    + '    print(square)\nprint(square)\n');
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = loadCompiledExtension(path.join(root, 'out'), fake);
  extension.activate(createExtensionContext(root) as never);
  try {
    await fake.executeCommand('evalens.evaluateFile');
    const inline = paintedLineText(editor, 0).replace(/\u00a0/g, ' ');
    assert.match(inline, /×3/);
    assert.match(inline, /n: 0, 1, 2/);
    assert.match(inline, /square: 0, 1, 4/);
    assert.match(paintedLineText(editor, 3).replace(/\u00a0/g, ' '), /square: 4/);
    const hover = fake.hoverProviders[0]!.provider as { provideHover(
      document: unknown, position: FakePosition): Promise<{ contents: { value: string } } | undefined> };
    const text = (await hover.provideHover(editor.document, new FakePosition(0, 0)))!.contents.value;
    assert.match(text, /square/);
    assert.match(text, /0, 1, 4/);
    const view = new FakeWebviewView();
    fake.webviewViewProviders.get('evalens.values')!.resolveWebviewView(view, {}, {});
    const html = contents(view.webview.html);
    assert.match(html, /class="loop-explorer"/);
    assert.match(html, /Values after loop: n = 2, square = 4/);
    assert.doesNotMatch(html, /square = 0|square = 1/,
      'independent body histories must not be invented as iteration readings');
  } finally { extension.deactivate(); }
});

test('single-loop provider keeps manual folds/pages across reanchor and resets on reevaluation', async () => {
  const sample = 'for n in range(25):\n    print("line\\n" * 100)\n';
  const fake = createFakeVscode();
  const editor = createEditor(sample);
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = loadCompiledExtension(path.join(root, 'out'), fake);
  extension.activate(createExtensionContext(root) as never);
  try {
    const evaluate = fake.commands.registered.get('evalens.evaluateAtCursor') as () => Promise<void>;
    await evaluate();
    const view = new FakeWebviewView();
    fake.webviewViewProviders.get('evalens.values')!.resolveWebviewView(view, {}, {});
    const revision = () => Number(/var revision = (\d+)/.exec(view.webview.html)![1]);
    const send = (line: number, node: number, action: string, value = 0) =>
      view.webview.fireMessage({ loop: line, node, action, value, revision: revision() });
    send(0, 1, 'page', 1);
    send(0, 22, 'toggle');
    send(0, 22, 'text:0:0', 1);
    assert.match(view.webview.html, /Iterations 21–25 of 25/);
    assert.match(view.webview.html, /Output part 2 of 6/);
    const previousRevision = revision();
    editor.document.setText('# prefix\n' + sample);
    fake.emitters.onDidChangeTextDocument.fire({ document: editor.document,
      contentChanges: [{ range: new FakeRange(0, 0, 0, 0), text: '# prefix\n' }] });
    assert.match(view.webview.html, /Output part 2 of 6/);
    send(1, 22, 'select');
    assert.equal(editor.selection.active.line, 1);
    assert.match(view.webview.html, /loop-selected/);
    await evaluate();
    assert.match(view.webview.html, /Iterations 1–20 of 25/);
    assert.doesNotMatch(contents(view.webview.html), /class="loop-output"/);
    view.webview.fireMessage({ loop: 1, node: 1, action: 'page', value: 1,
      revision: previousRevision });
    assert.match(view.webview.html, /Iterations 1–20 of 25/);
  } finally { extension.deactivate(); }
});

test('real nested output becomes X5 with Unicode slices and separate final snapshots', async () => {
  const result = await captured(source);
  const presentation = present(result, 0);
  assert.equal(presentation.kind, 'value');
  if (presentation.kind !== 'value') return;
  assert.equal(presentation.loopExplorer, result.loop_explorer);
  const model = prepared(result);
  const leaves = model.wire.entries.filter((entry): entry is LoopIteration =>
    entry.kind === 'iteration' && !model.children.has(entry.id));
  const leafOutput = leaves.map((entry) => loopSlice(model, entry.start, entry.end, 0));
  assert.deepEqual(leafOutput, ['', '🦉 0 1\n', '🦉 0 2\n', '🦉 0 3\n',
    '', '🦉 1 1\n', '🦉 1 2\n', '🦉 1 3\n']);
  const rows = rowsFor({ lineAt: (line) => ({ text: source.split('\n')[line] ?? '' }) }, [presentation], 'printed');
  assert.ok(rows[0]?.loopExplorer);
  const html = contents(valuesHtml({ fileName: 'example.py', rows }, 0, 'test'));
  assert.equal((html.match(/Iteration values/g) ?? []).length, 1);
  assert.equal((html.match(/Printed output/g) ?? []).length, 1);
  assert.equal((html.match(/printed 4 lines/g) ?? []).length, 2);
  assert.equal((html.match(/No output/g) ?? []).length, 2);
  assert.match(html, /Values after loop: x = 1, y = 3/);
  assert.match(html, /😀 x 0/);
  assert.match(html, /🦉 1 3/);
  assert.doesNotMatch(html, /class="result-values"/,
    'old independent histories must not masquerade as iteration readings');
});

test('silent equal values in sibling loops retain distinct invocation/parent IDs', async () => {
  const model = prepared(await captured('for x in [0, 0]:\n'
    + '    for y in [1, 1]: pass\n    for y in [1, 1]: pass\n'));
  const parents = model.wire.entries.filter((entry) => entry.kind === 'invocation');
  assert.equal(new Set(parents.map((entry) => entry.id)).size, 5);
  assert.equal(new Set(parents.map((entry) => entry.parent)).size, 3);
  const html = loopExplorerHtml(model, 0);
  assert.equal((html.match(/>No output<\/span>/g) ?? []).length, 8);
  assert.match(html, /line 2/);
  assert.match(html, /line 3/);
});

test('else child invocation preserves its parent and renders each stream segment once', async () => {
  const model = prepared(await captured('for x in [0]:\n    print("😀 A")\n'
    + 'else:\n    for y in [1, 2]:\n        print("🦉 B", y)\n'));
  assert.equal(model.roots.length, 1);
  const child = model.wire.entries.find((entry) => entry.kind === 'invocation' && entry.site === 1);
  assert.equal(child?.kind, 'invocation');
  if (child?.kind !== 'invocation') return;
  assert.equal(child.parent, null);
  assert.equal(child.parent_invocation, model.roots[0]!.id);
  const html = loopExplorerHtml(model, 0);
  for (const text of ['😀 A', '🦉 B 1', '🦉 B 2']) {
    assert.equal(html.split(text).length - 1, 1, text);
  }
});

test('invalid relationships/offsets/overlong arrays fail back to original flat output', async () => {
  const result = await captured(source);
  const wire = result.loop_explorer!;
  const invalids = [
    { ...wire, entries: [{ ...wire.entries[0], end: null }] },
    { ...wire, entries: wire.entries.map((entry, i) => i === 2 ? { ...entry, parent: 9999 } : entry) },
    { ...wire, retained: [65537, 0] },
    { ...wire, entries: Array(2001).fill(wire.entries[0]) },
    { ...wire, omitted_iterations: 1 },
  ];
  for (const invalid of invalids) assert.equal(prepareLoopExplorer(
    invalid as unknown as LoopExplorerWire, result.stdout, result.stderr), undefined);
});

test('large sibling groups all remain reachable through independent invocation folds', async () => {
  const sample = 'for x in [0]:\n' + Array.from({ length: 8 }, (_, i) =>
    `    for y${i} in range(20):\n        print(y${i})\n`).join('');
  const model = prepared(await captured(sample));
  const state = newLoopViewState();
  state.expanded.set(2, true);
  let html = loopExplorerHtml(model, 0, state);
  assert.equal((html.match(/data-loop-action="toggle-invocation"/g) ?? []).length, 8);
  const last = model.wire.entries.find((entry) => entry.kind === 'invocation' && entry.site === 8)!;
  state.expanded.set(last.id, true);
  html = loopExplorerHtml(model, 0, state);
  assert.match(html, /y7 = 19/);
  for (const entry of model.wire.entries) state.expanded.set(entry.id, true);
  html = loopExplorerHtml(model, 0, state);
  assert.ok((html.match(/data-loop-(?:entry|invocation)=/g) ?? []).length <= LOOP_VISIBLE_LIMIT);
  assert.match(html, /Visible detail limit/);
});

test('100-by-100 output outside retained iterations starts folded and pages independently', async () => {
  const result = await captured('for x in range(100):\n'
    + '    for y in range(100):\n        print(x, y)\n');
  const expected = Array.from({ length: 100 }, (_, x) =>
    Array.from({ length: 100 }, (_, y) => `${x} ${y}\n`).join('')).join('');
  assert.equal(result.stdout, expected);
  const model = prepared(result);
  const root = model.roots[0]!;
  const children = model.children.get(root.id)!;
  const last = children.at(-1)!;
  assert.equal(last.kind, 'iteration');
  assert.equal((last as LoopIteration).value, '19');
  assert.ok(loopSlice(model, last.end, root.end, 0).startsWith('20 0\n'));
  const state = newLoopViewState();
  let html = loopExplorerHtml(model, 0, state);
  assert.match(html, /Remaining printed output/);
  assert.match(html, /Details were captured for the first/);
  assert.doesNotMatch(html, /class="loop-output"/,
    'collapsed iterations must not leave a raw transcript tail visible');

  state.expandedGaps.add(`${root.id}:${children.length}`);
  html = loopExplorerHtml(model, 0, state);
  assert.match(html, /20 0\n20 1\n/);
  assert.match(html, /20 19<\/span>/);
  assert.doesNotMatch(html, /20 20\n/);
  assert.match(html, /More output/);
  assert.ok(html.length < 20000, String(html.length));
  state.textPages.set(`${root.id}:${children.length}:0`, 1);
  html = loopExplorerHtml(model, 0, state);
  assert.match(html, /20 20\n20 21\n/);
  assert.doesNotMatch(html, /20 0\n/);
  state.expandedGaps.clear();
  assert.doesNotMatch(loopExplorerHtml(model, 0, state), /class="loop-output"/);
  assert.equal(model.streams[0], expected, 'folds/pages do not change captured export');
});

test('outer and inner capture boundaries share paging against actual invocation totals', async () => {
  const model = prepared(await captured('for x in range(100):\n'
    + '    for y in range(100):\n        print(x, y)\n'));
  const outer = model.roots[0]!;
  const outerChildren = model.children.get(outer.id)!;
  const lastOuter = outerChildren.at(-1)!;
  const inner = model.children.get(lastOuter.id)![0]!;
  const innerChildren = model.children.get(inner.id)!;
  assert.equal(outerChildren.length, 20);
  assert.equal(innerChildren.length, 59);
  const state = newLoopViewState();
  state.expanded.set(lastOuter.id, true);
  let html = loopExplorerHtml(model, 0, state);
  let outerNav = navigation(html, outer.id);
  let innerNav = navigation(html, inner.id);
  assert.match(outerNav, /for x in range\(100\) · line 1/);
  assert.match(innerNav, /for y in range\(100\) · line 2 · within Iteration 20, x = 19/);
  for (const nav of [outerNav, innerNav]) {
    assert.match(nav, /Iterations 1–20 of 100/);
    assert.match(nav, /disabled[^>]*>Previous iterations/);
  }
  assert.match(outerNav, /disabled[^>]*>More iterations/);
  assert.match(outerNav, /first 20 of 100 iterations/);
  assert.match(innerNav, /first 59 of 100 iterations/);
  assert.doesNotMatch(innerNav, /disabled[^>]*>More iterations/);
  assert.doesNotMatch(html, /8,121|41 iterations|80 iterations|retained iteration detail/);
  assert.ok(html.indexOf(`data-loop-overflow="${outer.id}"`) > html.indexOf(`data-loop-navigation="${outer.id}"`));
  assert.match(html, /Remaining printed output; for x in range\(100\) · line 1/);
  assert.doesNotMatch(html, /20 0\n/);
  assert.doesNotMatch(html, new RegExp(`data-loop-overflow="${inner.id}"`),
    'the inner remainder follows its last captured page');

  state.pages.set(inner.id, 2);
  html = loopExplorerHtml(model, 0, state);
  innerNav = navigation(html, inner.id);
  assert.match(innerNav, /Iterations 41–59 of 100/);
  assert.match(innerNav, /disabled[^>]*>More iterations/);
  assert.doesNotMatch(innerNav, /disabled[^>]*>Previous iterations/);
  assert.match(html, /y = 58/);
  assert.doesNotMatch(html, /y = 59</);
  assert.match(html, /Remaining printed output; for y in range\(100\) · line 2 · within Iteration 20, x = 19/);
  state.expandedGaps.add(`${inner.id}:${innerChildren.length}`);
  html = loopExplorerHtml(model, 0, state);
  assert.match(html, /19 59\n19 60/);
  assert.doesNotMatch(html, /20 0\n/);
  state.expanded.set(lastOuter.id, false);
  html = loopExplorerHtml(model, 0, state);
  assert.doesNotMatch(html, /19 59\n/);
  assert.doesNotMatch(html, new RegExp(`data-loop-overflow="${inner.id}"`));
  assert.equal((html.match(/data-loop-overflow=/g) ?? []).length, 1,
    'closing an outer iteration hides its inner remainder, leaving only root overflow');
  state.expanded.set(lastOuter.id, true);
  state.pages.set(inner.id, 1);
  html = loopExplorerHtml(model, 0, state);
  assert.match(navigation(html, inner.id), /Iterations 21–40 of 100/);
  outerNav = navigation(html, outer.id);
  assert.match(outerNav, /Iterations 1–20 of 100/);
});

test('complete loops keep both navigation controls at each page boundary', async () => {
  const model = prepared(await captured('for x in range(25):\n'
    + '    for y in range(25):\n        pass\n'));
  const outer = model.roots[0]!;
  const first = model.children.get(outer.id)![0]!;
  const inner = model.children.get(first.id)![0]!;
  const state = newLoopViewState();
  state.expanded.set(first.id, true);
  let html = loopExplorerHtml(model, 0, state);
  for (const id of [outer.id, inner.id]) {
    const nav = navigation(html, id);
    assert.match(nav, /Iterations 1–20 of 25/);
    assert.match(nav, /disabled[^>]*>Previous iterations/);
    assert.doesNotMatch(nav, /disabled[^>]*>More iterations/);
  }
  state.pages.set(inner.id, 1);
  html = loopExplorerHtml(model, 0, state);
  let nav = navigation(html, inner.id);
  assert.match(nav, /Iterations 21–25 of 25/);
  assert.match(nav, /disabled title="Already at the last page"[^>]*>More iterations/);
  assert.doesNotMatch(nav, /disabled[^>]*>Previous iterations/);
  state.pages.set(outer.id, 1);
  html = loopExplorerHtml(model, 0, state);
  nav = navigation(html, outer.id);
  assert.match(nav, /Iterations 21–25 of 25/);
  assert.match(nav, /disabled[^>]*>More iterations/);
  assert.doesNotMatch(html, /loop-capture-limit|loop-overflow/);
});

test('limited silent loops explain the local capture boundary without offering absent output', async () => {
  const model = prepared(await captured('for x in range(100):\n'
    + '    for y in range(100):\n        pass\n'));
  const state = newLoopViewState();
  const html = loopExplorerHtml(model, 0, state);
  assert.match(navigation(html, 1), /first 20 of 100 iterations/);
  assert.doesNotMatch(html, /Remaining printed output|data-loop-action="gap:|8,121/);
});

test('remaining loop output includes for-else text without inventing its iteration owner', async () => {
  const model = prepared(await captured('for n in range(3000):\n'
    + '    print(n)\nelse:\n    print("loop complete")\n'));
  const root = model.roots[0]!;
  const children = model.children.get(root.id)!;
  const state = newLoopViewState();
  state.pages.set(root.id, Math.floor((children.length - 1) / 20));
  let html = loopExplorerHtml(model, 4, state);
  assert.match(html, /Remaining printed output; for n in range\(3000\) · line 5/);
  assert.doesNotMatch(html, /loop complete|Iterations 2000–3000/);
  const gap = children.length;
  state.expandedGaps.add(`${root.id}:${gap}`);
  state.textPages.set(`${root.id}:${gap}:0`, 1000);
  html = loopExplorerHtml(model, 4, state);
  assert.match(html, /2999\nloop complete/);
  assert.equal(model.streams[0], Array.from({ length: 3000 }, (_, n) => `${n}\n`).join('') + 'loop complete\n');
});

test('visible iteration spans stop at the DOM budget instead of claiming unrendered rows', async () => {
  const model = prepared(await captured('for x in range(20):\n'
    + '    for y in range(100):\n        pass\n'));
  const state = newLoopViewState();
  for (const entry of model.wire.entries) state.expanded.set(entry.id, true);
  const html = loopExplorerHtml(model, 0, state);
  const rootChildren = model.children.get(model.roots[0]!.id)!;
  const shown = rootChildren.filter((entry) => html.includes(`data-loop-entry="${entry.id}"`));
  assert.ok(shown.length > 0 && shown.length < 20);
  assert.match(navigation(html, 1), new RegExp(`Iterations 1–${shown.length} of 20`));
  assert.match(navigation(html, 1), /Collapse an expanded group/);
  assert.ok((html.match(/data-loop-(?:entry|invocation)=/g) ?? []).length <= LOOP_VISIBLE_LIMIT);
});

test('one outer expansion reveals its only inner loop page but preserves long-output folds', async () => {
  const model = prepared(await captured('for x in range(2):\n'
    + '    for y in range(100):\n        print(x, y)\n'));
  const outer = model.children.get(model.roots[0]!.id)![0]!;
  const inner = model.children.get(outer.id)![0]!;
  const state = newLoopViewState();
  state.expanded.set(outer.id, true);
  let html = loopExplorerHtml(model, 0, state);
  assert.doesNotMatch(html, /data-loop-action="toggle-invocation"/);
  assert.match(html, /y = 0/);
  assert.match(html, /y = 19/);
  assert.match(html, /Iterations 1–20 of 100/);
  state.pages.set(inner.id, 1);
  html = loopExplorerHtml(model, 0, state);
  assert.match(html, /y = 20/);
  assert.match(html, /y = 39/);
  assert.doesNotMatch(html, /y = 19</);
  state.expanded.set(outer.id, false);
  assert.doesNotMatch(loopExplorerHtml(model, 0, state), /class="loop-output"/);

  const long = prepared(await captured('for x in range(2):\n'
    + '    for y in range(30):\n        print("large page\\n" * 100)\n'));
  const longState = newLoopViewState();
  longState.expanded.set(2, true);
  html = loopExplorerHtml(long, 0, longState);
  assert.doesNotMatch(html, /data-loop-action="toggle-invocation"/);
  assert.match(html, /printed 101 lines/);
  assert.doesNotMatch(html, /class="loop-output"/,
    'opening the only inner invocation must not open large iteration output');
});

test('unattributed Unicode and stderr remain separate from text that was never captured', async () => {
  const model = prepared(await captured('for x in [0]:\n'
    + '    for y in range(3000):\n        import sys\n'
    + '        print("😀", y)\n        print("🦉", y, file=sys.stderr)\n'));
  const state = newLoopViewState();
  state.expanded.set(2, true);
  const inner = model.children.get(2)![0]!;
  const children = model.children.get(inner.id)!;
  state.pages.set(inner.id, Math.floor((children.length - 1) / 20));
  state.expandedGaps.add(`${inner.id}:${children.length}`);
  const html = loopExplorerHtml(model, 0, state);
  assert.match(html, /Remaining printed output/);
  assert.match(html, /😀 1997\n/);
  assert.match(html, /🦉 1997\n/);
  assert.match(html, /class="loop-stream-label">stderr:/);
  assert.doesNotMatch(html, /\uFFFD/);

  const clipped = prepared(await captured('for x in [0]:\n'
    + '    for y in range(3000):\n        print("z" * 100)\n'));
  const clippedState = newLoopViewState();
  clippedState.expanded.set(2, true);
  const clippedInner = clipped.children.get(2)![0]!;
  const clippedChildren = clipped.children.get(clippedInner.id)!;
  clippedState.pages.set(clippedInner.id, Math.floor((clippedChildren.length - 1) / 20));
  const clippedHtml = loopExplorerHtml(clipped, 0, clippedState);
  assert.match(clippedHtml, /Further output was not retained/);
  assert.doesNotMatch(clippedHtml, /data-loop-action="gap:/,
    'unretained text cannot be offered as an expandable capture');
});

test('huge per-iteration one-line output uses bounded chunks and truthful capture notices', async () => {
  const model = prepared(await captured('for x in range(2):\n'
    + '    for y in range(2):\n        print("😀" * 100000)\n'));
  const state = newLoopViewState();
  for (const entry of model.wire.entries) state.expanded.set(entry.id, true);
  const html = loopExplorerHtml(model, 0, state);
  assert.ok(html.length < 24000, String(html.length));
  assert.ok(!html.includes('😀'.repeat(LOOP_TEXT_CHUNK)));
  assert.match(html, /More output/);
  assert.match(html, /not fully retained/);
  assert.match(html, /unretained text cannot be expanded/);
  assert.match(html, /Open captured output/);
  assert.equal(model.wire.retained[0], 65536);
});

test('repeated nested invocations have pages even when they share one loop site', async () => {
  const model = prepared(await captured('for outer in [0]:\n    i = 0\n'
    + '    while i < 150:\n        for child in [0]:\n            print(i, child)\n'
    + '        i += 1\n'));
  const state = newLoopViewState();
  state.expanded.set(2, true);
  let html = loopExplorerHtml(model, 0, state);
  assert.match(html, /Nested loops 1–20 of 150 retained/);
  state.pages.set(2, 7);
  const last = model.wire.entries.filter((entry) => entry.kind === 'invocation').at(-1)!;
  state.expanded.set(last.id, true);
  html = loopExplorerHtml(model, 0, state);
  assert.match(html, /Nested loops 141–150 of 150 retained/);
  assert.match(html, /149 0/);
  assert.ok((html.match(/data-loop-(?:entry|invocation)=/g) ?? []).length <= LOOP_VISIBLE_LIMIT);
});

test('silent spans after output capture fills remain known silent', async () => {
  const model = prepared(await captured('for x in [0]:\n    for y in range(2):\n'
    + '        if y == 0: print("z" * 70000)\n'));
  const html = loopExplorerHtml(model, 0);
  assert.match(html, /y = 1[\s\S]*?>No output<\/span>/);
  assert.doesNotMatch(html, /y = 1[\s\S]*?<div class="loop-stream">/);
});

test('stderr has its own count and mixed else pages count entries honestly', async () => {
  const error = prepared(await captured('for x in [0]:\n    for y in [0]:\n'
    + '        import sys\n        print("one\\ntwo", file=sys.stderr)\n'));
  assert.match(loopExplorerHtml(error, 0), /stderr 2 lines/);
  assert.doesNotMatch(loopExplorerHtml(error, 0), /No printed output/);
  const mixed = prepared(await captured('for x in range(20):\n    pass\n'
    + 'else:\n    for y in [0]: pass\n'));
  assert.match(loopExplorerHtml(mixed, 0), /Rows 1–20 of 21 · Iterations 1–20 of 20/);
});

test('one million iterations have bounded wire and bounded initial/expanded DOM', async () => {
  const started = performance.now();
  const model = prepared(await captured('for x in [0]:\n'
    + '    for y in range(1000000):\n        pass\n'));
  assert.equal(model.wire.entries.length, 2000);
  assert.equal(model.wire.iterations, 1000001);
  assert.ok(JSON.stringify(model.wire).length < 400000);
  let html = loopExplorerHtml(model, 0);
  assert.ok(html.length < 6000);
  const state = newLoopViewState();
  for (const entry of model.wire.entries) state.expanded.set(entry.id, true);
  html = loopExplorerHtml(model, 0, state);
  assert.ok(html.length < 20000);
  assert.match(html, /Details were captured for the first/);
  const inner = model.wire.entries.find((entry) => entry.kind === 'invocation' && entry.site === 1)!;
  state.pages.set(inner.id, 1);
  html = loopExplorerHtml(model, 0, state);
  assert.match(html, /y = 20/);
  assert.match(html, /y = 39/);
  assert.doesNotMatch(html, /y = 19</);
  assert.ok(performance.now() - started < 30000);
});

test('flat million-character values fold by characters even with no newline', () => {
  const value = 'x'.repeat(1000000);
  const rows = rowsFor({ lineAt: () => ({ text: 'value' }) }, [
    { range: { start: { line: 0 }, end: { line: 0 } }, value,
      display: 'value', isBinding: true }], 'printed');
  const folded = contents(valuesHtml({ fileName: 'test.py', rows }, 0, 'n'));
  assert.ok(folded.length < 5000);
  assert.match(folded, /998,000 more characters/);
  const expanded = contents(valuesHtml({ fileName: 'test.py', rows }, 0, 'n', undefined,
    { expandedLines: new Set([0]) }));
  assert.ok(expanded.length < 19000);
  assert.match(expanded, /984,000 more characters/);
  assert.match(expanded, /Open in editor/);
});

test('provider preserves folds across unrelated edits and reanchors only reliable loop sites', async () => {
  const fake = createFakeVscode();
  const editor = createEditor(source + '\nother = 1\n');
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = loadCompiledExtension(path.join(root, 'out'), fake);
  extension.activate(createExtensionContext(root) as never);
  try {
    const evaluate = fake.commands.registered.get('evalens.evaluateAtCursor') as () => Promise<void>;
    await evaluate();
    const provider = fake.webviewViewProviders.get('evalens.values')!;
    const view = new FakeWebviewView();
    provider.resolveWebviewView(view, {}, {});
    const send = (line: number, node: number, action: string, value = 0) => {
      const revision = Number(/var revision = (\d+)/.exec(view.webview.html)![1]);
      view.webview.fireMessage({ loop: line, node, action, value, revision });
    };
    send(0, 2, 'toggle');
    assert.match(view.webview.html, /data-loop-id="2"[^>]*aria-expanded="false"/);
    editor.document.setText('# prefix\n' + source + '\nother = 1\n');
    fake.emitters.onDidChangeTextDocument.fire({ document: editor.document,
      contentChanges: [{ range: new FakeRange(0, 0, 0, 0), text: '# prefix\n' }] });
    assert.match(view.webview.html, /data-loop-id="2"[^>]*aria-expanded="false"/);
    send(1, 2, 'toggle');
    assert.match(view.webview.html, /· line 4/);
    send(1, 5, 'select');
    assert.equal(editor.selection.active.line, 3);
    assert.match(view.webview.html, /loop-selected/);
    const old = editor.document.lineAt(2).text;
    editor.document.setText(editor.document.getText().replace('😀 x', 'edited'));
    fake.emitters.onDidChangeTextDocument.fire({ document: editor.document,
      contentChanges: [{ range: new FakeRange(2, 0, 2, old.length), text: '    print("edited", x)' }] });
    editor.selection = new FakeSelection(new FakePosition(6, 0), new FakePosition(6, 0));
    send(1, 5, 'select');
    assert.equal(editor.selection.active.line, 6, 'edited source must not receive a guessed jump');
    editor.selection = new FakeSelection(new FakePosition(1, 0), new FakePosition(1, 0));
    await evaluate();
    assert.match(view.webview.html, /data-loop-id="2"[^>]*aria-expanded="true"/);
  } finally { extension.deactivate(); }
});

test('provider preserves gap folds/pages across edits and rejects old evaluation controls', async () => {
  const sample = 'for x in range(100):\n    for y in range(100):\n        print(x, y)\n';
  const fake = createFakeVscode();
  const editor = createEditor(sample);
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = loadCompiledExtension(path.join(root, 'out'), fake);
  extension.activate(createExtensionContext(root) as never);
  try {
    const evaluate = fake.commands.registered.get('evalens.evaluateAtCursor') as () => Promise<void>;
    await evaluate();
    const view = new FakeWebviewView();
    fake.webviewViewProviders.get('evalens.values')!.resolveWebviewView(view, {}, {});
    const revision = () => Number(/var revision = (\d+)/.exec(view.webview.html)![1]);
    const send = (line: number, action: string, value = 0) => {
      view.webview.fireMessage({ loop: line, node: 1, action, value, revision: revision() });
    };
    assert.doesNotMatch(view.webview.html, /class="loop-output"/);
    const gapAction = /data-loop-action="(gap:\d+)"/.exec(view.webview.html)![1]!;
    const gap = gapAction.slice(4);
    send(0, gapAction);
    assert.match(view.webview.html, /20 0\n/);
    send(0, `text:${gap}:0`, 1);
    assert.match(view.webview.html, /20 20\n/);
    const openRevision = revision();
    const initialIdentity = /data-loop-token="(\d+)"/.exec(view.webview.html)![1];
    editor.document.setText('# prefix\n' + sample);
    fake.emitters.onDidChangeTextDocument.fire({ document: editor.document,
      contentChanges: [{ range: new FakeRange(0, 0, 0, 0), text: '# prefix\n' }] });
    assert.match(view.webview.html, /20 20\n/);
    assert.equal(/data-loop-token="(\d+)"/.exec(view.webview.html)![1], initialIdentity);
    view.webview.fireMessage({ loop: 0, node: 1, action: gapAction,
      value: 0, revision: openRevision });
    assert.match(view.webview.html, /20 20\n/, 'a queued old-render fold cannot change current state');
    send(1, gapAction);
    assert.doesNotMatch(view.webview.html, /class="loop-output"/);
    send(1, gapAction);
    assert.match(view.webview.html, /20 20\n/, 'reopening a fold retains the chosen output page');
    const priorEvaluationRevision = revision();
    editor.selection = new FakeSelection(new FakePosition(1, 0), new FakePosition(1, 0));
    await evaluate();
    assert.doesNotMatch(view.webview.html, /class="loop-output"/);
    assert.notEqual(/data-loop-token="(\d+)"/.exec(view.webview.html)![1], initialIdentity);
    view.webview.fireMessage({ loop: 1, node: 1, action: gapAction,
      value: 0, revision: priorEvaluationRevision });
    assert.doesNotMatch(view.webview.html, /class="loop-output"/);
    send(1, gapAction);
    assert.match(view.webview.html, /20 0\n/, 'a new capture starts on the first output page');
    assert.equal(editor.selection.active.line, 1, 'browsing captured output does not move source');
  } finally { extension.deactivate(); }
});


test('capturing away from the file start keeps nested line labels relative to the statement', async () => {
  const model = prepared(await captured('# intro\n\n' + source, 2));
  assert.equal(model.wire.statement_line, 2);
  assert.match(loopExplorerHtml(model, 2), /· line 5/);
  assert.match(loopExplorerHtml(model, 3), /· line 6/);
});

test('long flat multiline output keeps capped scrolling and honest expansion copy', () => {
  const value = 'line\n'.repeat(10000);
  const rows = rowsFor({ lineAt: () => ({ text: 'print(value)' }) }, [
    { range: { start: { line: 0 }, end: { line: 0 } }, value: '',
      printed: { stdout: value } }], 'printed');
  const folded = contents(valuesHtml({ fileName: 'test.py', rows }, 0, 'n'));
  assert.match(folded, />Show more</);
  assert.doesNotMatch(folded, />Show all</);
  const expanded = contents(valuesHtml({ fileName: 'test.py', rows }, 0, 'n', undefined,
    { expandedLines: new Set([0]) }));
  assert.match(expanded, /class="fold-scroll"/);
  assert.match(expanded, />Show less</);
  assert.match(expanded, />Open in editor</);
  assert.ok(expanded.length < 19000);
});


test('failed nested evaluation preserves its printed text in Values for both commands', async () => {
  for (const command of ['evalens.evaluateAtCursor', 'evalens.evaluateFile']) {
    const fake = createFakeVscode();
    const editor = createEditor('for x in [0]:\n    for y in [0]:\n'
      + '        print("before failure")\n        1 / 0\n');
    fake.window.activeTextEditor = editor;
    fake.window.visibleTextEditors = [editor];
    const extension = loadCompiledExtension(path.join(root, 'out'), fake);
    extension.activate(createExtensionContext(root) as never);
    try {
      await fake.executeCommand(command);
      const view = new FakeWebviewView();
      fake.webviewViewProviders.get('evalens.values')!.resolveWebviewView(view, {}, {});
      const html = contents(view.webview.html);
      assert.match(html, /class="error-text">ZeroDivisionError/);
      assert.match(html, /class="seg-streamLabel">printed:/);
      assert.match(html, /class="seg-value">before failure/);
      assert.doesNotMatch(html, /class="loop-explorer"/);
    } finally { extension.deactivate(); }
  }
});
