import * as vscode from 'vscode';

import { nextStop } from './advance';
import { advanceSkipsComments, progressDelay } from './config';
import { LoadPrompts, waitingLabel } from './input';
import { describeInterrupt, settlesWithin } from './interrupt';
import { KernelClient } from './kernel/client';
import {
  EvalResponse, FileResponse, InputRequest, LatestWins, OutlineResponse,
  PartialParse, StatementOutcome, StatementSpan,
} from './kernel/protocol';
import { askForInput } from './prompt';
import { Annotations } from './render/annotations';
import { Annotation, sourceAt, toVsCodeRange } from './render/decorations';
import { Flash, SNAP } from './render/flash';
import { hasOutput, printedFrom } from './render/format';
import {
  describeLoad, describeRun, hoverFor, partialCause, partialOf, present,
} from './render/present';
import { PaintedAbove } from './render/repeats';
import { Waiting, whileRunning } from './render/status';
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
 */
const MAX_LOAD_ANNOTATIONS = 200;

/**
 * The annotation for one loaded statement, or none if it has nothing to say.
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
  if (outcome.value === null && outcome.loop === undefined
      && !outcome.names?.length && !hasOutput(printed)) {
    // It ran; a `del` or a bare `pass` simply has no value to report. A loop
    // that ran zero times is one exception -- no value, and still an answer --
    // and so is any statement whose names have something to say, or that
    // printed: a `while` has no target to point at and its output is the
    // whole of what it had to show.
    return undefined;
  }
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
   */
  private outline?: {
    readonly key: string;
    readonly version: number;
    readonly statements: readonly StatementSpan[];
  };

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
    marker?.say(waitingLabel(request.prompt));

    try {
      const answer = await askForInput(request, asking.load?.offerSkip === true);
      asking.load?.record(answer.kind);
      return answer.kind === 'value' ? answer.value : null;
    } finally {
      if (borrowed !== undefined) {
        // The statement is still running; only the question is over.
        borrowed.say();
      } else {
        marker?.withdraw();
      }
    }
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
      vscode.window.setStatusBarMessage(message, 4000);
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
   */
  async evaluateFile(editor: vscode.TextEditor): Promise<void> {
    const document = editor.document;
    const selection = editor.selection;
    const lines = selectedLines(selection);
    let response: FileResponse;
    // Set before the request, because the first prompt can arrive before the
    // await has even yielded once.
    this.asking = { document, load: new LoadPrompts() };
    try {
      const client = await this.client();
      response = (await this.watch(
        client.request({
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
        }),
        lines ? 'Evalens: running the selection' : 'Evalens: loading the file'
      )) as FileResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(message);
      void vscode.window.showErrorMessage(`Evalens: ${message}`);
      return;
    } finally {
      this.asking = undefined;
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
        describeRun(0, 0, 0, false, response.partial?.truncated_at), 2000);
      return;
    }

    // Loading paints values. Load File exists to remove the tedium of
    // walking down a file pressing a key; if it runs fifteen statements and
    // shows nothing, the user has to walk down the file pressing a key to
    // find out what it did, and the command has removed nothing.
    // Printed output is not echoed here any more: it already reached the
    // output channel as each statement wrote it, and appending the captured
    // copy afterwards would print the whole load a second time.
    //
    // Annotating every statement is also what makes repetition the file's
    // dominant visual problem: four consecutive lines calling methods on one
    // dictionary each restate it. So a pair already painted above, unchanged,
    // is dropped here -- in file order, which is the direction the reader's
    // eye travels to find it. A run starts knowing nothing, so the first
    // mention inside a selection is always painted; what stands above a
    // selection was painted by some other run, and hiding a value on the
    // strength of an annotation that may since have gone is the wrong way to
    // be wrong.
    //
    // This is the one path that suppresses anything. `evaluateAtCursor` never
    // does, because there somebody pressed a key and is owed a visible answer.
    let failed = 0;
    let annotated = 0;
    const painted = new PaintedAbove();
    for (const outcome of response.results) {
      if (!outcome.ok) {
        failed += 1;
      }
      if (annotated >= MAX_LOAD_ANNOTATIONS) {
        continue;
      }
      const annotation = annotationFor(document, outcome);
      const fresh = annotation === undefined
        ? undefined
        : painted.keep(annotation);
      if (fresh) {
        this.annotations.add(document, fresh);
        annotated += 1;
      }
    }

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
        describeRun(response.ran, response.statements, failed, widened,
          response.partial?.truncated_at), 4000);
      return;
    }

    vscode.window.setStatusBarMessage(
      describeLoad(response.ran, response.statements, failed,
        response.partial?.truncated_at), 4000);
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

    const presentation = present(response, cursor.line);
    if (presentation.kind === 'nothing') {
      // A blank line. Nothing is going to replace the mark, so it goes.
      run.waiting.withdraw();
      vscode.window.setStatusBarMessage(presentation.message, 2000);
      return;
    }

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
        'Evalens: last statement in the file', 2000);
    } else if (stop?.kind === 'move') {
      const position = new vscode.Position(
        stop.position.line, stop.position.character);
      editor.selection = new vscode.Selection(position, position);
      // Only when it is off screen, and then centred: stepping past the fold
      // has to scroll, and a statement already in view must not jump.
      editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    await evaluation;
  }

  /**
   * Every top-level statement in `document`, as the kernel's parser sees them.
   *
   * `undefined` when the file does not parse or the kernel cannot be reached;
   * both are the evaluation's business to report, and neither is a reason for
   * this to raise on a keypress.
   */
  private async statementsOf(
    document: vscode.TextDocument
  ): Promise<readonly StatementSpan[] | undefined> {
    const key = document.uri.toString();
    if (this.outline?.key === key && this.outline.version === document.version) {
      return this.outline.statements;
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
