import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { KernelClient, KernelProcess } from '../kernel/client';
import { Response } from '../kernel/protocol';

/** A child process that never runs Python, so the transport can be driven. */
class FakeProcess extends EventEmitter implements KernelProcess {
  readonly written: string[] = [];
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;
  stdinEnded = false;

  readonly stdin = {
    write: (chunk: string) => { this.written.push(chunk); },
    end: () => { this.stdinEnded = true; },
  };

  kill(): void { this.killed = true; }

  /** The request objects the client has written, parsed. */
  requests(): Array<Record<string, unknown>> {
    return this.written.map((line) => JSON.parse(line));
  }

  reply(payload: Record<string, unknown>): void {
    this.stdout.emit('data', `${JSON.stringify(payload)}\n`);
  }
}

interface Harness {
  client: KernelClient;
  spawned: FakeProcess[];
  calls: Array<{ command: string; args: readonly string[] }>;
}

function clientWith(): Harness {
  const spawned: FakeProcess[] = [];
  const calls: Harness['calls'] = [];
  const client = new KernelClient({
    pythonPath: 'python3',
    kernelPath: '/kernel/evalens_kernel.py',
    spawn: (command, args) => {
      calls.push({ command, args });
      const p = new FakeProcess();
      spawned.push(p);
      return p;
    },
  });
  return { client, spawned, calls };
}

test('the kernel is not spawned until the first request', () => {
  const { client, spawned } = clientWith();
  assert.equal(spawned.length, 0, 'constructing must not start an interpreter');
  assert.equal(client.running, false);
  void client.request({ op: 'ping' });
  assert.equal(spawned.length, 1);
});

test('responses are matched to their request by id', async () => {
  const { client, spawned } = clientWith();
  const first = client.request({ op: 'ping' });
  const second = client.request({ op: 'reset' });
  const proc = spawned[0]!;

  // Answered out of order, which is what a slow evaluation followed by a fast
  // one actually looks like.
  proc.reply({ id: 2, ok: true, marker: 'second' });
  proc.reply({ id: 1, ok: true, marker: 'first' });

  assert.equal((await first as Response & { marker: string }).marker, 'first');
  assert.equal((await second as Response & { marker: string }).marker, 'second');
});

test('a response split across three writes still resolves', async () => {
  const { client, spawned } = clientWith();
  const pending = client.request({ op: 'ping' });
  const proc = spawned[0]!;
  proc.stdout.emit('data', '{"id":1,');
  proc.stdout.emit('data', '"ok":true,"value"');
  proc.stdout.emit('data', ':"42"}\n');
  assert.equal((await pending as Response & { value: string }).value, '42');
});

test('pending requests reject when the kernel exits', async () => {
  const { client, spawned } = clientWith();
  const pending = client.request({ op: 'ping' });
  spawned[0]!.emit('exit', 1, null);
  await assert.rejects(pending, /exited \(code 1/);
});

test('a spawn failure names the interpreter it tried', async () => {
  const { client, spawned } = clientWith();
  const pending = client.request({ op: 'ping' });
  spawned[0]!.emit('error', new Error('spawn python3 ENOENT'));
  await assert.rejects(pending, /could not start .* "python3".*evalens\.pythonPath/s);
});

test('restart kills the old process and the next request starts a new one', async () => {
  const { client, spawned } = clientWith();
  const abandoned = client.request({ op: 'ping' });
  client.restart();
  await assert.rejects(abandoned, /restarted/);
  assert.equal(spawned[0]!.killed, true);

  void client.request({ op: 'ping' });
  assert.equal(spawned.length, 2, 'a fresh interpreter should be started');
});

test('a late reply to an abandoned request is dropped, not thrown', () => {
  const { client, spawned } = clientWith();
  void client.request({ op: 'ping' }).catch(() => undefined);
  const proc = spawned[0]!;
  client.restart();
  assert.doesNotThrow(() => proc.reply({ id: 1, ok: true }));
});

test('an unparseable line is reported and does not break the stream', async () => {
  const seen: string[] = [];
  const spawned: FakeProcess[] = [];
  const client = new KernelClient({
    pythonPath: 'python3',
    kernelPath: '/kernel/evalens_kernel.py',
    spawn: () => { const p = new FakeProcess(); spawned.push(p); return p; },
    onStderr: (text) => seen.push(text),
  });
  const pending = client.request({ op: 'ping' });
  const proc = spawned[0]!;
  proc.stdout.emit('data', 'not json\n');
  proc.reply({ id: 1, ok: true });
  await pending;
  assert.match(seen.join(''), /unparseable line/);
});

test('dispose kills the process and refuses further requests', async () => {
  const { client, spawned } = clientWith();
  void client.request({ op: 'ping' }).catch(() => undefined);
  client.dispose();
  assert.equal(spawned[0]!.killed, true, 'an orphaned interpreter outlives the window');
  assert.equal(spawned[0]!.stdinEnded, true);
  await assert.rejects(client.request({ op: 'ping' }), /disposed/);
});

test('the kernel is spawned unbuffered, with the configured interpreter', () => {
  const { client, calls } = clientWith();
  void client.request({ op: 'ping' });
  assert.equal(calls[0]!.command, 'python3');
  assert.deepEqual([...calls[0]!.args], ['-u', '/kernel/evalens_kernel.py'],
    '-u keeps a response from sitting in a buffer waiting for a fuller write');
});

test('a request goes out as one JSON line carrying its id', () => {
  const { client, spawned } = clientWith();
  void client.request({ op: 'ping' });
  const raw = spawned[0]!.written[0]!;
  assert.ok(raw.endsWith('\n'), 'the kernel reads one request per line');
  assert.equal(raw.indexOf('\n'), raw.length - 1, 'no embedded newlines');
  assert.deepEqual(JSON.parse(raw), { op: 'ping', id: 1 });
});
