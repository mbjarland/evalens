import { spawn as nodeSpawn } from 'node:child_process';

import { InterruptOutcome } from '../interrupt';
import {
  ControlMessage,
  ControlRequest,
  LineDecoder,
  Request,
  Response,
} from './protocol';

/** How long the kernel gets to acknowledge an interrupt before we say so. */
const DEFAULT_ACK_TIMEOUT = 2000;

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
   * How long an interrupt may go unacknowledged before it is reported as
   * unconfirmed. Two seconds unless a test wants to reach that branch without
   * waiting two seconds for it.
   */
  readonly ackTimeout?: number;
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
  private readonly decoder = new LineDecoder();
  /** The control channel is framed separately: it is a separate stream. */
  private readonly controlDecoder = new LineDecoder();
  private readonly spawnFn: SpawnFn;
  /** What the kernel last said it was doing, rather than what we assume. */
  private busy = false;
  /** Resolved by `interrupt_ack`, so cancel is not fire-and-forget. */
  private acknowledged?: Deferred<void>;
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

  async request(message: Request): Promise<Response> {
    if (this.disposed) {
      throw new Error('the Evalens kernel client has been disposed');
    }
    const process = await this.ensureStarted();
    const id = this.nextId++;
    const deferred = new Deferred<Response>();
    this.pending.set(id, deferred);
    try {
      process.stdin.write(`${JSON.stringify({ ...message, id })}\n`);
    } catch (error) {
      this.pending.delete(id);
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
    if (!process || (!this.busy && this.pending.size === 0)) {
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
    let response: Response;
    try {
      response = JSON.parse(line) as Response;
    } catch {
      this.options.onStderr?.(`unparseable line from kernel: ${line}\n`);
      return;
    }
    const deferred = this.pending.get(response.id);
    if (!deferred) {
      // A response to a request abandoned by a restart. Dropping it is
      // correct; reporting it would be noise.
      return;
    }
    this.pending.delete(response.id);
    deferred.resolve(response);
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
        this.busy = message.state === 'busy';
        return;
      case 'interrupt_ack':
        this.acknowledged?.resolve();
        this.acknowledged = undefined;
        return;
      default:
        this.options.onStderr?.(`unknown control message from kernel: ${line}\n`);
    }
  }

  private writeControl(process: KernelProcess, message: ControlRequest): void {
    process.control?.write(`${JSON.stringify(message)}\n`);
  }

  private get ackTimeout(): number {
    return this.options.ackTimeout ?? DEFAULT_ACK_TIMEOUT;
  }

  private stop(reason: Error): void {
    const process = this.process;
    this.process = undefined;
    this.generation += 1;
    this.decoder.reset();
    this.controlDecoder.reset();
    this.busy = false;
    // An interrupt whose kernel has gone will never be acknowledged, and the
    // caller is waiting on that. Let the timeout say so rather than leaving a
    // promise nothing can resolve.
    this.acknowledged = undefined;
    // Reject before killing: a pending promise that never settles is a
    // spinner that never stops, and the caller cannot tell it from slow code.
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
