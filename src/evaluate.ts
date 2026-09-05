import * as vscode from 'vscode';

import { KernelClient } from './kernel/client';
import { EvalResponse, LatestWins } from './kernel/protocol';
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
              : { value: presentation.value }),
            ...(presentation.hover ? { hover: presentation.hover } : {}),
          };

    this.annotations.add(document, annotation);
  }
}
