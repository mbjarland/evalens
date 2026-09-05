import { spawn as nodeSpawn } from 'node:child_process';

import { InterruptOutcome } from '../interrupt';
import {
  ControlMessage,
  ControlRequest,
  InputRequest,
  LineDecoder,
  Request,
  Response,
  StatementFrame,
  salvageResponse,
} from './protocol';

/** How long the kernel gets to acknowledge an interrupt before we say so. */
const DEFAULT_ACK_TIMEOUT = 2000;

/**
 * How long a request already in flight gets after the protocol channel was
 * seen to carry something that was not a response.
 *
 * Deliberately not a per-request timeout. Evaluations are allowed to take as
 * long as the user's code takes -- `while True:` is a normal thing to write,
 * and interrupting rather than timing out is the whole of how that is handled
 * -- so a clock started by every request would cancel exactly the evaluations
 * the Cancel button exists for. This clock starts only on evidence: a line
 * arrived that the kernel cannot have written, so an answer may have been
 * destroyed on its way here, and a promise nothing can settle is a spinner
 * that runs forever.
 */
const DEFAULT_STRAY_GRACE = 2000;

/** Enough of a stray line to recognise it by, in a notification. */
const STRAY_QUOTE_LIMIT = 120;

type Stream = NodeJS.EventEmitter & { setEncoding?(encoding: string): void };
type Sink = { write(chunk: string): void; end(): void };

/**
 * The subset of a child process this client uses.
 *
 * Narrowing it to this is what lets the tests drive a fake and cover the
 * failure modes that matter -- a split response, a crash mid-request, a
 * process that never starts -- none of which are reachable if the client
 * reaches for `child_process` directly.
 */
export interface KernelProcess {
  readonly stdin: Sink;
  readonly stdout: Stream;
  readonly stderr: Stream;
  /**
   * The control channel: the kernel's file descriptors 3 and 4.
   *
   * Named here so that nothing below has to remember the numbering. They are
   * optional because a process can be spawned without them, and a client that
   * throws rather than degrading would turn a missing pipe into a broken
   * extension instead of one that cannot be interrupted.
   */
  readonly control?: Sink;
  readonly controlOut?: Stream;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  kill(): void;
}

export type SpawnFn = (command: string, args: readonly string[]) => KernelProcess;

export interface KernelClientOptions {
  /**
   * Interpreter to run, resolved afresh on every spawn.
   *
   * A function rather than a string because it was a string: the path was
   * baked in at construction, so a cached client went on trying a broken
   * interpreter no matter what the user changed the setting to.
   */
  readonly resolvePython: () => Promise<string>;
  readonly kernelPath: string;
  readonly spawn?: SpawnFn;
  /** Kernel-side stderr: its own crashes, not the user's code. */
  readonly onStderr?: (text: string) => void;
  readonly onExit?: (code: number | null, signal: string | null) => void;
  /**
   * Answer a prompt from the running code, or null for end-of-file.
   *
   * Absent means nobody can be asked, and every prompt is answered with EOF --
   * which is the behaviour the kernel had before it could ask at all, and the
   * right default for a client with no user attached to it.
   */
  readonly onInput?: (request: InputRequest) => Promise<string | null>;
  /**
   * What the evaluated code printed, as it printed it.
   *
   * `unattributed` says nothing was running when it was written -- a thread
   * or an executor still going after the statement that started it returned.
   * It is still the user's own output and still worth showing; what cannot be
   * done is to say which line it came from.
   */
  readonly onStream?: (
    name: 'stdout' | 'stderr', text: string, unattributed: boolean
  ) => void;
  /**
   * How long an interrupt may go unacknowledged before it is reported as
   * unconfirmed. Two seconds unless a test wants to reach that branch without
   * waiting two seconds for it.
   */
  readonly ackTimeout?: number;
  /**
   * How long a request in flight when the protocol channel was corrupted gets
   * before it is failed rather than left pending. See `DEFAULT_STRAY_GRACE`.
   */
  readonly strayGrace?: number;
}

class Deferred<T> {
  resolve!: (value: T) => void;
  reject!: (reason: Error) => void;
  readonly promise = new Promise<T>((resolve, reject) => {
    this.resolve = resolve;
    this.reject = reject;
  });
}

/**
 * Owns the kernel subprocess and the request/response correlation over it.
 *
 * The process is spawned on the first request rather than at construction, so
 * opening a Python file to read it does not start an interpreter. Every
 * failure a user actually hits lives here -- no Python on the PATH, the wrong
 * Python, a kernel that died three requests ago -- which is why this is
 * separated from anything that touches the editor.
 */
export class KernelClient {
  private process?: KernelProcess;
  /** In-flight spawn, so two fast keypresses do not start two interpreters. */
  private starting?: Promise<KernelProcess>;
  private readonly pending = new Map<number, Deferred<Response>>();
  /**
   * Who wants the statement frames of a load still in flight, by request id.
   *
   * Keyed rather than a single slot, and the id is not decoration. Statement
   * frames travel on the control channel while the response travels on the
   * request channel, and nothing orders two pipes against each other -- so the
   * last frame of one load can be delivered after that load's response, which
   * is after the next load has already started. Without the id that frame
   * would be painted as the *new* load's statement of the same index: a value
   * beside code it did not come from, which is the failure this project treats
   * as worse than showing nothing.
   */
  private readonly watchers =
    new Map<number, (frame: StatementFrame) => void>();
  private readonly decoder = new LineDecoder();
  /** The control channel is framed separately: it is a separate stream. */
  private readonly controlDecoder = new LineDecoder();
  private readonly spawnFn: SpawnFn;
  /** What the kernel last said it was doing, rather than what we assume. */
  private executing = false;
  /** Resolved by `interrupt_ack`, so cancel is not fire-and-forget. */
  private acknowledged?: Deferred<void>;
  /** Armed by a corrupted line; see `stranded`. Cleared by every stop. */
  private readonly watchdogs = new Set<ReturnType<typeof setTimeout>>();
  /** Requests already given their grace period, so noise arms one each. */
  private readonly doomed = new Set<number>();
  private nextId = 1;
  private disposed = false;
  /** Bumped by every stop, so a spawn in flight can tell it is orphaned. */
  private generation = 0;

  constructor(private readonly options: KernelClientOptions) {
    this.spawnFn =
      options.spawn ??
      ((command, args) => {
        // Five pipes, not three. Descriptors 3 and 4 are the control channel,
        // and it exists because descriptor 0 has exactly one reader: while the
        // kernel runs user code it is not reading its stdin at all, so
        // anything that must be serviced *during* an evaluation cannot travel
        // on the pipe the evaluation is standing on.
        const child = nodeSpawn(command, [...args], {
          stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
        });
        return Object.assign(child, {
          control: child.stdio[3],
          controlOut: child.stdio[4],
        }) as unknown as KernelProcess;
      });
  }

  get running(): boolean {
    return this.process !== undefined;
  }

  /**
   * Whether the kernel says it is executing something.
   *
   * Reported by the kernel on the control channel, not inferred from a promise
   * that has not settled -- which is equally true while an interpreter is
   * still being probed and nothing is running at all. Those are different
   * facts and the user can act on them differently, which is why "taking a
   * while" and "has not started yet" are worded apart on the line.
   */
  get busy(): boolean {
    return this.executing;
  }

  /**
   * Send one request and wait for its answer.
   *
   * `onStatement` is for `eval_file` and is how a load is painted while it
   * runs rather than when it ends. It is passed here, rather than registered
   * separately, because only this method knows the id the request is about to
   * be given -- and the id is the whole of what keeps a late frame from one
   * load out of the next one. It is called synchronously, from the control
   * channel's reader, in the order the kernel wrote the frames.
   *
   * It stops being called the moment the response settles: after that the
   * caller has `results` and reconciles against it, and a frame that lost the
   * race between the two pipes has nothing left to say.
   */
  async request(
    message: Request, onStatement?: (frame: StatementFrame) => void
  ): Promise<Response> {
    if (this.disposed) {
      throw new Error('the Evalens kernel client has been disposed');
    }
    const process = await this.ensureStarted();
    const id = this.nextId++;
    const deferred = new Deferred<Response>();
    this.pending.set(id, deferred);
    if (onStatement) {
      this.watchers.set(id, onStatement);
    }
    try {
      process.stdin.write(`${JSON.stringify({ ...message, id })}\n`);
    } catch (error) {
      this.pending.delete(id);
      this.watchers.delete(id);
      throw error;
    }
    return deferred.promise;
  }

  /**
   * Stop whatever is running, and keep the session.
   *
   * An interrupt rather than a kill. The kernel raises `KeyboardInterrupt`
   * inside the user's loop and reports it as an ordinary failure, so the
   * namespace -- every binding the session has built up, which is the thing
   * worth protecting -- survives. Killing would stop the loop just as well and
   * throw all of that away.
   *
   * It goes down the control channel because the request channel cannot carry
   * it: the kernel is busy at exactly the moment someone wants to stop it, so
   * a message it has to read for itself would be read when it has finished --
   * which for an infinite loop is never. The kernel's control thread hears it,
   * acknowledges, and raises the interrupt in the main thread, on every
   * platform. There is no Windows fallback that restarts and loses the
   * namespace, because there does not need to be one.
   */
  async interrupt(): Promise<InterruptOutcome> {
    const process = this.process;
    if (!process || (!this.executing && this.pending.size === 0)) {
      // The race Cancel loses when the evaluation finishes first. Claiming to
      // have stopped something that had already stopped is a small lie the
      // status bar should not tell.
      return 'idle';
    }
    if (!process.control) {
      return 'unconfirmed';
    }
    const acknowledged = new Deferred<void>();
    this.acknowledged = acknowledged;
    try {
      this.writeControl(process, { op: 'interrupt' });
    } catch {
      return 'unconfirmed';
    }
    return (await settled(acknowledged.promise, this.ackTimeout))
      ? 'interrupted'
      : 'unconfirmed';
  }

  /** Kill and forget. The next request starts a fresh interpreter. */
  restart(): void {
    this.stop(new Error('the Evalens kernel was restarted'));
  }

  dispose(): void {
    this.disposed = true;
    this.stop(new Error('the Evalens kernel was shut down'));
  }

  // -- internals ------------------------------------------------------------

  private async ensureStarted(): Promise<KernelProcess> {
    if (this.process) {
      return this.process;
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = this.start();
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async start(): Promise<KernelProcess> {
    const { kernelPath } = this.options;
    // Which stop this spawn is still ahead of. Resolving an interpreter probes
    // candidates and that takes real time, so a restart or a dispose can land
    // while the spawn is in flight -- and a process started after it would be
    // one nothing holds a handle to and nothing ever kills.
    const generation = this.generation;
    const pythonPath = await this.options.resolvePython();
    // -u so nothing sits in a buffer waiting for a fuller write. The kernel
    // flushes explicitly too; this covers the paths that do not.
    const process = this.spawnFn(pythonPath, ['-u', kernelPath]);

    if (this.generation !== generation) {
      this.discard(process);
      throw new Error('the Evalens kernel was stopped while it was starting');
    }

    process.stdout.setEncoding?.('utf8');
    process.stderr.setEncoding?.('utf8');

    process.stdout.on('data', (chunk: string | Buffer) => {
      for (const line of this.decoder.push(chunk.toString())) {
        this.deliver(line);
      }
    });

    process.stderr.on('data', (chunk: string | Buffer) => {
      this.options.onStderr?.(chunk.toString());
    });

    process.controlOut?.setEncoding?.('utf8');
    process.controlOut?.on('data', (chunk: string | Buffer) => {
      for (const line of this.controlDecoder.push(chunk.toString())) {
        this.onControl(line);
      }
    });

    process.on('error', (error: Error) => {
      // The most common real failure: the interpreter does not exist. Name it,
      // rather than surfacing a bare ENOENT that says nothing about which
      // Python was tried.
      this.stop(
        new Error(
          `the Evalens kernel could not be started with "${pythonPath}": ` +
            `${error.message}`
        )
      );
    });

    process.on('exit', (code, signal) => {
      this.stop(
        new Error(
          `the Evalens kernel exited (code ${code ?? 'null'}, ` +
            `signal ${signal ?? 'null'})`
        )
      );
      this.options.onExit?.(code, signal);
    });

    this.process = process;
    return process;
  }

  private deliver(line: string): void {
    const { response, stray } = salvageResponse(line);
    if (!response) {
      // Nothing here was a response. It may simply be noise on its own line,
      // in which case the answer is still coming; or it may have swallowed
      // one, in which case nothing will ever settle the request that is
      // waiting for it. Which of the two it is cannot be told apart now, only
      // later, by whether the answer turns up.
      this.options.onStderr?.(`unparseable line from kernel: ${line}\n`);
      this.stranded(line);
      return;
    }
    if (stray) {
      // The dangerous shape: text with no trailing newline written onto the
      // front of a real response. The answer was computed correctly and is
      // right here; discarding the line would throw it away and wedge the
      // request it belongs to.
      this.options.onStderr?.(
        `stray output on the kernel's protocol channel: ${stray}\n`);
    }
    const deferred = this.pending.get(response.id);
    if (!deferred) {
      // A response to a request abandoned by a restart. Dropping it is
      // correct; reporting it would be noise.
      return;
    }
    this.pending.delete(response.id);
    // Before the promise is resolved, so the caller cannot be woken into a
    // world where a frame it has already reconciled away could still arrive.
    this.watchers.delete(response.id);
    deferred.resolve(response);
  }

  /**
   * Fail the requests whose answer this line may have destroyed.
   *
   * Only the ones already in flight, and only after a grace period: a stray
   * line that arrived whole, on its own, has taken nothing with it and the
   * real answer lands milliseconds later. What must not happen is the other
   * case -- the answer eaten, `pending` untouched, and a progress
   * notification spinning until the user restarts the kernel and loses the
   * session's namespace to find out why.
   */
  private stranded(line: string): void {
    // One grace period per request, not one per garbage line: something
    // writing to the descriptor in a loop would otherwise arm a timer per
    // line, all of them saying the same thing about the same request.
    const ids = [...this.pending.keys()].filter((id) => !this.doomed.has(id));
    if (ids.length === 0) {
      return;
    }
    const generation = this.generation;
    for (const id of ids) {
      this.doomed.add(id);
    }
    const quoted = line.length > STRAY_QUOTE_LIMIT
      ? `${line.slice(0, STRAY_QUOTE_LIMIT)}…`
      : line;
    const timer = setTimeout(() => {
      this.watchdogs.delete(timer);
      for (const id of ids) {
        this.doomed.delete(id);
      }
      if (this.generation !== generation) {
        return;
      }
      for (const id of ids) {
        const deferred = this.pending.get(id);
        if (!deferred) {
          continue;
        }
        this.pending.delete(id);
        this.watchers.delete(id);
        deferred.reject(new Error(
          'this evaluation was lost: something that is not a response was ' +
          `written on the kernel's protocol channel ("${quoted}"). ` +
          'Evaluating the line again is safe; the namespace is intact.'
        ));
      }
    }, this.strayGrace);
    this.watchdogs.add(timer);
  }

  /**
   * Handle one message the kernel started on its own account.
   *
   * The rule above -- unknown id, drop it -- is right for the request channel
   * and would be wrong here, and this is why the two are separate streams
   * rather than one stream with a marker on it. A stale response and a
   * message the kernel began are not distinguished by inspecting the message;
   * they cannot be confused, because a response never arrives on this pipe.
   */
  private onControl(line: string): void {
    let message: ControlMessage;
    try {
      message = JSON.parse(line) as ControlMessage;
    } catch {
      this.options.onStderr?.(`unparseable control line from kernel: ${line}\n`);
      return;
    }
    switch (message.op) {
      case 'status':
        this.executing = message.state === 'busy';
        return;
      case 'interrupt_ack':
        this.acknowledged?.resolve();
        this.acknowledged = undefined;
        return;
      case 'stream':
        this.options.onStream?.(
          message.name, message.text, message.unattributed === true);
        return;
      case 'statement':
        // Synchronously, and that is the requirement rather than an
        // implementation detail: one reader, one pipe, no await between
        // arriving and being handed on, so the order the kernel wrote these in
        // is the order the painter sees them in. An id with no watcher is a
        // load that has already settled, or one abandoned by a restart.
        this.watchers.get(message.id ?? -1)?.(message);
        return;
      case 'input_request':
        void this.answerInput(message);
        return;
      default:
        this.options.onStderr?.(`unknown control message from kernel: ${line}\n`);
    }
  }

  /**
   * Ask whoever is attached, and write the answer back.
   *
   * The kernel is blocked while this runs, which is correct -- it is what a
   * REPL does -- and is also why every path out of here ends in a reply. No
   * handler, a handler that throws, a user who cancelled: all of them send
   * end-of-file, because the one outcome that must not happen is a kernel
   * left waiting for an answer nobody is going to give.
   */
  private async answerInput(request: InputRequest): Promise<void> {
    const generation = this.generation;
    let value: string | null = null;
    try {
      value = (await this.options.onInput?.(request)) ?? null;
    } catch (error) {
      this.options.onStderr?.(
        `Evalens could not ask for input: ${String(error)}\n`);
    }
    if (this.generation !== generation || !this.process) {
      // The kernel was restarted or disposed while the box was open. There is
      // nothing listening for this answer, and the next kernel is not waiting
      // for one.
      return;
    }
    this.writeControl(this.process, {
      op: 'input_reply', seq: request.seq, value,
    });
  }

  private writeControl(process: KernelProcess, message: ControlRequest): void {
    process.control?.write(`${JSON.stringify(message)}\n`);
  }

  private get ackTimeout(): number {
    return this.options.ackTimeout ?? DEFAULT_ACK_TIMEOUT;
  }

  private get strayGrace(): number {
    return this.options.strayGrace ?? DEFAULT_STRAY_GRACE;
  }

  private stop(reason: Error): void {
    const process = this.process;
    this.process = undefined;
    this.generation += 1;
    this.decoder.reset();
    this.controlDecoder.reset();
    this.executing = false;
    // An interrupt whose kernel has gone will never be acknowledged, and the
    // caller is waiting on that. Let the timeout say so rather than leaving a
    // promise nothing can resolve.
    this.acknowledged = undefined;
    // The loop below settles everything a watchdog was waiting to settle, so
    // the timers have nothing left to do but keep the process awake.
    for (const timer of this.watchdogs) {
      clearTimeout(timer);
    }
    this.watchdogs.clear();
    this.doomed.clear();
    // Reject before killing: a pending promise that never settles is a
    // spinner that never stops, and the caller cannot tell it from slow code.
    // Cleared before the rejections, so a watcher cannot outlive the kernel it
    // was watching and take the next one's frames.
    this.watchers.clear();
    for (const deferred of this.pending.values()) {
      deferred.reject(reason);
    }
    this.pending.clear();
    if (process) {
      this.discard(process);
    }
  }

  /** Close the pipes, then kill. A kernel is never left half-attached. */
  private discard(process: KernelProcess): void {
    for (const sink of [process.stdin, process.control]) {
      try {
        sink?.end();
      } catch {
        // Already gone; killing below is what matters.
      }
    }
    process.kill();
  }
}

/** True if `work` settled within `ms`; false if the wait ran out first. */
function settled(work: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    work.then(
      () => { clearTimeout(timer); resolve(true); },
      () => { clearTimeout(timer); resolve(false); }
    );
  });
}
