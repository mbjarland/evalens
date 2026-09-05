import * as vscode from 'vscode';

/**
 * Activation is `onLanguage:python`, so a window with no Python in it pays
 * nothing for having this installed. The Python kernel is a further step
 * lazier still -- it is not spawned until the first evaluation, so opening a
 * Python file to read it does not start an interpreter nobody asked for.
 */
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('evalens.evaluateAtCursor', () => {
      // Placeholder. The kernel (#4), the resolver (#5), the client (#6) and
      // the renderer (#7) land behind this command; #9 wires them together.
      vscode.window.setStatusBarMessage('Evalens: not wired up yet', 2000);
    })
  );
}

export function deactivate(): void {
  // Nothing owns an out-of-process resource yet. The kernel client will, and
  // must be disposed here -- an orphaned Python process outliving the window
  // is a bug users see in Activity Monitor and never report.
}
