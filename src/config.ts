import { execFile } from 'node:child_process';
import * as vscode from 'vscode';

import { DisplayLimits } from './kernel/protocol';
import {
  Candidate, NO_INTERPRETER, ProbeResult, chooseInterpreter, describeFailure,
} from './python';

/**
 * Every setting Evalens reads, read in one place.
 *
 * Not tidiness. The default written at a call site and the default declared
 * in `package.json` are two statements of one fact with nothing making them
 * agree, and they had already drifted: the manifest said `alignColumn` was 0
 * and the call site in `decorations.ts` said 80. Nothing failed, because a
 * declared setting resolves to its manifest default and the second number was
 * dead -- it would have come alive the day somebody renamed the property, as
 * a silent change of behaviour. Gathering the reads makes the pair checkable,
 * and `settings.test.ts` checks it.
 *
 * Every read below is `getConfiguration('evalens')` with no resource, which
 * resolves at window level. That is why nothing is contributed at `resource`
 * scope: a per-folder value the code never asks for is a setting that does
 * nothing in the place it was set, silently.
 */

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

/** The column inline results line up on; 0 follows the code instead. */
export function resultColumn(): number {
  return vscode.workspace
    .getConfiguration('evalens')
    .get<number>('resultColumn', 0);
}

/**
 * What the line calls the output a statement printed.
 *
 * Trimmed, and an empty setting falls back rather than painting a bare value:
 * `  ` reads as "I want no label" and would leave `hello` on the line looking
 * like the expression evaluated to it, which is the one reading the label
 * exists to prevent.
 */
export function printedLabel(): string {
  return vscode.workspace
    .getConfiguration('evalens')
    .get<string>('printedLabel', 'printed')
    .trim() || 'printed';
}

/**
 * Whether a result speaks for itself, for a screen reader.
 *
 * A closed set of three, so the manifest offers an enum and the settings UI
 * lists them rather than asking anyone to remember the spellings. Anything
 * else that arrives here is `auto`: a value outside the enum can only come
 * from a hand-edited settings.json, and falling back is what every other
 * malformed setting does rather than choosing one of the loud answers on the
 * user's behalf.
 *
 * Read per announcement, like everything above it. This is the one setting
 * somebody turns on *because* nothing is being said to them, so a value that
 * waited for a window reload would look exactly like the silence it was meant
 * to end.
 */
export function announceResults(): 'auto' | 'always' | 'never' {
  const configured = vscode.workspace
    .getConfiguration('evalens')
    .get<string>('announceResults', 'auto');
  return configured === 'always' || configured === 'never'
    ? configured
    : 'auto';
}

/**
 * How many `name: value` pairs the kernel may put in one response, when
 * `evalens.readNames` is on.
 *
 * Not `evalens.readNamesPerLine` -- that used to travel on the wire as this
 * same number, and #85 is the record of why that was the bug: the kernel
 * cannot know which of a line's names the reader has already seen painted
 * above it, so a cap enforced there can only keep whichever names came first
 * and drop the rest, which is exactly backwards when the dropped one is the
 * one that just changed. So the wire asks for more than any line is meant to
 * show, generous the way `WIRE_REPR_LIMIT` is generous for one value, and
 * `nameDisplayCap` below is the number actually painted, applied by the
 * renderer once repeat suppression has said which names are new.
 *
 * Kept in step with the kernel's own `NAME_LIMIT`, which is the same bound
 * for a request that sends no `limits` at all.
 */
export const TRANSPORT_NAME_LIMIT = 64;

/**
 * What the annotations may contain, in the form the kernel is told it.
 *
 * The two off switches collapse into the counts rather than crossing the wire
 * as flags of their own. Off is "keep none of them", which the kernel already
 * has to handle for a limit of zero, and a separate boolean would be a second
 * way of saying the same thing -- with the usual consequence that one day the
 * two disagree. The booleans exist in the settings UI because a checkbox is
 * what somebody hunting for a way to turn something off looks for; making
 * that a number is this function's job.
 */
export function displayLimits(): DisplayLimits {
  const config = vscode.workspace.getConfiguration('evalens');
  return {
    loop_values: config.get<boolean>('loopValues', true)
      ? config.get<number>('loopIterations', 5)
      : 0,
    names: config.get<boolean>('readNames', true) ? TRANSPORT_NAME_LIMIT : 0,
  };
}

/**
 * How many `name: value` pairs one line's annotation actually shows, once
 * repeat suppression has decided which of the names the wire carried are new.
 *
 * This is `evalens.readNamesPerLine`, and until #85 it was sent to the kernel
 * instead of kept here -- see `displayLimits`. It belongs on this side of the
 * pipe now because choosing which four names of six to paint is a question
 * about what is already on the reader's screen, and the kernel has no view of
 * that at all.
 */
export function nameDisplayCap(): number {
  const config = vscode.workspace.getConfiguration('evalens');
  return config.get<boolean>('readNames', true)
    ? config.get<number>('readNamesPerLine', 4)
    : 0;
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
  // Short on purpose. The detail is already on screen with buttons under it;
  // this rejection travels out through the spawn to the catch in Evaluator,
  // which shows whatever it is given prefixed `Evalens: `. Throwing the
  // detail here put the same paragraph up twice, the second time without the
  // buttons and in no guaranteed order -- one failure reading as two, with
  // the worse copy possibly on top.
  throw new Error(NO_INTERPRETER);
}

/**
 * The one place the interpreter failure is spelled out, and the only one that
 * can do anything about it.
 */
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
