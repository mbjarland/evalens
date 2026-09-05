import * as vscode from 'vscode';

import { progressDelay } from './config';
import { describeInterrupt, settlesWithin } from './interrupt';
import { KernelClient } from './kernel/client';
import {
  EvalResponse, FileResponse, LatestWins, StatementOutcome,
} from './kernel/protocol';
import { Annotations } from './render/annotations';
import { Annotation, toVsCodeRange } from './render/decorations';
import { describeLoad, hoverFor, present } from './render/present';

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

/** The annotation for one loaded statement, or none if it has nothing to say. */
function annotationFor(outcome: StatementOutcome): Annotation | undefined {
  if (!outcome.ok) {
    return outcome.range
      ? {
          range: toVsCodeRange(outcome.range),
          ...(outcome.anchor === undefined ? {} : { anchor: outcome.anchor }),
          error: { type: outcome.error.type, message: outcome.error.message },
          hover: outcome.error.traceback || outcome.error.message,
        }
      : undefined;
  }
  if (outcome.value === null && outcome.loop === undefined
      && !outcome.names?.length) {
    // It ran; a `del` or a bare `pass` simply has no value to report. A loop
    // that ran zero times is one exception -- no value, and still an answer --
    // and so is any statement whose names have something to say.
    return undefined;
  }
  return {
    range: toVsCodeRange(outcome.range),
    ...(outcome.anchor === undefined ? {} : { anchor: outcome.anchor }),
    ...(outcome.value === null ? {} : { value: outcome.value }),
    display: outcome.display,
    ...(outcome.loop === undefined ? {} : { loop: outcome.loop }),
    ...(outcome.names === undefined ? {} : { names: outcome.names }),
    hover: hoverFor(
      outcome.display, outcome.value, outcome.repr, outcome.loop, outcome.names
    ),
  };
}

export class Evaluator {
  private readonly gate = new LatestWins<string>();

  constructor(
    private readonly kernel: () => Promise<KernelClient>,
    private readonly annotations: Annotations,
    private readonly output: vscode.OutputChannel
  ) {}

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
      outcome = await (await this.kernel()).interrupt();
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
   * Load the whole file into the namespace, the way a session starts.
   *
   * This is Calva's Load File. It reports rather than annotates: loading is
   * "get me set up", not "show me the work" -- keeping those distinct is
   * what stops a 400-line file painting 400 annotations. #13 is the command
   * that shows the work.
   */
  async evaluateFile(editor: vscode.TextEditor): Promise<void> {
    const document = editor.document;
    let response: FileResponse;
    try {
      const client = await this.kernel();
      response = (await this.watch(
        client.request({
          op: 'eval_file',
          source: document.getText(),
          filename: document.uri.fsPath,
        }),
        'Evalens: loading the file'
      )) as FileResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(message);
      void vscode.window.showErrorMessage(`Evalens: ${message}`);
      return;
    }

    if (!response.ok) {
      // Only a syntax error reaches here: nothing could run, so there is
      // nothing partial to report.
      void vscode.window.showErrorMessage(
        `Evalens: ${response.error.type}: ${response.error.message}`);
      if (response.range) {
        this.annotations.add(document, {
          range: toVsCodeRange(response.range),
          error: { type: response.error.type, message: response.error.message },
          hover: response.error.traceback || response.error.message,
        });
      }
      return;
    }

    // Loading paints values. Load File exists to remove the tedium of
    // walking down a file pressing a key; if it runs fifteen statements and
    // shows nothing, the user has to walk down the file pressing a key to
    // find out what it did, and the command has removed nothing.
    let failed = 0;
    let annotated = 0;
    for (const outcome of response.results) {
      if (outcome.stdout) {
        this.output.append(outcome.stdout);
      }
      if (!outcome.ok) {
        failed += 1;
      }
      if (annotated >= MAX_LOAD_ANNOTATIONS) {
        continue;
      }
      const annotation = annotationFor(outcome);
      if (annotation) {
        this.annotations.add(document, annotation);
        annotated += 1;
      }
    }

    vscode.window.setStatusBarMessage(
      describeLoad(response.ran, response.statements, failed), 4000);
  }

  async evaluateAtCursor(editor: vscode.TextEditor): Promise<void> {
    const document = editor.document;
    const cursor = editor.selection.active;
    const key = document.uri.toString();
    const token = this.gate.claim(key);

    let response: EvalResponse;
    try {
      const client = await this.kernel();
      response = (await this.watch(
        client.request({
          op: 'eval',
          source: document.getText(),
          line: cursor.line,
          character: cursor.character,
          filename: document.uri.fsPath,
        }),
        'Evalens: evaluating'
      )) as EvalResponse;
    } catch (error) {
      // A transport failure is about the extension, not the user's code, so
      // it does not belong painted next to their line.
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(message);
      void vscode.window.showErrorMessage(`Evalens: ${message}`);
      return;
    }

    if (!this.gate.isCurrent(key, token)) {
      // A newer evaluation has already claimed this document. Painting this
      // one would leave a value beside code it did not come from.
      return;
    }

    const presentation = present(response, cursor.line);
    if (presentation.kind === 'nothing') {
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
            error: { type: presentation.type, message: presentation.message },
            hover: presentation.hover,
          }
        : {
            range: toVsCodeRange(presentation.range),
            ...(presentation.anchor === undefined
              ? {}
              : { anchor: presentation.anchor }),
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
            ...(presentation.names === undefined
              ? {}
              : { names: presentation.names }),
            ...(presentation.hover ? { hover: presentation.hover } : {}),
          };

    this.annotations.add(document, annotation);
  }
}
