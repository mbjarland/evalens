import * as vscode from 'vscode';

import { KernelClient } from './kernel/client';
import { EvalResponse, FileResponse, LatestWins } from './kernel/protocol';
import { Annotations } from './render/annotations';
import { Annotation, toVsCodeRange } from './render/decorations';
import { present } from './render/present';

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

    if (response.ok) {
      const n = response.statements;
      vscode.window.setStatusBarMessage(
        `Evalens: loaded ${n} statement${n === 1 ? '' : 's'}`, 3000);
      if (response.stdout) {
        this.output.append(response.stdout);
      }
      return;
    }

    // A failure DOES get annotated: it has a place on screen, and the user
    // needs to see which statement stopped the load.
    const ran = response.statements ?? 0;
    void vscode.window.showErrorMessage(
      `Evalens: load stopped after ${ran} statement${ran === 1 ? '' : 's'} ` +
      `- ${response.error.type}: ${response.error.message}`);
    if (response.range) {
      this.annotations.add(document, {
        range: toVsCodeRange(response.range),
        error: { type: response.error.type, message: response.error.message },
        hover: response.error.traceback || response.error.message,
      });
    }
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
            ...(presentation.value === null
              ? {}
              : { value: presentation.value, display: presentation.display }),
            ...(presentation.hover ? { hover: presentation.hover } : {}),
          };

    this.annotations.add(document, annotation);
  }
}
