import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nextStop } from '../advance';
import { StatementSpan } from '../kernel/protocol';

/**
 * A statement spanning `start` to `end`, the way the kernel reports one.
 *
 * Only the range matters to the decision, so `kind` is filled in for shape
 * rather than read.
 */
function span(start: number, end = start): StatementSpan {
  return {
    kind: 'Assign',
    range: {
      start: { line: start, character: 0 },
      end: { line: end, character: 0 },
    },
  };
}

/** Statements read off a source string, so a test can be written as a file. */
function outline(source: string, ...ranges: [number, number][]): {
  statements: StatementSpan[];
  lineText: (line: number) => string;
} {
  const lines = source.split('\n');
  return {
    statements: ranges.map(([start, end]) => span(start, end)),
    lineText: (line) => lines[line] ?? '',
  };
}

test('a multi-line statement is one step, not one step per line', () => {
  // The reason this steps by statements at all: a `def` with a ten-line body
  // would otherwise cost eleven presses, ten of which re-evaluate the same
  // `def`.
  const statements = [span(0), span(1, 5), span(6)];
  const text = () => '';

  assert.deepEqual(nextStop(statements, 0, text),
    { kind: 'move', position: { line: 1, character: 0 } });
  // From anywhere inside the multi-line statement, including its last line.
  for (const line of [1, 2, 3, 4, 5]) {
    assert.deepEqual(nextStop(statements, line, text),
      { kind: 'move', position: { line: 6, character: 0 } });
  }
});

test('blank lines and comments between statements are stepped over', () => {
  const { statements, lineText } = outline(
    'a = 1\n\n# a comment about b\n# and a second line of it\n\nb = 2\n',
    [0, 0], [5, 5]);

  assert.deepEqual(nextStop(statements, 0, lineText),
    { kind: 'move', position: { line: 5, character: 0 } });
});

test('the last statement stays put and says so, rather than wrapping', () => {
  // Wrapping would re-run a file the user has just finished walking -- every
  // side effect in it, a second time, on the press that was meant to stop.
  const statements = [span(0), span(1)];
  assert.deepEqual(nextStop(statements, 1, () => ''), { kind: 'end' });
});

test('a file with no statements at all has nowhere to go', () => {
  assert.deepEqual(nextStop([], 0, () => ''), { kind: 'end' });
});

test('a cursor above the first statement steps on to it', () => {
  // Which is how walking a file starts: the top of a teaching file is a
  // paragraph of comments, and the first press has to leave it.
  const { statements, lineText } = outline(
    '# what this file is for\n#\n# and how to read it\n\nimport os\n',
    [4, 4]);

  assert.deepEqual(nextStop(statements, 0, lineText),
    { kind: 'move', position: { line: 4, character: 0 } });
});

test('a trailing comment after the last statement is not a stop', () => {
  // Even with comment stops on. A comment on the way to a statement is an
  // explanation of it; one after the last statement is on the way to nothing,
  // and the walk is over.
  const { statements, lineText } = outline(
    'a = 1\n\n# nothing follows this\n', [0, 0]);

  assert.deepEqual(nextStop(statements, 0, lineText, true), { kind: 'end' });
});

test('two statements on one line are one stop', () => {
  // A cursor gives a line, and resolution is line-based (#18), so stopping on
  // that line twice would evaluate the first of them twice and never reach
  // the second.
  const statements = [span(3), span(3), span(4)];

  assert.deepEqual(nextStop(statements, 3, () => ''),
    { kind: 'move', position: { line: 4, character: 0 } });
});

test('with comment stops on, the walk pauses once per block', () => {
  // Once per block and not once per line: a six-line explanatory paragraph is
  // one thing to read, and six presses to get past it is how a setting gets
  // turned back off.
  const { statements, lineText } = outline(
    'a = 1\n# first line of the paragraph\n# second line of it\n# third\nb = 2\n',
    [0, 0], [4, 4]);

  assert.deepEqual(nextStop(statements, 0, lineText, true),
    { kind: 'move', position: { line: 1, character: 0 } });
  // Standing in the block, the next press leaves it rather than crawling.
  assert.deepEqual(nextStop(statements, 1, lineText, true),
    { kind: 'move', position: { line: 4, character: 0 } });
});

test('two comment blocks split by a blank line are two stops', () => {
  const { statements, lineText } = outline(
    'a = 1\n# section heading\n\n# what the next line does\nb = 2\n',
    [0, 0], [4, 4]);

  assert.deepEqual(nextStop(statements, 0, lineText, true),
    { kind: 'move', position: { line: 1, character: 0 } });
  assert.deepEqual(nextStop(statements, 1, lineText, true),
    { kind: 'move', position: { line: 3, character: 0 } });
  assert.deepEqual(nextStop(statements, 3, lineText, true),
    { kind: 'move', position: { line: 4, character: 0 } });
});

test('a comment stop lands on the `#`, not on column zero', () => {
  const { statements, lineText } = outline(
    'a = 1\n    # indented, and still a comment\nb = 2\n', [0, 0], [2, 2]);

  assert.deepEqual(nextStop(statements, 0, lineText, true),
    { kind: 'move', position: { line: 1, character: 4 } });
});

test('a trailing comment on a code line is not a comment line', () => {
  const { statements, lineText } = outline(
    'a = 1  # the annotation shares this line\nb = 2\n', [0, 0], [1, 1]);

  assert.deepEqual(nextStop(statements, 0, lineText, true),
    { kind: 'move', position: { line: 1, character: 0 } });
});

test('a comment inside a multi-line statement is never a stop', () => {
  // The `#` is inside the statement's range, so it is never in the gap this
  // looks at -- which is the mistake a text scan makes when it is free to look
  // anywhere. The same protection covers a `#` inside a string literal.
  const { statements, lineText } = outline(
    'matrix = [\n    [1, 2],\n    # a comment in the middle of a statement\n' +
    '    [3, 4],\n]\ntail = 42\n',
    [0, 4], [5, 5]);

  assert.deepEqual(nextStop(statements, 0, lineText, true),
    { kind: 'move', position: { line: 5, character: 0 } });
});

test('the step is to the start of the next statement, not its anchor', () => {
  // A compound statement's value is written beside its header and a multi-line
  // assignment's beside its last line; the cursor belongs at the top of what
  // it is about to run either way.
  const statements: StatementSpan[] = [
    span(0),
    { ...span(1, 4), kind: 'FunctionDef', anchor: 1 },
  ];

  assert.deepEqual(nextStop(statements, 0, () => ''),
    { kind: 'move', position: { line: 1, character: 0 } });
});
