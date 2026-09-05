import * as vscode from 'vscode';

import {
  conflictMessage, describeConflicts, detectConflicts, keybindingSnippet,
  keybindingsQuery, platformOf,
} from './keybindings';

/**
 * Remembered per install, across windows and sessions. An extension that
 * re-asks is an extension that gets dismissed on reflex, and this one has
 * something to say exactly once.
 *
 * Deliberately not registered for Settings Sync: whether AREPL is installed
 * is a fact about one machine, and syncing "already asked" would silence the
 * notice on the machine that needs it.
 */
const NOTIFIED = 'evalens.keybindingConflictNotified';

/** Installed *and* enabled: `getExtension` returns undefined for disabled. */
function installed(extensionId: string): boolean {
  return vscode.extensions.getExtension(extensionId) !== undefined;
}

/**
 * Called at the end of activation, after the commands exist, so the offer can
 * never arrive before the thing it is about.
 */
export function reportKeybindingConflicts(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): void {
  const platform = platformOf(process.platform);
  const conflicts = detectConflicts(installed, platform);
  if (conflicts.length === 0) {
    return;
  }
  // Logged every activation, whether or not the user is notified: the
  // original bug cost three diagnostic rounds precisely because nothing
  // anywhere said another extension had taken the key.
  output.appendLine(describeConflicts(conflicts, platform));

  if (context.globalState.get<boolean>(NOTIFIED) === true) {
    return;
  }
  // Recorded before the notification is awaited, so a dismissed or
  // never-answered prompt still counts as asked.
  void context.globalState.update(NOTIFIED, true);
  void offerFix(conflictMessage(conflicts, platform));
}

/**
 * An offer, deliberately not a write.
 *
 * Both routes end with the user looking at the change before it applies.
 * Editing somebody's keybindings.json for them is worse than a dead key: it
 * is their file, it is JSON with comments and hand formatting, there is no
 * API for editing it, and a botched rewrite loses bindings that have nothing
 * to do with us. So the fix is handed over instead -- copied to the clipboard
 * with the file open, or shown in the keybindings editor next to the binding
 * it is fighting.
 */
async function offerFix(message: string): Promise<void> {
  const FIX = 'Fix Keybinding';
  const SHOW = 'Show Conflict';
  const picked = await vscode.window.showWarningMessage(message, FIX, SHOW);

  if (picked === FIX) {
    await fixKeybindingConflict();
  } else if (picked === SHOW) {
    await vscode.commands.executeCommand(
      'workbench.action.openGlobalKeybindings',
      keybindingsQuery(platformOf(process.platform)));
  }
}

/**
 * The palette route to the same fix, which is what makes a once-only
 * notification safe to dismiss. It works with no conflict detected too: the
 * binding it hands out is the fix for any extension that takes the key,
 * including one nobody here has heard of.
 */
export async function fixKeybindingConflict(): Promise<void> {
  const platform = platformOf(process.platform);
  const snippet = keybindingSnippet(
    platform, detectConflicts(installed, platform));

  await vscode.env.clipboard.writeText(snippet);
  await vscode.commands.executeCommand(
    'workbench.action.openGlobalKeybindingsFile');
  void vscode.window.showInformationMessage(
    'Evalens: keybinding copied to the clipboard. Paste it inside the outer ' +
    '[ ] and save -- deleting it again undoes the change.');
}
