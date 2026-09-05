import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AnnotationRegistry, merge, overlaps } from '../render/registry';

test('annotations belong to a document, not to the window', () => {
  const registry = new AnnotationRegistry<string>();
  registry.set('a.py', ['one']);
  registry.set('b.py', ['two']);
  registry.clear('a.py');
  assert.deepEqual(registry.get('b.py'), ['two'],
    'editing one document must not clear another');
  assert.deepEqual(registry.get('a.py'), []);
});

test('clear reports whether it changed anything', () => {
  // onDidChangeTextDocument fires on every keystroke in every open document.
  // Repainting on each -- almost always to clear nothing -- is thousands of
  // pointless calls an hour.
  const registry = new AnnotationRegistry<string>();
  registry.set('a.py', ['one']);
  assert.equal(registry.clear('a.py'), true);
  assert.equal(registry.clear('a.py'), false);
  assert.equal(registry.clear('never-annotated.py'), false);
});

test('setting an empty list is the same as clearing', () => {
  const registry = new AnnotationRegistry<string>();
  registry.set('a.py', ['one']);
  registry.set('a.py', []);
  assert.equal(registry.has('a.py'), false,
    'an empty entry would keep the Escape context key stuck on');
});

test('closing a document leaves nothing behind', () => {
  const registry = new AnnotationRegistry<string>();
  registry.set('a.py', ['one']);
  registry.forget('a.py');
  assert.equal(registry.documentCount, 0,
    'the map would otherwise grow for the life of the window');
});

test('clearAll reports which documents need repainting', () => {
  const registry = new AnnotationRegistry<string>();
  registry.set('a.py', ['one']);
  registry.set('b.py', ['two']);
  assert.deepEqual(registry.clearAll().sort(), ['a.py', 'b.py']);
  assert.equal(registry.documentCount, 0);
  assert.deepEqual(registry.clearAll(), []);
});

test('replacing annotations does not accumulate them', () => {
  const registry = new AnnotationRegistry<string>();
  registry.set('a.py', ['one']);
  registry.set('a.py', ['two']);
  assert.deepEqual(registry.get('a.py'), ['two']);
});

test('annotations accumulate, so a file reads as a worked example', () => {
  // IDEA.md opens with two values visible at once. Replacing rather than
  // adding shows one at a time and the feature reads as a status bar.
  const a = { range: { start: { line: 0 }, end: { line: 0 } }, id: 'a' };
  const b = { range: { start: { line: 3 }, end: { line: 3 } }, id: 'b' };
  assert.deepEqual(merge(merge([], a), b).map((x) => x.id), ['a', 'b']);
});

test('re-evaluating a statement updates it instead of stacking', () => {
  const first = { range: { start: { line: 0 }, end: { line: 0 } }, id: 'old' };
  const again = { range: { start: { line: 0 }, end: { line: 0 } }, id: 'new' };
  assert.deepEqual(merge([first], again).map((x) => x.id), ['new']);
});

test('a nested range displaces the one containing it, and vice versa', () => {
  // Evaluate a line inside a function, then the function: one range contains
  // the other, and painting both puts two values on one line.
  const inner = { range: { start: { line: 2 }, end: { line: 2 } }, id: 'inner' };
  const outer = { range: { start: { line: 1 }, end: { line: 4 } }, id: 'outer' };
  assert.deepEqual(merge([inner], outer).map((x) => x.id), ['outer']);
  assert.deepEqual(merge([outer], inner).map((x) => x.id), ['inner']);
});

test('a multi-line statement displaces annotations on any line it covers', () => {
  const one = { range: { start: { line: 1 }, end: { line: 1 } }, id: 'one' };
  const two = { range: { start: { line: 5 }, end: { line: 5 } }, id: 'two' };
  const spanning = { range: { start: { line: 0 }, end: { line: 3 } }, id: 'span' };
  assert.deepEqual(
    merge([one, two], spanning).map((x) => x.id), ['two', 'span']);
});

test('adjacent ranges do not overlap', () => {
  // The boundary that decides whether two consecutive one-line statements can
  // both stay annotated -- which is the whole point of accumulating.
  const first = { range: { start: { line: 0 }, end: { line: 0 } } };
  const second = { range: { start: { line: 1 }, end: { line: 1 } } };
  assert.equal(overlaps(first, second), false);
  assert.equal(overlaps(second, first), false);
});

test('ranges sharing a single line do overlap', () => {
  const spanning = { range: { start: { line: 0 }, end: { line: 2 } } };
  const touching = { range: { start: { line: 2 }, end: { line: 4 } } };
  assert.equal(overlaps(spanning, touching), true);
});
