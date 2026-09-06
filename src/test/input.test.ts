import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ESCAPE_HINT, LoadPrompts, SKIP_HINT, SKIP_LABEL, cursorWatchPrefill,
  enclosingLoopHeader, locatedTitle, offersSkip, promptLabel, waitingLabel,
} from '../input';

/** `lineText` for `enclosingLoopHeader`, over a fixed array of lines. */
function linesOf(source: string): (line: number) => string {
  const lines = source.split('\n');
  return (line: number) => lines[line];
}

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

test('the box title names the line and the code that asked', () => {
  // `showInputBox` floats at the top of the window while the statement that
  // asked can be anywhere -- this is the whole of what ties the two together.
  assert.equal(
    locatedTitle(12, 'x = input("give me a value: ")'),
    'line 13 · x = input("give me a value: ")');
});

test('a long line is trimmed the same way a prompt is', () => {
  const title = locatedTitle(0, 'x'.repeat(1000));
  assert.ok(title.length < 250, 'a title is not where to discover a bug');
  assert.ok(title.endsWith('…'));
});

test('a bare loop header is found immediately above its body', () => {
  const lines = linesOf('total = 0\nfor x in data:\n    total += x\n');
  assert.equal(enclosingLoopHeader(lines, 2), 1);
});

test('an expression on the loop\'s own header line finds itself', () => {
  const lines = linesOf('for x in data:\n    pass\n');
  assert.equal(enclosingLoopHeader(lines, 0), 0);
});

test('a nested loop finds the innermost header, not the outer one', () => {
  const lines = linesOf(
    'for i in range(3):\n'
    + '    total = 0\n'
    + '    for j in range(3):\n'
    + '        total += i * j\n');
  assert.equal(enclosingLoopHeader(lines, 3), 2,
    'the line between the two loops is only inside the outer one');
  assert.equal(enclosingLoopHeader(lines, 1), 0);
});

test('async for is found the same way for is', () => {
  const lines = linesOf('async for chunk in stream:\n    process(chunk)\n');
  assert.equal(enclosingLoopHeader(lines, 1), 0);
});

test('blank lines and comments between the header and the body are skipped',
  () => {
    const lines = linesOf(
      'for x in data:\n'
      + '\n'
      + '    # comment\n'
      + '    total += x\n');
    assert.equal(enclosingLoopHeader(lines, 3), 0);
  });

test('no enclosing loop at all is said honestly, not guessed at', () => {
  const lines = linesOf('total = 0\ntotal += 1\n');
  assert.equal(enclosingLoopHeader(lines, 1), undefined);
});

test('a for inside a function is found without the def confusing the scan',
  () => {
    const lines = linesOf(
      'def total_of(data):\n'
      + '    total = 0\n'
      + '    for x in data:\n'
      + '        total += x\n'
      + '    return total\n');
    assert.equal(enclosingLoopHeader(lines, 3), 2);
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

// -- #106: what the watch box prefills with nothing selected -----------------

test('a bare name is offered, touching either edge of the word counts',
  () => {
    const line = '    total += x';
    assert.equal(cursorWatchPrefill(line, 4), 'total',
      'resting immediately before the word still counts as on it');
    assert.equal(cursorWatchPrefill(line, 7), 'total', 'the middle of it');
    assert.equal(cursorWatchPrefill(line, 9), 'total',
      'resting immediately after the word still counts as on it');
  });

test('a keyword is never offered, however often a cursor lands on one', () => {
  // "for", "in", "if" and "not" are the loudest case #106 names by name:
  // the words a beginner's cursor sits on constantly inside a loop header.
  const forIn = 'for x in data:';
  assert.equal(cursorWatchPrefill(forIn, 1), '', '"for"');
  assert.equal(cursorWatchPrefill(forIn, 8), '', '"in"');
  const ifNot = 'if not seen:';
  assert.equal(cursorWatchPrefill(ifNot, 0), '', '"if"');
  assert.equal(cursorWatchPrefill(ifNot, 4), '', '"not"');
});

test('a word inside a string literal is declined, not offered as a name',
  () => {
    const line = "greeting = 'hello world'";
    assert.equal(cursorWatchPrefill(line, 14), '',
      'the cursor sits on text the quotes hold, not a name in scope');
  });

test('a word inside a comment is declined, but code before the # is not',
  () => {
    const line = 'value  # comment';
    assert.equal(cursorWatchPrefill(line, 12), '',
      'a word from the comment itself');
    assert.equal(cursorWatchPrefill(line, 2), 'value',
      'the code before the # is unaffected by the comment after it');
  });

test('a number is declined -- it is a literal, never an identifier', () => {
  assert.equal(cursorWatchPrefill('x = 42', 5), '');
  assert.equal(cursorWatchPrefill('x = 0x1F', 6), '',
    'a hex literal is still a token that starts with a digit');
});

test('whitespace, and an empty line, have no word to offer', () => {
  assert.equal(cursorWatchPrefill('    total += x', 0), '');
  assert.equal(cursorWatchPrefill('', 0), '');
});

test('an attribute name is declined, but the name before the dot is not',
  () => {
    // obj.attr is exactly the multi-token reach #48 and #104 both declined
    // to add here -- "attr" alone reads as ordinary Python but is essentially
    // never itself a bound name, so it is declined the same way a keyword is.
    const line = 'value = obj.attr';
    assert.equal(cursorWatchPrefill(line, 13), '', 'cursor on "attr"');
    assert.equal(cursorWatchPrefill(line, 9), 'obj',
      'the base name is an ordinary bare identifier');
  });
