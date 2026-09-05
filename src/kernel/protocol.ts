/**
 * The wire contract with the Python kernel, and the two pure pieces of logic
 * that keep it honest. Nothing here imports `vscode`, which is what makes it
 * testable outside the extension host.
 *
 * Coordinates are VS Code's throughout -- 0-based line and character. The
 * kernel converts from `ast`'s 1-based line numbers on its side, so this side
 * never adjusts an index.
 *
 * There are two channels, and the split is load-bearing rather than tidy.
 *
 * The **request channel** is the kernel's stdin and stdout: a `Request` goes
 * down it and a `Response` carrying the same `id` comes back. Exactly one
 * thing reads each end. While the kernel is running user code it is not
 * reading its stdin at all, which is precisely why nothing that has to be
 * dealt with *during* an evaluation can travel here.
 *
 * The **control channel** is a second pair of pipes -- the kernel's file
 * descriptors 3 and 4 -- serviced there by a thread that is never blocked by
 * whatever the main thread is doing. `ControlRequest` goes down it and
 * `ControlMessage` comes back.
 *
 * **Nothing on the control channel is a reply to anything on the request
 * channel.** That is what makes a message the kernel starts unmistakable: it
 * is not told apart from a stale response by some rule applied to a shared
 * stream, it arrives somewhere a response cannot. Jupyter splits its channels
 * the same way and for the same reason.
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

/**
 * What the extension sends down the control channel.
 *
 * `interrupt` is here rather than on the request channel for the reason the
 * channel exists: the kernel is busy at the moment someone wants to stop it,
 * so a message it has to read for itself is a message it reads when it is
 * finished -- which is never, for the loop this is meant to end.
 */
export type ControlRequest = { readonly op: 'interrupt' };

/**
 * What the kernel says on the control channel, unprompted.
 *
 * `status` reports what the kernel is doing, so the extension's progress and
 * cancel affordances can be driven by fact rather than by "the promise has
 * not settled yet" -- which is also true while an interpreter is still being
 * probed and nothing is running at all.
 *
 * `interrupt_ack` says the kernel heard an interrupt. Note what it does not
 * say: the acknowledgement is written by the control thread, so it means
 * "heard", not "stopped".
 */
export type ControlMessage =
  | {
      readonly op: 'status';
      readonly state: 'busy' | 'idle';
      readonly id?: number | null;
    }
  | { readonly op: 'interrupt_ack' };

/** Nothing under the cursor -- a blank line. Not an error. */
export interface Unresolved {
  readonly id: number;
  readonly ok: true;
  readonly resolved: false;
}

/**
 * What a `for` loop's target held, iteration by iteration.
 *
 * A loop's final value is true and nearly useless: the reason to run one in an
 * exploration file is to watch what it does, and every iteration but the last
 * is thrown away. The kernel rewrites the loop to record each iteration as it
 * begins, and sends the result bounded rather than whole -- `values` are the
 * leading iterations, `last` is the final one when it is not already among
 * them, and `count` is how many there were. A loop over a million rows costs
 * six strings, not a million.
 *
 * Every entry is a `repr()` taken *at that iteration*, never afterwards. A
 * loop over mutable objects would otherwise report the same final state N
 * times, which is worse than one value because it reads as N observations.
 */
export interface LoopTrace {
  readonly values: readonly string[];
  readonly last: string | null;
  readonly count: number;
}

/**
 * What one name on a line holds, read at the moment the line ran.
 *
 * Most lines in a real file are not bindings, and their own value has nothing
 * to say: `print("y unaffected by rebind:", y)` produced `None`, which is true
 * and useless beside the line whose entire point is `y`. The names are what
 * the reader came for, and their values are already in the namespace.
 *
 * Bare names only, and read once. A trace, not a watch (#40): the kernel takes
 * these while the statement's own effects are still the newest thing that
 * happened, and nothing re-reads them afterwards.
 */
export interface NamedValue {
  readonly name: string;
  readonly value: string;
  /** The untouched `repr()`, present only when `value` describes it instead. */
  readonly repr?: string;
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
  /**
   * The line the annotation belongs on, when that is not the end of `range`.
   *
   * A compound statement's value belongs beside the line that introduces it:
   * `greet: <function greet>` next to `return f"hello {name}"` reads as a
   * claim that the return statement produced a function. `range` still covers
   * the whole statement, because that is what shows how much code ran.
   * Absent means the two agree, which is every statement that is not
   * compound.
   */
  readonly anchor?: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Present only for a `for` / `async for`. */
  readonly loop?: LoopTrace;
  /** Present only when the line mentions names worth reporting. */
  readonly names?: readonly NamedValue[];
}

export interface Failed {
  readonly id: number;
  readonly ok: false;
  readonly error: KernelError;
  readonly range?: Range;
  /** Where the message belongs, when that is not the end of `range`. */
  readonly anchor?: number;
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
      readonly anchor?: number;
      readonly stdout: string;
      readonly stderr: string;
      readonly loop?: LoopTrace;
      readonly names?: readonly NamedValue[];
    }
  | {
      readonly ok: false;
      readonly error: KernelError;
      readonly kind?: string;
      readonly range?: Range;
      readonly anchor?: number;
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
