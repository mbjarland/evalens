import { spawn as nodeSpawn } from 'node:child_process';

import {
  LineDecoder,
  Request,
  Response,
} from './protocol';

/**
 * The subset of a child process this client uses.
 *
 * Narrowing it to this is what lets the tests drive a fake and cover the
 * failure modes that matter -- a split response, a crash mid-request, a
 * process that never starts -- none of which are reachable if the client
 * reaches for `child_process` directly.
 */
export interface KernelProcess {
  readonly stdin: { write(chunk: string): void; end(): void };
  readonly stdout: NodeJS.EventEmitter & { setEncoding?(encoding: string): void };
  readonly stderr: NodeJS.EventEmitter & { setEncoding?(encoding: string): void };
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  kill(): void;
}

export type SpawnFn = (command: string, args: readonly string[]) => KernelProcess;

export interface KernelClientOptions {
  /** Interpreter to run. Resolved by the caller; see `resolvePythonPath`. */
  readonly pythonPath: string;
  readonly kernelPath: string;
  readonly spawn?: SpawnFn;
  /** Kernel-side stderr: its own crashes, not the user's code. */
  readonly onStderr?: (text: string) => void;
  readonly onExit?: (code: number | null, signal: string | null) => void;
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
  private readonly pending = new Map<number, Deferred<Response>>();
  private readonly decoder = new LineDecoder();
  private readonly spawnFn: SpawnFn;
  private nextId = 1;
  private disposed = false;

  constructor(private readonly options: KernelClientOptions) {
    this.spawnFn =
      options.spawn ??
      ((command, args) =>
        nodeSpawn(command, [...args], {
          stdio: ['pipe', 'pipe', 'pipe'],
        }) as unknown as KernelProcess);
  }

  get running(): boolean {
    return this.process !== undefined;
  }

  async request(message: Request): Promise<Response> {
    if (this.disposed) {
      throw new Error('the Evalens kernel client has been disposed');
    }
    const process = this.ensureStarted();
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

  /** Kill and forget. The next request starts a fresh interpreter. */
  restart(): void {
    this.stop(new Error('the Evalens kernel was restarted'));
  }

  dispose(): void {
    this.disposed = true;
    this.stop(new Error('the Evalens kernel was shut down'));
  }

  // -- internals ------------------------------------------------------------

  private ensureStarted(): KernelProcess {
    if (this.process) {
      return this.process;
    }
    const { pythonPath, kernelPath } = this.options;
    // -u so nothing sits in a buffer waiting for a fuller write. The kernel
    // flushes explicitly too; this covers the paths that do not.
    const process = this.spawnFn(pythonPath, ['-u', kernelPath]);

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

    process.on('error', (error: Error) => {
      // The most common real failure: the interpreter does not exist. Name it,
      // rather than surfacing a bare ENOENT that says nothing about which
      // Python was tried.
      this.stop(
        new Error(
          `could not start the Evalens kernel with "${pythonPath}": ` +
            `${error.message}. Set evalens.pythonPath to a working interpreter.`
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

  private stop(reason: Error): void {
    const process = this.process;
    this.process = undefined;
    this.decoder.reset();
    // Reject before killing: a pending promise that never settles is a
    // spinner that never stops, and the caller cannot tell it from slow code.
    for (const deferred of this.pending.values()) {
      deferred.reject(reason);
    }
    this.pending.clear();
    if (process) {
      try {
        process.stdin.end();
      } catch {
        // Already gone; killing below is what matters.
      }
      process.kill();
    }
  }
}
