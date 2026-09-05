import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AnnotationRegistry } from '../render/registry';

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
