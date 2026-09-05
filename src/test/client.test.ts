import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { KernelClient, KernelProcess } from '../kernel/client';
import { InputRequest, Response } from '../kernel/protocol';

/** A child process that never runs Python, so the transport can be driven. */
class FakeProcess extends EventEmitter implements KernelProcess {
  readonly written: string[] = [];
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;
  stdinEnded = false;
  /** What the client has written on the control channel, in order. */
  readonly controlWritten: string[] = [];
  readonly controlOut = new EventEmitter();

  readonly stdin = {
    write: (chunk: string) => { this.written.push(chunk); },
    end: () => { this.stdinEnded = true; },
  };

  readonly control = {
    write: (chunk: string) => { this.controlWritten.push(chunk); },
    end: () => undefined,
  };

  kill(): void { this.killed = true; }

  /** The request objects the client has written, parsed. */
  requests(): Array<Record<string, unknown>> {
    return this.written.map((line) => JSON.parse(line));
  }

  /** The control messages the client has written, parsed. */
  controlRequests(): Array<Record<string, unknown>> {
    return this.controlWritten.map((line) => JSON.parse(line));
  }

  reply(payload: Record<string, unknown>): void {
    this.stdout.emit('data', `${JSON.stringify(payload)}\n`);
  }

  /** Something the kernel says on its own account, not a reply to anything. */
  says(payload: Record<string, unknown>): void {
    this.controlOut.emit('data', `${JSON.stringify(payload)}\n`);
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
  /** Short by default, so the unacknowledged branch is reachable in a test. */
  readonly ackTimeout?: number;
  readonly onInput?: (request: InputRequest) => Promise<string | null>;
  readonly onStream?: (
    name: 'stdout' | 'stderr', text: string, unattributed: boolean
  ) => void;
  /** Short by default, so a stranded request can be seen to fail in a test. */
  readonly strayGrace?: number;
}

function clientWith(options: HarnessOptions = {}): Harness {
  const spawned: FakeProcess[] = [];
  const calls: Harness['calls'] = [];
  const client = new KernelClient({
    resolvePython: options.resolvePython ?? (async () => 'python3'),
    kernelPath: '/kernel/evalens_kernel.py',
    onStderr: options.onStderr,
    ackTimeout: options.ackTimeout ?? 50,
    strayGrace: options.strayGrace ?? 50,
    onInput: options.onInput,
    onStream: options.onStream,
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

test('a response with output spliced onto the front is still delivered', async () => {
  // The wedge, and the whole reason this is worth recovering rather than
  // reporting: a write with no trailing newline lands on the same line as the
  // next response. Discarding the line loses an answer that was computed
  // correctly, and leaves the request pending with nothing left to settle it.
  const seen: string[] = [];
  const { client, started } = clientWith({ onStderr: (text) => seen.push(text) });
  const pending = client.request({ op: 'ping' });
  const proc = await started();
  proc.stdout.emit('data',
    'PARTIAL FROM THREAD{"id":1,"ok":true,"value":"42"}\n');
  assert.equal((await pending as Response & { value: string }).value, '42');
  assert.match(seen.join(''), /stray output.*PARTIAL FROM THREAD/s);
});

test('a request whose answer a stray line may have eaten is failed, not dropped', async () => {
  // `deliver` used to return here without touching `pending`, and nothing else
  // clears it short of the kernel dying -- so the promise for that keypress
  // never settled and the progress notification spun forever. Failing it names
  // something the user can act on instead.
  const { client, started } = clientWith({ strayGrace: 20 });
  const pending = client.request({ op: 'ping' });
  const proc = await started();
  proc.stdout.emit('data', 'LATE THREAD PRINT\n');
  await assert.rejects(pending, /this evaluation was lost.*LATE THREAD PRINT/s);
});

test('a stray line does not fail a request sent after it', async () => {
  // Only what was already in flight can have had its answer destroyed. A
  // blanket per-request timeout would also cancel the long-running evaluation
  // that Cancel exists for, which is why the clock starts on evidence.
  const { client, started } = clientWith({ strayGrace: 20 });
  const doomed = client.request({ op: 'ping' });
  const proc = await started();
  proc.stdout.emit('data', 'LATE THREAD PRINT\n');
  const later = client.request({ op: 'ping' });
  await assert.rejects(doomed, /this evaluation was lost/);
  proc.reply({ id: 2, ok: true, marker: 'answered' });
  assert.equal((await later as Response & { marker: string }).marker,
    'answered');
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

test('an interrupt goes out on the control channel, never on stdin', async () => {
  // The invariant the whole two-pipe design exists for: the kernel is not
  // reading its stdin while it runs user code, so an interrupt written there
  // would be read when the evaluation finished -- which for the infinite loop
  // this feature exists to end is never.
  const { client, started } = clientWith();
  const pending = client.request({ op: 'ping' });
  const proc = await started();
  const requestsBefore = proc.written.length;

  const interrupting = client.interrupt();
  proc.says({ op: 'interrupt_ack' });

  assert.equal(await interrupting, 'interrupted');
  assert.deepEqual(proc.controlRequests(), [{ op: 'interrupt' }]);
  assert.equal(proc.written.length, requestsBefore,
    'nothing about an interrupt belongs on the request pipe');
  assert.equal(proc.killed, false, 'an interrupt is not a kill');

  // The request is still outstanding: the kernel answers it with the failure.
  proc.reply({ id: 1, ok: false, error: { type: 'KeyboardInterrupt' } });
  assert.equal((await pending).ok, false);
});

test('an interrupt the kernel never acknowledges is reported as unconfirmed', async () => {
  // Cancel is not fire-and-forget. If the kernel says nothing the user has a
  // decision to make -- keep waiting, or restart and lose the namespace -- and
  // cannot make it while being told the interrupt worked.
  const { client, started } = clientWith({ ackTimeout: 20 });
  void client.request({ op: 'ping' }).catch(() => undefined);
  await started();
  assert.equal(await client.interrupt(), 'unconfirmed');
});

test('interrupting with nothing running says so and sends nothing', async () => {
  // The race Cancel loses when the evaluation finishes first. A stray
  // interrupt is harmless to the kernel, which swallows one that arrives while
  // it is idle -- but claiming to have stopped something that was not running
  // is a lie the status bar should not tell.
  const { client, started } = clientWith();
  void client.request({ op: 'ping' }).catch(() => undefined);
  const proc = await started();
  proc.reply({ id: 1, ok: true });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(await client.interrupt(), 'idle');
  assert.deepEqual(proc.controlWritten, []);
});

test('a kernel that says it is busy can be interrupted', async () => {
  // Status comes from the kernel rather than being inferred from an unsettled
  // promise, which is also unsettled while an interpreter is being probed and
  // nothing is running at all.
  const { client, started } = clientWith();
  void client.request({ op: 'ping' }).catch(() => undefined);
  const proc = await started();
  proc.says({ op: 'status', state: 'busy', id: 1 });
  proc.reply({ id: 1, ok: true });
  await new Promise((resolve) => setImmediate(resolve));

  const interrupting = client.interrupt();
  proc.says({ op: 'interrupt_ack' });
  assert.equal(await interrupting, 'interrupted',
    'the kernel had not said it was finished yet');

  proc.says({ op: 'status', state: 'idle', id: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await client.interrupt(), 'idle');
});

test('interrupting before the kernel starts is idle, not a crash', async () => {
  const { client } = clientWith();
  assert.equal(await client.interrupt(), 'idle');
});

test('a control message split across writes still arrives whole', async () => {
  const { client, started } = clientWith();
  void client.request({ op: 'ping' }).catch(() => undefined);
  const proc = await started();
  const interrupting = client.interrupt();
  proc.controlOut.emit('data', '{"op":"interr');
  proc.controlOut.emit('data', 'upt_ack"}\n');
  assert.equal(await interrupting, 'interrupted');
});

test('an unparseable control line is reported, not thrown', async () => {
  const seen: string[] = [];
  const { client, started } = clientWith({ onStderr: (text) => seen.push(text) });
  void client.request({ op: 'ping' }).catch(() => undefined);
  const proc = await started();
  assert.doesNotThrow(() => proc.controlOut.emit('data', 'not json\n'));
  assert.match(seen.join(''), /unparseable control line/);
});

test('a prompt is answered on the control channel, carrying its sequence', async () => {
  // The other half of the two-pipe invariant. The answer goes back where the
  // question came from, and never on the request pipe -- where the kernel is
  // not listening, because it is blocked waiting for this.
  const asked: InputRequest[] = [];
  const { client, started } = clientWith({
    onInput: async (request) => { asked.push(request); return 'Ada'; },
  });
  void client.request({ op: 'ping' }).catch(() => undefined);
  const proc = await started();
  const before = proc.written.length;

  proc.says({ op: 'input_request', seq: 7, prompt: 'who? ', password: false });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(asked, [
    { op: 'input_request', seq: 7, prompt: 'who? ', password: false },
  ]);
  assert.deepEqual(proc.controlRequests(), [
    { op: 'input_reply', seq: 7, value: 'Ada' },
  ]);
  assert.equal(proc.written.length, before, 'nothing goes on the request pipe');
});

test('a prompt nobody can answer is answered with end-of-file', async () => {
  // No handler at all, which is what a client with no user attached is. The
  // one outcome that must not happen is a kernel left waiting for an answer
  // nobody is going to give, so every path out of here sends something.
  const { client, started } = clientWith();
  void client.request({ op: 'ping' }).catch(() => undefined);
  const proc = await started();

  proc.says({ op: 'input_request', seq: 1, prompt: '', password: false });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(proc.controlRequests(), [
    { op: 'input_reply', seq: 1, value: null },
  ]);
});

test('a handler that throws still lets the kernel go', async () => {
  const { client, started } = clientWith({
    onInput: async () => { throw new Error('the box exploded'); },
  });
  void client.request({ op: 'ping' }).catch(() => undefined);
  const proc = await started();

  proc.says({ op: 'input_request', seq: 3, prompt: '', password: false });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(proc.controlRequests(), [
    { op: 'input_reply', seq: 3, value: null },
  ]);
});

test('an answer to a kernel that has gone is not written anywhere', async () => {
  // The box was still open when the kernel was restarted. Nothing is waiting
  // for this answer, and the kernel that replaced it is not waiting either.
  let release: (value: string | null) => void = () => undefined;
  const { client, started } = clientWith({
    onInput: () => new Promise((resolve) => { release = resolve; }),
  });
  void client.request({ op: 'ping' }).catch(() => undefined);
  const proc = await started();
  proc.says({ op: 'input_request', seq: 1, prompt: '', password: false });
  await new Promise((resolve) => setImmediate(resolve));

  client.restart();
  release('too late');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(proc.controlWritten, []);
});

test('printed output is handed over as it arrives', async () => {
  const seen: string[] = [];
  const { client, started } = clientWith({
    onStream: (name, text) => seen.push(`${name}:${text}`),
  });
  void client.request({ op: 'ping' }).catch(() => undefined);
  const proc = await started();

  proc.says({ op: 'stream', name: 'stdout', text: 'tick 3\n' });
  proc.says({ op: 'stream', name: 'stderr', text: 'careful\n' });

  assert.deepEqual(seen, ['stdout:tick 3\n', 'stderr:careful\n']);
});

test('output from a thread with nothing running arrives marked', async () => {
  // It is the user's own print and they need to see it. What cannot be done is
  // to say which line produced it: the statement that started the thread has
  // long returned, and attributing it would put text beside code that did not
  // write it.
  const seen: string[] = [];
  const { client, started } = clientWith({
    onStream: (name, text, unattributed) =>
      seen.push(`${name}:${unattributed ? 'late' : 'live'}:${text}`),
  });
  void client.request({ op: 'ping' }).catch(() => undefined);
  const proc = await started();

  proc.says({ op: 'stream', name: 'stdout', text: 'in the statement' });
  proc.says({
    op: 'stream', name: 'stdout', text: 'from a thread', unattributed: true,
  });

  assert.deepEqual(seen,
    ['stdout:live:in the statement', 'stdout:late:from a thread']);
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

/** A `statement` frame as the kernel writes it, for the load with this id. */
function statement(id: number, index: number, value: string) {
  return {
    op: 'statement',
    id,
    index,
    outcome: {
      ok: true, resolved: true, value, display: 'x', kind: 'Assign',
      range: {
        start: { line: index, character: 0 },
        end: { line: index, character: 5 },
      },
      stdout: '', stderr: '',
    },
  };
}

test('a load\'s statements arrive as they finish, in the order they ran', async () => {
  // The whole of the ticket at the transport layer. Before this the outcomes
  // came back inside the response, so a load that blocked on `input()` had
  // said nothing about any statement before it.
  const seen: string[] = [];
  const { client, started } = clientWith();
  const load = client.request(
    { op: 'eval_file', source: '', filename: '/tmp/f.py', allow_stdin: true },
    (frame) => seen.push(`${frame.index}:${(frame.outcome as { value: string }).value}`)
  );
  const proc = await started();

  proc.says(statement(1, 0, '1'));
  proc.says(statement(1, 1, '2'));
  assert.deepEqual(seen, ['0:1', '1:2'],
    'both before the response, which has not been written yet');

  proc.reply({ id: 1, ok: true, statements: 2, ran: 2, results: [] });
  await load;
});

test('a frame for another load is not delivered to this one', async () => {
  // Not a theoretical id check. Frames travel on the control channel and
  // responses on the request channel, and nothing orders two pipes against
  // each other -- so the tail of one load can be delivered after the next load
  // has started. Painted without the id, it would land on the new load's
  // statement of the same index: a value beside code it did not come from.
  const seen: number[] = [];
  const { client, started } = clientWith();
  void client.request({ op: 'ping' });
  const proc = await started();
  const load = client.request(
    { op: 'eval_file', source: '', filename: '/tmp/f.py', allow_stdin: true },
    (frame) => seen.push(frame.index)
  );
  await new Promise((resolve) => setImmediate(resolve));

  proc.says(statement(1, 7, 'stale'));
  proc.says(statement(2, 0, 'mine'));

  assert.deepEqual(seen, [0]);
  proc.reply({ id: 2, ok: true, statements: 1, ran: 1, results: [] });
  await load;
});

test('frames stop being delivered once the response has settled', async () => {
  // After the response the caller has `results` and has reconciled against it,
  // so a frame that lost the race between the two pipes has nothing left to
  // say. Delivering it would ask the caller to guard against its own answer.
  const seen: number[] = [];
  const { client, started } = clientWith();
  const load = client.request(
    { op: 'eval_file', source: '', filename: '/tmp/f.py', allow_stdin: true },
    (frame) => seen.push(frame.index)
  );
  const proc = await started();

  proc.says(statement(1, 0, '1'));
  proc.reply({ id: 1, ok: true, statements: 2, ran: 2, results: [] });
  await load;
  proc.says(statement(1, 1, '2'));

  assert.deepEqual(seen, [0]);
});

test('a restart takes the load\'s watcher with it', async () => {
  // A watcher outliving its kernel would take the next kernel's frames, and
  // the next kernel is a fresh namespace: every value it reports belongs to a
  // load nobody asked for from the buffer this one was painting.
  const seen: number[] = [];
  const { client, started } = clientWith();
  const load = client.request(
    { op: 'eval_file', source: '', filename: '/tmp/f.py', allow_stdin: true },
    (frame) => seen.push(frame.index)
  ).catch(() => undefined);
  const proc = await started();

  client.restart();
  await load;
  proc.says(statement(1, 0, '1'));

  assert.deepEqual(seen, []);
});
