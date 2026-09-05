import * as vscode from 'vscode';

import { resolvePythonPath } from './config';
import { KernelClient } from './kernel/client';
import { Annotations } from './render/annotations';

let client: KernelClient | undefined;
let output: vscode.OutputChannel | undefined;
let annotations: Annotations | undefined;

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

  context.subscriptions.push(
    vscode.commands.registerCommand('evalens.evaluateAtCursor', async () => {
      // Placeholder: the renderer (#7, #8) and the wiring (#9) land here.
      const kernel = await ensureClient(context);
      const result = await kernel.request({ op: 'ping' });
      output?.appendLine(`kernel ping: ${JSON.stringify(result)}`);
      vscode.window.setStatusBarMessage('Evalens: kernel reachable', 2000);
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

  context.subscriptions.push({ dispose: () => disposeClient() });
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
    pythonPath: await resolvePythonPath(),
    kernelPath,
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
