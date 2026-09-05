import { execFile } from 'node:child_process';
import * as vscode from 'vscode';

import {
  Candidate, ProbeResult, chooseInterpreter, describeFailure,
} from './python';

/**
 * How long an evaluation may run before it earns a progress notification.
 *
 * Read at the moment it is needed rather than cached, so editing the setting
 * takes effect on the next keypress. Zero means show it immediately, which is
 * useful for seeing what the notification looks like and intolerable
 * otherwise.
 */
export function progressDelay(): number {
  return vscode.workspace
    .getConfiguration('evalens')
    .get<number>('progressDelay', 750);
}

/**
 * Whether Evaluate and Advance steps over comment lines on its way to the
 * next statement.
 *
 * Read per press for the same reason as the delay above: a setting whose
 * effect waits for a reload is one the user changes twice before believing it.
 */
export function advanceSkipsComments(): boolean {
  return vscode.workspace
    .getConfiguration('evalens')
    .get<boolean>('advanceSkipsComments', true);
}

/** Ask an interpreter what version it is, rather than assuming. */
export function probeInterpreter(path: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    execFile(
      path,
      ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'],
      { timeout: 5000 },
      (error, stdout) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          resolve({
            ok: false,
            reason: code === 'ENOENT' ? 'not found' : error.message.trim(),
          });
          return;
        }
        const match = /^(\d+)\.(\d+)/.exec(stdout.trim());
        if (!match) {
          resolve({ ok: false, reason: `unexpected output: ${stdout.trim()}` });
          return;
        }
        resolve({ ok: true, version: [Number(match[1]), Number(match[2])] });
      }
    );
  });
}

async function candidates(): Promise<Candidate[]> {
  const configured = vscode.workspace
    .getConfiguration('evalens')
    .get<string>('pythonPath', '')
    .trim();

  const list: Candidate[] = [];
  if (configured !== '') {
    list.push({
      path: configured,
      source: 'the evalens.pythonPath setting',
      explicit: true,
    });
  }
  const fromExtension = await interpreterFromPythonExtension();
  if (fromExtension) {
    list.push({ path: fromExtension, source: 'the Python extension' });
  }
  list.push({ path: 'python3', source: 'PATH' });
  list.push({ path: 'python', source: 'PATH' });
  return list;
}

/**
 * The interpreter to run the kernel with.
 *
 * Resolved fresh on every spawn rather than once, so editing the setting
 * takes effect on the next evaluation. Baking it in at construction meant a
 * cached client kept trying a broken interpreter no matter what the user
 * changed.
 */
export async function resolveInterpreter(
  output: vscode.OutputChannel
): Promise<string> {
  const choice = await chooseInterpreter(await candidates(), probeInterpreter);

  if (choice.ok) {
    // Always logged: "which Python is this actually running?" is the first
    // question behind every ImportError anyone will ever report.
    output.appendLine(
      `using ${choice.path} (Python ${choice.version[0]}.${choice.version[1]}) ` +
      `from ${choice.source}`);
    return choice.path;
  }

  const detail = describeFailure(choice.attempts);
  output.appendLine(detail);
  void offerToFix(detail);
  throw new Error(detail);
}

async function offerToFix(detail: string): Promise<void> {
  const SELECT = 'Select Interpreter';
  const SETTINGS = 'Open Setting';
  const hasPythonExtension =
    vscode.extensions.getExtension('ms-python.python') !== undefined;

  const actions = hasPythonExtension ? [SELECT, SETTINGS] : [SETTINGS];
  const picked = await vscode.window.showErrorMessage(
    detail, { modal: false }, ...actions);

  if (picked === SELECT) {
    await vscode.commands.executeCommand('python.setInterpreter');
  } else if (picked === SETTINGS) {
    await vscode.commands.executeCommand(
      'workbench.action.openSettings', 'evalens.pythonPath');
  }
}

async function interpreterFromPythonExtension(): Promise<string | undefined> {
  try {
    const extension = vscode.extensions.getExtension('ms-python.python');
    if (!extension) {
      return undefined;
    }
    if (!extension.isActive) {
      await extension.activate();
    }
    // Read defensively: this is another extension's API surface, and a shape
    // change there must degrade to a probe of python3 rather than break
    // evaluation. It also reports a bare "python" when it has nothing
    // resolved, which is what made trusting it a bug.
    const environments = (extension.exports as {
      environments?: { getActiveEnvironmentPath?(): { path?: string } };
    })?.environments;
    const path = environments?.getActiveEnvironmentPath?.()?.path;
    return typeof path === 'string' && path !== '' ? path : undefined;
  } catch {
    return undefined;
  }
}
