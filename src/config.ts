import { execFile } from 'node:child_process';
import * as vscode from 'vscode';

import { DisplayLimits } from './kernel/protocol';
import {
  Candidate, InterpreterUnavailableError, ProbeResult,
  chooseInterpreter, describeFailure,
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

/**
 * Whether **Evaluate File** clears the namespace before it runs the whole
 * file.
 *
 * Read per request, like every setting here: flipping it must take effect on
 * the next load rather than waiting for a restart, which would itself carry
 * the namespace away. Default `true` -- see
 * `docs/development/namespace-reset.md` and the superseding decision
 * recorded on #99 for why: a namespace holding a binding the file on screen
 * no longer makes is the notebook trap this project exists to argue
 * against, and #56 found the residue crosses file boundaries, not only
 * reloads of one file.
 *
 * Governs a whole-file run only. `evaluateFile` never resets on a selection
 * -- resetting and then running three lines would leave everything above
 * them unbound, which is worse than doing nothing. `evaluateAtCursor` and
 * `evaluateAndAdvance` do not read this at all. `Run File as Script` always
 * resets, whatever this says: see `evaluateFile` in `evaluate.ts` for why
 * that is not governed by this setting.
 */
export function resetOnLoad(): boolean {
  return vscode.workspace
    .getConfiguration('evalens')
    .get<boolean>('resetOnLoad', true);
}

/**
 * Whether the values panel scrolls the row that just changed into view,
 * every time an evaluation lands (#149).
 *
 * Read fresh on every rebuild, like everything else here: the panel decides
 * whether to reveal at the moment it repaints, not once when the view was
 * first opened. On (the default), the newest value is always what is on
 * screen, which is the whole reason this exists -- otherwise the panel
 * keeps showing whatever was there while evaluations append new rows out of
 * sight below the fold. Off keeps the reader's own scroll position exactly
 * where they left it, for reading back through a file's history without the
 * view jumping away underneath them. This is also what the `$(lock)` /
 * `$(unlock)` toggle in the panel's own title bar flips, so a reader never
 * has to find the settings UI to turn it off mid-session.
 */
export function followValuesPanel(): boolean {
  return vscode.workspace
    .getConfiguration('evalens')
    .get<boolean>('valuesPanel.follow', true);
}

/** Link cursor navigation independently of following evaluation results. */
export function followValuesCursor(): boolean {
  return vscode.workspace
    .getConfiguration('evalens')
    .get<boolean>('valuesPanel.followCursor', true);
}

/** Set the reading preference from the Values panel's own checkbox. */
export async function setFollowValuesCursor(value: boolean): Promise<void> {
  await vscode.workspace.getConfiguration('evalens').update(
    'valuesPanel.followCursor', value, vscode.ConfigurationTarget.Global);
}

/**
 * Flip `evalens.valuesPanel.follow`, for **Evalens: Toggle Follow in Values
 * Panel** (#149). Before #181 this also drove a title-bar lock icon; VS Code
 * gives an extension-contributed title-bar item no toggled appearance, so
 * that icon is gone and the panel's own "Follow newest value" checkbox
 * (`setFollowValuesPanel`, below) is the one place this state is shown.
 *
 * Always writes to the user's global settings, matching "flips the setting
 * globally" -- a reading habit belongs to the person at the keyboard, not to
 * whichever workspace happens to be open.
 */
export async function toggleFollowValuesPanel(): Promise<void> {
  await vscode.workspace
    .getConfiguration('evalens')
    .update(
      'valuesPanel.follow', !followValuesPanel(),
      vscode.ConfigurationTarget.Global);
}

/** Set `evalens.valuesPanel.follow` from the Values panel's own "Follow
 * newest value" checkbox (#181), mirroring `setFollowValuesCursor` above. */
export async function setFollowValuesPanel(value: boolean): Promise<void> {
  await vscode.workspace.getConfiguration('evalens').update(
    'valuesPanel.follow', value, vscode.ConfigurationTarget.Global);
}

/**
 * Whether an inline chip ever yields to the Values panel (#178).
 *
 * `'always'` (the default) paints inline whatever the panel is doing --
 * every behaviour that existed before this setting. `'whenPanelHidden'`
 * paints inline only while the Values view is not visible: open it, or
 * switch to its tab, and the chips make way for the same values sitting in
 * the panel; close it, or switch away, and they come straight back. Tying
 * the hiding to the panel's own visibility, rather than a plain on/off
 * switch, is deliberate -- see `ValuesViewProvider`'s own comment on `hide`
 * for the failure mode a bare switch has that this does not: a value is
 * always visible *somewhere*.
 *
 * Read fresh wherever it matters, like everything else here: the panel
 * recomputes its own `hide` flag on resolve, on visibility change, and on
 * this setting changing, so flipping it takes effect immediately rather
 * than waiting for a reload.
 */
export function inlineValues(): 'always' | 'whenPanelHidden' {
  const configured = vscode.workspace
    .getConfiguration('evalens')
    .get<string>('inlineValues', 'always');
  return configured === 'whenPanelHidden' ? 'whenPanelHidden' : 'always';
}

/**
 * Flip `evalens.inlineValues` between its two values, for **Evalens: Toggle
 * Inline Values in the Editor** (#178). Before #181 this also drove a
 * title-bar eye/eye-closed icon; VS Code gives an extension-contributed
 * title-bar item no toggled appearance, so that icon is gone and the panel's
 * own "Hide inline values while this panel is visible" checkbox
 * (`setInlineValues`, below) is the one place this state is shown.
 *
 * Always writes to the user's global settings, for the same reason
 * `toggleFollowValuesPanel` does: this is a reading habit, not a per-project
 * preference.
 */
export async function toggleInlineValues(): Promise<void> {
  await vscode.workspace
    .getConfiguration('evalens')
    .update(
      'inlineValues',
      inlineValues() === 'always' ? 'whenPanelHidden' : 'always',
      vscode.ConfigurationTarget.Global);
}

/** Set `evalens.inlineValues` from the Values panel's own "Hide inline
 * values while this panel is visible" checkbox (#181): checked writes
 * `whenPanelHidden`, unchecked writes `always`. */
export async function setInlineValues(
  value: 'always' | 'whenPanelHidden'
): Promise<void> {
  await vscode.workspace.getConfiguration('evalens').update(
    'inlineValues', value, vscode.ConfigurationTarget.Global);
}

/**
 * How many lines of a printed stream or a long value the values panel shows
 * before folding the rest behind `Show all` (#155).
 *
 * Read fresh on every rebuild, like everything else here: a row already on
 * screen re-folds to the new number the next time anything repaints it,
 * rather than waiting for the panel to be closed and reopened. Fewer lines
 * fold sooner, which is what keeps the panel scrollable no matter how much
 * one statement printed -- a nested loop that prints ten thousand lines
 * used to turn one row into a ten-thousand-line wall. More lines show a
 * longer stretch of a run before the reader has to click `Show all`, at
 * the cost of a taller row and a heavier rebuild, since the panel repaints
 * every row in full on every evaluation (#116, #149). The fold itself is
 * unconditional -- there is no off switch -- because an unfolded
 * ten-thousand-line block is the defect this setting exists to prevent,
 * not a display style someone might reasonably prefer.
 */
export function valuesPanelOutputLines(): number {
  return vscode.workspace
    .getConfiguration('evalens')
    .get<number>('valuesPanel.outputLines', 20);
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
    return [{
      path: configured,
      source: 'the evalens.pythonPath setting',
      explicit: true,
    }];
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
  // Callers may log this failure, but the actionable notification is owned
  // here. A typed error preserves that distinction through kernel startup.
  throw new InterpreterUnavailableError();
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
