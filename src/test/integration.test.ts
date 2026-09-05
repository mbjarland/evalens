import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { KernelClient } from '../kernel/client';
import { Evaluated, EvalResponse, Failed } from '../kernel/protocol';

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
  return new KernelClient({ pythonPath: 'python3', kernelPath: KERNEL });
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
