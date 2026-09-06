import { test } from 'node:test';
import assert from 'node:assert/strict';
import type * as ChildProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * `require`d rather than `import * as`: TypeScript compiles a namespace
 * import to a read-only view (a getter with no setter, for live-binding
 * fidelity with real ES modules), and `withSpawnedPids` below needs to
 * reassign `.spawn` on the actual module object -- the same one
 * `kernel/client.ts` looks its `spawn` up on at call time.
 */
const childProcess = require('node:child_process') as typeof ChildProcess;

import {
  FakeEditor, FakeHover, FakeMarkdownString, FakePosition, FakeRange,
  FakeSelection, FakeVscode, createEditor, createExtensionContext,
  createFakeVscode, loadCompiledExtension, paintedLineText, paintedLines,
} from './harness/fakeVscode';

/**
 * What nothing else in this suite touches: `extension.ts`, `evaluate.ts`,
 * `render/decorations.ts` and `render/annotations.ts` (the four `import *
 * as vscode` files the pure/impure split leaves uncovered), plus `config.ts`,
 * `prompt.ts` and `render/announcer.ts`, which joined them since. See #42.
 *
 * ## Why a `vscode` mock rather than `@vscode/test-electron`
 *
 * `@vscode/test-electron` downloads a real VS Code build and runs tests
 * inside an actual Extension Development Host. That is the only way to prove
 * a pixel was painted, and it is not what this does. It was weighed and set
 * aside for what design rule 10 asks of any check that claims to verify
 * something: it would need a display in CI (`xvfb` on Linux), it adds a
 * real, large, slow dependency, and a single run of it is measured in
 * minutes rather than the low single-digit seconds the rest of this suite
 * costs -- which matters concretely here, because ten agents landing changes
 * across these same files each run this suite before every commit. A check
 * that makes that loop minutes long gets skipped, which is a worse outcome
 * than a check that proves less but always runs.
 *
 * The fake in `./harness/fakeVscode.ts` is the cheaper answer: a
 * `Module._load` override stands in for `'vscode'`, so the *compiled*
 * `out/extension.js` -- the file that ships -- can be `require`d and its
 * `activate`/`deactivate` driven directly, against the real kernel
 * subprocess over its real pipes. What it proves is real: which commands get
 * registered, that a command handler reaches the kernel and an annotation
 * comes back, that an edit re-anchors what it did not touch and drops what
 * it did, that disposing the extension's subscriptions disposes what it
 * created, that no interpreter survives `deactivate`.
 *
 * ## What this cannot prove (design rule 11)
 *
 * No pixel is ever drawn. `FakeDecorationType` records the options a real
 * `TextEditorDecorationType` would have been built from and nothing more --
 * whether the result is legible, whether two decoration layers actually
 * align, whether a `ThemeColor` renders as the colour a human would call
 * "the same colour but dimmer", none of that is answerable here. Nor is
 * anything about real user input, focus, or multi-window behaviour: there is
 * no real editor underneath any of this, only an object shaped enough like
 * one for the compiled code to run against without noticing the difference.
 * A decoration test asserting a range is not a person looking at the screen,
 * and nothing below claims to be one.
 */

const root = path.resolve(__dirname, '..', '..');
const outRoot = path.resolve(__dirname, '..');
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    contributes?: { commands?: Array<{ command: string }> };
  };
const contributedCommands: readonly string[] =
  (manifest.contributes?.commands ?? []).map((c) => c.command);

/** A fresh fake, a fresh compiled extension, and a context rooted at the real
 * repository -- so `ensureClient`'s kernel path resolves to the kernel that
 * actually ships. */
function activated(fake: FakeVscode): ReturnType<typeof loadCompiledExtension> {
  const extension = loadCompiledExtension(outRoot, fake);
  extension.activate(createExtensionContext(root) as never);
  return extension;
}

/** Same, but keeping the context so its subscriptions can be disposed. */
function activatedWithContext(fake: FakeVscode): {
  extension: ReturnType<typeof loadCompiledExtension>;
  context: ReturnType<typeof createExtensionContext>;
} {
  const extension = loadCompiledExtension(outRoot, fake);
  const context = createExtensionContext(root);
  extension.activate(context as never);
  return { extension, context };
}

/** Whether a process this test spawned is still alive, without signalling it. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until every one of `pids` has exited, or `timeoutMs` runs out. */
async function waitForExit(pids: readonly number[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && pids.some(isAlive)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Record the pid of every child process spawned while `work` runs.
 *
 * `kernel/client.ts` looks up `spawn` on the `node:child_process` module
 * object at call time rather than binding it at import time (`(0,
 * node_child_process_1.spawn)(...)` in the compiled output), so overwriting
 * the property here is visible to it -- the same module object is shared by
 * every `require('node:child_process')` in the process, this test's included.
 */
async function withSpawnedPids<T>(work: () => Promise<T>): Promise<{
  result: T;
  pids: readonly number[];
}> {
  const original = childProcess.spawn;
  const pids: number[] = [];
  const spy = ((...args: unknown[]) => {
    const child = (original as (...a: unknown[]) => ChildProcess.ChildProcess)(...args);
    if (typeof child.pid === 'number') {
      pids.push(child.pid);
    }
    return child;
  }) as typeof original;
  (childProcess as { spawn: typeof original }).spawn = spy;
  try {
    const result = await work();
    return { result, pids };
  } finally {
    (childProcess as { spawn: typeof original }).spawn = original;
  }
}

// -- commands: registered, contributed, and reachable ------------------------

test('activation registers exactly the commands package.json contributes', () => {
  const fake = createFakeVscode();
  activated(fake);

  const registered = [...fake.commands.registered.keys()].sort();
  assert.deepEqual(
    registered, [...contributedCommands].sort(),
    'the set of registered commands does not match package.json exactly -- ' +
    'either a contributed command is never registered (dead in the palette) ' +
    'or a registered one is never contributed (unreachable except by id)');
});

test('every contributed command runs through the palette with no editor open', async () => {
  // No active editor: every command that needs one guards on it and returns,
  // which is what this asserts about all nine without needing a kernel for
  // any of them -- `evalens.interrupt` and `evalens.restartKernel` reach
  // `ensureClient`, but neither spawns a process for a client that has never
  // made a request. Dispatched through `executeCommand`, the same entry
  // point the palette and a keybinding both use, rather than by calling the
  // registered handler directly.
  const fake = createFakeVscode();
  activated(fake);

  for (const id of contributedCommands) {
    await assert.doesNotReject(
      () => fake.executeCommand(id),
      `${id} failed when invoked the way the command palette invokes it`);
  }
});

test('a command contributed but never registered fails at the palette, ' +
  'which is what the test above would catch', async () => {
  // Not a test of the extension -- a test of the harness's own claim, so a
  // future edit to the fake cannot quietly stop checking anything. Nothing
  // here ever registers this id.
  const fake = createFakeVscode();
  activated(fake);
  await assert.rejects(
    () => fake.executeCommand('evalens.notAContributedCommand'),
    /not found/);
});

// -- activation degrades, rather than throws, with no interpreter ------------

test('activation does not throw with no interpreter, and says so actionably', async () => {
  const fake = createFakeVscode();
  // An explicit, wrong setting: `chooseInterpreter` treats a configured path
  // as a hard failure rather than falling back, which is the shortest route
  // to "no usable interpreter" without needing PATH itself to be empty.
  fake.config.set('evalens', 'pythonPath', '/no/such/interpreter-42');
  const editor = createEditor('1 + 1\n');
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  activated(fake);

  const evaluateAtCursor = fake.commands.registered.get('evalens.evaluateAtCursor');
  assert.ok(evaluateAtCursor, 'evalens.evaluateAtCursor was not registered');
  await assert.doesNotReject(
    () => evaluateAtCursor() as Promise<void>,
    'evaluating with no interpreter available must degrade, not throw');

  assert.equal(fake.messages.error.length, 2,
    'expected the interpreter failure and the transport-level summary');
  const [detail, summary] = fake.messages.error;
  assert.match(detail!.message, /could not start a Python kernel/);
  assert.deepEqual(detail!.items, ['Open Setting'],
    'no ms-python.python in this fake, so "Select Interpreter" must not be ' +
    'offered -- offering it would run a command from an extension that is ' +
    'not there');
  assert.match(summary!.message, /^Evalens: /);
  assert.match(summary!.message, /no usable Python interpreter/);
});

// -- evaluateAtCursor and evaluateFile paint real kernel output ---------------

test('evaluateAtCursor paints exactly one annotation, carrying the value the ' +
  'kernel returned', async () => {
  const fake = createFakeVscode();
  const editor = createEditor('40 + 2\n');
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = activated(fake);

  try {
    const evaluateAtCursor = fake.commands.registered.get('evalens.evaluateAtCursor');
    await (evaluateAtCursor as () => Promise<void>)();

    assert.deepEqual(paintedLines(editor), [0],
      'expected exactly one line carrying a painted annotation');
    assert.match(paintedLineText(editor, 0), /42/,
      'the painted text does not carry the value the kernel computed');
  } finally {
    // Every test that reaches a real kernel kills it again, or the process
    // this run spawns outlives the run -- exactly the bug #42 asks a test to
    // catch, and it should not take a whole run of them leaking to notice.
    extension.deactivate();
  }
});

test('evaluateFile paints one annotation per statement', async () => {
  const fake = createFakeVscode();
  const editor = createEditor('40 + 2\n100 + 1\n9 * 9\n');
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = activated(fake);

  try {
    const evaluateFile = fake.commands.registered.get('evalens.evaluateFile');
    await (evaluateFile as () => Promise<void>)();

    assert.deepEqual(paintedLines(editor), [0, 1, 2],
      'expected one painted line per statement');
    assert.match(paintedLineText(editor, 0), /42/);
    assert.match(paintedLineText(editor, 1), /101/);
    assert.match(paintedLineText(editor, 2), /81/);
  } finally {
    extension.deactivate();
  }
});

// -- #104: Add Inline Watch prompts for a typed expression -------------------

/**
 * `paintedLineText`, with the non-breaking spaces `format.ts`'s
 * `preserveSpacing` puts in painted text folded back to ordinary ones --
 * `format.ts` itself does the same reversal for a screen reader's benefit
 * (`hoverFor`'s "said" text). A regex written the way a reader would read
 * the line should not have to know VS Code eats literal spaces in
 * `contentText`.
 */
function depainted(editor: FakeEditor, line: number): string {
  return paintedLineText(editor, line).replace(/ /g, ' ');
}

test('addInlineWatch traces a typed expression that is not in the source ' +
  'at all', async () => {
  const fake = createFakeVscode();
  const editor = createEditor(
    'total = 0\nfor x in [1, 2, 3, 4]:\n    total += x\n');
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = activated(fake);

  try {
    // Bind `total` first -- `eval_watch` runs only the loop it resolves to,
    // the same as a plain `eval` of it would, so a name the loop's body
    // reads has to already be in the namespace.
    const evaluateAtCursor = fake.commands.registered.get('evalens.evaluateAtCursor');
    await (evaluateAtCursor as () => Promise<void>)();

    // No selection, and the cursor sits in the body line's indentation --
    // not on the word "total" -- so #106's cursor prefill has nothing to
    // offer either; the box opens exactly as empty as it always has here.
    editor.selection = new FakeSelection(
      new FakePosition(2, 0), new FakePosition(2, 0));
    fake.inputBox.answers.push('total * 2');
    const addInlineWatch = fake.commands.registered.get('evalens.addInlineWatch');
    await (addInlineWatch as () => Promise<void>)();

    assert.equal(fake.inputBox.calls.length, 1, 'the box was shown');
    assert.equal(fake.inputBox.calls[0].value, '',
      'nothing was selected and the cursor touches no word, so nothing is ' +
      'prefilled');
    assert.match(fake.inputBox.calls[0].title ?? '', /for x in/,
      'the box names the loop this nomination lands in');

    // Painted on the loop's own header line -- 0-based line 1 -- exactly
    // where the loop's own target trace already lands.
    const text = depainted(editor, 1);
    assert.match(text, /total \* 2/,
      'the typed expression was never in the source and still traced');
    assert.match(text, /2, 6, 12, 20/,
      'total * 2, tracked at each iteration total itself became 1, 3, 6, 10');
  } finally {
    extension.deactivate();
  }
});

test('addInlineWatch still offers the selection as the box\'s default',
  async () => {
    const fake = createFakeVscode();
    const editor = createEditor(
      'total = 0\nfor x in [1, 2, 3, 4]:\n    total += x\n');
    fake.window.activeTextEditor = editor;
    fake.window.visibleTextEditors = [editor];
    const extension = activated(fake);

    try {
      const evaluateAtCursor = fake.commands.registered.get('evalens.evaluateAtCursor');
      await (evaluateAtCursor as () => Promise<void>)();

      // "total" on its own body line -- the gesture the command supported
      // before #104, still exactly one keypress once the box accepts it.
      editor.selection = new FakeSelection(
        new FakePosition(2, 4), new FakePosition(2, 9));
      fake.inputBox.answers.push('total');
      const addInlineWatch = fake.commands.registered.get('evalens.addInlineWatch');
      await (addInlineWatch as () => Promise<void>)();

      assert.equal(fake.inputBox.calls[0].value, 'total',
        'the selection is offered as the prefilled default');
      const text = depainted(editor, 1);
      assert.match(text, /x ×4: 1, 2, 3, 4/);
      assert.match(text, /total ×4: 1, 3, 6, 10/);
    } finally {
      extension.deactivate();
    }
  });

// -- #106: with no selection, the box prefills with the word under the ------
// -- cursor, when that word is one this can trust -----------------------------

test('addInlineWatch prefills the bare name under the cursor with no ' +
  'selection', async () => {
  const fake = createFakeVscode();
  const editor = createEditor(
    'total = 0\nfor x in [1, 2, 3, 4]:\n    total += x\n');
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = activated(fake);

  try {
    const evaluateAtCursor = fake.commands.registered.get('evalens.evaluateAtCursor');
    await (evaluateAtCursor as () => Promise<void>)();

    // No selection: an empty range sitting on the word "total" itself, the
    // zero-effort case #106 exists for.
    editor.selection = new FakeSelection(
      new FakePosition(2, 4), new FakePosition(2, 4));
    fake.inputBox.answers.push('total');
    const addInlineWatch = fake.commands.registered.get('evalens.addInlineWatch');
    await (addInlineWatch as () => Promise<void>)();

    assert.equal(fake.inputBox.calls[0].value, 'total',
      'the identifier under the cursor is offered with nothing selected');
    const text = depainted(editor, 1);
    assert.match(text, /total ×4: 1, 3, 6, 10/);
  } finally {
    extension.deactivate();
  }
});

test('addInlineWatch leaves the box empty when the cursor sits on a word ' +
  'this cannot trust', async () => {
  const fake = createFakeVscode();
  const editor = createEditor('for x in [1, 2, 3, 4]:\n    pass\n');
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = activated(fake);

  try {
    // No selection, cursor resting on the loop's own keyword "for".
    editor.selection = new FakeSelection(
      new FakePosition(0, 1), new FakePosition(0, 1));
    fake.inputBox.answers.push('x');
    const addInlineWatch = fake.commands.registered.get('evalens.addInlineWatch');
    await (addInlineWatch as () => Promise<void>)();

    assert.equal(fake.inputBox.calls[0].value, '',
      '"for" is a keyword, never offered, however loudly the cursor sits ' +
      'on it');
  } finally {
    extension.deactivate();
  }
});

test('a selection wins over the cursor outright, even one starting on a ' +
  'keyword', async () => {
  const fake = createFakeVscode();
  const editor = createEditor('for x in [1, 2, 3, 4]:\n    pass\n');
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = activated(fake);

  try {
    // Selecting "for x" whole: `selection.start` sits on the keyword "for",
    // which #106's cursor prefill declines on its own -- but a selection is
    // text the reader chose, and it is offered verbatim regardless of what a
    // cursor-only reading of the same position would have made of it.
    editor.selection = new FakeSelection(
      new FakePosition(0, 0), new FakePosition(0, 5));
    fake.inputBox.answers.push('x');
    const addInlineWatch = fake.commands.registered.get('evalens.addInlineWatch');
    await (addInlineWatch as () => Promise<void>)();

    assert.equal(fake.inputBox.calls[0].value, 'for x',
      'the selection is offered exactly as selected, keyword text included');
  } finally {
    extension.deactivate();
  }
});

test('cancelling the watch box leaves no request sent and nothing painted',
  async () => {
    const fake = createFakeVscode();
    const editor = createEditor(
      'total = 0\nfor x in [1, 2, 3, 4]:\n    total += x\n');
    fake.window.activeTextEditor = editor;
    fake.window.visibleTextEditors = [editor];
    editor.selection = new FakeSelection(
      new FakePosition(2, 4), new FakePosition(2, 9));
    // No answer queued: `showInputBox` resolves to `undefined`, the same as
    // Escape, the close button, or the palette opening over it.
    const extension = activated(fake);

    try {
      const addInlineWatch = fake.commands.registered.get('evalens.addInlineWatch');
      await (addInlineWatch as () => Promise<void>)();

      assert.equal(fake.inputBox.calls.length, 1, 'the box was still shown');
      assert.deepEqual(paintedLines(editor), [],
        'nothing was ever sent to the kernel, so nothing can be painted');
      assert.equal(fake.messages.error.length, 0);
    } finally {
      extension.deactivate();
    }
  });

test('an expression that does not compile is shown as an error, never ' +
  'appended to the output channel', async () => {
  const fake = createFakeVscode();
  const editor = createEditor(
    'total = 0\nfor x in [1, 2, 3, 4]:\n    total += x\n');
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  editor.selection = new FakeSelection(
    new FakePosition(2, 4), new FakePosition(2, 4));
  // Incomplete on purpose: `ast.parse(..., mode="eval")` cannot finish it.
  fake.inputBox.answers.push('total *');
  const extension = activated(fake);

  try {
    const addInlineWatch = fake.commands.registered.get('evalens.addInlineWatch');
    await (addInlineWatch as () => Promise<void>)();

    assert.equal(fake.messages.error.length, 1,
      'a nomination that never compiled is said where the reader is looking');
    assert.match(fake.messages.error[0].message, /SyntaxError/);
    assert.deepEqual(paintedLines(editor), [],
      'there is no statement to paint a compile failure beside');
    // Kernel start-up chatter (which interpreter was probed and picked)
    // belongs on this channel; the compile failure itself must not.
    for (const channel of fake.outputChannels) {
      for (const line of channel.lines) {
        assert.doesNotMatch(line, /cannot watch|SyntaxError/,
          'design rule 7: the answer goes on the line, never the output ' +
          'channel, which is overflow and not a destination');
      }
    }
  } finally {
    extension.deactivate();
  }
});

test('a typed watch that raises partway still paints the loop it completed',
  async () => {
    const fake = createFakeVscode();
    const editor = createEditor('for p in [1, 0, 2, 0, 3]:\n    pass\n');
    fake.window.activeTextEditor = editor;
    fake.window.visibleTextEditors = [editor];
    editor.selection = new FakeSelection(
      new FakePosition(1, 4), new FakePosition(1, 4));
    fake.inputBox.answers.push('1/p');
    const extension = activated(fake);

    try {
      const addInlineWatch = fake.commands.registered.get('evalens.addInlineWatch');
      await (addInlineWatch as () => Promise<void>)();

      const text = depainted(editor, 0);
      // The loop's own target completed all five iterations regardless.
      assert.match(text, /p ×5: 1, 0, 2, 0, 3/);
      assert.match(text, /1\/p/);
      // The three iterations that did not divide by zero were still traced.
      assert.match(text, /1\.0/);
      assert.match(text, /0\.5/);
      assert.match(text, /0\.3333333333333333/);
    } finally {
      extension.deactivate();
    }
  });

// -- #99: a whole-file load resets the namespace by default -----------------

test('evaluateFile resets the namespace before a whole-file load, by ' +
  'default (#99)', async () => {
  const fake = createFakeVscode();
  const editor = createEditor('x = 1\nx\n');
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = activated(fake);

  try {
    const evaluateFile = fake.commands.registered.get('evalens.evaluateFile');
    await (evaluateFile as () => Promise<void>)();
    assert.match(paintedLineText(editor, 1), /\b1\b/,
      'setup: x is bound to 1 after the first load');

    // The line that bound x is gone. A namespace that did not reset would
    // still answer for it -- #56's exact failure, and the one #99 exists to
    // close.
    editor.document.setText('x\n');
    await (evaluateFile as () => Promise<void>)();
    assert.match(paintedLineText(editor, 0), /NameError/,
      'x survived a reload that no longer binds it, so the namespace was ' +
      'not reset');
  } finally {
    extension.deactivate();
  }
});

test('evalens.resetOnLoad false keeps the namespace across whole-file ' +
  'loads (#99)', async () => {
  const fake = createFakeVscode();
  fake.config.set('evalens', 'resetOnLoad', false);
  const editor = createEditor('x = 1\nx\n');
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = activated(fake);

  try {
    const evaluateFile = fake.commands.registered.get('evalens.evaluateFile');
    await (evaluateFile as () => Promise<void>)();
    assert.match(paintedLineText(editor, 1), /\b1\b/,
      'setup: x is bound to 1 after the first load');

    editor.document.setText('x\n');
    await (evaluateFile as () => Promise<void>)();
    assert.match(paintedLineText(editor, 0), /\b1\b/,
      'x should still be readable: the setting is off, so the load did ' +
      'not reset the namespace');
  } finally {
    extension.deactivate();
  }
});

// -- #100: surfacing residue after a non-resetting load ----------------------

test('a non-resetting load notes the residue it is running on top of ' +
  '(#100)', async () => {
  const fake = createFakeVscode();
  fake.config.set('evalens', 'resetOnLoad', false);
  const editor = createEditor('x = 1\nx\n');
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = activated(fake);

  try {
    const evaluateFile = fake.commands.registered.get('evalens.evaluateFile');
    await (evaluateFile as () => Promise<void>)();
    assert.ok(
      !fake.statusBarMessages.some((m) => m.includes('earlier session')),
      'the first load has nothing behind it yet, so nothing is residue');

    // x is gone from the file's own text, but the setting keeps it in the
    // namespace -- exactly the case #100 exists to make visible.
    editor.document.setText('y = 2\n');
    await (evaluateFile as () => Promise<void>)();
    const last = fake.statusBarMessages.at(-1);
    assert.match(last ?? '', /earlier session/);
    assert.match(last ?? '', /\(x\)/);
  } finally {
    extension.deactivate();
  }
});

test('a default, resetting load never mentions residue (#100)', async () => {
  const fake = createFakeVscode();
  const editor = createEditor('x = 1\nx\n');
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = activated(fake);

  try {
    const evaluateFile = fake.commands.registered.get('evalens.evaluateFile');
    await (evaluateFile as () => Promise<void>)();
    editor.document.setText('y = 2\n');
    await (evaluateFile as () => Promise<void>)();
    assert.ok(
      !fake.statusBarMessages.some((m) => m.includes('earlier session')),
      'the default resets first, so there is nothing left over to report');
  } finally {
    extension.deactivate();
  }
});

// -- #102: a load flashes each statement as a sweep, not once at the end ----

test('a whole-file load flashes each statement as its outcome lands (#102)',
  async () => {
  const fake = createFakeVscode();
  const editor = createEditor('1\n2\n3\n');
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = activated(fake);

  try {
    const evaluateFile = fake.commands.registered.get('evalens.evaluateFile');
    await (evaluateFile as () => Promise<void>)();

    // `Flash` reuses one decoration type per colour, identified by the
    // theme colour id rather than by import: `render/decorations.ts` pulls
    // in `vscode` at the top of the module, which this test file cannot
    // require directly -- only the compiled extension, through the fake.
    const flashedLines = editor.decorationCalls
      .filter((call) => {
        const options = call.type.options as {
          readonly backgroundColor?: { readonly id?: string };
        };
        return options.backgroundColor?.id === 'evalens.flashRegionBackground';
      })
      .filter((call) => call.options.length > 0)
      .map((call) => call.options[0]!.range!.start.line);

    // One flash per statement, landing in file order, rather than a single
    // flash once the whole load is over -- the whole point of building this
    // as a sweep rather than a single "the load finished" emphasis.
    assert.deepEqual(flashedLines, [0, 1, 2]);
  } finally {
    extension.deactivate();
  }
});

// -- #88: bulk-work summaries reach a screen reader too ----------------------

test('a whole-file load is announced, not only shown in the status bar ' +
  '(#88)', async () => {
  const fake = createFakeVscode();
  fake.config.set('evalens', 'announceResults', 'always');
  const editor = createEditor('1 + 1\n');
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = activated(fake);

  try {
    const evaluateFile = fake.commands.registered.get('evalens.evaluateFile');
    await (evaluateFile as () => Promise<void>)();

    const expected = 'Evalens: loaded 1 statement';
    assert.equal(fake.statusBarMessages.at(-1), expected,
      'setup: the sighted status-bar summary is unchanged');
    assert.ok(
      fake.messages.information.some((m) => m.message === expected),
      'the load summary never reached showInformationMessage, so a screen ' +
      'reader hears nothing when a file loads');
    const item = fake.statusBarItems.at(-1);
    assert.equal(item?.accessibilityInformation?.label, expected,
      'the held status-bar item does not carry the load summary as its ' +
      'accessibility label');
  } finally {
    extension.deactivate();
  }
});

test('"nothing to evaluate here" is announced, not only shown (#88)',
  async () => {
  const fake = createFakeVscode();
  fake.config.set('evalens', 'announceResults', 'always');
  const editor = createEditor('\n');
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = activated(fake);

  try {
    const evaluateAtCursor =
      fake.commands.registered.get('evalens.evaluateAtCursor');
    await (evaluateAtCursor as () => Promise<void>)();

    const expected = 'Evalens: nothing to evaluate here';
    assert.equal(fake.statusBarMessages.at(-1), expected);
    assert.ok(
      fake.messages.information.some((m) => m.message === expected),
      'a blank line under the cursor is silent to a screen reader, ' +
      'indistinguishable from a dead keybinding');
  } finally {
    extension.deactivate();
  }
});

test('a load summary is not announced when announceResults is never (#88)',
  async () => {
  const fake = createFakeVscode();
  fake.config.set('evalens', 'announceResults', 'never');
  const editor = createEditor('1 + 1\n');
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = activated(fake);

  try {
    const evaluateFile = fake.commands.registered.get('evalens.evaluateFile');
    await (evaluateFile as () => Promise<void>)();

    assert.equal(fake.messages.information.length, 0,
      'the setting says never, so nothing should reach a notification');
  } finally {
    extension.deactivate();
  }
});

// -- an edit invalidates what it touched, and nothing else -------------------

test('a document edit clears only the statement it touched', async () => {
  const fake = createFakeVscode();
  const editor = createEditor('40 + 2\n100 + 1\n9 * 9\n');
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = activated(fake);

  try {
    const evaluateFile = fake.commands.registered.get('evalens.evaluateFile');
    await (evaluateFile as () => Promise<void>)();
    assert.deepEqual(paintedLines(editor), [0, 1, 2], 'setup: all three painted');

    // Line 1 gains a line break inside it -- an edit that changes the line
    // count of the statement it lands on, which `reanchor` always drops
    // rather than merely marks stale, because the statement it was beside no
    // longer occupies one line. The buffer is updated first, matching the
    // order VS Code delivers this in: `onDidChangeTextDocument` fires after
    // the model already reflects the edit.
    const oldLine = '100 + 1';
    editor.document.setText('40 + 2\n100 +\n1\n9 * 9\n');
    fake.emitters.onDidChangeTextDocument.fire({
      document: editor.document,
      contentChanges: [{ range: new FakeRange(1, 0, 1, oldLine.length), text: '100 +\n1' }],
    });

    // Untouched, above the edit: still there, unmoved, unmarked.
    assert.match(paintedLineText(editor, 0), /42/,
      'the annotation above the edit must survive it exactly as it was');
    // The edited statement: gone. Not merely unreadable -- absent, because
    // `render/registry.ts`'s `reanchor` drops rather than guesses at an
    // annotation whose statement the edit actually rewrote the shape of.
    assert.equal(paintedLineText(editor, 1), '',
      'the edited line must not still claim the value it had before the edit');
    // Below the edit, shifted down by the one line the edit added, value
    // intact: the statement did not change, only where it lives.
    assert.match(paintedLineText(editor, 3), /81/,
      'the annotation below the edit must move down with its statement');
  } finally {
    extension.deactivate();
  }
});

test('activation registers a hover provider for Python', async () => {
  // #46: the hover used to hang off the decoration's `hoverMessage`, which
  // can never be reached -- a zero-width `after` attachment matches no hover
  // anchor, and VS Code's own `showIfCollapsed` tolerance is not in the
  // public API. It is a real `HoverProvider` now, so failing to register one
  // is the same silent nothing an unregistered command is, and nothing else
  // in the suite would notice.
  const fake = createFakeVscode();
  const extension = activated(fake);
  try {
    assert.equal(fake.hoverProviders.length, 1,
      'exactly one hover provider should be registered');
    assert.ok(fake.hoverProviders[0]!.provider,
      'a provider object, not undefined');
  } finally {
    extension.deactivate();
  }
});

// -- #23: the inline object explorer's hover table and drill-down -----------

interface FakeHoverProvider {
  provideHover(
    document: unknown, position: FakePosition
  ): Promise<FakeHover | undefined>;
}

function hoverProvider(fake: FakeVscode): FakeHoverProvider {
  return fake.hoverProviders[0]!.provider as FakeHoverProvider;
}

/** The markdown a hover over `line` shows, or `undefined` for no hover at
 * all -- driven through the real kernel, exactly as a mouse would trigger
 * it, never by calling anything in `render/inspector.ts` directly. */
async function hoverTextAt(
  fake: FakeVscode, editor: FakeEditor, line: number
): Promise<string | undefined> {
  const hover = await hoverProvider(fake).provideHover(
    editor.document, new FakePosition(line, 0));
  return (hover?.contents as FakeMarkdownString | undefined)?.value;
}

// -- #109: a stale hover says why, not only that -----------------------------

test('hovering a stale line explains that its own code changed', async () => {
  const fake = createFakeVscode();
  const editor = createEditor('x = [1, 2, 3]\n');
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = activated(fake);
  try {
    await (fake.commands.registered.get('evalens.evaluateAtCursor') as
      () => Promise<void>)();
    // A bare digit, not the bracketed list: `preserveSpacing` renders the
    // painted text with non-breaking spaces, which a plain-space literal
    // here would not match (#95's own evidence).
    assert.match(paintedLineText(editor, 0), /3/, 'setup: evaluated');

    // A same-line rewrite, not a line-count change, so `afterEdit` marks the
    // statement stale instead of `reanchor` dropping it outright (#96).
    const oldLine = 'x = [1, 2, 3]';
    editor.document.setText('x = [1, 2, 3, 4]\n');
    fake.emitters.onDidChangeTextDocument.fire({
      document: editor.document,
      contentChanges: [{
        range: new FakeRange(0, 0, 0, oldLine.length), text: 'x = [1, 2, 3, 4]',
      }],
    });

    const text = await hoverTextAt(fake, editor, 0);
    assert.match(text!, /Stale/);
    assert.match(text!, /code changed since it ran/i);
    assert.doesNotMatch(text!, /re-bound/i,
      'this line was edited directly -- nothing rebound a name it reads');
  } finally {
    extension.deactivate();
  }
});

test('hovering a stale dependant explains that a value it reads moved on',
  async () => {
  const fake = createFakeVscode();
  const editor = createEditor('x = 1\ny = x + 1\n');
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = activated(fake);
  try {
    const evaluateAtCursor = fake.commands.registered.get(
      'evalens.evaluateAtCursor') as () => Promise<void>;

    await evaluateAtCursor(); // line 0: x = 1
    editor.selection = new FakeSelection(
      new FakePosition(1, 0), new FakePosition(1, 0));
    await evaluateAtCursor(); // line 1: y = x + 1, reads x
    assert.match(paintedLineText(editor, 1), /2/, 'setup: y saw the old x');

    // Line 0 rewritten in place and re-evaluated. Line 1's own text is
    // untouched throughout -- only `markDependents`, from the landed
    // re-evaluation of line 0, can be what marks it (registry.ts).
    const oldLine = 'x = 1';
    editor.document.setText('x = 5\ny = x + 1\n');
    fake.emitters.onDidChangeTextDocument.fire({
      document: editor.document,
      contentChanges: [
        { range: new FakeRange(0, 0, 0, oldLine.length), text: 'x = 5' },
      ],
    });
    editor.selection = new FakeSelection(
      new FakePosition(0, 0), new FakePosition(0, 0));
    await evaluateAtCursor(); // re-run line 0, which marks line 1's dependant

    const text = await hoverTextAt(fake, editor, 1);
    assert.match(text!, /Stale/);
    assert.match(text!, /re-bound/i);
    assert.doesNotMatch(text!, /code changed/i,
      "line 1's own text never changed -- only what it reads did");
  } finally {
    extension.deactivate();
  }
});

test('hovering a bare dict shows its fields as a table', async () => {
  const fake = createFakeVscode();
  const editor = createEditor("config = {'host': 'localhost', 'port': 8080}\n");
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = activated(fake);
  try {
    await (fake.commands.registered.get('evalens.evaluateAtCursor') as
      () => Promise<void>)();

    const text = await hoverTextAt(fake, editor, 0);
    assert.ok(text, 'expected a hover over the annotated line');
    assert.match(text!, /\| Field \| Type \| Value \|/);
    assert.match(text!, /'host' \| \*str\* \| 'localhost'/);
    assert.match(text!, /'port' \| \*int\* \| 8080/);
    // Both fields fit in the table already shown -- nothing more to open.
    assert.doesNotMatch(text!, /Explore/);
  } finally {
    extension.deactivate();
  }
});

test('hovering a value that is not a bare name adds no table', async () => {
  // `print(...)` is design rule 3's own example of a display that would
  // have to run something to re-resolve -- the hover must fall back to
  // exactly what it showed before this ticket, not attempt to inspect it.
  const fake = createFakeVscode();
  const editor = createEditor("print('hello')\n");
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = activated(fake);
  try {
    await (fake.commands.registered.get('evalens.evaluateAtCursor') as
      () => Promise<void>)();

    const text = await hoverTextAt(fake, editor, 0);
    assert.ok(text, 'expected the plain hover to survive');
    assert.doesNotMatch(text!, /\| Field \| Type \| Value \|/);
  } finally {
    extension.deactivate();
  }
});

test('a value with something further to open gets an Explore link', async () => {
  const fake = createFakeVscode();
  const editor = createEditor(
    "data = {'user': {'name': 'Jane Smith', 'age': 25}}\n");
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = activated(fake);
  try {
    await (fake.commands.registered.get('evalens.evaluateAtCursor') as
      () => Promise<void>)();

    const text = await hoverTextAt(fake, editor, 0);
    assert.match(text!, /'user' \| \*dict\*/);
    assert.match(text!, /\[Explore ▸\]\(command:evalens\.inspectValue\?/);
    assert.match(text!, /%22data%22/, // encodeURIComponent(JSON.stringify(["data"]))
      'the link must carry the exact namespace name, not a guess at one');
  } finally {
    extension.deactivate();
  }
});

test('a property is shown unevaluated in the hover table, and never called', async () => {
  const fake = createFakeVscode();
  const editor = createEditor(
    "class Config:\n"
    + "    def __init__(self):\n"
    + "        self.host = 'localhost'\n"
    + "    @property\n"
    + "    def url(self):\n"
    + "        raise AssertionError('must not run')\n"
    + "cfg = Config()\n"
  );
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = activated(fake);
  try {
    const evaluateAtCursor =
      fake.commands.registered.get('evalens.evaluateAtCursor') as () => Promise<void>;
    for (let line = 0; line < 7; line += 1) {
      editor.selection = new FakeSelection(
        new FakePosition(line, 0), new FakePosition(line, 0));
      await evaluateAtCursor();
    }

    const text = await hoverTextAt(fake, editor, 6);
    assert.match(text!, /'localhost'/);
    assert.match(text!, /\| url \| \*property\* \| \*not evaluated\* \|/);
  } finally {
    extension.deactivate();
  }
});

test('Evalens: Inspect Value walks into a nested value and back out, ' +
  'reaching only the real kernel', async () => {
  const fake = createFakeVscode();
  const editor = createEditor(
    "data = {'user': {'name': 'Jane Smith', 'age': 25}}\n");
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = activated(fake);
  try {
    await (fake.commands.registered.get('evalens.evaluateAtCursor') as
      () => Promise<void>)();

    // Down into `user`, look at the list, then back out and give up --
    // three real `inspect` round trips to the same kernel the annotation
    // itself came from.
    fake.quickPick.picks.push("$(chevron-right) 'user'", undefined);
    await fake.executeCommand('evalens.inspectValue', 'data');

    assert.equal(fake.quickPick.calls.length, 2,
      'one inspect per level shown, root then one level down');
    assert.deepEqual(fake.quickPick.calls[0]!.labels, ["$(chevron-right) 'user'"]);
    assert.deepEqual(
      fake.quickPick.calls[1]!.labels,
      ['$(arrow-left) Back', "'name'", "'age'"],
      'a deeper level offers Back first, then its own fields in their ' +
      "dict's own insertion order");
    assert.equal(fake.messages.warning.length, 0,
      'no failure should have been reported for a value the kernel can walk');
  } finally {
    extension.deactivate();
  }
});

test('Evalens: Inspect Value with no name falls back to the cursor, ' +
  'and says so when there is nothing there', async () => {
  const fake = createFakeVscode();
  const editor = createEditor("print('hi')\n");
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = activated(fake);
  try {
    await (fake.commands.registered.get('evalens.evaluateAtCursor') as
      () => Promise<void>)();

    await fake.executeCommand('evalens.inspectValue');

    assert.equal(fake.quickPick.calls.length, 0, 'nothing safe to inspect here');
  } finally {
    extension.deactivate();
  }
});

// -- disposal ----------------------------------------------------------------

test('disposing the extension disposes every decoration type it created, and ' +
  'the status bar item announcing turns on', async () => {
  const fake = createFakeVscode();
  // Without this, `Announcer` never creates a status bar item at all (see
  // `announcesAutomatically`), and this test would pass without ever
  // exercising the disposal it claims to check.
  fake.config.set('evalens', 'announceResults', 'always');
  const editor = createEditor('1 + 1\n');
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const { extension, context } = activatedWithContext(fake);

  try {
    const evaluateAtCursor = fake.commands.registered.get('evalens.evaluateAtCursor');
    await (evaluateAtCursor as () => Promise<void>)();

    assert.ok(fake.decorationTypes.length > 0, 'no decoration type was created');
    assert.ok(fake.statusBarItems.length > 0,
      'setup: expected an announcement to create a status bar item');
    assert.ok(fake.decorationTypes.every((type) => !type.disposed),
      'setup: nothing should be disposed before deactivation');

    // What VS Code itself does on deactivation: dispose everything the
    // extension pushed onto `context.subscriptions`. One of those
    // subscriptions is the closure that disposes the kernel client, so this
    // also leaves no process behind -- `deactivate` below is belt and
    // braces, the way `extension.ts` itself has it.
    for (const subscription of context.subscriptions) {
      subscription.dispose();
    }

    assert.ok(fake.decorationTypes.every((type) => type.disposed),
      'every decoration type created during activation must be disposed ' +
      'when the extension is');
    assert.ok(fake.statusBarItems.every((item) => item.disposed),
      'the status bar item Announcer created must be disposed too');
  } finally {
    extension.deactivate();
  }
});

test('no Python process outlives deactivate', async () => {
  const fake = createFakeVscode();
  const editor = createEditor('1 + 1\n');
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];

  const { result: extension, pids } = await withSpawnedPids(async () => {
    const ext = activated(fake);
    const evaluateAtCursor = fake.commands.registered.get('evalens.evaluateAtCursor');
    await (evaluateAtCursor as () => Promise<void>)();
    return ext;
  });

  assert.equal(pids.length, 1, 'expected exactly one kernel process spawned');
  assert.ok(isAlive(pids[0]!), 'setup: the kernel should still be running here');

  extension.deactivate();
  await waitForExit(pids, 2000);

  assert.ok(!isAlive(pids[0]!),
    'the kernel process outlived deactivate -- this is the orphaned ' +
    'interpreter a user would only ever notice in Activity Monitor');
});
