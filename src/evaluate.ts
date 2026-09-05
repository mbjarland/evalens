import * as vscode from 'vscode';

import { OutlineCache, nextStop, outlinePlan } from './advance';
import {
  advanceSkipsComments, displayLimits, nameDisplayCap, progressDelay,
  resetOnLoad,
} from './config';
import { LoadPrompts, locatedTitle, waitingLabel } from './input';
import { describeInterrupt, settlesWithin } from './interrupt';
import { KernelClient } from './kernel/client';
import {
  EvalResponse, FileResponse, InputRequest, LatestWins, OutlineResponse,
  PartialParse, StatementOutcome, StatementSpan,
} from './kernel/protocol';
import { InOrder } from './load';
import { askForInput } from './prompt';
import { Annotations } from './render/annotations';
import { Annotation, sourceAt, toVsCodeRange } from './render/decorations';
import { Flash, SNAP } from './render/flash';
import { printedFrom } from './render/format';
import {
  describeAbove, describeLoad, describeResidue, describeRun, hoverFor,
  partialCause,
  partialOf, present,
} from './render/present';
import { capNames, PaintedAbove } from './render/repeats';
import {
  BlockedMark, Waiting, askingMessage, whileRunning,
} from './render/status';
import { selectedLines, widenedBeyond } from './selection';

/**
 * Turns a keypress into an annotation.
 *
 * The commitment implemented here rather than merely written down:
 * **evaluation is explicitly triggered, never continuous.** That is what
 * makes side effects the user's decision instead of this extension's. AREPL
 * runs continuously and consequently needs a blocklist of "unsafe keywords"
 * to guess which code is dangerous to re-run; Calva's manual trigger
 * sidesteps the whole problem. Changing this is a decision ticket, not a
 * commit.
 */
/**
 * One missing import at the top can fail every statement below it, and a long
 * file has a lot of statements. This is a guard against painting a thousand
 * annotations in one keystroke, not a considered display limit.
 *
 * Which is exactly why it is not a setting. A number offered in the settings
 * UI reads as a considered display limit whatever its description says, and a
 * user who hits this one does not want a bigger number -- they want to know
 * that their first import failed, which is what the two hundred annotations
 * above the cut already tell them. The value only has to be far past any
 * honest file and far short of a decoration count that makes the editor
 * stutter, and 200 is both.
 */
const MAX_LOAD_ANNOTATIONS = 200;

/**
 * How long a status-bar message that only acknowledges a keypress stays up.
 *
 * "Nothing under the cursor", "last statement in the file", "kernel
 * restarted": each says that the key was heard and that there was nothing to
 * paint, which is a thing the reader either catches in the second after
 * pressing it or does not need. Two seconds is long enough to be seen at the
 * bottom of the window and short enough that walking a file with Evaluate and
 * Advance does not leave a trail of them.
 *
 * Not a setting, and not for `progressDelay`'s reason. That number decides how
 * long the user waits with no feedback, so somebody genuinely has a preference
 * about it; this one runs *after* the answer, and nothing is pending while it
 * shows. Offering it would be offering to configure how long to look at
 * something that has already happened.
 */
export const STATUS_ACK_MS = 2000;

/**
 * The same, for a message carrying something to actually read.
 *
 * A load summary counts statements, failures and how much of the file parsed;
 * an interrupt says whether the kernel confirmed the stop. Both are read
 * rather than glimpsed, and both appear when the reader is looking at their
 * code rather than at the status bar -- so they get double, on the same
 * reasoning that keeps the number out of the settings UI.
 */
export const STATUS_OUTCOME_MS = 4000;

/**
 * The annotation for one loaded statement, undefined only when a failure
 * gives no range to paint on at all.
 *
 * A statement that ran always gets one, whether or not it has a value: a
 * `del` or a bare `pass` produces the same shape as `x = 5` with every
 * text-bearing field left out by the spreads below. That is not an
 * afterthought -- `Decorator.show` already paints a range with no text as a
 * highlighted region and a gutter marker and nothing else, precisely because
 * a statement that ran and a statement the load never reached must not look
 * the same (#91). Only the caller's repeat rule, and its own cap, get to take
 * the *text* back off a registered annotation; neither is licensed to make
 * the statement disappear.
 *
 * `document` is here for one field: the statement's own text, taken at the
 * moment its value was, so that a later edit can be compared against what
 * actually ran rather than guessed at. It is a snapshot and stays one --
 * nothing re-reads the buffer to decide whether a value is still true.
 */
function annotationFor(
  document: vscode.TextDocument, outcome: StatementOutcome
): Annotation | undefined {
  if (!outcome.ok) {
    return outcome.range
      ? {
          range: toVsCodeRange(outcome.range),
          ...(outcome.anchor === undefined ? {} : { anchor: outcome.anchor }),
          source: sourceAt(document, toVsCodeRange(outcome.range)),
          ...(outcome.binds === undefined ? {} : { binds: outcome.binds }),
          ...(outcome.reads === undefined ? {} : { reads: outcome.reads }),
          error: { type: outcome.error.type, message: outcome.error.message },
          hover: outcome.error.traceback || outcome.error.message,
        }
      : undefined;
  }
  const printed = printedFrom(outcome.stdout, outcome.stderr);
  return {
    range: toVsCodeRange(outcome.range),
    ...(outcome.anchor === undefined ? {} : { anchor: outcome.anchor }),
    source: sourceAt(document, toVsCodeRange(outcome.range)),
    ...(outcome.value === null ? {} : { value: outcome.value }),
    display: outcome.display,
    ...(outcome.loop === undefined ? {} : { loop: outcome.loop }),
    ...(outcome.bindings === undefined ? {} : { bindings: outcome.bindings }),
    ...(outcome.names === undefined ? {} : { names: outcome.names }),
    ...(printed === undefined ? {} : { printed }),
    ...(outcome.more_names === undefined ? {} : { more: outcome.more_names }),
    ...(outcome.binds === undefined ? {} : { binds: outcome.binds }),
    ...(outcome.reads === undefined ? {} : { reads: outcome.reads }),
    hover: hoverFor(
      outcome.display, outcome.value, outcome.repr, outcome.loop,
      outcome.names, outcome.bindings, printed
    ),
  };
}

/**
 * `annotation` with every text-bearing field stripped away, keeping only the
 * range and the trace fields a later edit needs to judge it.
 *
 * Reached from exactly one place: the repeat rule found every pair on this
 * line already painted, unchanged, above it, and nothing here printed, so
 * there is no text left to show. The statement still ran -- `annotationFor`
 * already proved that by returning something for it -- and this is what
 * keeps the region highlight and the gutter marker attached to the line
 * rather than losing them along with the text (#91).
 */
function withoutText(annotation: Annotation): Annotation {
  return {
    range: annotation.range,
    ...(annotation.anchor === undefined ? {} : { anchor: annotation.anchor }),
    ...(annotation.source === undefined ? {} : { source: annotation.source }),
    ...(annotation.binds === undefined ? {} : { binds: annotation.binds }),
    ...(annotation.reads === undefined ? {} : { reads: annotation.reads }),
  };
}

/**
 * Who is in front of the kernel, so a prompt can be attributed to a document.
 *
 * One slot, because the kernel runs one thing at a time and a prompt always
 * belongs to whatever it is running. A request that outlives its command --
 * interrupted, restarted -- finds this empty and is answered with end-of-file,
 * which is the only answer that does not leave the kernel waiting.
 */
interface Asking {
  readonly document: vscode.TextDocument;
  /**
   * The mark the keypress already put up, when there is one.
   *
   * A single evaluation has one and the prompt borrows it, so the line does
   * not briefly carry two marks. A load has none: which of its statements is
   * asking is not known until the request arrives and says.
   */
  readonly waiting?: Waiting;
  /** Prompt bookkeeping for a load; absent for a single evaluation. */
  readonly load?: LoadPrompts;
  /** Where a load's mark lives between the answer and the outcome. */
  readonly blocked?: BlockedMark;
}

/**
 * One load's painting: the suppressor, the cap, and the counts.
 *
 * It is an object because a load is no longer one pass over one array.
 * Statements arrive as they finish and the response's `results` arrives at the
 * end, and both go through here -- so what used to be three locals inside a
 * `for` loop now has to survive between two callers and several turns of the
 * event loop.
 *
 * What order they arrive in is `InOrder`'s problem rather than this class's,
 * and the separation is the point: everything below assumes it is handed
 * statements top to bottom, which is exactly what `InOrder` guarantees and
 * exactly what repeat suppression needs.
 */
class LoadPainting {
  readonly order: InOrder<StatementOutcome>;
  /**
   * What each name last had painted beside it, walking the file downward.
   *
   * Annotating every statement is what makes repetition a file's dominant
   * visual problem -- four consecutive lines calling methods on one dictionary
   * each restate it -- so a `name: value` pair already painted above,
   * unchanged, is dropped. A load starts knowing nothing, so the first mention
   * inside a selection is always painted; what stands above a selection was
   * painted by some other run, and hiding a value on the strength of an
   * annotation that may since have gone is the wrong way to be wrong.
   *
   * This is the one path that suppresses anything. `evaluateAtCursor` never
   * does, because there somebody pressed a key and is owed a visible answer
   * -- though it still caps what it shows to the same `nameDisplayCap`, since
   * the kernel's own cap is a transport bound now and no longer does that
   * job; see `capNames`.
   */
  private readonly painted = new PaintedAbove(nameDisplayCap());
  private annotated = 0;
  private failures = 0;

  constructor(
    private readonly document: vscode.TextDocument,
    private readonly annotations: Annotations
  ) {
    this.order = new InOrder((outcome) => this.paint(outcome));
  }

  /** How many of the statements reported so far failed. */
  get failed(): number {
    return this.failures;
  }

  /**
   * Show what one statement produced.
   *
   * Loading paints values: Load File exists to remove the tedium of walking
   * down a file pressing a key, and one that runs fifteen statements and shows
   * nothing has removed nothing -- the user still has to walk down the file
   * pressing a key to find out what it did.
   *
   * But a statement that ran is registered whether or not any of that text
   * survives (#91). `annotationFor` already proved it ran by returning
   * something; from here, the repeat rule and the cap only ever get to take
   * the *text* back off, never the region highlight and the gutter marker
   * that come with registering it at all -- a line the load never reached
   * must not end up looking like one it did.
   *
   * Printed output is not echoed to the channel here. It reached it as each
   * statement wrote it, and appending the captured copy afterwards would print
   * the whole load a second time.
   */
  private paint(outcome: StatementOutcome): void {
    if (!outcome.ok) {
      this.failures += 1;
    }
    if (this.annotated >= MAX_LOAD_ANNOTATIONS) {
      // Counted above regardless: the count is about what the file did, not
      // about how much of it fitted on screen.
      return;
    }
    const annotation = annotationFor(this.document, outcome);
    if (annotation === undefined) {
      // A failure with no range at all: nothing to point the region at.
      return;
    }
    const fresh = this.painted.keep(annotation);
    if (fresh) {
      this.annotations.add(this.document, fresh);
      this.annotated += 1;
      return;
    }
    // Every pair on this line was already painted, unchanged, above, and
    // nothing here printed -- so the repeat rule leaves no text. The
    // statement still ran, so it still gets its region and its marker. Not
    // counted towards the cap above: that bounds how much text one load
    // paints, and a text-less registration is not text.
    this.annotations.add(this.document, withoutText(annotation));
  }
}

/**
 * The break that reduced the context, painted where the break is.
 *
 * Two jobs in one annotation. It puts the cause on the line that caused it,
 * which is where the eye goes and where a fix is typed -- a message about line
 * 19 delivered beside line 1 sends the reader to the wrong end of the file.
 * And it is the loudest half of saying which mode answered: a red syntax error
 * on screen is why the value beside the cursor carries a caveat.
 */
function causeAnnotation(partial: PartialParse): Annotation {
  const cause = partialCause(partial);
  return {
    range: toVsCodeRange(cause.range),
    error: { type: cause.type, message: cause.message },
    hover: cause.hover,
  };
}

export class Evaluator {
  private readonly gate = new LatestWins<string>();
  private asking?: Asking;
  /**
   * The client, once one has been resolved.
   *
   * Held so that "is the kernel busy?" can be asked without awaiting the
   * handle -- the pending state has to decide what to say while an evaluation
   * is in flight, and awaiting the client there would be waiting on the very
   * thing being reported.
   */
  private connected?: KernelClient;

  /**
   * The last outline asked for, kept against the document version it came from.
   *
   * One entry, because a file is walked one at a time and an unbounded map
   * would hold every document a window ever opened. It matters because of the
   * rhythm: holding the key down while a slow statement runs must still move
   * the cursor, and a fresh outline request would queue behind that statement
   * on the request pipe and stall exactly the keypress it was meant to serve.
   * `outlinePlan` is what decides when this is trusted even though it is
   * stale, for that reason.
   */
  private outline?: OutlineCache;

  constructor(
    private readonly kernel: () => Promise<KernelClient>,
    private readonly annotations: Annotations,
    private readonly output: vscode.OutputChannel,
    private readonly flash: Flash
  ) {}

  /** What the kernel last said it was doing, or nothing if there is none. */
  private busy(): boolean {
    return this.connected?.busy ?? false;
  }

  private async client(): Promise<KernelClient> {
    this.connected = await this.kernel();
    return this.connected;
  }

  /**
   * Answer a prompt from the running code.
   *
   * The box is only half of it. The other half is the blocked line saying that
   * it is waiting and what for -- without that, a box appears at the top of
   * the window with no account of which of a hundred lines wants something,
   * and during a load the statement that asked may not even be on screen.
   *
   * Skipping is offered from the second prompt of a load onward. A file with
   * twenty prompts must not mean twenty boxes with no way out; a file with one
   * must not be asked about a problem it does not have.
   */
  async askUser(request: InputRequest): Promise<string | null> {
    const asking = this.asking;
    if (asking === undefined || asking.load?.quiet === true) {
      // Nobody attached, or the user already said not to ask again. Null is
      // end-of-file, which raises `EOFError` in the code that asked -- the
      // behaviour the kernel had before it could ask at all, kept as the way
      // out precisely so that it is always available.
      return null;
    }

    // Borrowed for a single evaluation, made fresh for a load -- and that is
    // the whole difference afterwards: a borrowed mark goes back to saying
    // what it said, a made one has to be taken away again.
    const borrowed = asking.waiting;
    const marker = borrowed ?? this.markWhereItAsked(asking.document, request);
    // Tagged rather than plain: this is the one call site that puts a
    // statement in the "your turn" state rather than the "merely slow" one,
    // and `askingMessage` is how that survives down to the paint layer.
    marker?.say(askingMessage(waitingLabel(request.prompt)));

    try {
      const answer = await askForInput(
        request, asking.load?.offerSkip === true,
        this.titleFor(asking.document, request));
      asking.load?.record(answer.kind);
      return answer.kind === 'value' ? answer.value : null;
    } finally {
      if (borrowed !== undefined) {
        // The statement is still running; only the question is over.
        borrowed.say();
      } else if (marker !== undefined && asking.blocked !== undefined) {
        // A load, and the same reasoning as the borrowed case: answering a
        // question does not finish the statement that asked it. The mark stays
        // until that statement reports, which is now a thing it does on its
        // own account rather than at the end of the file.
        asking.blocked.hold(marker);
      } else {
        marker?.withdraw();
      }
    }
  }

  /**
   * The box's title, when the kernel said where the asking statement is.
   *
   * `undefined` for the same reason `markWhereItAsked` declines to guess: a
   * kernel too old to send `range` has given nothing honest to point at, and
   * `askForInput` falls back to the bare extension name on its own.
   *
   * The line quoted is the anchor when the statement has one -- a compound
   * statement's `input()` sits inside its body, and the header is what the
   * reader recognises -- and otherwise the end of `range`, the same choice
   * `Decorator` makes for where a value is written.
   */
  private titleFor(
    document: vscode.TextDocument, request: InputRequest
  ): string | undefined {
    if (request.range === undefined) {
      return undefined;
    }
    const line = request.anchor ?? request.range.end.line;
    return locatedTitle(line, document.lineAt(line).text.trim());
  }

  /**
   * Mark the statement that asked, and bring the reader to it.
   *
   * Revealing is not a nicety. During a load the prompt can come from a
   * statement fifty lines below the viewport, and a box asking for a value
   * with no visible line behind it is a question about code the reader cannot
   * see.
   */
  private markWhereItAsked(
    document: vscode.TextDocument, request: InputRequest
  ): Waiting | undefined {
    if (request.range === undefined) {
      // A kernel too old to say where it is. Guessing a line would put a mark
      // beside code that is not blocked, which is worse than the box alone.
      return undefined;
    }
    const range = toVsCodeRange(request.range);
    const marker = this.annotations.pending(document, range, request.anchor);
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === document) {
        editor.revealRange(
          range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    }
    return marker;
  }

  /**
   * Stop whatever the kernel is running.
   *
   * One implementation behind both ways in -- the Cancel button on the
   * progress notification and the `Evalens: Interrupt Evaluation` command --
   * so that a user who dismissed the notification and reached for the palette
   * gets the same thing, and neither path can drift into doing something the
   * other does not.
   */
  async interrupt(): Promise<void> {
    let outcome;
    try {
      outcome = await (await this.client()).interrupt();
    } catch (error) {
      // No usable interpreter, so no kernel and nothing running. Interrupting
      // is not the moment to relitigate that.
      this.output.appendLine(
        error instanceof Error ? error.message : String(error));
      return;
    }
    const message = describeInterrupt(outcome);
    if (outcome === 'unconfirmed') {
      // A kernel that did not answer is not a status-bar fact. It is the one
      // case where the user has to decide something -- wait, or restart and
      // lose the namespace -- so it goes somewhere they will read it.
      void vscode.window.showWarningMessage(message);
    } else {
      vscode.window.setStatusBarMessage(message, STATUS_OUTCOME_MS);
    }
  }

  /**
   * Await `work`, offering a way to stop it once it has proved slow.
   *
   * The notification is deliberately late. Nearly every evaluation finishes in
   * milliseconds, and one that popped a notification each time would make the
   * feature unusable -- so nothing appears until an evaluation has already
   * failed to finish, which is exactly the moment the extension otherwise
   * looks like it ignored the keypress.
   */
  private async watch<T>(work: Promise<T>, title: string): Promise<T> {
    if (await settlesWithin(work, progressDelay())) {
      return work;
    }
    void vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: true,
      },
      (_progress, token) => {
        token.onCancellationRequested(() => void this.interrupt());
        // The notification lives exactly as long as the work does, however it
        // ends. The caller does the reporting; swallowing here only keeps this
        // second reference to the promise from raising on its own.
        return work.then(() => undefined, () => undefined);
      }
    );
    return work;
  }

  /**
   * Load the file into the namespace, the way a session starts -- or, with a
   * selection, run only the statements the selection touches.
   *
   * This is Calva's Load File, and `eval-region` alongside it rather than in
   * place of it: no selection keeps the whole-file behaviour exactly. What a
   * selection changes is only *how much* runs. Every statement it does run is
   * run and annotated identically, because the two are the same command
   * pointed at a different amount of code, and a selection that quietly
   * evaluated differently would be a second set of semantics to learn.
   *
   * A selection is not resolved to an expression here. That is
   * `Ctrl/Cmd+Enter`'s question -- "what is this worth" -- and this key asks
   * "run this part of my file"; blurring them would make the answer depend on
   * which key the user happened to reach for.
   *
   * **The file paints as it runs.** Each statement's value appears when that
   * statement finishes rather than when the file does, which matters most in
   * the case that used to be worst: a load that stops on `input()` at line 47
   * had run lines 1-46, had their values, and showed none of them -- so the
   * reader was asked to type something into a program whose behaviour so far
   * was invisible. Painting as it goes also removes the "did the key work?"
   * silence from a slow load, at file scale.
   *
   * `options.asScript` is Evalens: Run File as Script (#78): the same command
   * with `__name__` bound to `"__main__"` for the run instead of the file's
   * own name, so an `if __name__ == "__main__":` guard fires and its body
   * runs. A selection is a different question -- "run this part of my file"
   * -- that a script run does not ask, so it is ignored here: this always
   * runs the whole file, the way `python3 <file>` would.
   *
   * **A whole-file run resets the namespace first**, per `evalens.resetOnLoad`
   * (#99), because a namespace carrying a binding this file no longer makes
   * is the exact trap `docs/development/namespace-reset.md` records -- one
   * that crosses file boundaries, not only reloads of the same file. A
   * script run resets unconditionally, whatever the setting says: it exists
   * to answer whether the file matches `python3 <file>`, and a namespace
   * left over from an earlier run makes that comparison meaningless. A
   * selection never resets, regardless of either: resetting and then
   * running three lines would leave everything above them unbound, which is
   * worse than doing nothing. The reset is a separate, awaited request
   * ahead of `eval_file` rather than a flag on it -- the kernel processes
   * its stdin one line at a time, so awaiting the reset's own response is
   * what guarantees it lands first.
   */
  async evaluateFile(
    editor: vscode.TextEditor, options?: { readonly asScript?: boolean }
  ): Promise<void> {
    const asScript = options?.asScript ?? false;
    const document = editor.document;
    const selection = editor.selection;
    const lines = asScript ? undefined : selectedLines(selection);
    // See the doc comment above: a selection never resets, a script run
    // always does, and an ordinary whole-file load follows the setting.
    const shouldReset = lines === undefined && (asScript || resetOnLoad());
    let response: FileResponse;
    // The load's paint state, built before the request because the first
    // statement can report before the await has yielded once.
    const load = new LoadPainting(document, this.annotations);
    const blocked = new BlockedMark();
    // Set before the request, for the same reason.
    this.asking = { document, load: new LoadPrompts(), blocked };
    try {
      const client = await this.client();
      if (shouldReset) {
        // Awaited on its own, not raced with `eval_file`: the kernel reads
        // its stdin one request at a time, so the response settling is what
        // proves the namespace was empty before the load below started
        // filling it back in. This also clears #86's input-replay store --
        // `Kernel.reset` already does that as part of clearing the
        // namespace -- so nothing further is needed to keep that state in
        // step with this one.
        await client.request({ op: 'reset' });
      }
      const running = client.request(
        {
          op: 'eval_file',
          source: document.getText(),
          filename: document.uri.fsPath,
          // A load asks. It used to refuse, citing the flag Jupyter sets false
          // for `nbconvert` -- but that runs unattended, and this is somebody
          // pressing a key and waiting. Refusing painted a red `EOFError` on
          // the prompt line and a cascade of `NameError` under it, on exactly
          // the teaching files this command exists to set up. Twenty prompts
          // is still too many, which is what "skip the rest" is for. A
          // selection is the same command over less code and does not change
          // that either.
          allow_stdin: true,
          // The whole buffer either way, with the selection sent as a line
          // range rather than as the selected text: the kernel needs the file
          // around the selection to snap outward to whole statements, and to
          // keep every line number it reports pointing at the real file.
          ...(lines ?? {}),
          // Only present when true: absent is what every load before #78 sent,
          // and the kernel reads it with `bool(request.get("as_script"))`, so
          // there is nothing this needs to be false for.
          ...(asScript ? { as_script: true } : {}),
          // Read per request, so a setting changed between two keypresses
          // applies to the second one without restarting the kernel -- which
          // would take the namespace with it.
          limits: displayLimits(),
        },
        // Each statement, the moment it finishes. It goes to the same painter
        // the response's `results` reaches, through the gate that keeps the
        // two paths from painting anything twice or out of turn.
        (frame) => {
          // Whatever was waiting has finished waiting: the kernel runs one
          // statement at a time, so this outcome is the marked statement's.
          blocked.release();
          load.order.offer(frame.index, frame.outcome);
        }
      );
      response = (await this.watch(
        running,
        asScript
          ? 'Evalens: running the file as a script'
          : lines ? 'Evalens: running the selection' : 'Evalens: loading the file'
      )) as FileResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(message);
      void vscode.window.showErrorMessage(`Evalens: ${message}`);
      // The statements that did report keep their values: they ran, and the
      // transport failing afterwards does not make them untrue.
      return;
    } finally {
      this.asking = undefined;
      // However the load ended, nothing is running any more, so nothing on
      // screen may go on saying that something is. Here rather than beside
      // each exit because the last statement may have prompted and then
      // produced nothing to paint over its own mark, which is the case a
      // release on the success path alone would miss.
      blocked.release();
    }

    if (!response.ok) {
      // Only a syntax error reaches here: nothing could run, so there is
      // nothing partial to report.
      void vscode.window.showErrorMessage(
        `Evalens: ${response.error.type}: ${response.error.message}`);
      if (response.range) {
        this.annotations.add(document, {
          range: toVsCodeRange(response.range),
          source: sourceAt(document, toVsCodeRange(response.range)),
          error: { type: response.error.type, message: response.error.message },
          hover: response.error.traceback || response.error.message,
        });
      }
      return;
    }

    if (response.partial) {
      // #25 settled that a broken line must not stop a load; a line that does
      // not parse is the same argument one step earlier. The prefix is in the
      // namespace, and the part that is not is painted where it is rather
      // than thrown away with the load.
      //
      // Painted before the empty-selection return below, not after it. That
      // case is the one that most needs the reason on screen: a selection
      // below the break matches nothing in the part that parsed, so it runs
      // nothing, and the break is the whole explanation for a count of zero.
      this.annotations.add(document, causeAnnotation(response.partial));
    }

    if (lines && response.statements === 0) {
      // A selection holding only comments, or only blank lines -- or one
      // lying below the line the file stops parsing at. Not an error: it is
      // the same answer a blank line under the cursor gets, said in the same
      // place, and reaching for the nearest statement instead would run code
      // nobody pointed at. Nor is it a reason to fall back to the prefix,
      // which is code nobody pointed at with a tempting amount of it.
      vscode.window.setStatusBarMessage(
        describeRun(0, 0, 0, false, response.partial?.truncated_at),
        STATUS_ACK_MS);
      return;
    }

    // Everything the frames did not deliver, which on a kernel with no control
    // channel is the whole file and on a healthy one is usually nothing. The
    // gate is what makes calling this unconditionally safe: it starts where the
    // frames stopped, so no statement is painted twice and none is skipped.
    load.order.settle(response.results);

    if (lines) {
      // A statement runs whole or not at all, so the run may have reached
      // outside the highlight. Saying the count without saying that would let
      // the reader attribute it to the lines they chose.
      const executed = response.range;
      const widened = executed !== undefined
        && widenedBeyond(executed, selection);
      if (widened) {
        // Pointing at it costs a decoration and says in one look what a
        // sentence about line numbers says slowly. The same `Flash` the
        // success emphasis uses, in the evaluated-region colour and for far
        // longer: one mechanism, so the two cannot expire on each other.
        this.flash.show([editor], [toVsCodeRange(executed)], SNAP);
      }
      vscode.window.setStatusBarMessage(
        describeRun(response.ran, response.statements, load.failed, widened,
          response.partial?.truncated_at), STATUS_OUTCOME_MS);
      return;
    }

    const summary = describeLoad(response.ran, response.statements,
      load.failed, response.partial?.truncated_at, asScript);
    // #100: the signal for whoever turned #99's reset off. Gated on the same
    // two facts the kernel cannot know about its own caller -- a script run
    // was just unconditionally reset, and an ordinary load was reset unless
    // the setting says otherwise -- rather than on `response.residue` alone,
    // because a namespace that was just cleared reporting a name some
    // untracked dynamic write left behind is not "an earlier session", and
    // would read as one.
    const message = !asScript && !resetOnLoad()
      && response.residue && response.residue.length > 0
      ? `${summary}; ${describeResidue(response.residue)}`
      : summary;
    vscode.window.setStatusBarMessage(message, STATUS_OUTCOME_MS);
  }

  /**
   * Run everything above the cursor into the namespace, and stop there (#13).
   *
   * Evaluating a line needs whatever names it uses to already be bound, and
   * getting there one statement at a time is the tedium this removes. It is
   * deliberately not what Evaluate File is for: a load runs the *whole*
   * file, including the statement the cursor is sitting in and everything
   * below it, and it keeps going after a broken line because a file being
   * explored is expected to have one. Neither is true of what this command
   * is for -- getting the namespace ready for one specific statement -- so
   * it stops exactly at that statement's boundary and stops for good the
   * moment anything above it fails, rather than building a namespace on top
   * of a line nobody can vouch for.
   *
   * "Above the cursor" is resolved on the kernel side, in `evaluate_above`:
   * the boundary is the top-level statement the cursor is in, or would be in
   * -- see that method's docstring for why a cursor inside a multi-line
   * statement is exactly what forces that choice. The statement at the
   * boundary is never run here; it is what Evaluate at Cursor answers for.
   *
   * The namespace is reset first, unconditionally, on the kernel side. This
   * command's entire premise is that the namespace afterward matches what
   * running the file from the top through the cursor would have produced,
   * and a binding left over from an earlier keypress would quietly break
   * that premise -- see `evaluate_above`'s docstring for the full argument
   * and its relationship to #99.
   *
   * Painted exactly like a load: each statement's value appears as it
   * finishes (`LoadPainting`, `InOrder`), which is what lets the reader see
   * lines 1-11 settle before line 12 turns out to be the one that fails.
   */
  async evaluateAbove(editor: vscode.TextEditor): Promise<void> {
    const document = editor.document;
    const line = editor.selection.active.line;
    let response: FileResponse;
    // Built before the request, for the same reason `evaluateFile` builds
    // its painting state first: the first statement can report before the
    // `await` below has yielded even once.
    const load = new LoadPainting(document, this.annotations);
    const blocked = new BlockedMark();
    this.asking = { document, load: new LoadPrompts(), blocked };
    try {
      const client = await this.client();
      const running = client.request(
        {
          op: 'eval_above',
          source: document.getText(),
          filename: document.uri.fsPath,
          line,
          // Same reasoning as Evaluate File: somebody pressed a key and is
          // watching, so refusing to prompt only trades a visible question
          // for a red `EOFError` and the cascade of `NameError` beneath it.
          allow_stdin: true,
          limits: displayLimits(),
        },
        (frame) => {
          blocked.release();
          load.order.offer(frame.index, frame.outcome);
        }
      );
      response = (await this.watch(
        running, 'Evalens: running everything above the cursor'
      )) as FileResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(message);
      void vscode.window.showErrorMessage(`Evalens: ${message}`);
      return;
    } finally {
      this.asking = undefined;
      blocked.release();
    }

    if (!response.ok) {
      // Only a syntax error reaches here: nothing could even be resolved
      // against the tree, so there is nothing partial to report either.
      void vscode.window.showErrorMessage(
        `Evalens: ${response.error.type}: ${response.error.message}`);
      if (response.range) {
        this.annotations.add(document, {
          range: toVsCodeRange(response.range),
          source: sourceAt(document, toVsCodeRange(response.range)),
          error: { type: response.error.type, message: response.error.message },
          hover: response.error.traceback || response.error.message,
        });
      }
      return;
    }

    if (response.partial) {
      // A break below the boundary the cursor implied: the prefix above it
      // still ran, and this is why the reader may see fewer statements than
      // the file appears to have.
      this.annotations.add(document, causeAnnotation(response.partial));
    }

    load.order.settle(response.results);

    vscode.window.setStatusBarMessage(
      describeAbove(response.ran, response.statements, load.failed,
        response.partial?.truncated_at), STATUS_OUTCOME_MS);
  }

  /**
   * Evaluate the statement under the cursor, visibly.
   *
   * "Visibly" is not decoration. Since loading a file paints every value,
   * pressing this key on an already-annotated line repaints an identical
   * string -- nothing changes on screen, and the key reads as dead. It cost
   * three rounds of diagnosis before it was clear that the command had been
   * running correctly the whole time and simply left no evidence.
   *
   * So the line is marked *before* the kernel is asked, and the answer arrives
   * with a brief emphasis on the range. Both halves are needed: marking on the
   * response would give the fast path -- almost every evaluation -- no
   * transition at all, and a permanent success colour says nothing in a file
   * where every line already carries a value.
   *
   * `at` is where the cursor was when the key was pressed, for the caller that
   * is about to move it. Evaluate and Advance dispatches this and then steps
   * on without waiting, so "the cursor" has already changed by the time the
   * kernel answers; passing the position makes that explicit rather than
   * resting on this method reading `selection` before its first `await`.
   */
  async evaluateAtCursor(
    editor: vscode.TextEditor, at?: vscode.Position
  ): Promise<void> {
    const document = editor.document;
    const cursor = at ?? editor.selection.active;
    // Keyed by line as well as document. Two presses on one line race, and the
    // newer one is the answer -- but two presses on different lines are not
    // competitors at all: they annotate different statements, and Evaluate and
    // Advance dispatches exactly that in a stream. Keyed by document alone, a
    // walk held down over a slow file would discard every annotation but the
    // last one, which is the feature failing quietly.
    const key = `${document.uri.toString()}#${cursor.line}`;
    const token = this.gate.claim(key);

    let run;
    try {
      run = await whileRunning(
        // Synchronous, and first. Resolving an interpreter and spawning it is
        // itself slow the first time round, so a mark applied after the client
        // handle was obtained would miss the evaluation that needs it most.
        () => this.annotations.pending(
          document, new vscode.Range(cursor.line, 0, cursor.line, 0)),
        async (waiting) => {
          // The mark goes to the prompt handler rather than a second one being
          // made: the line the cursor is on is inside the statement that is
          // blocked, so it is already the right line to say so on.
          this.asking = { document, waiting };
          try {
            const client = await this.client();
            return (await this.watch(
              client.request({
                op: 'eval',
                source: document.getText(),
                line: cursor.line,
                character: cursor.character,
                filename: document.uri.fsPath,
                // Somebody pressed a key and is sitting there waiting for this
                // line to answer, so `input()` is a conversation, not a hang.
                allow_stdin: true,
                // Read per request, so a setting changed between two
                // keypresses applies to the second one without restarting the
                // kernel -- which would take the namespace with it.
                limits: displayLimits(),
              }),
              'Evalens: evaluating'
            )) as EvalResponse;
          } finally {
            this.asking = undefined;
          }
        },
        { busy: () => this.busy() }
      );
    } catch (error) {
      // A transport failure is about the extension, not the user's code, so
      // it does not belong painted next to their line. The mark is already
      // gone: `whileRunning` withdraws it rather than leaving a line claiming
      // to be running something that blew up.
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(message);
      void vscode.window.showErrorMessage(`Evalens: ${message}`);
      return;
    }

    const response = run.value;
    if (!this.gate.isCurrent(key, token)) {
      // A newer evaluation has already claimed this line. Painting this one
      // would leave a value beside code it did not come from -- and its mark
      // belongs to nothing now either.
      run.waiting.withdraw();
      return;
    }

    // Read off the response rather than the presentation: the break belongs to
    // the file, not to this keypress, so it is painted even when the cursor
    // resolved to nothing. Before the answer, so that if the two ever landed
    // on one line the value the user asked for is what survives `merge`.
    const partial = partialOf(response);
    if (partial) {
      this.annotations.add(document, causeAnnotation(partial));
    }

    const evaluated = present(response, cursor.line);
    if (evaluated.kind === 'nothing') {
      // A blank line. Nothing is going to replace the mark, so it goes.
      run.waiting.withdraw();
      vscode.window.setStatusBarMessage(evaluated.message, STATUS_ACK_MS);
      return;
    }
    // The kernel's own cap is a transport bound now, generous enough that a
    // single line rarely reaches it -- see `NAME_LIMIT` in
    // `evalens_kernel.py`. Capping to what the setting actually asks for is
    // this side's job, same as it is for a bulk load; the difference is that
    // nothing is suppressed first, because nobody's `PaintedAbove` runs over
    // a single keypress.
    const presentation = evaluated.kind === 'value'
      ? capNames(evaluated, nameDisplayCap())
      : evaluated;

    const annotation: Annotation =
      presentation.kind === 'error'
        ? {
            range: toVsCodeRange(presentation.range),
            ...(presentation.anchor === undefined
              ? {}
              : { anchor: presentation.anchor }),
            // Taken now, beside the value, so an edit can be judged against
            // the code that actually ran rather than against the buffer.
            source: sourceAt(document, toVsCodeRange(presentation.range)),
            ...(presentation.binds === undefined
              ? {}
              : { binds: presentation.binds }),
            ...(presentation.reads === undefined
              ? {}
              : { reads: presentation.reads }),
            error: { type: presentation.type, message: presentation.message },
            hover: presentation.hover,
            ...(partial === undefined
              ? {}
              : { partialFrom: partial.truncated_at }),
          }
        : {
            range: toVsCodeRange(presentation.range),
            ...(presentation.anchor === undefined
              ? {}
              : { anchor: presentation.anchor }),
            source: sourceAt(document, toVsCodeRange(presentation.range)),
            display: presentation.display,
            // A loop that ran zero times has a trace and no value, which is
            // still an answer -- and the only thing that keeps the previous
            // run's value from standing as this one's.
            ...(presentation.value === null
              ? {}
              : { value: presentation.value }),
            ...(presentation.loop === undefined
              ? {}
              : { loop: presentation.loop }),
            ...(presentation.bindings === undefined
              ? {}
              : { bindings: presentation.bindings }),
            ...(presentation.names === undefined
              ? {}
              : { names: presentation.names }),
            // What the line printed, which for a `print` is the answer and
            // the reason the user pressed the key. It reached the output
            // channel live as the kernel produced it; this is the same text
            // arriving where the reader is already looking.
            ...(presentation.printed === undefined
              ? {}
              : { printed: presentation.printed }),
            ...(presentation.more === undefined
              ? {}
              : { more: presentation.more }),
            ...(presentation.binds === undefined
              ? {}
              : { binds: presentation.binds }),
            ...(presentation.reads === undefined
              ? {}
              : { reads: presentation.reads }),
            ...(presentation.hover ? { hover: presentation.hover } : {}),
            ...(partial === undefined
              ? {}
              : { partialFrom: partial.truncated_at }),
          };

    // Withdrawn rather than left to be displaced by overlap: the mark sits on
    // the cursor's line and the answer's range is whatever statement that
    // landed in, and relying on those two to coincide is a bug waiting for
    // the first statement whose range does not cover the cursor.
    run.waiting.withdraw();
    // Painted regardless of what stands above it. An explicit evaluation
    // always shows its result: staying silent because the value has not
    // changed since a line further up is indistinguishable from the keypress
    // being ignored, which is a failure this project has already shipped. The
    // repeat rule belongs to bulk annotation, where nobody is waiting on any
    // one line.
    this.annotations.settle(document, annotation);
  }

  /**
   * Evaluate the statement under the cursor, then step to the next one.
   *
   * The second of two commands rather than a change to the first, because both
   * behaviours are wanted and they are wanted at different moments. Staying put
   * is right while iterating on one statement -- edit, re-run, edit, re-run.
   * Advancing is right while reading a file you did not write, which is the
   * case this project is aimed at: a worked example walked one statement at a
   * time with the values appearing as you go. Jupyter, Spyder, MATLAB and VS
   * Code's own Interactive Window all ship the pair.
   *
   * The cursor moves as soon as the evaluation is **dispatched**, not when it
   * comes back. Waiting would mean a statement that takes two seconds holds the
   * cursor for two seconds, and holding the key down would silently drop the
   * presses that arrived meanwhile -- the rhythm this command exists for is the
   * first thing a slow statement would break.
   */
  async evaluateAndAdvance(editor: vscode.TextEditor): Promise<void> {
    const document = editor.document;
    const cursor = editor.selection.active;
    const statements = await this.statementsOf(document);
    const stop = statements
      ? nextStop(
          statements,
          cursor.line,
          (line) => document.lineAt(line).text,
          !advanceSkipsComments())
      : undefined;

    const evaluation = this.evaluateAtCursor(editor, cursor);

    // No stop at all means the file does not parse, so there is no next
    // statement to speak of. The evaluation reports the syntax error; moving
    // the cursor on a guess would be the one unhelpful thing left to add.
    if (stop?.kind === 'end') {
      // Said out loud, because "the key did nothing" and "there is nothing
      // after this" look identical from the keyboard.
      vscode.window.setStatusBarMessage(
        'Evalens: last statement in the file', STATUS_ACK_MS);
    } else if (stop?.kind === 'move') {
      const position = new vscode.Position(
        stop.position.line, stop.position.character);
      editor.selection = new vscode.Selection(position, position);
      // Only when it is off screen, and then centred: stepping past the fold
      // has to scroll, and a statement already in view must not jump.
      //
      // The audit looked at making this a setting and did not, because the
      // three alternatives VS Code offers are each wrong in a way a user would
      // report as a bug rather than adjust. `InCenter` scrolls on every press,
      // so a file that fits on screen jumps under the reader anyway.
      // `Default` scrolls the minimum, which lands the next statement on the
      // bottom edge with none of the code it is about to run visible below it.
      // `AtTop` puts it at the top with the file just walked out of sight.
      // This one is the only value that is right in both directions, and the
      // same one marks where a `input()` prompt is waiting -- a setting would
      // have to govern both or let them disagree about the same question.
      editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    await evaluation;
  }

  /**
   * Every top-level statement in `document`, as the kernel's parser sees them.
   *
   * `undefined` when the file does not parse, the kernel cannot be reached, or
   * nothing safe can be asked right now -- see `outlinePlan`. All three are
   * the evaluation's business to report, and none of them is a reason for
   * this to raise on a keypress.
   */
  private async statementsOf(
    document: vscode.TextDocument
  ): Promise<readonly StatementSpan[] | undefined> {
    const key = document.uri.toString();
    const plan = outlinePlan(this.outline, key, document.version, this.busy());
    if (plan.kind === 'cached') {
      return plan.statements;
    }
    if (plan.kind === 'unknown') {
      // The kernel is busy with a statement dispatched earlier and nothing
      // has ever been outlined for this document, so there is nothing to ask
      // for and nothing to fall back to. Asking anyway would queue behind
      // whatever the kernel is doing -- #90's hang -- for a request whose
      // answer would not even be trustworthy once it arrived.
      return undefined;
    }

    let response: OutlineResponse;
    try {
      const client = await this.kernel();
      response = (await client.request({
        op: 'outline',
        source: document.getText(),
        filename: document.uri.fsPath,
      })) as OutlineResponse;
    } catch {
      // Whatever went wrong reaching the kernel, the evaluation dispatched a
      // moment from now runs into it too and reports it properly. Saying it
      // twice in the output channel is how a log stops being read.
      return undefined;
    }
    if (!response.ok) {
      // A syntax error, and the only failure this op has. Same reasoning: the
      // evaluation paints it where the user can see it.
      return undefined;
    }

    this.outline = {
      key, version: document.version, statements: response.statements,
    };
    return response.statements;
  }
}
