/**
 * The wire contract with the Python kernel, and the two pure pieces of logic
 * that keep it honest. Nothing here imports `vscode`, which is what makes it
 * testable outside the extension host.
 *
 * Coordinates are VS Code's throughout -- 0-based line and character. The
 * kernel converts from `ast`'s 1-based line numbers on its side, so this side
 * never adjusts an index.
 */

export interface Position {
  readonly line: number;
  readonly character: number;
}

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

export interface KernelError {
  readonly type: string;
  readonly message: string;
  readonly traceback: string;
}

export interface EvalRequest {
  readonly op: 'eval';
  readonly source: string;
  readonly line: number;
  readonly character: number;
  readonly filename: string;
}

export interface EvalFileRequest {
  readonly op: 'eval_file';
  readonly source: string;
  readonly filename: string;
}

export type Request =
  | EvalRequest
  | EvalFileRequest
  | { readonly op: 'ping' }
  | { readonly op: 'reset' };

/** Nothing under the cursor -- a blank line. Not an error. */
export interface Unresolved {
  readonly id: number;
  readonly ok: true;
  readonly resolved: false;
}

export interface Evaluated {
  readonly id: number;
  readonly ok: true;
  readonly resolved: true;
  /**
   * What to show, or null when the statement has nothing to show.
   *
   * Usually `repr()`. For the few things Python reprs by memory address --
   * functions, classes, instances that inherited `object.__repr__` -- it is a
   * description the kernel built instead, and `repr` then carries the
   * original. The substitution is on this side of the wire so that a consumer
   * cannot paint the address by forgetting to look for a description.
   */
  readonly value: string | null;
  /** The untouched `repr()`, present only when `value` describes it instead. */
  readonly repr?: string;
  readonly display: string | null;
  readonly kind: string;
  readonly range: Range;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Failed {
  readonly id: number;
  readonly ok: false;
  readonly error: KernelError;
  readonly range?: Range;
  readonly kind?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  /** How many statements ran before the failure, for `eval_file`. */
  readonly statements?: number;
}

/** What one statement produced while a file was being loaded. */
export type StatementOutcome =
  | {
      readonly ok: true;
      readonly resolved: true;
      readonly value: string | null;
      readonly repr?: string;
      readonly display: string | null;
      readonly kind: string;
      readonly range: Range;
      readonly stdout: string;
      readonly stderr: string;
    }
  | {
      readonly ok: false;
      readonly error: KernelError;
      readonly kind?: string;
      readonly range?: Range;
      readonly stdout?: string;
      readonly stderr?: string;
    };

/**
 * A whole module body executed into the namespace.
 *
 * `ok` says the file could be parsed and attempted, not that every statement
 * succeeded -- a file being explored in is expected to contain broken lines,
 * and the ones that worked are in the namespace regardless. Per-statement
 * success lives in `results`.
 */
export interface FileLoaded {
  readonly id: number;
  readonly ok: true;
  readonly statements: number;
  readonly ran: number;
  readonly results: readonly StatementOutcome[];
}

export type FileResponse = FileLoaded | Failed;

export type EvalResponse = Unresolved | Evaluated | Failed;

export interface Acknowledged {
  readonly id: number;
  readonly ok: true;
}

export type Response = EvalResponse | FileResponse | Acknowledged;

export function isFailure(response: Response): response is Failed {
  return response.ok === false;
}

export function isEvaluated(response: Response): response is Evaluated {
  return response.ok === true && (response as Evaluated).resolved === true;
}

/**
 * Reassembles JSON lines from a stream that arrives in arbitrary chunks.
 *
 * A pipe makes no promise about message boundaries: one response can arrive
 * split across three reads, and three responses can arrive in one. Assuming
 * otherwise produces the classic intermittent bug that reproduces only on a
 * slow machine or a large value, so the framing is separated out here and
 * tested directly rather than trusted.
 */
export class LineDecoder {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split('\n');
    // The last element is whatever came after the final newline: either an
    // empty string, or the start of a message still in flight.
    this.buffer = parts.pop() ?? '';
    // Python's text-mode stdout writes \r\n on Windows.
    return parts.map((line) => line.replace(/\r$/, '')).filter((l) => l !== '');
  }

  /** Whatever is still buffered, for reporting a truncated stream. */
  get pending(): string {
    return this.buffer;
  }

  reset(): void {
    this.buffer = '';
  }
}

/**
 * Keeps only the newest answer per key.
 *
 * Two fast keypresses race: the second evaluation can finish first, and
 * painting both leaves whichever landed last on screen. Since one of them is
 * stale, that is a value next to code it did not come from -- the failure
 * mode this project treats as worse than showing nothing.
 */
export class LatestWins<K> {
  private readonly tokens = new Map<K, number>();
  private counter = 0;

  claim(key: K): number {
    const token = ++this.counter;
    this.tokens.set(key, token);
    return token;
  }

  isCurrent(key: K, token: number): boolean {
    return this.tokens.get(key) === token;
  }

  forget(key: K): void {
    this.tokens.delete(key);
  }
}
