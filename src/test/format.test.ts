import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SEPARATOR, alignmentGap, collapseLines, columnWidth, errorText,
  preserveSpacing, resultText,
} from '../render/format';

const NBSP = ' ';

test('spaces become non-breaking so a value keeps its shape', () => {
  // VS Code collapses runs of ordinary spaces in contentText, which turns
  // {'a': 1, 'b': 2} into {'a':1,'b':2}. The annotation must be a faithful
  // repr(), not an approximation of one.
  assert.equal(preserveSpacing("{'a': 1}"), `{'a':${NBSP}1}`);
  assert.equal(preserveSpacing('a  b').split(NBSP).length, 3);
});

test('a multi-line repr collapses to one line', () => {
  assert.equal(collapseLines('Point(\n  x=1,\n  y=2\n)'), 'Point( x=1, y=2 )');
});

test('carriage returns collapse too', () => {
  assert.equal(collapseLines('a\r\nb'), 'a b');
});

test('a result is separated from the code it annotates', () => {
  const text = resultText('[1, 2, 3]');
  assert.ok(text.startsWith(SEPARATOR), text);
  assert.equal(text, preserveSpacing('=> [1, 2, 3]'));
});

test('an error shows its type and message, never a traceback', () => {
  const text = errorText('NameError', "name 'x' is not defined");
  assert.equal(text, preserveSpacing("=> NameError: name 'x' is not defined"));
});

test('an error with no message still names its type', () => {
  assert.equal(errorText('KeyboardInterrupt', ''),
    preserveSpacing('=> KeyboardInterrupt'));
});

test('a value that is itself None renders as None, not as nothing', () => {
  // repr(None) is a real answer -- `xs.append(1)` returns None and the user
  // should see that rather than an empty annotation.
  assert.equal(resultText('None'), preserveSpacing('=> None'));
});

test('a tab is worth its tab stop, not one column', () => {
  // A file indented with tabs would otherwise align to a column nowhere near
  // where its code actually ends.
  assert.equal(columnWidth('\tx = 1', 4), 9, 'tab fills to column 4, then 5 characters');
  assert.equal(columnWidth('ab\tc', 4), 5, 'the tab fills to the next stop');
  assert.equal(columnWidth('abcd\te', 4), 9);
  assert.equal(columnWidth('x = 1', 4), 5);
});

test('short lines are padded out to the target column', () => {
  assert.equal(alignmentGap(15, 80, 2), 65);
});

test('a line past the target column degrades to a gap', () => {
  // The alternative -- aligning to the longest line -- lets one statement
  // push every other result off the screen.
  assert.equal(alignmentGap(95, 80, 2), 2);
  assert.equal(alignmentGap(80, 80, 2), 2, 'exactly at the column');
  assert.equal(alignmentGap(79, 80, 2), 2, 'one short, still below minimum');
});

test('alignment can be switched off without losing the gap', () => {
  assert.equal(alignmentGap(15, 0, 2), 2);
});

test('a binding is named, Rider-style', () => {
  assert.equal(resultText('[1, 2, 3]', 'lst'),
    preserveSpacing('lst: [1, 2, 3]'));
});

test('a dotted name is still a binding', () => {
  assert.equal(resultText('7', 'self.count'),
    preserveSpacing('self.count: 7'));
});

test('an expression keeps the arrow instead of being echoed', () => {
  // `sum([10, 20]): 30` repeats the line back at the reader and crowds out
  // the only new information on it.
  assert.equal(resultText('30', 'sum([10, 20])'), preserveSpacing('=> 30'));
  assert.equal(resultText('12', 'area(3, 4)'), preserveSpacing('=> 12'));
  assert.equal(resultText("'k'", "d['k']"), preserveSpacing("=> 'k'"));
});

test('no display at all falls back to the arrow', () => {
  assert.equal(resultText('42'), preserveSpacing('=> 42'));
  assert.equal(resultText('42', null), preserveSpacing('=> 42'));
});
