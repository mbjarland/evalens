import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeInterrupt, settlesWithin } from '../interrupt';

test('work that finishes inside the delay counts as settled', async () => {
  // The ordinary case, and the reason the notification exists at all: nearly
  // every evaluation lands here, and none of them should put anything on
  // screen.
  assert.equal(await settlesWithin(Promise.resolve('42'), 1000), true);
});

test('work still running after the delay is reported as slow', async () => {
  const forever = new Promise<never>(() => undefined);
  assert.equal(await settlesWithin(forever, 5), false);
});

test('a failure counts as settled, and does not escape as unhandled', async () => {
  // Two seconds spent failing is still two seconds of nothing on screen, so
  // the notification must come down either way -- and the rejection must not
  // surface a second time from this side of the promise.
  const rejected = Promise.reject(new Error('boom'));
  assert.equal(await settlesWithin(rejected, 1000), true);
  await assert.rejects(rejected, /boom/);
});

test('a zero delay asks for the notification immediately', async () => {
  // Zero means show it now, rather than "wait zero milliseconds and hope the
  // microtask queue is on our side" -- which would report an already-resolved
  // promise as slow or not depending on scheduling.
  assert.equal(await settlesWithin(Promise.resolve(1), 0), false);
});

test('an acknowledged interrupt says the namespace survived', () => {
  // The whole reason for interrupting rather than killing. If the message does
  // not say it, the user has no way to know the session is still theirs.
  assert.match(describeInterrupt('interrupted'), /namespace is intact/);
});

test('an unacknowledged interrupt says so, and what to do about it', () => {
  // A Cancel button that silently does nothing is worse than no button. This
  // is the case where the user has a decision to make, so the message has to
  // name both halves of it: the kernel did not answer, and restarting costs
  // the namespace.
  const message = describeInterrupt('unconfirmed');
  assert.match(message, /did not answer/);
  assert.match(message, /Restart Kernel/);
  assert.match(message, /lose the namespace/);
});

test('interrupting nothing says so rather than claiming a stop', () => {
  assert.match(describeInterrupt('idle'), /nothing is running/);
});
