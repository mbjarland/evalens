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

/**
 * How much of an answer the reader wants, sent with every request.
 *
 * These are user settings, and they travel on the request rather than being
 * configured into the kernel because the only way to change a kernel's mind
 * about anything is to restart it -- which discards the namespace, the one
 * thing a session cannot get back. Adjusting a display preference must not
 * cost a session, so the kernel is simply told again each time.
 *
 * Zero means off, and it turns off the work rather than the display: an
 * uninstrumented loop costs nothing per iteration, and a line whose names
 * nobody wants is a line the namespace is never read for. Snake case because
 * this is the wire, and the wire is Python's.
 */
export interface DisplayLimits {
  /** Iterations of a loop to list; 0 leaves the loop uninstrumented. */
  readonly loop_values: number;
  /** Names on a line to read; 0 reads none. */
  readonly names: number;
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
  /** Absent means the kernel's own defaults, which are the same numbers. */
  readonly limits?: DisplayLimits;
}

/**
 * Run the loop under `line`/`character`, tracing `watch` across it -- #48.
 *
 * A separate op from `eval` rather than an optional field on it, because the
 * two answer different questions: `eval` reports whatever the statement under
 * the cursor already does, and this one nominates something extra to look at
 * *this once*. Sending it is itself the trigger -- design rule 5's "explicitly
 * triggered, never continuous" applies to a nomination exactly as it does to
 * an ordinary evaluation. Nothing about `watch` is remembered between
 * requests: a plain `eval` sent afterwards, for the same loop, carries no
 * trace of it, which is what keeps this a trace in the sense of design rule 4
 * rather than a watch in the sense the rule forbids -- see `loops.py`'s
 * module docstring for the full argument.
 *
 * `line`/`character` resolve two things at once, exactly as they do for
 * `eval`: which top-level statement to run -- it must itself be a `for` or
 * `async for`, `NoLoop` otherwise -- and, within it, which of its own loops
 * (nested ones included) `watch` attaches to, by innermost enclosure.
 * Pointing at a selection's start is the intended use: the reader selected
 * the expression, and that selection's own position is what the loop is
 * resolved from too.
 */
export interface EvalWatchRequest {
  readonly op: 'eval_watch';
  readonly source: string;
  readonly line: number;
  readonly character: number;
  readonly filename: string;
  readonly allow_stdin: boolean;
  readonly limits?: DisplayLimits;
  /** The expression's own source text, exactly as the reader selected it. */
  readonly watch: string;
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
  /** The same preferences apply to a load; see `DisplayLimits`. */
  readonly limits?: DisplayLimits;
  /**
   * Run the file the way `python3 <file>` would, rather than the way
   * `import` would.
   *
   * Absent or false is Load File exactly as it has always been: `__name__`
   * is the file's own name and an `if __name__ == "__main__":` guard stays
   * False. True is Evalens: Run File as Script (#78) -- `__name__` is
   * `"__main__"` for this one request, so the guard fires and its body runs
   * like every other statement in the file, reported the same way. Nothing
   * else about the request changes: the whole file still runs top to bottom,
   * into the same persistent namespace, and a second script run simply runs
   * it again rather than resetting anything first.
   */
  readonly as_script?: boolean;
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

/**
 * Run everything above the statement a 0-based cursor `line` is in, so that
 * statement's own state matches what running the file from the top through
 * it would have produced (#13).
 *
 * Unlike `EvalFileRequest`, there is no `start_line`/`end_line`: the range to
 * run is not something the caller narrows, it is derived on the kernel side
 * from where the cursor sits, and the boundary is the statement itself
 * rather than a line the caller already knows. There is also no `as_script`
 * -- run-above is always a load, never a script run, because its whole job
 * is preparing state for the statement at the cursor, not imitating
 * `python3 <file>`.
 */
export interface EvalAboveRequest {
  readonly op: 'eval_above';
  readonly source: string;
  readonly filename: string;
  /** 0-based line the cursor is on. Everything above its statement runs. */
  readonly line: number;
  /** Same reasoning as `EvalFileRequest.allow_stdin`: a person is watching. */
  readonly allow_stdin: boolean;
  /** The same preferences apply to a run-above; see `DisplayLimits`. */
  readonly limits?: DisplayLimits;
}

/**
 * One safe access on the way from a namespace binding down to a value the
 * explorer wants to show -- never a key or index the extension invents.
 *
 * Every `step` an `Inspected` child carries is handed back on the wire
 * exactly as it arrived: the kernel is what decides whether an attribute
 * read or a container position is safe to repeat (#73's rule, applied to
 * `__getattr__`/`__getitem__` instead of `__repr__`), and inventing one
 * here would be trusting the extension's own guess about a type it has
 * never seen the definition of.
 */
export type InspectStep =
  | { readonly kind: 'attr'; readonly name: string }
  | { readonly kind: 'item'; readonly index: number };

/**
 * Ask for one level of a value's children -- the object explorer's op
 * (#23) -- addressed by a name already sitting in the namespace and a path
 * of `InspectStep`s below it, never by an expression to re-evaluate.
 *
 * `name` has to be a bare identifier: the one shape a namespace lookup can
 * answer without running anything, which is also why `Evaluated.display`
 * is the only source of it -- see `render/inspector.ts`. Re-sent on every
 * request, on the same footing as `EvalRequest.source`: the kernel holds no
 * "current" value to expand, only the namespace itself.
 */
export interface InspectRequest {
  readonly op: 'inspect';
  readonly name: string;
  readonly path: readonly InspectStep[];
}

export type Request =
  | EvalRequest
  | EvalWatchRequest
  | EvalFileRequest
  | EvalAboveRequest
  | OutlineRequest
  | InspectRequest
  | { readonly op: 'ping' }
  | { readonly op: 'reset' }
  /**
   * Forget every replayed `input()` answer, and nothing else.
   *
   * Lighter than `reset`: the namespace is untouched, only the memory of
   * what answered a past prompt is let go. See `InputAnswer` for what a
   * replay is and why it has to be told apart from a typed answer.
   */
  | { readonly op: 'clear_input_replay' };

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
 * One statement of a file load, reported the moment it finished.
 *
 * A load is sequential in the kernel and used to be atomic on screen: every
 * outcome was collected and sent back in one response, so a file that blocks
 * on `input()` at line 47 had run lines 1-46 with nothing whatsoever painted.
 * The prompt then arrived with no context, and #61's mark on the waiting line
 * had nothing around it to be prominent against.
 *
 * It is on the control channel for the reason the channel exists: a response
 * settles a request and nothing else is written where a response is written,
 * so a not-yet-a-response there would have to be told apart by inspecting it.
 * This channel is also the one already proven to reach the extension *during*
 * an evaluation -- printed output does it today.
 *
 * `outcome` is the same object that will appear in `FileLoaded.results`, not a
 * summary of it, so painting from a frame and painting from the response
 * cannot drift.
 */
export interface StatementFrame {
  readonly op: 'statement';
  /** Which load this belongs to; the id of the `eval_file` request. */
  readonly id?: number | null;
  /**
   * Where the statement sits in file order, 0-based, indexing `results`.
   *
   * Carried rather than inferred from arrival order, because arrival order is
   * only trustworthy while nothing goes missing. A consumer that counted
   * arrivals would shift every annotation below a lost frame by one line and
   * have no way to notice; with the index it can refuse instead, and let the
   * response's `results` finish the job in order. See `InOrder`.
   */
  readonly index: number;
  readonly outcome: StatementOutcome;
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
  | StatementFrame
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
      /**
       * Nothing was running when this was written, so it belongs to no line.
       *
       * A thread, a timer or an executor started by one statement goes on
       * printing after that statement has returned. The kernel's streams are
       * replaced for its whole life so that text can never reach the protocol
       * channel, but the statement that started it is gone and no id can
       * honestly be put on it. Absent means the text came from the evaluation
       * that was in flight. Attributing late output to the line that started
       * the thread is not knowable and is deliberately not attempted.
       */
      readonly unattributed?: boolean;
    };

/**
 * What the kernel could not parse, when it answered from part of the file.
 *
 * `ast` is all-or-nothing, so one half-typed line used to make every line in
 * the file unevaluable -- and a half-typed line is what a file being explored
 * in has, because that is why anyone is evaluating anything. The kernel drops
 * trailing lines until what is left parses and answers from that, which means
 * the answer carries a weaker claim than usual: it was computed without the
 * rest of the file. This is that claim, made explicit.
 *
 * Its presence is the signal. Absent means the whole file parsed and nothing
 * was left out, which is why there is no `partial: false` to misread.
 */
export interface PartialParse {
  /** 0-based first line the parse could not reach. */
  readonly truncated_at: number;
  readonly error: KernelError;
  /** Where the break is, so the report lands on the line that caused it. */
  readonly range: Range;
}

/** Nothing under the cursor -- a blank line. Not an error. */
export interface Unresolved {
  readonly id: number;
  readonly ok: true;
  readonly resolved: false;
  /** Present when the file did not parse whole -- see `PartialParse`. */
  readonly partial?: PartialParse;
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
 * A named sequence appended beside a statement's own value, iteration by
 * iteration.
 *
 * Three different sources fill this array, on the same shape because the
 * rendering they want is the same one.
 *
 * **What a `for` loop's *body* bound.** The target is usually the input being
 * iterated; the body binding is usually the computed result, which is the
 * half the reader came for. Both change on every iteration, and reporting the
 * input's whole history beside the output's final value -- in the same style,
 * side by side -- is exactly backwards.
 *
 * **What one of a comprehension's `for` clauses drew from its iterable.** A
 * comprehension has no body statement to bind a name in -- it is built
 * entirely from expressions -- so there is nothing here that plays the first
 * role for one. What it does have is the clause's own target, scoped to the
 * comprehension and gone by the time the statement finishes, and this is
 * where the kernel reports the sequence that scope never got to keep: `x` in
 * `squares = [x**2 for x in range(10)]`. `name` is then the clause's target
 * pattern, unparsed -- `"x"`, or `"(k, v)"` for one that unpacks.
 *
 * **What a reader nominated for `eval_watch` to trace -- #48.** `name` here
 * is the expression's own source text (`"p+6"`, `"acct.balance"`), not an
 * identifier, and it is never parsed back into anything on this side: an
 * opaque label like any other, painted the same way. `error`/`failed`, both
 * optional, are its own addition -- present only when the expression raised
 * during at least one iteration; see `EvalWatchRequest`.
 *
 * Bounded on the same terms as the target's own trace, which is why this
 * extends it rather than repeating it. A few things are its own:
 *
 * **`count` need not match the loop's.** An iteration that hit `continue` or
 * `break` left the body before the recorder and computed no result, so it
 * contributes nothing. Rendering the two as parallel columns is wrong the
 * first time someone writes a filter loop; they are separate sequences that
 * happen to have been recorded by one statement. A comprehension clause has
 * no loop of its own to compare against -- `count` there is simply how many
 * times it ran, and a nested clause legitimately runs once per outer
 * iteration.
 *
 * **`constant`** says every iteration bound the same value, and `values` then
 * holds that one reading. `c: 7, 7, 7, 7` is four observations of one fact,
 * and it crowds out the sequence next to it that is actually moving.
 */
export interface BindingTrace extends LoopTrace {
  readonly name: string;
  readonly constant?: boolean;
  /**
   * The first exception a nominated expression raised, if it ever did --
   * #48. Never set for a body binding or a comprehension clause, both of
   * which only ever read a name rather than evaluate one. `values`/`last`
   * on the same object stay whatever it managed to produce beforehand and
   * afterwards; a failure does not stop the loop or the trace.
   */
  readonly error?: { readonly type: string; readonly message: string };
  /** How many further iterations raised, beyond the one `error` describes. */
  readonly failed?: number;
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
  /** A bounded table description of this name's value; see `TableWire`. */
  readonly table?: TableWire;
}

/**
 * A bounded description of a value that duck-types as a table -- #24.
 *
 * A DataFrame's `repr()` is a grid, and squashing it onto one line destroys
 * the only thing that made it readable; the same is true of a list of dicts
 * with consistent keys, a list of same-length lists, and a sequence of
 * `namedtuple`s. `kernel/tabular.py`'s `describe` recognises exactly those
 * four shapes and answers with this, computed from the same value at the
 * same moment `value`/`repr` above already are -- never a second lookup.
 *
 * `row_count`/`col_count` are the value's real totals; `shown_rows` and
 * `shown_cols` are how many made it into `rows`/`columns`, bounded to a
 * head-and-tail sample so a million-row value is never walked whole.
 * `more_rows`/`more_cols` say how many were left out and are absent when
 * nothing was, on the same terms `more_names` already uses.
 *
 * Absent from `NamedValue`/`Evaluated` entirely for every value that does
 * not duck-type as one of the four shapes -- which is every value in a
 * session with no pandas installed, the default this was built against.
 */
export interface TableWire {
  readonly kind: 'dataframe' | 'records' | 'namedtuples' | 'rows';
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly row_count: number;
  readonly shown_rows: number;
  readonly col_count: number;
  readonly shown_cols: number;
  readonly more_rows?: number;
  readonly more_cols?: number;
}

/**
 * One line `input()` (or `readline()` / `read()`) returned, and where the
 * value came from.
 *
 * `typed` is a human answering the box just now. `replay` is this exact
 * statement's own most recent typed answer, reused automatically -- and
 * told apart from `typed` because design rule 1 says an annotation must
 * never assert more than is known: reusing an answer silently would claim a
 * human was asked when nobody was. `comment` is a `# evalens: ...` on the
 * statement's own line, which beats a replay whenever both are available,
 * because it is the value the user wrote down. See #86.
 */
export interface InputAnswer {
  readonly value: string;
  readonly source: 'typed' | 'replay' | 'comment';
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
  /**
   * Whether `display` names a place this statement bound -- an assignment
   * target, a loop variable, a `with ... as`, the name a `def` or `import`
   * introduces -- rather than the value of a bare expression statement.
   * Present only when true, the same as `loop`'s own `constant` (#81).
   *
   * `display`'s own text says nothing about this: `led['a']` for
   * `led['a'] = 1` is exactly as much a binding as `x` is for `x = 1`, and a
   * consumer that guessed from whether `display` reads as a bare or dotted
   * identifier got that one wrong. `resolver.Form.is_binding` decides it
   * from the statement itself.
   */
  readonly is_binding?: boolean;
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
  /**
   * What the loop's body bound, or what a comprehension's `for` clauses drew
   * from their iterables; present only when there is one or the other. See
   * `BindingTrace`. A statement is never both -- a comprehension's own clause
   * traces sit here rather than in `loop`, precisely so they do not displace
   * the statement's own value the way a `for` loop's target does.
   */
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
  /** A bounded table description of `value`; see `TableWire`. */
  readonly table?: TableWire;
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
  /** Present when the file did not parse whole -- see `PartialParse`. */
  readonly partial?: PartialParse;
  /**
   * What answered each `input()` call this statement made, in order.
   * Absent when the statement read nothing, in line with every other
   * conditional field here.
   */
  readonly stdin?: readonly InputAnswer[];
}

export interface Failed {
  readonly id: number;
  readonly ok: false;
  readonly error: KernelError;
  readonly range?: Range;
  /** Where the message belongs, when that is not the end of `range`. */
  readonly anchor?: number;
  readonly kind?: string;
  /**
   * What answered each `input()` call before the statement raised. A read
   * can succeed and the statement still fail afterwards --
   * `int(input("Age: "))` on a non-numeric reply -- and what supplied the
   * value is worth keeping even though the statement did not finish.
   */
  readonly stdin?: readonly InputAnswer[];
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
  /**
   * Present when the file did not parse whole -- see `PartialParse`.
   *
   * A failure under a reduced context is where this matters most: the missing
   * lines are the likeliest reason a name is not defined, and a `NameError`
   * that does not say so sends the reader looking for a typo that is not
   * there.
   */
  readonly partial?: PartialParse;
}

/**
 * What one statement produced while a file was being loaded.
 *
 * Travels twice, deliberately: once as a `StatementFrame` the moment the
 * statement finished, and once in `FileLoaded.results` when the load is over.
 * The two are the same object rather than two renderings of it, which is what
 * makes it safe to paint whichever arrives first -- see `InOrder`, which is
 * where "whichever arrives first, exactly once, in file order" is enforced.
 */
export type StatementOutcome =
  | {
      readonly ok: true;
      readonly resolved: true;
      readonly value: string | null;
      readonly repr?: string;
      readonly display: string | null;
      /** See `Evaluated.is_binding` (#81); the same fact, the same shape. */
      readonly is_binding?: boolean;
      readonly kind: string;
      readonly range: Range;
      readonly anchor?: number;
      readonly stdout: string;
      readonly stderr: string;
      readonly loop?: LoopTrace;
      readonly bindings?: readonly BindingTrace[];
      readonly names?: readonly NamedValue[];
      readonly more_names?: number;
      readonly table?: TableWire;
      readonly binds?: readonly string[];
      readonly reads?: readonly string[];
      readonly stdin?: readonly InputAnswer[];
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
      readonly stdin?: readonly InputAnswer[];
    };

/**
 * A whole module body executed into the namespace.
 *
 * `ok` says the file could be parsed and attempted, not that every statement
 * succeeded -- a file being explored in is expected to contain broken lines,
 * and the ones that worked are in the namespace regardless. Per-statement
 * success lives in `results`.
 *
 * A line that does not *parse* is the same argument one step earlier: the file
 * loads as far as it parses and `partial` says where that stopped. `statements`
 * counts what was there to run, which under a `partial` is the prefix rather
 * than the file.
 */
export interface FileLoaded {
  readonly id: number;
  readonly ok: true;
  /**
   * How many statements the request covered -- the selection's, when narrowed,
   * and under a `partial` the selection's *within the part that parsed*.
   *
   * Those compose in that order and only that order: a selection snaps outward
   * to whole statements, and whole statements only exist in a tree. So a
   * selection lying below `partial.truncated_at` covers nothing and this is 0.
   * It is emphatically not answered by running the prefix, which would execute
   * code the user did not select.
   */
  readonly statements: number;
  readonly ran: number;
  /**
   * Every outcome, in file order, and still the authoritative record.
   *
   * Each of these was also announced as a `StatementFrame` while the load was
   * running, so a consumer painting progressively has usually seen them all by
   * the time this arrives. It is kept whole rather than trimmed to what the
   * frames did not cover, for two reasons: a caller with no control channel --
   * a test harness, an unattended script -- still gets everything in one
   * place, and a caller that does stream has something to reconcile against
   * when a frame is lost or when the response wins the race between the two
   * pipes. Painting both without reconciling is the mistake this shape makes
   * possible; `InOrder` is where it is refused.
   */
  readonly results: readonly StatementOutcome[];
  /**
   * The span actually executed, present only for a narrowed load that found
   * something to run.
   *
   * Wider than the requested lines whenever a statement was only partly
   * inside them, because a partial statement runs whole or not at all. The
   * kernel reports it because the extension cannot infer it: the side that
   * decided how far to widen is the side that knows.
   *
   * Independent of `partial`, and both may be present. This is what ran;
   * `partial.truncated_at` is where parsing stopped. A selection reaching past
   * the break has a `range` ending above it and neither number implies the
   * other.
   */
  readonly range?: Range;
  /** Present when the file did not parse whole -- see `PartialParse`. */
  readonly partial?: PartialParse;
  /**
   * #100: names the namespace holds, after this load, that nothing in the
   * file just read binds anywhere at top level -- residue an earlier load,
   * of this file or another, left behind. Present only for a whole-file
   * request (absent for a narrowed selection, where nearly the whole
   * namespace would qualify) and only when it is non-empty.
   *
   * Computed regardless of whether this load was itself preceded by a
   * reset, because the kernel is never told that it was: with #99
   * defaulting to resetting, this is usually absent, and becomes the signal
   * for whoever turned that off.
   */
  readonly residue?: readonly string[];
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

/**
 * One row of an `inspect` table -- a field, an item, or a property the
 * kernel declined to evaluate.
 *
 * `value` and `repr` follow the same convention `Evaluated` does: `value`
 * is what to show, already substituted the way `wire_value` substitutes an
 * address-shaped repr, and `repr` is the untouched original only when the
 * two differ. `null` for `value` is reserved for the one row that has
 * neither -- a property, where showing anything would mean calling it.
 *
 * `step`, present on every row but a property's, is what a further
 * `InspectRequest.path` extends with to open that row -- see `InspectStep`.
 * Its absence *is* "not expandable further"; `expandable` still carries the
 * cheaper of the two questions ("would opening this find anything") so a
 * renderer need not inspect `step`'s shape to decide whether to offer it.
 */
export interface InspectChild {
  readonly name: string;
  readonly kind: 'attr' | 'item' | 'property';
  readonly type: string;
  readonly value: string | null;
  readonly repr?: string;
  readonly expandable: boolean;
  /** `false` only for a property; absent is equivalent to `true`. */
  readonly evaluated?: boolean;
  readonly step?: InspectStep;
}

/**
 * One level of a value's children, and the value's own type and repr for
 * the row that led to it.
 *
 * `children` is never the whole of a large container -- see
 * `INSPECT_CHILD_LIMIT` in the kernel -- so `count` and `truncated` are
 * what let a renderer say "and 4,999,900 more" honestly rather than
 * silently showing a partial table as if it were complete.
 */
export interface Inspected {
  readonly id: number;
  readonly ok: true;
  readonly type: string;
  readonly value: string | null;
  readonly repr?: string;
  readonly children: readonly InspectChild[];
  readonly count: number;
  readonly truncated: boolean;
}

/**
 * A path that no longer resolves, a name that was never bound, or a `name`
 * that is not a bare identifier are all `Failed` rather than a crash --
 * see `Kernel.inspect_value`.
 */
export type InspectResponse = Inspected | Failed;

export interface Acknowledged {
  readonly id: number;
  readonly ok: true;
}

export type Response =
  EvalResponse | FileResponse | OutlineResponse | InspectResponse
  | Acknowledged;

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

/** A response read off the wire, and anything written in front of it. */
export interface SalvagedLine {
  /** Absent when nothing in the line parsed as a response object. */
  readonly response?: Response;
  /** What preceded it, which is never anything the protocol wrote. */
  readonly stray: string;
}

/** How many `{` in one line are worth trying before calling it noise. */
const SALVAGE_ATTEMPTS = 64;

/**
 * Read a response out of a line that may have something spliced in front.
 *
 * The kernel writes one response per line and writes nothing else on that
 * channel, so in a healthy session this is `JSON.parse` and nothing more. The
 * reason it is more is that descriptor 1 can still be written by something no
 * Python-level redirection reaches -- a native extension calling `printf`, a
 * subprocess or a multiprocessing worker that inherited the descriptor -- and
 * text with no trailing newline does not merely arrive as its own bad line. It
 * lands on the *front* of the next response, which parses as nothing, and a
 * correctly computed answer is destroyed by output the user cannot see.
 *
 * So the leading garbage is skipped rather than the line discarded. The suffix
 * has to parse whole and be an object, and the caller still checks the `id`
 * against what it actually sent, which is what keeps this a recovery rather
 * than a guess.
 */
export function salvageResponse(line: string): SalvagedLine {
  const whole = parseObject(line);
  if (whole) {
    return { response: whole, stray: '' };
  }
  let from = line.indexOf('{');
  for (let tries = 0; from >= 0 && tries < SALVAGE_ATTEMPTS; tries++) {
    const response = parseObject(line.slice(from));
    if (response) {
      return { response, stray: line.slice(0, from) };
    }
    from = line.indexOf('{', from + 1);
  }
  return { stray: line };
}

/** `JSON.parse`, but only a JSON object counts. `42` is not a response. */
function parseObject(text: string): Response | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Response;
    }
  } catch {
    // Not a response, or not one yet -- the caller decides what that means.
  }
  return undefined;
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
