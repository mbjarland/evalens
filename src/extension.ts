import * as vscode from 'vscode';

import { Evaluator, STATUS_ACK_MS } from './evaluate';
import { fixKeybindingConflict, reportKeybindingConflicts } from './conflicts';
import { resolveInterpreter } from './config';
import { KernelClient } from './kernel/client';
import { Announcer } from './render/announcer';
import { Annotations } from './render/annotations';
import { Flash } from './render/flash';
import { ValueHoverProvider } from './render/hover';

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

  // One for the window, handed to both the things that flash: the annotations,
  // for the emphasis that says a statement just re-ran, and the evaluator, for
  // the highlight showing how far a selection snapped. Two instances would be
  // two timers over the same editor, and those two flashes can land on the
  // same statement.
  const flash = new Flash();
  context.subscriptions.push(flash);

  // The channel for a reader who cannot see a decoration. A decoration takes
  // no accessibility label -- the VS Code API simply has no field for one --
  // so the answer has to be said somewhere else as well as painted on the
  // line. It is never said *instead*: the line keeps the answer, and this is
  // an addition for people the line cannot reach.
  const announcer = new Announcer();
  context.subscriptions.push(announcer);

  annotations = new Annotations(context.extensionUri, flash, announcer);
  context.subscriptions.push(annotations);

  // #46: the full value, reachable by hovering the statement it came from,
  // rather than glued to a decoration range that nothing can ever land on.
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      'python', new ValueHoverProvider(annotations))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('evalens.clearResults', () => {
      annotations?.clearAll();
    })
  );

  context.subscriptions.push(
    // The on-demand half, and the half that needs no configuration: whatever
    // the announce setting says, this reads out what is painted on the line
    // the cursor is on. It answers when there is nothing there too -- silence
    // in reply to a command is exactly the failure this exists to remove.
    // Registered by its literal id, the way every other command here is: the
    // manifest and the source declare it in two places and a test compares the
    // two, which a constant would hide from that check.
    vscode.commands.registerCommand('evalens.announceResultAtCursor', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      announcer.read(
        annotations?.at(editor.document, editor.selection.active.line));
    })
  );

  context.subscriptions.push(
    // Reached from the link on an annotation that printed more than fits, and
    // from the palette. `preserveFocus` is the whole point of it: output
    // belongs on the line, and the channel is overflow. A panel that took the
    // cursor would move the reader away from the code to read about the code,
    // which is the notebook's mistake and the gap this extension exists to
    // close -- so nothing here ever opens it unasked either.
    vscode.commands.registerCommand('evalens.showOutput', () => {
      output?.show(true);
    })
  );

  evaluator = new Evaluator(
    () => ensureClient(context), annotations, output, flash);

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
    // The same evaluation, plus a step to the next statement, so a file can be
    // walked by repeating one key. Both commands exist because both are
    // wanted: staying put suits iterating on one statement, advancing suits
    // reading a file you did not write.
    vscode.commands.registerCommand('evalens.evaluateAndAdvance', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      await evaluator?.evaluateAndAdvance(editor);
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
      vscode.window.setStatusBarMessage(
        'Evalens: kernel restarted', STATUS_ACK_MS);
    })
  );

  context.subscriptions.push(
    // The way out mechanism 1 of #86 promises: a stored answer is replayed
    // until the statement that asked for it changes or this is run. Nothing
    // to forget if the kernel has never prompted, so this reaches for the
    // client directly rather than through `ensureClient` -- spawning an
    // interpreter just to tell it to clear an empty store would be the
    // "opening a file starts a process" mistake lazy activation exists to
    // avoid.
    vscode.commands.registerCommand('evalens.clearInputAnswers', async () => {
      if (!client) {
        return;
      }
      await client.request({ op: 'clear_input_replay' });
      vscode.window.setStatusBarMessage(
        'Evalens: input answers cleared', STATUS_ACK_MS);
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
    // Through the evaluator rather than straight to the box, because asking
    // is no longer only a box: the blocked line has to be marked and revealed,
    // and a load has to count its prompts so the second one can offer a way
    // out of the rest. Only the command that is running knows any of that.
    onInput: (request) => evaluator!.askUser(request),
    // Live, rather than at the end of the statement. A loop that prints its
    // progress only reads as progress if the output arrives while it runs.
    onStream: (_name, text, unattributed) =>
      output?.append(unattributed ? markBackground(text) : text),
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

/** Whether the next piece of background output starts a fresh line. */
let backgroundAtLineStart = true;

/**
 * Label output that arrived with no statement running.
 *
 * A thread the user started two lines ago is still printing, and there is no
 * line to put its text beside -- attributing it would be a guess, and a value
 * next to code it did not come from is the failure this project treats as
 * worse than showing nothing. So it goes in the channel, marked.
 *
 * Marked per *line* rather than per frame, and that is why this holds state:
 * `print("x")` is two writes, the text and the newline, so a marker stamped on
 * every chunk would land in the middle of the sentence it is describing.
 */
function markBackground(text: string): string {
  let marked = '';
  for (const piece of text.split(/(\n)/)) {
    if (piece === '') {
      continue;
    }
    if (piece === '\n') {
      marked += piece;
      backgroundAtLineStart = true;
      continue;
    }
    marked += backgroundAtLineStart ? `[background] ${piece}` : piece;
    backgroundAtLineStart = false;
  }
  return marked;
}
