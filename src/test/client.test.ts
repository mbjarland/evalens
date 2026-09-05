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
  /**
   * The nth spawned process, once it exists.
   *
   * Spawning is asynchronous now -- the interpreter is probed before it is
   * run -- so `request()` returns before `spawn` has been called and reaching
   * straight for `spawned[0]` gets `undefined`. Waiting on the fake rather
   * than on a fixed number of microtasks keeps these tests from encoding how
   * many awaits the client happens to do on the way.
   */
  started(n?: number): Promise<FakeProcess>;
}

interface HarnessOptions {
  /** Defaults to a resolved `python3`; override to change or delay it. */
  readonly resolvePython?: () => Promise<string>;
  readonly onStderr?: (text: string) => void;
}

function clientWith(options: HarnessOptions = {}): Harness {
  const spawned: FakeProcess[] = [];
  const calls: Harness['calls'] = [];
  const client = new KernelClient({
    resolvePython: options.resolvePython ?? (async () => 'python3'),
    kernelPath: '/kernel/evalens_kernel.py',
    onStderr: options.onStderr,
    spawn: (command, args) => {
      calls.push({ command, args });
      const p = new FakeProcess();
      spawned.push(p);
      return p;
    },
  });

  const started = async (n = 1): Promise<FakeProcess> => {
    // Bounded, and it fails rather than waits forever: `npm test` runs with no
    // timeout, so a spawn that never happens must be a red test and not a
    // suite that hangs.
    for (let tick = 0; tick < 100; tick++) {
      await new Promise((resolve) => setImmediate(resolve));
      if (spawned.length >= n) {
        return spawned[n - 1]!;
      }
    }
    assert.fail(`expected ${n} spawned process(es), saw ${spawned.length}`);
  };

  return { client, spawned, calls, started };
}

test('the kernel is not spawned until the first request', async () => {
  const { client, spawned, started } = clientWith();
  assert.equal(spawned.length, 0, 'constructing must not start an interpreter');
  assert.equal(client.running, false);
  void client.request({ op: 'ping' });
  await started();
  assert.equal(spawned.length, 1);
});

test('the interpreter is resolved again for every spawn', async () => {
  // The bug behind the ticket: the path was resolved once and baked into a
  // client that outlived the setting, so editing evalens.pythonPath changed
  // nothing until the window was reloaded.
  let selected = 'python3';
  const { client, calls, started } = clientWith({
    resolvePython: async () => selected,
  });
  void client.request({ op: 'ping' }).catch(() => undefined);
  await started();

  client.restart();
  selected = '/venv/bin/python';
  void client.request({ op: 'ping' });
  await started(2);

  assert.deepEqual(calls.map((c) => c.command), ['python3', '/venv/bin/python']);
});

test('two requests racing the same spawn start one interpreter', async () => {
  // Probing costs real time, so the second keypress lands inside the window
  // where the first spawn has not finished. Two interpreters would mean two
  // namespaces and values that depend on which one answered.
  const { client, spawned, started } = clientWith();
  void client.request({ op: 'ping' });
  void client.request({ op: 'reset' });
  await started();
  assert.equal(spawned.length, 1);
});

test('responses are matched to their request by id', async () => {
  const { client, started } = clientWith();
  const first = client.request({ op: 'ping' });
  const second = client.request({ op: 'reset' });
  const proc = await started();

  // Answered out of order, which is what a slow evaluation followed by a fast
  // one actually looks like.
  proc.reply({ id: 2, ok: true, marker: 'second' });
  proc.reply({ id: 1, ok: true, marker: 'first' });

  assert.equal((await first as Response & { marker: string }).marker, 'first');
  assert.equal((await second as Response & { marker: string }).marker, 'second');
});

test('a response split across three writes still resolves', async () => {
  const { client, started } = clientWith();
  const pending = client.request({ op: 'ping' });
  const proc = await started();
  proc.stdout.emit('data', '{"id":1,');
  proc.stdout.emit('data', '"ok":true,"value"');
  proc.stdout.emit('data', ':"42"}\n');
  assert.equal((await pending as Response & { value: string }).value, '42');
});

test('pending requests reject when the kernel exits', async () => {
  const { client, started } = clientWith();
  const pending = client.request({ op: 'ping' });
  (await started()).emit('exit', 1, null);
  await assert.rejects(pending, /exited \(code 1/);
});

test('a spawn failure names the interpreter it tried', async () => {
  const { client, started } = clientWith();
  const pending = client.request({ op: 'ping' });
  (await started()).emit('error', new Error('spawn python3 ENOENT'));
  // Which Python was tried is the whole content of this message: a bare
  // ENOENT names none of the four candidates the chain may have walked.
  await assert.rejects(pending, /could not be started with "python3".*ENOENT/s);
});

test('a stop while the interpreter resolves leaves no process behind', async () => {
  // Probing can take seconds, and changing evalens.pythonPath disposes the
  // client, so a stop lands mid-spawn in ordinary use. The process that
  // arrives afterwards belongs to nobody, and an orphaned interpreter is a
  // bug users see in Activity Monitor and never report.
  let release: (path: string) => void = () => undefined;
  const { client, started } = clientWith({
    resolvePython: () => new Promise<string>((resolve) => { release = resolve; }),
  });
  const pending = client.request({ op: 'ping' });
  const rejected = assert.rejects(pending, /stopped while it was starting/);

  client.dispose();
  release('python3');

  const proc = await started();
  assert.equal(proc.killed, true, 'a kernel nothing holds a handle to');
  assert.equal(proc.stdinEnded, true);
  await rejected;
});

test('restart kills the old process and the next request starts a new one', async () => {
  const { client, spawned, started } = clientWith();
  const abandoned = client.request({ op: 'ping' });
  const first = await started();
  client.restart();
  await assert.rejects(abandoned, /restarted/);
  assert.equal(first.killed, true);

  void client.request({ op: 'ping' });
  await started(2);
  assert.equal(spawned.length, 2, 'a fresh interpreter should be started');
});

test('a late reply to an abandoned request is dropped, not thrown', async () => {
  const { client, started } = clientWith();
  void client.request({ op: 'ping' }).catch(() => undefined);
  const proc = await started();
  client.restart();
  assert.doesNotThrow(() => proc.reply({ id: 1, ok: true }));
});

test('an unparseable line is reported and does not break the stream', async () => {
  const seen: string[] = [];
  const { client, started } = clientWith({ onStderr: (text) => seen.push(text) });
  const pending = client.request({ op: 'ping' });
  const proc = await started();
  proc.stdout.emit('data', 'not json\n');
  proc.reply({ id: 1, ok: true });
  await pending;
  assert.match(seen.join(''), /unparseable line/);
});

test('dispose kills the process and refuses further requests', async () => {
  const { client, started } = clientWith();
  void client.request({ op: 'ping' }).catch(() => undefined);
  const proc = await started();
  client.dispose();
  assert.equal(proc.killed, true, 'an orphaned interpreter outlives the window');
  assert.equal(proc.stdinEnded, true);
  await assert.rejects(client.request({ op: 'ping' }), /disposed/);
});

test('the kernel is spawned unbuffered, with the configured interpreter', async () => {
  const { client, calls, started } = clientWith();
  void client.request({ op: 'ping' });
  await started();
  assert.equal(calls[0]!.command, 'python3');
  assert.deepEqual([...calls[0]!.args], ['-u', '/kernel/evalens_kernel.py'],
    '-u keeps a response from sitting in a buffer waiting for a fuller write');
});

test('a request goes out as one JSON line carrying its id', async () => {
  const { client, started } = clientWith();
  void client.request({ op: 'ping' });
  const proc = await started();
  const raw = proc.written[0]!;
  assert.ok(raw.endsWith('\n'), 'the kernel reads one request per line');
  assert.equal(raw.indexOf('\n'), raw.length - 1, 'no embedded newlines');
  assert.deepEqual(JSON.parse(raw), { op: 'ping', id: 1 });
});
