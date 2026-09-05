import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ESCAPE_HINT, promptLabel } from '../input';

test('the prompt the code printed is what the box says', () => {
  assert.equal(promptLabel('Enter a value: '), 'Enter a value:');
});

test('a bare input() still gets a box that explains itself', () => {
  // `input()` with no argument is a thing beginner code is full of, and an
  // empty label is a box with no account of why the editor wants something.
  assert.equal(promptLabel(''), 'The evaluated code is waiting for input');
  assert.equal(promptLabel('   \n  '), 'The evaluated code is waiting for input');
});

test('an absurd prompt is trimmed rather than shown whole', () => {
  const label = promptLabel('x'.repeat(1000));
  assert.ok(label.length < 250, 'a dialog is not where to discover a bug');
  assert.ok(label.endsWith('…'));
});

test('the way out of a prompt is written on the prompt', () => {
  // Cancelling is deliberate rather than a dead end, and a student who cannot
  // find the way out of a box is worse off than one whose program errors.
  assert.match(ESCAPE_HINT, /Escape/);
  assert.match(ESCAPE_HINT, /EOFError/);
});
