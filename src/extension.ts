import * as vscode from 'vscode';

import { Evaluator } from './evaluate';
import { fixKeybindingConflict, reportKeybindingConflicts } from './conflicts';
import { resolveInterpreter } from './config';
import { KernelClient } from './kernel/client';
import { askForInput } from './prompt';
import { Annotations } from './render/annotations';

let client: KernelClient | undefined;
let output: vscode.OutputChannel | undefined;
let annotations: Annotations | undefined;
let evaluator: Evaluator | undefined;

/**
 * Activation is `onLanguage:python`, so a window with no Python in it pays
 * nothing for having this installed. The kernel is lazier still: the client
 * does not spawn an interpreter until the first evaluation, so opening a
 * Python file to read it starts no process.
 */
export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Evalens');
  context.subscriptions.push(output);

  annotations = new Annotations();
  context.subscriptions.push(annotations);

  context.subscriptions.push(
    vscode.commands.registerCommand('evalens.clearResults', () => {
      annotations?.clearAll();
    })
  );

  evaluator = new Evaluator(
    () => ensureClient(context), annotations, output);

  context.subscriptions.push(
    vscode.commands.registerCommand('evalens.evaluateAtCursor', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      await evaluator?.evaluateAtCursor(editor);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('evalens.evaluateFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      await evaluator?.evaluateFile(editor);
    })
  );

  context.subscriptions.push(
    // In the palette as well as on the progress notification's Cancel button.
    // The notification can be dismissed; the infinite loop behind it cannot,
    // and a stop button that exists only on a thing you have closed is not a
    // stop button.
    vscode.commands.registerCommand('evalens.interrupt', async () => {
      await evaluator?.interrupt();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('evalens.restartKernel', async () => {
      client?.restart();
      // The interpreter may have changed since the last spawn -- a new venv
      // selected, a setting edited -- so the next client is built fresh.
      client?.dispose();
      client = undefined;
      vscode.window.setStatusBarMessage('Evalens: kernel restarted', 2000);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'evalens.fixKeybindingConflict', fixKeybindingConflict)
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('evalens.pythonPath')) {
        // Drop the running kernel so the new interpreter is picked up without
        // the user having to know that Restart Kernel exists.
        disposeClient();
        output?.appendLine('evalens.pythonPath changed; kernel will restart');
      }
    })
  );

  context.subscriptions.push({ dispose: () => disposeClient() });

  // Last, so the offer to fix a stolen keybinding cannot arrive before the
  // command it is about is registered.
  reportKeybindingConflicts(context, output);
}

export function deactivate(): void {
  // The kernel is a separate OS process. Left running it outlives the window,
  // and an orphaned interpreter is a bug users see in Activity Monitor and
  // never report.
  disposeClient();
}

async function ensureClient(
  context: vscode.ExtensionContext
): Promise<KernelClient> {
  if (client) {
    return client;
  }
  const kernelPath = vscode.Uri.joinPath(
    context.extensionUri, 'kernel', 'evalens_kernel.py'
  ).fsPath;
  client = new KernelClient({
    // Resolved on every spawn, not captured here: editing the setting must
    // take effect on the next evaluation.
    resolvePython: () => resolveInterpreter(output!),
    kernelPath,
    onInput: askForInput,
    // Live, rather than at the end of the statement. A loop that prints its
    // progress only reads as progress if the output arrives while it runs.
    onStream: (_name, text) => output?.append(text),
    onStderr: (text) => output?.append(text),
    onExit: (code, signal) =>
      output?.appendLine(
        `kernel exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`
      ),
  });
  return client;
}

function disposeClient(): void {
  client?.dispose();
  client = undefined;
}
