import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { KernelClient } from '../kernel/client';
import {
  Evaluated, EvalResponse, Failed, FileLoaded,
} from '../kernel/protocol';
import { errorText, resultText } from '../render/format';
import { present } from '../render/present';

/**
 * The only test that checks the TypeScript and the Python agree.
 *
 * Everything else on either side runs against a fake: the client tests drive a
 * fake process, the kernel tests drive a real process but speak to it in
 * Python. A protocol drift -- a renamed field, a coordinate base changed on
 * one side -- passes both suites and fails only in a real editor. This runs
 * the real kernel over a real pipe.
 */
const KERNEL = path.resolve(__dirname, '..', '..', 'kernel', 'evalens_kernel.py');

function connect(): KernelClient {
  return new KernelClient({
    resolvePython: async () => 'python3',
    kernelPath: KERNEL,
  });
}

async function evaluate(client: KernelClient, source: string, line: number) {
  return (await client.request({
    op: 'eval', source, line, character: 0, filename: '/tmp/evalens-test.py',
  })) as EvalResponse;
}

test('the IDEA.md example round-trips through the real kernel', async (t) => {
  const client = connect();
  t.after(() => client.dispose());

  const source = 'lst = [1, 2, 3]\ny = lst\ny.append(4)\nlst\n';

  const first = await evaluate(client, source, 0) as Evaluated;
  assert.equal(first.ok, true);
  assert.equal(first.resolved, true);
  assert.equal(first.display, 'lst');
  assert.equal(first.value, '[1, 2, 3]');

  await evaluate(client, source, 1);
  await evaluate(client, source, 2);

  const last = await evaluate(client, source, 3) as Evaluated;
  assert.equal(last.value, '[1, 2, 3, 4]',
    'the namespace should remember, and append should have run exactly once');
});

test('the range the kernel returns is in VS Code coordinates', async (t) => {
  const client = connect();
  t.after(() => client.dispose());

  // Third line of the file: 0-based line 2, not ast\'s 1-based 3.
  const result = await evaluate(client, 'a = 1\nb = 2\ntotal = a + b\n', 2) as Evaluated;
  assert.equal(result.range.start.line, 2);
  assert.equal(result.range.start.character, 0);
  assert.equal(result.range.end.line, 2);
  assert.equal(result.range.end.character, 13);
});

test('a failure arrives as a typed error, not a rejection', async (t) => {
  const client = connect();
  t.after(() => client.dispose());

  const result = await evaluate(client, 'undefined_name\n', 0) as Failed;
  assert.equal(result.ok, false);
  assert.equal(result.error.type, 'NameError');
  assert.match(result.error.traceback, /NameError/);
});

test('a blank line resolves to nothing without erroring', async (t) => {
  const client = connect();
  t.after(() => client.dispose());

  const result = await evaluate(client, 'a = 1\n\nb = 2\n', 1);
  assert.equal(result.ok, true);
  assert.equal((result as { resolved: boolean }).resolved, false);
});

test('printed output survives the protocol channel', async (t) => {
  const client = connect();
  t.after(() => client.dispose());

  const result = await evaluate(client, "print('hi')\n", 0) as Evaluated;
  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'hi\n');
});

test('the whole pipeline produces the annotation IDEA.md promises', async (t) => {
  // Kernel -> resolver -> client -> present -> format, i.e. everything except
  // the call to setDecorations. This is the acceptance clip, minus the pixels.
  const client = connect();
  t.after(() => client.dispose());

  const source = 'lst = [1, 2, 3]\ny = lst\ny.append(4)\nlst\n';
  const painted: string[] = [];

  for (const line of [0, 1, 2, 3]) {
    const response = await evaluate(client, source, line);
    const shown = present(response, line);
    if (shown.kind === 'value' && shown.value !== null) {
      painted.push(resultText(shown.value));
    }
  }

  assert.deepEqual(painted.map((p) => p.replace(/ /g, ' ')), [
    '=> [1, 2, 3]',
    '=> [1, 2, 3]',
    '=> None',
    '=> [1, 2, 3, 4]',
  ]);
});

test('an undefined name paints as an error, not as a crash', async (t) => {
  const client = connect();
  t.after(() => client.dispose());

  const shown = present(await evaluate(client, 'nope\n', 0), 0);
  assert.equal(shown.kind, 'error');
  assert.equal(
    errorText((shown as { type: string }).type,
      (shown as { message: string }).message).replace(/ /g, ' '),
    "=> NameError: name 'nope' is not defined");
});

test('loading a file makes a line near the bottom evaluate straight away', async (t) => {
  // The command's whole reason to exist: without it the first thirty seconds
  // are a NameError and a walk down the file.
  const client = connect();
  t.after(() => client.dispose());

  const source = [
    'import sys',
    "GREETING = 'hello'",
    'def shout():',
    '    return GREETING.upper()',
    "if __name__ == '__main__':",
    "    sys.exit('the main guard ran')",
    'shout()',
  ].join('\n') + '\n';

  const loaded = await client.request({
    op: 'eval_file', source, filename: '/tmp/evalens-load.py',
  }) as FileLoaded;
  assert.equal(loaded.ok, true);

  const called = await evaluate(client, source, 6) as Evaluated;
  assert.equal(called.value, "'HELLO'",
    'the namespace should be populated without evaluating line by line');
});

test('the __main__ guard does not run on load', async (t) => {
  // Load File means "import the module", and an imported module does not run
  // its main guard. True here because __name__ is "__evalens__" -- pinned on
  // both sides because it is a consequence of the namespace setup rather
  // than an explicit rule.
  const client = connect();
  t.after(() => client.dispose());

  const source = "import sys\nif __name__ == '__main__':\n    sys.exit(9)\n";
  const loaded = await client.request({
    op: 'eval_file', source, filename: '/tmp/evalens-main.py',
  }) as FileLoaded;
  assert.equal(loaded.ok, true, 'sys.exit would have made this a failure');

  const name = await evaluate(client, '__name__\n', 0) as Evaluated;
  assert.equal(name.value, "'__evalens__'");
});

test('loading a file paints what walking down it would have', async (t) => {
  const client = connect();
  t.after(() => client.dispose());

  const source = 'lst = [1, 2, 3]\ny = lst\ny.append(4)\nlst\n';
  const loaded = await client.request({
    op: 'eval_file', source, filename: '/tmp/evalens-tour.py',
  }) as FileLoaded;

  assert.equal(loaded.ok, true);
  assert.equal(loaded.ran, 4);
  assert.deepEqual(
    loaded.results.map((r) => (r.ok ? [r.display, r.value] : ['!', r.error.type])),
    [['lst', '[1, 2, 3]'], ['y', '[1, 2, 3]'],
     ['y.append(4)', 'None'], ['lst', '[1, 2, 3, 4]']],
    'one keystroke should produce the same four values as four keystrokes');
});

test('a broken line does not stop the rest of the file loading', async (t) => {
  // The tour file contains a deliberate NameError two thirds of the way down,
  // and stopping there made Load File refuse to set up a session.
  const client = connect();
  t.after(() => client.dispose());

  const source = 'a = 1\nundefined_one\nb = 2\nundefined_two\nc = 3\n';
  const loaded = await client.request({
    op: 'eval_file', source, filename: '/tmp/evalens-partial.py',
  }) as FileLoaded;

  assert.equal(loaded.ok, true, 'a broken line is not a broken load');
  assert.equal(loaded.ran, 3);
  assert.equal(loaded.results.filter((r) => !r.ok).length, 2);

  // The statement below BOTH failures is usable.
  const c = await evaluate(client, source, 4) as Evaluated;
  assert.equal(c.value, '3');
});
