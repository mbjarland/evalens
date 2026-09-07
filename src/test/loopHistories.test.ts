import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { KernelClient } from '../kernel/client';
import { Evaluated, LoopExplorerWire } from '../kernel/protocol';
import { hoverText, resultText } from '../render/format';
import { inlineLoopHistories, inlineLoopHover } from '../render/loopHistories';
import { present } from '../render/present';
import {
  FakeEditor, FakePosition, FakeRange, FakeSelection, FakeVscode,
  createEditor, createExtensionContext, createFakeVscode, loadCompiledExtension,
  paintedLineText, paintedLines,
} from './harness/fakeVscode';

const root = path.resolve(__dirname, '..', '..');
const uniform = 'for x in range(100):\n    for y in range(100):\n        print(x, y)\n';
async function capture(source: string) {
  const client = new KernelClient({ resolvePython: async () => 'python3',
    kernelPath: path.join(root, 'kernel', 'evalens_kernel.py') });
  try {
    const result = await client.request({ op: 'eval', source, line: 0,
      character: 0, filename: '/tmp/evalens-inline-histories-test.py', allow_stdin: false });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result as Evaluated;
  } finally { client.dispose(); }
}
const plain = (text: string) => text.replace(/\u00a0/g, ' ');

async function hover(fake: FakeVscode, editor: FakeEditor, line: number) {
  const provider = fake.hoverProviders[0]!.provider as { provideHover(
    document: unknown, position: FakePosition): Promise<{ contents: { value: string } } | undefined> };
  return (await provider.provideHover(editor.document, new FakePosition(line, 0)))?.contents.value;
}
function activated(source: string) {
  const fake = createFakeVscode();
  const editor = createEditor(source);
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = loadCompiledExtension(path.join(root, 'out'), fake);
  extension.activate(createExtensionContext(root) as never);
  const evaluate = fake.commands.registered.get('evalens.evaluateAtCursor') as () => Promise<void>;
  return { fake, editor, extension, evaluate };
}

test('real saved recorder summaries place exact aggregate histories on each source header', async () => {
  const result = await capture(uniform);
  const annotation = present(result, 0);
  assert.equal(annotation.kind, 'value');
  if (annotation.kind !== 'value') return;
  const rows = inlineLoopHistories(annotation)!;
  assert.deepEqual(rows.map((row) => [row.line, row.site.target, row.trace.count]),
    [[0, 'x', 100], [1, 'y', 10000]]);
  assert.ok(result.loop_explorer!.omitted_iterations > 8000);
  const text = resultText({ value: null, display: 'y', loop: rows[1]!.trace });
  assert.match(plain(text), /y ×10,000 total: 0, 1, 2, 3, 4, … \(\+9,994 more\) … 99/);
  assert.match(inlineLoopHover({ ...annotation, partial: undefined }, 1)!, /10000 iterations total across 100 loop runs/);
});

test('zero runs and empty runs are distinct; one inner run keeps the ordinary count grammar', () => {
  const trace = { site: 1, invocations: 0, count: 0, values: [], last: null };
  assert.match(plain(resultText({ value: null, display: 'y', loop: trace })), /y: \(not reached\)/);
  assert.match(hoverText({ value: null, display: 'y', loop: trace }), /Loop not reached/);
  assert.match(plain(resultText({ value: null, display: 'y', loop: { ...trace, invocations: 2 } })),
    /y: \(no iterations\)/);
  assert.match(hoverText({ value: null, loop: { ...trace, invocations: 2 } }),
    /0 iterations total across 2 loop runs/);
  assert.match(plain(resultText({ value: null, display: 'y', loop: {
    ...trace, count: 2, invocations: 1, values: ['0', '1'],
  } })), /y ×2: 0, 1/);
});

test('malformed or incomplete source-history metadata never guesses child placements', async () => {
  const result = await capture(uniform);
  const wire = result.loop_explorer!;
  const invalids = [
    { ...wire, histories: undefined },
    { ...wire, histories: wire.histories!.slice(1) },
    { ...wire, histories: [wire.histories![0], wire.histories![0]] },
    { ...wire, histories: wire.histories!.map((h) => ({ ...h, count: -1 })) },
    { ...wire, histories: wire.histories!.map((h) => ({ ...h, values: Array(51).fill('1') })) },
    { ...wire, sites: wire.sites.map((site) => ({ ...site, line: 9999 })) },
    { ...wire, sites: Array(65).fill(wire.sites[0]) },
    { ...wire, sites: wire.sites.map((site) => ({ ...site, parent: null })) },
  ];
  for (const invalid of invalids) assert.equal(inlineLoopHistories({ range: result.range,
    loopExplorer: invalid as LoopExplorerWire }), undefined);
  assert.equal(inlineLoopHistories({ range: result.range, loopExplorer: wire, pending: {} }), undefined);
  assert.equal(inlineLoopHistories({ range: result.range, loopExplorer: wire, error: {} }), undefined);
});

test('loaded extension paints nested histories, keeps output with its owner and serves local saved hover', async () => {
  const { fake, editor, extension, evaluate } = activated(uniform);
  try {
    await evaluate();
    assert.deepEqual(paintedLines(editor), [0, 1]);
    const outer = plain(paintedLineText(editor, 0));
    const inner = plain(paintedLineText(editor, 1));
    assert.match(outer, /x ×100:/);
    assert.doesNotMatch(outer, /y:/);
    assert.match(outer, /printed:/);
    assert.match(inner, /y ×10,000 total:/);
    assert.doesNotMatch(inner, /printed:/);
    const localHover = await hover(fake, editor, 1);
    assert.match(localHover!, /10000 iterations total across 100 loop runs/);
    assert.doesNotMatch(localHover!, /Current kernel value|x =|Explore/);
    const ownerHover = await hover(fake, editor, 0);
    assert.match(ownerHover!, /Values after loop:\nx = 99\ny = 99/);
    (fake.commands.registered.get('evalens.clearResults') as () => void)();
    assert.deepEqual(paintedLines(editor), []);
    assert.equal(await hover(fake, editor, 1), undefined);
  } finally { extension.deactivate(); }
});

test('child decorations reanchor as one owned capture and withdraw uncertain positions on own edit', async () => {
  const source = 'for x in range(2):\n    for y in range(3): pass\n';
  const { fake, editor, extension, evaluate } = activated(source);
  try {
    await evaluate();
    editor.document.setText('# prefix\n' + source);
    fake.emitters.onDidChangeTextDocument.fire({ document: editor.document,
      contentChanges: [{ range: new FakeRange(0, 0, 0, 0), text: '# prefix\n' }] });
    assert.deepEqual(paintedLines(editor), [1, 2]);
    assert.match(plain(paintedLineText(editor, 2)), /y ×6 total:/);
    assert.match((await hover(fake, editor, 2))!, /6 iterations total across 2 loop runs/);
    editor.document.setText('# prefix\n' + source.replace('range(3)', 'range(4)'));
    fake.emitters.onDidChangeTextDocument.fire({ document: editor.document,
      contentChanges: [{ range: new FakeRange(2, 19, 2, 20), text: '4' }] });
    assert.deepEqual(paintedLines(editor), [1]);
    assert.match((await hover(fake, editor, 1))!, /Stale:/);
    assert.doesNotMatch(plain(paintedLineText(editor, 1)), /y:/);
    editor.selection = new FakeSelection(new FakePosition(1, 0), new FakePosition(1, 0));
    await evaluate();
    assert.deepEqual(paintedLines(editor), [1, 2]);
    assert.match(plain(paintedLineText(editor, 2)), /y ×8 total:/);
  } finally { extension.deactivate(); }
});

test('new pending evaluation removes every old child before the response arrives', async () => {
  const { editor, extension, evaluate } = activated(
    'for x in range(2):\n    for y in range(2): pass\n');
  try {
    await evaluate();
    assert.deepEqual(paintedLines(editor), [0, 1]);
    const running = evaluate();
    assert.equal(paintedLineText(editor, 1), '');
    await running;
    assert.match(plain(paintedLineText(editor, 1)), /y ×4 total:/);
  } finally { extension.deactivate(); }
});

test('repeated target names and three levels retain separate decoration anchors', async () => {
  const { editor, extension, evaluate } = activated(
    'for x in [3, 4]:\n    for x in [7, 8]:\n        for x in [9]: pass\n');
  try {
    await evaluate();
    assert.deepEqual(paintedLines(editor), [0, 1, 2]);
    assert.match(plain(paintedLineText(editor, 0)), /x ×2: 3, 4/);
    assert.match(plain(paintedLineText(editor, 1)), /x ×4 total: 7, 8, 7, 8/);
    assert.match(plain(paintedLineText(editor, 2)), /x ×4 total: 9, 9, 9, 9/);
  } finally { extension.deactivate(); }
});


test('file-load repeat suppression never treats hidden final snapshots as painted values', async () => {
  const { fake, editor, extension } = activated(
    'for x in [0]:\n    for y in [0, 1]: pass\nprint(y)\n');
  try {
    await (fake.commands.registered.get('evalens.evaluateFile') as () => Promise<void>)();
    assert.doesNotMatch(plain(paintedLineText(editor, 0)), /y:/);
    assert.match(plain(paintedLineText(editor, 1)), /y ×2: 0, 1/);
    assert.match(plain(paintedLineText(editor, 2)), /y: 1/);
  } finally { extension.deactivate(); }
});

test('dependency staleness keeps child histories as old readings with the owner explanation', async () => {
  const source = 'n = 2\nfor x in range(n):\n    for y in range(3): pass\n';
  const { fake, editor, extension, evaluate } = activated(source);
  try {
    await (fake.commands.registered.get('evalens.evaluateFile') as () => Promise<void>)();
    editor.document.setText(source.replace('n = 2', 'n = 3'));
    fake.emitters.onDidChangeTextDocument.fire({ document: editor.document,
      contentChanges: [{ range: new FakeRange(0, 4, 0, 5), text: '3' }] });
    editor.selection = new FakeSelection(new FakePosition(0, 0), new FakePosition(0, 0));
    await evaluate();
    assert.match(plain(paintedLineText(editor, 1)), /x ×2: 0, 1/);
    assert.match(plain(paintedLineText(editor, 2)), /y ×6 total:/);
    const text = await hover(fake, editor, 2);
    assert.match(text!, /Stale:.*‘n’.*re-bound/);
    assert.match(text!, /6 iterations total across 2 loop runs/);
  } finally { extension.deactivate(); }
});
