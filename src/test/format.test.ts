import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SEPARATOR, collapseLines, errorText, preserveSpacing, resultText,
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
