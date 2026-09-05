import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ESCAPE_HINT, LoadPrompts, SKIP_HINT, SKIP_LABEL, offersSkip, promptLabel,
  waitingLabel,
} from '../input';

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

test('the line says something shorter than the box does', () => {
  // The box has the width of the window; the line shares its width with the
  // user's code.
  assert.equal(waitingLabel('Enter a value: '), 'Enter a value:');
  assert.ok(waitingLabel('').length < promptLabel('').length,
    'the line cannot afford the box\'s sentence');
  assert.equal(waitingLabel('   '), 'waiting for input');
});

test('the first prompt of a load is not asked about the rest', () => {
  // A file with one prompt would be asked whether it wants to skip the
  // nineteen it has not got. By the second, twenty boxes with no way out is a
  // real prospect, and that is the moment to say there is one.
  assert.equal(offersSkip(0), false);
  assert.equal(offersSkip(1), true);
  assert.equal(offersSkip(7), true);
});

test('skipping stops the asking for the rest of that load only', () => {
  // Two rules, both easy to get subtly wrong. The offer arrives on the second
  // prompt; once taken it holds for every prompt still to come in this load,
  // and for none in the next one, because running Load File again is the user
  // asking for the file to be loaded again.
  const load = new LoadPrompts();
  assert.equal(load.quiet, false);
  assert.equal(load.offerSkip, false, 'the first prompt makes no offer');

  load.record('value');
  assert.equal(load.offerSkip, true, 'the second prompt carries the way out');
  assert.equal(load.quiet, false, 'it was offered, not taken');

  load.record('skip');
  assert.equal(load.quiet, true, 'every later prompt is answered without a box');
  load.record('eof');
  assert.equal(load.quiet, true, 'and stays that way for the rest of the load');

  assert.equal(new LoadPrompts().quiet, false, 'the next load asks again');
});

test('cancelling one prompt is not skipping the rest', () => {
  // They both send end-of-file, which is exactly why the two have to be kept
  // apart: Escape means "not this one", and a student who escapes a prompt by
  // reflex must not silently lose every prompt after it.
  const load = new LoadPrompts();
  load.record('eof');
  load.record('eof');
  assert.equal(load.quiet, false);
});

test('skipping is described as cancelling the rest, not as abandoning', () => {
  // Both send end-of-file; skipping is every prompt still to come cancelled at
  // once. The statements that do not prompt still run, and a wording that
  // implied otherwise would stop people using the one way out.
  assert.match(SKIP_HINT, /EOFError/);
  assert.match(SKIP_HINT, /rest of the file still runs/);
  assert.match(SKIP_LABEL, /Skip/);
});
