/**
 * Whether a statement has finished, and what it is doing while it has not.
 *
 * The pure half of the pending/success/error states: the wording, the two
 * flicker thresholds, and the order the states are applied in. Nothing here
 * imports `vscode`, which is what lets the one rule this module exists to
 * enforce be checked by a test rather than by reading the shell -- **the line
 * is marked before the kernel is asked, not when it answers.**
 *
 * ## Why that ordering is the whole feature
 *
 * Since loading a file paints every value, pressing the evaluate key on an
 * already-annotated line re-runs it and repaints an identical string. Nothing
 * changes on screen, so the primary keybinding reads as dead -- and the user's
 * next move is to press it again, which runs their code a second time. The
 * command was always working; there was simply no evidence of it.
 *
 * A state applied when the response arrives does not fix that. Almost every
 * evaluation finishes in milliseconds, so the fast path -- which is nearly all
 * of them -- would go straight from one painted value to an identical painted
 * value with no transition in between. Applying it on the keypress is what
 * makes the transition exist at all; the evidence is the *change*, not the
 * colour.
 *
 * ## Why pending carries a message rather than being a boolean
 *
 * Three different things drive this state and the reader has to tell them
 * apart: an evaluation that is merely slow, one the kernel has not begun yet,
 * and one blocked waiting for the reader to type an answer to `Enter a
 * value:`. A spinner says the same thing in all three cases, which is what
 * makes Jupyter's `[*]` famously ambiguous -- it means "running", "queued" and
 * "the interrupt landed and the UI has not caught up", and its maintainers
 * have answered for years that the frontend cannot distinguish them. Evalens
 * can: the kernel reports `busy` on the control channel, and a prompt arrives
 * as its own message, so the three are separable facts rather than one
 * unknown.
 */

import { collapseLines, preserveSpacing } from './format';

/**
 * Why a statement is not finished, when there is something worth saying about
 * it. An absent `message` is the plain case: it is running, and that is all.
 */
export interface Pending {
  readonly message?: string;
}

/**
 * How long a silent evaluation runs before it says that it is running.
 *
 * Classic Notebook delays its busy favicon by exactly this, with the reason in
 * a source comment: only show the busy icon if execution lasts more than a
 * second, to avoid rapidly switching icons. The pending *state* still goes on
 * at the keypress -- this governs only the wording, which is the part that
 * would otherwise appear and vanish inside one video frame.
 */
export const BUSY_DELAY = 1000;

/**
 * How long that wording stays once it has appeared.
 *
 * VS Code's notebook cell carries the same constant as `MIN_SPINNER_TIME`,
 * documented as: when the executing state is shown, it will be shown for a
 * minimum brief time. Without it a 1,010ms evaluation flashes a word for ten
 * milliseconds, which reads as a glitch rather than as information. The price
 * is that such an evaluation shows its answer at 1,500ms instead -- paid only
 * by evaluations that were already slow enough to have said something.
 */
export const MINIMUM_BUSY = 500;

/**
 * How long the success emphasis lasts.
 *
 * Julia's VS Code extension flashes the evaluated range for about this long
 * and then lets it go, and that shape is the point: after a file load every
 * line already carries an annotation, so a permanent green says nothing at all
 * about which one just ran. What carries the information is the emphasis
 * decaying -- something happened *here*, a moment ago.
 */
export const FLASH = 200;

/** The glyph that says "not finished". */
export const MARK = '⌛';

/**
 * Longest message painted beside the mark.
 *
 * Shorter than the input box's own limit on purpose. This one shares a line
 * with the user's code; the box has the width of the window.
 */
const MESSAGE_LIMIT = 60;

/** What the annotation says while the statement is unfinished. */
export function pendingText(pending: Pending): string {
  const message = collapseLines(pending.message ?? '');
  if (message === '') {
    return MARK;
  }
  const trimmed = message.length > MESSAGE_LIMIT
    ? `${message.slice(0, MESSAGE_LIMIT)}…`
    : message;
  return preserveSpacing(`${MARK} ${trimmed}`);
}

/**
 * What to say about an evaluation that has been slow.
 *
 * Driven by what the kernel reported, not by "the promise has not settled
 * yet" -- which is equally true while an interpreter is still being probed and
 * nothing is running at all. The two are different facts and the reader can
 * act on them differently: one is their code taking a while, the other is the
 * extension not having started yet.
 */
export function runningMessage(busy: boolean): string {
  return busy ? 'running…' : 'waiting for the kernel…';
}

/** A marker on a line that has not finished. */
export interface Waiting {
  /**
   * Say what the statement is waiting for now. No message goes back to the
   * bare mark, which is the state a prompt returns to once it is answered and
   * the statement is merely running again.
   */
  say(message?: string): void;
  /** Take the marker back: nothing is going to replace it. */
  withdraw(): void;
}

/**
 * The mark standing on the one statement of a file load that has stopped.
 *
 * It exists because the mark has to outlive the box. A prompt withdrew its
 * mark the instant the user pressed Enter, which left the statement still
 * running -- opening a file, calling a service, doing whatever it wanted the
 * value for -- with nothing on screen saying so, and the reader looking at a
 * line that had gone quiet without producing anything.
 *
 * Held until that statement's own outcome arrives, it is the prominence half
 * of #82. Everything above the blocked line carries a value and everything
 * below is bare, so the one line with a mark on it is the only unfinished
 * thing on screen. Prominence is contrast, and there was none to be had while
 * the screen was empty: a louder colour on line 47 of a blank file is not
 * prominent, it is alone.
 *
 * One at a time, because the kernel runs one statement at a time -- so the
 * next outcome to be painted is necessarily the marked statement's own, and
 * "release on the next outcome" needs no correlation to be exact.
 */
export class BlockedMark {
  private standing?: Waiting;

  /** Keep this mark up now that its prompt has been answered. */
  hold(marker: Waiting): void {
    // A statement can ask twice -- `input() + input()` is one statement -- and
    // the second mark replaces the first rather than standing beside it.
    this.release();
    this.standing = marker;
    // Back to the bare mark. The question is over; the statement is not.
    marker.say();
  }

  /** Nothing is waiting any more, so nothing on screen may say it is. */
  release(): void {
    this.standing?.withdraw();
    this.standing = undefined;
  }
}

/** The two thresholds, overridable so a test need not wait 1.5 seconds. */
export interface Timing {
  readonly busyDelay?: number;
  readonly minimumBusy?: number;
}

/** What one run produced, and the marker that stood on the line for it. */
export interface Run<T> {
  readonly value: T;
  readonly waiting: Waiting;
}

/**
 * How long a result must wait so that a word already on screen is not replaced
 * within the same eye-blink.
 *
 * `shownAt` is when the busy wording was painted, or `undefined` when it never
 * was -- in which case there is nothing to hold and the answer paints at once,
 * which is every fast evaluation.
 */
export function holdFor(
  shownAt: number | undefined, now: number, minimumBusy = MINIMUM_BUSY
): number {
  if (shownAt === undefined) {
    return 0;
  }
  return Math.max(0, minimumBusy - (now - shownAt));
}

/**
 * Run one evaluation with its line marked unfinished for the whole of it.
 *
 * `begin` is called synchronously, before `work` is so much as started. That
 * order is the fix and it is why this function exists rather than two lines
 * inlined in the shell: it is the only part of the behaviour that can be
 * asserted without an editor, and it is the part that was wrong.
 *
 * The marker comes back with the value rather than being cleaned up here,
 * because what replaces it depends on what the statement produced -- a value,
 * an error, or nothing at all. A failure is the one case with no such
 * decision, so it withdraws the marker on the way out; leaving a mark on a
 * line whose evaluation blew up would be a claim that something is still
 * running.
 */
export async function whileRunning<T>(
  begin: () => Waiting,
  work: (waiting: Waiting) => Promise<T>,
  kernel: { readonly busy: () => boolean },
  timing: Timing = {}
): Promise<Run<T>> {
  const busyDelay = timing.busyDelay ?? BUSY_DELAY;
  const minimumBusy = timing.minimumBusy ?? MINIMUM_BUSY;

  // Before anything is awaited. Resolving an interpreter and spawning it is
  // itself slow the first time, so a marker applied after the kernel handle
  // has been obtained would miss the one evaluation that most needs it.
  const marker = begin();

  let shownAt: number | undefined;
  let running = false;
  /** Something more specific than "running" is on the line. */
  let claimed = false;

  const timer = setTimeout(() => {
    running = true;
    if (claimed) {
      // A prompt got there first. "running…" is true and is the less useful
      // of the two things that could be said, so it does not displace one the
      // reader has to act on.
      return;
    }
    shownAt = Date.now();
    marker.say(runningMessage(kernel.busy()));
  }, busyDelay);

  const waiting: Waiting = {
    say: (message) => {
      claimed = message !== undefined;
      // Falling back to the busy wording rather than to a bare mark: once an
      // evaluation has been slow enough to say so, answering its prompt does
      // not make it fast.
      marker.say(message ?? (running ? runningMessage(kernel.busy()) : undefined));
    },
    withdraw: () => marker.withdraw(),
  };

  let value: T;
  try {
    value = await work(waiting);
  } catch (error) {
    clearTimeout(timer);
    waiting.withdraw();
    throw error;
  }
  clearTimeout(timer);

  const hold = holdFor(shownAt, Date.now(), minimumBusy);
  if (hold > 0) {
    await new Promise((resolve) => setTimeout(resolve, hold));
  }
  return { value, waiting };
}
