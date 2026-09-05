import * as vscode from 'vscode';

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
          error: { type: outcome.error.type, message: outcome.error.message },
          hover: outcome.error.traceback || outcome.error.message,
        }
      : undefined;
  }
  if (outcome.value === null && outcome.loop === undefined) {
    // It ran; an `if` or a `del` simply has no value to report. A loop that
    // ran zero times is the exception -- no value, and still an answer.
    return undefined;
  }
  return {
    range: toVsCodeRange(outcome.range),
    ...(outcome.value === null ? {} : { value: outcome.value }),
    display: outcome.display,
    ...(outcome.loop === undefined ? {} : { loop: outcome.loop }),
    hover: hoverFor(
      outcome.display, outcome.value ?? '', outcome.repr, outcome.loop
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
      response = (await client.request({
        op: 'eval_file',
        source: document.getText(),
        filename: document.uri.fsPath,
      })) as FileResponse;
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
      response = (await client.request({
        op: 'eval',
        source: document.getText(),
        line: cursor.line,
        character: cursor.character,
        filename: document.uri.fsPath,
      })) as EvalResponse;
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
            error: { type: presentation.type, message: presentation.message },
            hover: presentation.hover,
          }
        : {
            range: toVsCodeRange(presentation.range),
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
            ...(presentation.hover ? { hover: presentation.hover } : {}),
          };

    this.annotations.add(document, annotation);
  }
}
