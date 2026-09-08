import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { KernelClient } from '../kernel/client';
import { Evaluated, Outlined } from '../kernel/protocol';
import {
  createFakeVscode, createExtensionContext, loadCompiledExtension, createEditor,
} from './harness/fakeVscode';

const root = path.resolve(__dirname, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const steps = manifest.contributes.walkthroughs[0].steps as Array<{
  id: string; description: string; media: { markdown: string }; completionEvents: string[];
}>;
const template = (id: string) => fs.readFileSync(path.join(root, 'media/learning', `${id}.py`), 'utf8');

function activate() {
  const fake = createFakeVscode();
  Object.assign(fake.module as object, { ViewColumn: { Beside: -2 } });
  const extension = loadCompiledExtension(path.join(root, 'out'), fake);
  const context = createExtensionContext(root);
  extension.activate(context as never);
  return { fake, extension, context };
}

test('learning links resolve to the five allowlisted exercises without automatic completion', () => {
  const { extension } = activate();
  try {
    const { EXERCISES } = require('../learning') as typeof import('../learning');
    assert.deepEqual(steps.map(s => s.id), EXERCISES.map(e => e.id));
    for (const step of steps) {
      const link = /command:evalens.openLearningExercise\?([^)]*)/.exec(step.description);
      assert.ok(link);
      assert.deepEqual(JSON.parse(decodeURIComponent(link[1])), [step.id]);
      assert.ok(fs.existsSync(path.join(root, step.media.markdown)));
      assert.ok(template(step.id).length > 0);
      // An empty list lets VS Code infer "opened the exercise = completed".
      // This reserved event is never fired; the native checkbox is the learner's.
      assert.deepEqual(step.completionEvents, ['onEvent:evalens.learning.manualCompletion']);
    }
  } finally { extension.deactivate(); }
});

test('every exercise opens a fresh editable Python copy without issuing evaluation', async () => {
  const { fake, extension } = activate();
  try {
    for (const step of steps) {
      await fake.executeCommand('evalens.openLearningExercise', step.id);
      const document = fake.openedDocuments.at(-1)!;
      assert.equal(document.languageId, 'python');
      assert.match(document.uri.toString(), /untitled:Untitled-/);
      assert.match(document.getText(), /^# /);
      assert.doesNotMatch(document.getText(), /\{\{/);
      assert.equal(fake.shownDocuments.at(-1)!.preserveFocus, false);
      assert.equal(document.getText(), template(step.id));
    }
    await fake.executeCommand('evalens.openLearningExercise', 'predict');
    assert.notEqual(fake.openedDocuments[0].uri.toString(), fake.openedDocuments.at(-1)!.uri.toString());
    assert.equal(fake.messages.error.length, 0);
    assert.ok(!fake.commands.executed.some(c => /evaluate|restartKernel|runFile/.test(c.id)));
  } finally { extension.deactivate(); }
});

test('exercise picker can be cancelled and rejects arbitrary file paths', async () => {
  const { fake, extension } = activate();
  try {
    await fake.executeCommand('evalens.openLearningExercise');
    assert.equal(fake.openedDocuments.length, 0);
    for (const invalid of ['../../README', null, {}, 1]) {
      await fake.executeCommand('evalens.openLearningExercise', invalid);
    }
    assert.equal(fake.openedDocuments.length, 0);
    assert.equal(fake.messages.error.length, 4);
    fake.quickPick.picks.push('1. Predict a value');
    await fake.executeCommand('evalens.openLearningExercise');
    assert.equal(fake.openedDocuments.length, 1);
  } finally { extension.deactivate(); }
});

test('each opened example gives its Mac default with Windows/Linux in parentheses', async () => {
  const { fake, extension } = activate();
  const commands: Record<string, string> = {
    predict: 'evaluateAtCursor', advance: 'evaluateAndAdvance',
    aliasing: 'evaluateAndAdvance', accumulator: 'evaluateFile', stale: 'evaluateAtCursor',
  };
  try {
    for (const step of steps) {
      await fake.executeCommand('evalens.openLearningExercise', step.id);
      const content = fake.openedDocuments.at(-1)!.getText().toLowerCase();
      assert.doesNotMatch(content, /\{\{/);
      const command = `evalens.${commands[step.id]}`;
      const binding = manifest.contributes.keybindings.find((b: { command: string }) => b.command === command);
      assert.ok(binding?.key && binding.mac, `${step.id} has no platform defaults`);
      const title = manifest.contributes.commands.find((c: { command: string }) => c.command === command)?.title;
      assert.ok(title && content.includes(title.toLowerCase()), `${step.id} names its evaluation command`);
      assert.ok(content.includes(`default key: ${binding.mac} (${binding.key} on windows/linux).`),
        `${step.id} must put the Mac default first and Windows/Linux in parentheses`);
    }
  } finally { extension.deactivate(); }
});

test('each learning guide documents its command defaults for Windows/Linux and macOS', () => {
  for (const step of steps) {
    const guide = fs.readFileSync(path.join(root, step.media.markdown), 'utf8');
    assert.match(guide, /\| Command \| Windows \/ Linux \| macOS \|/);
    const rows = [...guide.matchAll(/^\| (Evalens: [^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)];
    assert.ok(rows.length > 0, `${step.id} has no command key table`);
    for (const [, title, windows, mac] of rows) {
      const command = manifest.contributes.commands.find((c: { title: string }) => c.title === title);
      assert.ok(command, `${step.id} names an unknown command: ${title}`);
      const binding = manifest.contributes.keybindings.find((b: { command: string; mac?: string }) =>
        b.command === command.command && b.mac);
      assert.ok(binding, `${title} has no platform defaults`);
      assert.equal(windows.toLowerCase(), binding.key, `${step.id}: Windows/Linux`);
      assert.equal(mac.toLowerCase(), binding.mac, `${step.id}: macOS`);
    }
  }
});

test('the packaged exercises teach values produced by the real kernel', async (t) => {
  const client = new KernelClient({ resolvePython: async () => 'python3',
    kernelPath: path.join(root, 'kernel/evalens_kernel.py') });
  t.after(() => client.dispose());
  async function run(source: string): Promise<Evaluated[]> {
    const results: Evaluated[] = [];
    // Use outline ranges to follow top-level statements, as the editor does.
    const outline = await client.request({ op: 'outline', source, filename: '/tmp/learning.py' });
    assert.ok(outline.ok);
    const ranges = (outline as Outlined).statements;
    for (const range of ranges) {
      const result = await client.request({ op: 'eval', source, line: range.range.start.line,
        character: 0, filename: '/tmp/learning.py', allow_stdin: false }) as Evaluated;
      assert.ok(result.ok && result.resolved, JSON.stringify(result));
      results.push(result);
    }
    return results;
  }
  assert.equal((await run(template('predict'))).at(-1)!.value, '14');
  assert.equal((await run(template('advance'))).at(-1)!.value, '24');
  const alias = await run(template('aliasing'));
  assert.equal(alias[0].value, '[1, 2, 3]');
  assert.equal(alias.at(-1)!.value, '[1, 2, 3, 4]');
  const broken = await run(template('accumulator'));
  assert.equal(broken.at(-1)!.value, '6');
  assert.deepEqual(broken[2].bindings?.find(b => b.name === 'total')?.values, ['2', '4', '6']);
  const fixed = await run(template('accumulator').replace('    total = score', '    total += score'));
  assert.equal(fixed.at(-1)!.value, '12');
  assert.deepEqual(fixed[2].bindings?.find(b => b.name === 'total')?.values, ['2', '6', '12']);
  assert.equal((await run(template('stale'))).at(-1)!.value, '10');
  assert.equal((await run(template('stale').replace('answer = 10\n', 'answer = 20\n'))).at(-1)!.value, '20');
});

test('only asking for the walkthrough makes it visible and opens it', async () => {
  const { fake, extension } = activate();
  try {
    assert.equal(manifest.contributes.walkthroughs[0].when, 'evalens.learning.requested');
    assert.ok(!fake.commands.executed.some(c => c.id === 'workbench.action.openWalkthrough'));
    assert.ok(!fake.commands.executed.some(c => c.id === 'setContext' && c.args[0] === 'evalens.learning.requested'));
    await fake.executeCommand('evalens.openLearningWalkthrough');
    const last = fake.commands.executed.slice(-2);
    assert.deepEqual(last, [
      { id: 'setContext', args: ['evalens.learning.requested', true] },
      { id: 'workbench.action.openWalkthrough', args: ['mbjarland.evalens#evalens.learning', false] },
    ]);
    assert.equal(fake.openedDocuments.length, 0);
  } finally { extension.deactivate(); }
});

test('reopening an exercise reuses its visible group without targeting ordinary documents', async () => {
  const { fake, extension } = activate();
  const window = (fake.module as { window: {
    showTextDocument: (...args: any[]) => Promise<any>;
  } }).window;
  const original = window.showTextDocument;
  const columns: number[] = [];
  window.showTextDocument = async (...args: any[]) => {
    columns.push(args[1].viewColumn);
    const editor = await original(...args);
    Object.assign(editor, { viewColumn: 3 });
    fake.window.visibleTextEditors = [editor];
    return editor;
  };
  try {
    fake.window.visibleTextEditors = [Object.assign(createEditor('personal = 1'), { viewColumn: 2 })];
    await fake.executeCommand('evalens.openLearningExercise', 'predict');
    await fake.executeCommand('evalens.openLearningExercise', 'advance');
    assert.deepEqual(columns, [-2, 3]);
    assert.equal(fake.messages.error.length, 0);
  } finally { extension.deactivate(); }
});
