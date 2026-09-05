import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ASK_MARK, BUSY_DELAY, BlockedMark, FLASH, MARK, MINIMUM_BUSY, Waiting,
  askingMessage, holdFor, isAsking, pendingText, runningMessage, whileRunning,
} from '../render/status';

/** A marker that writes down everything it was told, in order. */
function recorder(): { waiting: Waiting; said: string[] } {
  const said: string[] = [];
  return {
    said,
    waiting: {
      say: (message) => said.push(message === undefined ? '(mark)' : message),
      withdraw: () => said.push('(withdrawn)'),
    },
  };
}

const IDLE = { busy: () => false };
const BUSY = { busy: () => true };

/** Short enough that the suite does not spend seconds proving a threshold. */
const QUICK = { busyDelay: 10, minimumBusy: 40 };

test('a pending statement with nothing to say is just the mark', () => {
  assert.equal(pendingText({}), MARK);
  assert.equal(pendingText({ message: '   ' }), MARK);
});

test('a bare pending statement is never mistaken for a question', () => {
  assert.equal(isAsking({}), false);
  assert.equal(isAsking(undefined), false);
  assert.equal(isAsking({ message: 'running…' }), false);
});

test('an asking message is told apart from a running one', () => {
  // The whole mechanism #97 needs: `Pending` has one field, `message`, and
  // the two states it can mean travel inside that one string.
  assert.equal(isAsking({ message: askingMessage('Enter a value:') }), true);
  assert.equal(isAsking({ message: 'Enter a value:' }), false);
});

test('asking paints the question glyph, never the hourglass', () => {
  const text = pendingText({ message: askingMessage('Enter a value:') })
    .replace(/\u00a0/g, ' ');
  assert.equal(text, `${ASK_MARK} Enter a value:`);
  assert.ok(!text.includes(MARK), 'the hourglass must not leak through');
});

test('a bare asking mark is the question glyph alone', () => {
  assert.equal(pendingText({ message: askingMessage('') }), ASK_MARK);
});

test('a pending statement carries what it is waiting for', () => {
  // The whole reason this is not a boolean. "Still running" and "waiting for
  // you to type an answer to `Enter a value:`" are different things, and the
  // reader has to be able to tell which one is happening.
  assert.equal(
    pendingText({ message: 'Enter a value:' }).replace(/\u00a0/g, ' '),
    `${MARK} Enter a value:`);
});

test('an absurd prompt is trimmed rather than pushed across the screen', () => {
  const text = pendingText({ message: 'x'.repeat(400) });
  assert.ok(text.length < 80, 'the annotation shares the line with the code');
  assert.ok(text.endsWith('…'));
});

test('a multi-line prompt is collapsed onto the one line it has', () => {
  assert.equal(
    pendingText({ message: 'pick one:\n  a\n  b' }).replace(/\u00a0/g, ' '),
    `${MARK} pick one: a b`);
});

test('slow and not-started-yet are worded apart', () => {
  // Jupyter cannot separate these -- the queueing happens inside ZeroMQ where
  // its frontend cannot see it -- and its `[*]` has meant all of them for a
  // decade. Here the kernel reports `busy` on the control channel, so they are
  // two facts rather than one unknown.
  assert.notEqual(runningMessage(true), runningMessage(false));
  assert.match(runningMessage(true), /running/);
  assert.match(runningMessage(false), /kernel/);
});

test('the answer waits only when a word is already on screen', () => {
  // VS Code's MIN_SPINNER_TIME, which the research on the interrupt ticket
  // found alongside the delay before showing: two thresholds, not one.
  assert.equal(holdFor(undefined, 5_000), 0, 'nothing was shown to hold');
  assert.equal(holdFor(1_000, 1_100), MINIMUM_BUSY - 100);
  assert.equal(holdFor(1_000, 1_000 + MINIMUM_BUSY), 0);
  assert.equal(holdFor(1_000, 9_999), 0, 'never negative');
});

test('the two thresholds are the ones the research found', () => {
  assert.equal(BUSY_DELAY, 1000, "Classic Notebook's busy-favicon delay");
  assert.equal(MINIMUM_BUSY, 500, "VS Code's MIN_SPINNER_TIME");
  assert.equal(FLASH, 200, "Julia's evaluated-range flash");
});

test('the line is marked before the kernel is asked', async () => {
  // The fix, stated as an order. Marking on the response would leave the fast
  // path -- which is nearly every evaluation -- with no transition at all,
  // which is exactly the bug: a re-evaluation repaints the same string and
  // the keypress looks ignored.
  const order: string[] = [];
  const { waiting } = recorder();

  await whileRunning(
    () => { order.push('marked'); return waiting; },
    async () => { order.push('asked'); return 'value'; },
    IDLE, QUICK);

  assert.deepEqual(order, ['marked', 'asked']);
});

test('a fast evaluation never says it is running', async () => {
  // A word that appears and vanishes inside one video frame reads as a glitch.
  const { waiting, said } = recorder();
  const run = await whileRunning(
    () => waiting, async () => 42, IDLE, QUICK);

  assert.equal(run.value, 42);
  assert.deepEqual(said, [], 'nothing had to be said; it was already over');
});

test('a slow evaluation says so, and holds the word once said', async () => {
  const { waiting, said } = recorder();
  const started = Date.now();

  await whileRunning(
    () => waiting,
    () => new Promise((resolve) => setTimeout(() => resolve(1), 20)),
    BUSY, QUICK);

  assert.deepEqual(said, [runningMessage(true)]);
  assert.ok(Date.now() - started >= QUICK.minimumBusy,
    'the answer replaced the word within the same eye-blink');
});

test('a prompt outranks "still running" and is not overwritten by it', async () => {
  // Both are true at that moment. Only one of them is something the reader has
  // to act on, and it is not the one the extension generated about itself.
  const { waiting, said } = recorder();

  await whileRunning(
    () => waiting,
    async (marker) => {
      marker.say('Enter a value:');
      await new Promise((resolve) => setTimeout(resolve, 30));
      return 'Ada';
    },
    BUSY, QUICK);

  assert.deepEqual(said, ['Enter a value:']);
});

test('an answered prompt falls back to the running word, not to silence', async () => {
  // Answering a prompt does not make a slow evaluation fast. Dropping to a
  // bare mark would take information off the line for no reason.
  const { waiting, said } = recorder();

  await whileRunning(
    () => waiting,
    async (marker) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      marker.say('Enter a value:');
      marker.say();
      return 'Ada';
    },
    BUSY, QUICK);

  assert.deepEqual(
    said, [runningMessage(true), 'Enter a value:', runningMessage(true)]);
});

test('a failed evaluation takes its mark with it', async () => {
  // A mark left on a line whose evaluation blew up is a claim that something
  // is still running there.
  const { waiting, said } = recorder();

  await assert.rejects(
    whileRunning(
      () => waiting,
      async () => { throw new Error('the kernel exited'); },
      IDLE, QUICK),
    /the kernel exited/);

  assert.deepEqual(said, ['(withdrawn)']);
});

test('re-evaluating an identical value still shows a transition', async () => {
  // The reported bug, at the layer where the fix lives. Since loading a file
  // paints every value, pressing the key on an already-annotated line
  // repaints the same string -- so comparing the painted text can never be
  // the evidence that anything happened. The evidence is the sequence: the
  // value goes, the mark stands, the value comes back, and the range is
  // emphasised for a moment on the way.
  //
  // Whether the pixels actually move is checked by hand in the Extension
  // Development Host, per the co-working doc; what is checked here is that
  // the extension asks for the transition at all, every time, including the
  // time the answer does not change.
  const screen: string[] = [];
  const surface: Waiting = {
    say: () => screen.push('pending'),
    withdraw: () => screen.push('cleared'),
  };

  for (let press = 0; press < 2; press += 1) {
    const run = await whileRunning(
      () => { screen.push('pending'); return surface; },
      async () => 'lst: [1, 2, 3]',
      IDLE, QUICK);
    assert.equal(run.value, 'lst: [1, 2, 3]', 'the same string both times');
    run.waiting.withdraw();
    screen.push('settled');
  }

  assert.deepEqual(screen, [
    'pending', 'cleared', 'settled',
    'pending', 'cleared', 'settled',
  ], 'the second keypress must change the screen as much as the first');
});

test('a load\'s mark outlives the box it was put up for', () => {
  // The half of #82 that is not about painting values. Answering a prompt used
  // to take the mark away, leaving the statement that asked still running --
  // opening a file, calling a service, doing whatever it wanted the value for
  // -- with nothing on screen saying so. What the reader saw was a line that
  // went quiet without producing anything.
  const { waiting, said } = recorder();
  const blocked = new BlockedMark();

  waiting.say('who? ');
  blocked.hold(waiting);

  assert.deepEqual(said, ['who? ', '(mark)'],
    'the question is over, so the wording goes; the statement is not, so the '
    + 'mark stays');
});

test('the mark is taken back when its statement reports', () => {
  const { waiting, said } = recorder();
  const blocked = new BlockedMark();

  blocked.hold(waiting);
  blocked.release();

  assert.deepEqual(said, ['(mark)', '(withdrawn)']);
});

test('releasing twice withdraws once', () => {
  // A load releases on the next outcome and again when the load ends, and
  // those are the same mark whenever the prompting statement was the last one
  // in the file. A second withdrawal would be a second repaint of a document
  // nothing changed about.
  const { waiting, said } = recorder();
  const blocked = new BlockedMark();

  blocked.hold(waiting);
  blocked.release();
  blocked.release();

  assert.deepEqual(said, ['(mark)', '(withdrawn)']);
});

test('a second prompt from one statement replaces the first mark', () => {
  // `answer = input() + input()` is one statement and two questions. Two marks
  // held at once would leave the first behind when the second is released,
  // which is a line claiming to be running something that finished.
  const first = recorder();
  const second = recorder();
  const blocked = new BlockedMark();

  blocked.hold(first.waiting);
  blocked.hold(second.waiting);
  blocked.release();

  assert.deepEqual(first.said, ['(mark)', '(withdrawn)']);
  assert.deepEqual(second.said, ['(mark)', '(withdrawn)']);
});
