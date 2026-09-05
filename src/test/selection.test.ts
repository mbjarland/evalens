import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Range } from '../kernel/protocol';
import { selectedLines, widenedBeyond } from '../selection';

/** A selection, written the way `vscode.Selection` presents one. */
function span(
  startLine: number, startChar: number, endLine: number, endChar: number
): Range {
  return {
    start: { line: startLine, character: startChar },
    end: { line: endLine, character: endChar },
  };
}

test('a cursor with nothing selected asks for the whole file', () => {
  // The behaviour Evaluate File has always had, and the one a selection
  // narrows rather than replaces.
  assert.equal(selectedLines(span(4, 2, 4, 2)), undefined);
});

test('a selection asks for the lines it covers', () => {
  assert.deepEqual(selectedLines(span(0, 0, 19, 12)),
    { start_line: 0, end_line: 19 });
});

test('a selection inside one line still asks for that line', () => {
  assert.deepEqual(selectedLines(span(7, 4, 7, 9)),
    { start_line: 7, end_line: 7 });
});

test('a selection ending at the start of a line stops on the line before', () => {
  // Dragging down the gutter, or Shift+Down at the end of a line, ends at
  // character 0 of the line after the last one highlighted. Nothing of that
  // line is selected and the user can see that nothing of it is; taking it at
  // face value would run a statement they never touched.
  assert.deepEqual(selectedLines(span(0, 0, 20, 0)),
    { start_line: 0, end_line: 19 });
});

test('a selection ending at the start of its own line is still that line', () => {
  // Backwards from the middle of line 3 to its start: one line, not zero.
  assert.deepEqual(selectedLines(span(3, 0, 3, 8)),
    { start_line: 3, end_line: 3 });
});

test('a run that matched the selection did not widen', () => {
  assert.equal(widenedBeyond(span(2, 0, 3, 5), span(2, 0, 3, 5)), false);
});

test('a run reaching above the selection widened', () => {
  // The selection started inside a `def`; the whole `def` ran.
  assert.equal(widenedBeyond(span(2, 0, 8, 1), span(4, 6, 8, 1)), true);
});

test('a run reaching below the selection widened', () => {
  assert.equal(widenedBeyond(span(2, 0, 8, 1), span(2, 0, 5, 3)), true);
});

test('a widening inside a single line counts as one', () => {
  // `left = 'a'; right = 'b'` with only `right = 'b'` selected: both
  // statements ran, and nothing about the line numbers says so.
  assert.equal(widenedBeyond(span(9, 0, 9, 23), span(9, 12, 9, 23)), true);
});

test('a gutter-selected run has not widened just by ending sooner', () => {
  // The selection reaches character 0 of the line below; the statements stop
  // at the end of the line above. Reporting that as a widening would put a
  // warning on the most ordinary way there is to select lines.
  assert.equal(widenedBeyond(span(0, 0, 19, 14), span(0, 0, 20, 0)), false);
});
