import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AnnotationRegistry, lineDelta, merge, overlaps, reanchor,
} from '../render/registry';

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
  // The caller repaints on a true, and Escape reaches it whether or not there
  // was anything to dismiss.
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

// -- re-anchoring annotations across an edit ---------------------------------

interface Marked {
  readonly range: {
    readonly start: { readonly line: number };
    readonly end: { readonly line: number };
  };
  readonly id: string;
}

/** An annotation on `line`, or spanning down to `through`. */
function at(line: number, id: string, through = line): Marked {
  return { range: { start: { line }, end: { line: through } }, id };
}

/** What replacing lines `from`..`to` with `text` looks like to the registry. */
function edit(from: number, to: number, text: string) {
  return { range: { start: { line: from }, end: { line: to } }, text };
}

/**
 * Stands in for the shell's `vscode.Range` rebuild. Keeping the move in a
 * callback is what lets the arithmetic be tested outside the extension host.
 */
function shift(annotation: Marked, lines: number): Marked {
  return at(
    annotation.range.start.line + lines, annotation.id,
    annotation.range.end.line + lines);
}

function placed(annotations: readonly Marked[]): string[] {
  return annotations.map(
    (a) => `${a.id}@${a.range.start.line}-${a.range.end.line}`);
}

test('a line delta counts what an edit added against what it replaced', () => {
  assert.equal(lineDelta(edit(3, 3, '7')), 0, 'replace within one line');
  assert.equal(lineDelta(edit(3, 3, '\n')), 1, 'press Enter');
  assert.equal(lineDelta(edit(3, 3, 'a\nb\nc')), 2, 'paste three lines in');
  assert.equal(lineDelta(edit(3, 5, '')), -2, 'delete two line breaks');
  assert.equal(lineDelta(edit(3, 6, 'one\ntwo')), -2,
    'replace four lines with two');
  assert.equal(lineDelta(edit(3, 3, 'a\r\nb')), 1,
    'CRLF still contains exactly one line break');
});

test('editing a line drops that annotation and no other', () => {
  // The complaint that opened the ticket: change range(8) to range(7) and the
  // whole column of values you were reading goes with it.
  const before = [at(0, 'a'), at(2, 'b'), at(4, 'c')];
  const after = reanchor(before, [edit(2, 2, '7')], shift);

  assert.deepEqual(placed(after), ['a@0-0', 'c@4-4']);
  assert.equal(after[0], before[0],
    'an untouched annotation should come back as the same object');
  assert.equal(after[1], before[2]);
});

test('inserting a line above moves the annotations below it down', () => {
  // Enter pressed on line 1, which carries no annotation of its own.
  const before = [at(0, 'a'), at(2, 'b'), at(4, 'c')];
  const after = reanchor(before, [edit(1, 1, '\n')], shift);

  assert.deepEqual(placed(after), ['a@0-0', 'b@3-3', 'c@5-5'],
    'they must stay beside the statement they were the value of');
  assert.equal(after[0], before[0], 'nothing above the edit gets rebuilt');
});

test('deleting a line pulls the annotations below it up', () => {
  const before = [at(0, 'a'), at(2, 'b'), at(5, 'c', 6)];
  const after = reanchor(before, [edit(2, 3, '')], shift);

  assert.deepEqual(placed(after), ['a@0-0', 'c@4-5'],
    'the deleted line loses its own annotation; the span below follows');
});

test('a replacement drops what it covered and shifts the rest', () => {
  // Four lines pasted over two: everything below has to come down by two.
  const before = [at(0, 'a'), at(3, 'b'), at(4, 'c'), at(9, 'd')];
  const after = reanchor(before, [edit(3, 4, 'w\nx\ny\nz')], shift);

  assert.deepEqual(placed(after), ['a@0-0', 'd@11-11']);
});

test('a multi-change event applies its changes back to front', () => {
  // One event, two edits, both addressing the document as it was before the
  // event. Applied top-down the second edit's coordinates are already stale.
  const before = [at(0, 'a'), at(4, 'b'), at(8, 'c'), at(12, 'd')];
  const after = reanchor(
    before, [edit(9, 9, '\n\n'), edit(1, 1, '\n')], shift);

  assert.deepEqual(placed(after), ['a@0-0', 'b@5-5', 'c@9-9', 'd@15-15'],
    'b and c move by the first edit alone, d by both');
});

test('changes arriving front to back are reordered, not trusted', () => {
  // VS Code happens to deliver contentChanges bottom-up, but nothing in the
  // API promises it, and getting it wrong corrupts a file's annotations
  // silently.
  const before = [at(0, 'a'), at(4, 'b'), at(8, 'c'), at(12, 'd')];
  const forwards = reanchor(
    before, [edit(1, 1, '\n'), edit(9, 9, '\n\n')], shift);
  const backwards = reanchor(
    before, [edit(9, 9, '\n\n'), edit(1, 1, '\n')], shift);

  assert.deepEqual(placed(forwards), placed(backwards));
});

test('an edit that touches nothing returns the very same list', () => {
  // This runs on every keystroke. Repainting a document whose annotations all
  // sit above the cursor is thousands of pointless setDecorations calls an
  // hour, which is why identity is the signal to skip the repaint.
  const before = [at(0, 'a'), at(2, 'b')];
  assert.equal(reanchor(before, [edit(7, 7, 'x')], shift), before);
  assert.equal(reanchor(before, [], shift), before,
    'a change event with no content changes must not repaint either');
});

test('an edit reaching into the next line takes its annotation too', () => {
  // Deleting a whole line arrives as a range ending at column 0 of the line
  // after it. That line's text does not change, but overlap is decided per
  // line, so its annotation goes. Erring towards dropping is the safe side of
  // this call: a wrong value on screen costs more than a missing one.
  const before = [at(2, 'b'), at(3, 'c')];
  const after = reanchor(before, [edit(2, 3, '')], shift);

  assert.deepEqual(placed(after), []);
});
