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
  /**
   * Whether this evaluation may stop and ask the user something.
   *
   * True for a keypress: somebody is sitting in front of the editor waiting
   * for this line to answer, so a prompt is a conversation rather than a
   * hang.
   */
  readonly allow_stdin: boolean;
}

export interface EvalFileRequest {
  readonly op: 'eval_file';
  readonly source: string;
  readonly filename: string;
  /**
   * Whether the load may stop and ask. It may.
   *
   * This was `false`, and typed as `false` so it could not become anything
   * else, on the grounds that Jupyter sets the same flag false for `nbconvert`
   * and `papermill`. That reading was wrong. Those are *unattended* -- a batch
   * conversion with nobody watching -- and the flag exists there because a
   * deadlock no one can see is worse than a loud failure. Loading a file here
   * is a person pressing a key and waiting for the result, so the reason
   * simply does not apply to it.
   *
   * What refusing produced was a red `EOFError` on the prompt line and a
   * cascade of `NameError` beneath it, because nothing downstream had the
   * value -- on precisely the teaching files this command was built for.
   * Twenty prompts is still too many, and that is answered by offering to skip
   * the rest rather than by refusing the first.
   *
   * A selection is the same command over less code and does not change this:
   * one key, one set of semantics, whatever it is pointed at.
   */
  readonly allow_stdin: boolean;
  /**
   * First line to run, 0-based and inclusive. Absent means the whole file.
   *
   * A line range over the whole buffer, and never a slice of the source. The
   * kernel keeps `linecache` pointing at what the user is looking at so that
   * a traceback quotes the right line and every range it answers with is a
   * real file position; sending only the selected text would renumber both,
   * and an annotation three lines from its statement is worse than none.
   * Both bounds or neither -- the kernel runs nothing for a half-stated
   * range rather than falling back to the whole file.
   */
  readonly start_line?: number;
  /** Last line to run, 0-based and inclusive. */
  readonly end_line?: number;
}

/**
 * Where every top-level statement in a file is, without running any of them.
 *
 * Asked on every press of Evaluate and Advance, which is why it is its own op
 * rather than a field on an evaluation: the answer has to be available before
 * the evaluation is dispatched, and a question about the shape of a file must
 * never be a reason to execute part of it.
 */
export interface OutlineRequest {
  readonly op: 'outline';
  readonly source: string;
  readonly filename: string;
}

export type Request =
  | EvalRequest
  | EvalFileRequest
  | OutlineRequest
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
export type ControlRequest =
  | { readonly op: 'interrupt' }
  | {
      readonly op: 'input_reply';
      /** Which question this answers -- see `InputRequest.seq`. */
      readonly seq: number;
      /**
       * What the user typed, or null for end-of-file.
       *
       * Null rather than a sentinel string: cancelling has to be expressible
       * as something no answer could ever be, and any text at all is
       * something someone could type. It reaches the running code as
       * `EOFError`, which is what `input()` raises on an empty read and what
       * this did before there was anywhere to ask -- kept deliberately, as
       * the way out. A student who cannot escape a prompt is worse off than
       * one whose program errors.
       */
      readonly value: string | null;
    };

/** The kernel asking the user for a line. */
export interface InputRequest {
  readonly op: 'input_request';
  /**
   * Which question this is.
   *
   * The kernel discards a reply that does not match, which is what stops a
   * late answer to a prompt that was interrupted -- the box was still open,
   * the user typed anyway -- from landing in an unrelated variable.
   */
  readonly seq: number;
  /**
   * The prompt, which is whatever the code printed and did not terminate.
   *
   * Empty when the code asked for a line without saying why, which is a thing
   * beginners write. The extension supplies its own wording then.
   */
  readonly prompt: string;
  /** The read came from inside `getpass`, so the answer must not be echoed. */
  readonly password: boolean;
  /**
   * Where the statement that asked is.
   *
   * Only the kernel knows. The extension sent a cursor position or a whole
   * file, and during a load neither of those is the statement that reached the
   * read -- so without this the box asking for a value could not say which
   * line wanted one, which is the half of the design that stops it feeling
   * disembodied.
   */
  readonly range?: Range;
  /** Where the marker belongs, when that is not the end of `range`. */
  readonly anchor?: number;
}

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
  | { readonly op: 'interrupt_ack' }
  | InputRequest
  | {
      /**
       * Something the evaluated code printed, as it printed it.
       *
       * The response still carries the whole of it when the statement
       * finishes; this is the same text arriving live. Both, because a loop
       * that prints its progress only reads as progress if the output shows
       * up while it is running -- and because the prompt has to be on screen
       * before the box asking about it.
       */
      readonly op: 'stream';
      readonly name: 'stdout' | 'stderr';
      readonly text: string;
    };

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
 * What one name the loop's *body* bound held, iteration by iteration.
 *
 * The target is usually the input being iterated; the body binding is usually
 * the computed result, which is the half the reader came for. Both change on
 * every iteration, and reporting the input's whole history beside the output's
 * final value -- in the same style, side by side -- is exactly backwards.
 *
 * Bounded on the same terms as the target's trace, which is why this extends
 * it rather than repeating it. Two things are its own:
 *
 * **`count` need not match the loop's.** An iteration that hit `continue` or
 * `break` left the body before the recorder and computed no result, so it
 * contributes nothing. Rendering the two as parallel columns is wrong the
 * first time someone writes a filter loop; they are separate sequences that
 * happen to have been recorded by one statement.
 *
 * **`constant`** says every iteration bound the same value, and `values` then
 * holds that one reading. `c: 7, 7, 7, 7` is four observations of one fact,
 * and it crowds out the sequence next to it that is actually moving.
 */
export interface BindingTrace extends LoopTrace {
  readonly name: string;
  readonly constant?: boolean;
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
  /** What the loop's body bound; present only when it bound something. */
  readonly bindings?: readonly BindingTrace[];
  /** Present only when the line mentions names worth reporting. */
  readonly names?: readonly NamedValue[];
  /**
   * How many further names the kernel's per-line cap left out.
   *
   * The cap keeps a line from disappearing under a second copy of the
   * namespace; dropping the rest silently is what made it read as a bug. A
   * reader who counts five names on the line and four beside it cannot tell
   * whether the fifth was omitted, unreadable, or somehow not a name. Absent
   * when the cap did not bite, which is nearly every line.
   */
  readonly more_names?: number;
  /**
   * The module-level names this statement wrote, and the ones it consulted.
   *
   * The only fields here that say nothing about this statement's own answer.
   * They are how the extension works out which *other* annotations this
   * evaluation just put out of date: one that reads a name this one binds, and
   * sits below it in the file. Marking, and never running -- that is #40's
   * decision and this must not become reactivity by increments. Absent when
   * empty.
   */
  readonly binds?: readonly string[];
  readonly reads?: readonly string[];
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
  /**
   * Sent on this path too. A statement that raised may have bound something
   * before it did, and marking a dependant that did not need it costs a grey
   * pixel where missing one costs the thing the marker is for.
   */
  readonly binds?: readonly string[];
  readonly reads?: readonly string[];
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
      readonly bindings?: readonly BindingTrace[];
      readonly names?: readonly NamedValue[];
      readonly more_names?: number;
      readonly binds?: readonly string[];
      readonly reads?: readonly string[];
    }
  | {
      readonly ok: false;
      readonly error: KernelError;
      readonly kind?: string;
      readonly range?: Range;
      readonly anchor?: number;
      readonly stdout?: string;
      readonly stderr?: string;
      readonly binds?: readonly string[];
      readonly reads?: readonly string[];
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
  /** How many statements the request covered -- the selection's, when narrowed. */
  readonly statements: number;
  readonly ran: number;
  readonly results: readonly StatementOutcome[];
  /**
   * The span actually executed, present only for a narrowed load that found
   * something to run.
   *
   * Wider than the requested lines whenever a statement was only partly
   * inside them, because a partial statement runs whole or not at all. The
   * kernel reports it because the extension cannot infer it: the side that
   * decided how far to widen is the side that knows.
   */
  readonly range?: Range;
}

export type FileResponse = FileLoaded | Failed;

/**
 * One top-level statement, as the parser sees it and before anything runs.
 *
 * The same `range` and `anchor` an evaluation of that statement would report,
 * which is the point: stepping through a file and evaluating in it must agree
 * about where the statements are, and they do because one parser answers both.
 */
export interface StatementSpan {
  readonly kind: string;
  readonly range: Range;
  /** The line the value belongs on, when that is not the end of `range`. */
  readonly anchor?: number;
}

export interface Outlined {
  readonly id: number;
  readonly ok: true;
  readonly statements: readonly StatementSpan[];
}

/** A syntax error is the only failure: nothing ran, so nothing else can fail. */
export type OutlineResponse = Outlined | Failed;

export type EvalResponse = Unresolved | Evaluated | Failed;

export interface Acknowledged {
  readonly id: number;
  readonly ok: true;
}

export type Response =
  EvalResponse | FileResponse | OutlineResponse | Acknowledged;

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
