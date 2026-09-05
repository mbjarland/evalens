import * as vscode from 'vscode';

import { announceResults } from '../config';
import {
  Announceable, NOTHING_HERE, announcement,
  announcesAutomatically, spokenText, statusText,
} from './announce';

/**
 * The command that reads the cursor's line out.
 *
 * Deliberately unbound. Choosing a chord blind is how this project ended up
 * diagnosing a dead `Cmd+Enter` three times before scanning the installed
 * extensions and finding AREPL on it, and nobody has run that scan for this
 * command. It is in the palette, the README shows the binding to paste, and a
 * key can be added once somebody has checked what already owns one.
 */
export const READ_AT_CURSOR = 'evalens.announceResultAtCursor';

/**
 * The second channel: what a screen reader can reach.
 *
 * ## Why there has to be a second channel at all
 *
 * Every answer this extension produces is an `after` decoration, and
 * `DecorationRenderOptions` takes no `label`, no `role` and no
 * `accessibilityInformation`. That was checked against the `@types/vscode` in
 * this repo rather than assumed: the interface exists and is accepted by
 * `StatusBarItem`, `NotebookCellStatusBarItem` and `TreeItem`, and by nothing
 * on any decoration type. There is no escape hatch either -- VS Code's own
 * announcements go through an internal `aria.alert` helper that is not
 * exported to extensions, and the request to expose it
 * (microsoft/vscode#114718) was closed as out of scope. Jupyter has had the
 * same gap open since 2019, so there is no version of this that waits for the
 * platform.
 *
 * ## Which surface, and why it is a notification
 *
 * Two surfaces, doing two different jobs, and the split follows from what was
 * measured in VS Code's own source rather than from what reads best.
 *
 * The **notification** is the announced one, and it is the only one.
 * `notificationsAlerts.ts` fires an assertive aria alert for every
 * notification VS Code raises, prefixed with its severity, which makes
 * `showInformationMessage` the one extension-reachable way to put a sentence
 * in front of a screen reader without taking focus off the code. The
 * exception is worth knowing: a notification raised while the window is in Do
 * Not Disturb carries `NotificationPriority.SILENT` and is not alerted, so a
 * user with notifications filtered hears nothing from this.
 *
 * Information severity for everything, a failure included. The severity of a
 * *notification* is a claim about the extension, and a `NameError` in a
 * first-year student's file is the normal outcome of evaluating rather than a
 * malfunction -- raising it as an editor error would leave a red badge in the
 * notification centre for something that already answered on the line. The
 * distinction the reader needs is carried in words instead: `spokenText` leads
 * a failure with "error", which does not depend on the screen reader
 * announcing severity at all.
 *
 * The **status bar item** is the persistent one, and the only place in the
 * whole API that takes an `AccessibilityInformation`. It holds the last answer
 * so it can be found again after the toast has gone. It is emphatically *not*
 * live: VS Code renders the status bar footer with `aria-live="off"` and puts
 * a plain `aria-label` on each entry, so an item's label is read when it has
 * focus and never when it changes. Reaching it is a deliberate act --
 * `workbench.action.focusStatusBar`, then arrow to the entry -- which is
 * exactly why it cannot be the announced channel on its own, and exactly why
 * it is still worth having as a place to go back to.
 *
 * What is *not* used here is `setStatusBarMessage`, which this extension
 * already uses for load summaries. It is backed by one shared status bar item
 * that never sets `accessibilityInformation` at all, so those summaries are
 * silent today -- see the note on `announce` below.
 *
 * ## Why it does not chatter
 *
 * Nothing here is wired to the cursor. An item that re-announced on every
 * arrow key would be noise for the people it is for, and the project's own
 * argument against bulk announcement -- two hundred annotations from one
 * keypress would be worse than announcing nothing -- applies just as well to
 * two hundred cursor movements. The two triggers are both deliberate: a
 * statement the user just evaluated, and a line the user just asked about.
 */
export class Announcer implements vscode.Disposable {
  /**
   * Created on demand and only while the channel is on, so a user who has not
   * asked for any of this never grows a status bar item they did not want.
   */
  private item?: vscode.StatusBarItem;

  /**
   * Say what an explicitly triggered evaluation produced.
   *
   * Reached from `Annotations.settle`, which is the single-statement path and
   * nothing else: a file load calls `add` two hundred times and is not routed
   * here. That is the rule implemented by wiring rather than by a flag --
   * there is no code path from bulk annotation to this method to get wrong.
   *
   * The load summary that covers bulk work is `describeLoad` /
   * `describeRun`, reached from `evaluateFile` through `announceSummary`
   * below rather than through this method -- a load calls `add`, never
   * `settle`, so there is still no code path from bulk annotation to a
   * per-statement announcement to get wrong.
   */
  announce(annotation: Announceable): void {
    const spoken = this.automatic() ? spokenText(annotation) : undefined;
    // Cleared rather than left standing when there is nothing to say. It ran
    // and had nothing to report -- a `del`, a bare `pass` -- and an item still
    // holding the previous answer would present it as this one's.
    this.hold(spoken);
    if (spoken !== undefined) {
      void vscode.window.showInformationMessage(announcement(spoken));
    }
  }

  /**
   * Say a bulk-work summary out loud: a whole file loaded, a selection run,
   * or a blank line's "nothing to evaluate here" (#88).
   *
   * `message` arrives already carrying the `Evalens: ` prefix `describeLoad`
   * and `describeRun` put on every summary for the status bar. The
   * notification shows it verbatim -- prefixing it again would read
   * "Evalens: Evalens: loaded...". `hold` below adds that same prefix of
   * its own accord for the status item's accessibility label, the way it
   * already does for a single result, so the prefix is stripped first
   * rather than doubled there. #55 decided bulk work earns one utterance for
   * the whole operation rather than one per statement, which is why this is
   * reached from a load's summary and never from `LoadPainting`'s
   * per-statement paint; this is that one utterance, sharing `announce`'s
   * gate and its status-bar holding place rather than opening a second
   * channel with its own rules.
   */
  announceSummary(message: string): void {
    if (!this.automatic()) {
      return;
    }
    const prefix = announcement('');
    const spoken = message.startsWith(prefix)
      ? message.slice(prefix.length)
      : message;
    this.hold(spoken);
    void vscode.window.showInformationMessage(message);
  }

  /**
   * Say what is on the line the reader is asking about.
   *
   * Always speaks, whatever the setting says, because the setting governs the
   * *unasked* channel and this was asked for. It also answers when there is
   * nothing there: silence in response to a command is the failure this whole
   * ticket is about, and "no result on this line" is a real answer that a
   * blank line and a dead keybinding do not share.
   */
  read(annotation: Announceable | undefined): void {
    const spoken = annotation === undefined
      ? undefined
      : spokenText(annotation);
    if (spoken !== undefined) {
      this.hold(spoken);
    }
    void vscode.window.showInformationMessage(
      announcement(spoken ?? NOTHING_HERE));
  }

  /**
   * Forget the last answer, because the annotations it came from have gone.
   *
   * Clearing the results and leaving a value in the status bar would keep a
   * reading alive after the thing it was a reading of was dismissed -- the
   * same "asserts more than we know" failure the gutter marker exists to
   * prevent, in the one place a screen-reader user can go back to.
   */
  silence(): void {
    this.retire();
  }

  dispose(): void {
    this.retire();
  }

  // -- internals ------------------------------------------------------------

  /**
   * Whether a result speaks for itself without being asked.
   *
   * The Evalens half of the question comes from `config.ts`, which is where
   * every read of an `evalens.` setting lives so that no default can drift
   * from the manifest's. The other half is VS Code's own
   * `editor.accessibilitySupport` and is read here, because it belongs to the
   * editor rather than to us and `config.ts` has nothing to check it against.
   */
  private automatic(): boolean {
    return announcesAutomatically(
      announceResults(),
      vscode.workspace
        .getConfiguration('editor')
        .get<string>('accessibilitySupport'));
  }

  /**
   * Keep this answer somewhere it can be found after the toast has gone, or
   * take the item away when there is nothing to keep.
   *
   * The one place the item's whole lifecycle lives, so its rule is one
   * sentence: it exists exactly while the announced channel is on and has an
   * answer to hold.
   */
  private hold(spoken: string | undefined): void {
    if (spoken === undefined || !this.automatic()) {
      this.retire();
      return;
    }
    if (!this.item) {
      this.item = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right, 0);
      // A command is what makes the entry a button, and a button is what
      // keyboard navigation stops on -- a plain label would carry an
      // accessibility label that nothing ever focuses to read out.
      this.item.command = READ_AT_CURSOR;
    }
    this.item.text = statusText(spoken);
    this.item.tooltip = spoken;
    // The label is the whole answer even though the text is an abbreviation of
    // it. Nothing spoken has a width to fit in.
    this.item.accessibilityInformation = { label: announcement(spoken) };
    this.item.show();
  }

  private retire(): void {
    this.item?.dispose();
    this.item = undefined;
  }
}
