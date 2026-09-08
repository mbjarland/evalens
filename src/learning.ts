import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

/** Fixed ids are also a path allowlist: command URIs must not read arbitrary files. */
export const EXERCISES = [
  { id: 'predict', label: '1. Predict a value' },
  { id: 'advance', label: '2. Follow the next statement' },
  { id: 'aliasing', label: '3. Two names, one list' },
  { id: 'accumulator', label: '4. Fix an accumulator' },
  { id: 'stale', label: '5. Notice an old answer' },
] as const;

export function registerLearningWalkthrough(context: vscode.ExtensionContext): void {
  const exerciseDocuments = new Set<string>();
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument(document => {
      exerciseDocuments.delete(document.uri.toString());
    }),
    vscode.commands.registerCommand('evalens.openLearningWalkthrough', async () => {
      // VS Code otherwise opens a newly installed walkthrough automatically.
      await vscode.commands.executeCommand('setContext', 'evalens.learning.requested', true);
      await vscode.commands.executeCommand(
        'workbench.action.openWalkthrough', 'mbjarland.evalens#evalens.learning', false);
    }),
    vscode.commands.registerCommand('evalens.openLearningExercise', async (id?: unknown) => {
      if (id === undefined) {
        id = (await vscode.window.showQuickPick(EXERCISES.map(e => ({ ...e })), {
          title: 'Evalens: Open Learning Exercise',
          placeHolder: 'Choose an exercise; opening it does not run Python',
        }))?.id;
        if (id === undefined) return;
      }
      if (!EXERCISES.some(exercise => exercise.id === id)) {
        await vscode.window.showErrorMessage('Unknown Evalens learning exercise.');
        return;
      }
      try {
        const content = await fs.readFile(path.join(
          context.extensionUri.fsPath, 'media', 'learning', `${id}.py`), 'utf8');
        const document = await vscode.workspace.openTextDocument({ language: 'python', content });
        const existing = vscode.window.visibleTextEditors.find(editor =>
          exerciseDocuments.has(editor.document.uri.toString()));
        const editor = await vscode.window.showTextDocument(document, {
          viewColumn: existing?.viewColumn ?? vscode.ViewColumn.Beside,
          preview: false, preserveFocus: false,
        });
        exerciseDocuments.add(document.uri.toString());
        // Land on code, not a comment: the first keypress produces the first value.
        const line = content.split('\n').findIndex(text => text.trim() && !text.startsWith('#'));
        if (line >= 0) editor.selection = new vscode.Selection(line, 0, line, 0);
      } catch (error) {
        await vscode.window.showErrorMessage(`Could not open the learning exercise: ${String(error)}`);
      }
    }),
  );
}
