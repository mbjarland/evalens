import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AnnotationRegistry, afterEdit, lineDelta, markDependents, markerFor, merge,
  normalizeSource, overlaps, reanchor,
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
 *
 * Generic so it can move an annotation carrying a value and a mark as well as
 * a bare one -- and the spread is the point: everything but the range comes
 * across, which is what keeps a stale marker attached to a line that moved.
 */
function shift<T extends Marked>(annotation: T, lines: number): T {
  return {
    ...annotation,
    range: {
      start: { line: annotation.range.start.line + lines },
      end: { line: annotation.range.end.line + lines },
    },
  };
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

test('editing a line drops that annotation when nothing can judge it', () => {
  // The three-argument form is for callers with no document to compare
  // against, and it keeps the older, blunter answer. The fourth argument is
  // what turns a drop into a mark, and it is what the extension passes.
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

// -- staleness ---------------------------------------------------------------

/** An annotation carrying the two things staleness is decided from. */
interface Valued extends Marked {
  readonly value: string;
  readonly source?: string;
  readonly stale?: boolean;
  readonly staleReason?: 'edited' | 'dependency';
}

/** One annotation per line, as evaluating each line in turn would leave. */
function evaluatedLines(lines: readonly string[]): Valued[] {
  return lines.map((text, line) => ({
    range: { start: { line }, end: { line } },
    id: `line${line}`,
    value: `v${line}`,
    source: normalizeSource(text),
  }));
}

/**
 * The callback the editor shell passes: read the lines the annotation now
 * covers out of the document, and decide from those.
 */
function against(lines: readonly string[]) {
  return (annotation: Valued): Valued | undefined => afterEdit(
    annotation, normalizeSource(
      lines.slice(annotation.range.start.line, annotation.range.end.line + 1)
        .join('\n')));
}

function markers(annotations: readonly Valued[]): boolean[] {
  return annotations.map((a) => a.stale === true);
}

test('normalising only folds physical CRLF line endings', () => {
  // Whitespace equivalence needs Python token context. Only physical line
  // endings have a safe context-independent normalization here.
  assert.equal(normalizeSource('x = 1  '), 'x = 1  ', 'a trailing space');
  assert.equal(normalizeSource('    x = 1'), '    x = 1', 'reindentation');
  assert.equal(normalizeSource('x = 1\r\ny = 2'), 'x = 1\ny = 2');
  assert.equal(normalizeSource('if x:\n\n    pass'), 'if x:\n\n    pass',
    'a blank line added inside a statement');
  assert.notEqual(normalizeSource('x = 1'), normalizeSource('x = 2'),
    'a real change has to survive normalisation');
  assert.notEqual(normalizeSource('x=1'), normalizeSource('x = 1'),
    'folding these together would need a tokeniser, and would hide real edits');
});

test('editing a line marks it stale and leaves every value alone', () => {
  // The ticket's acceptance case. Three lines evaluated, the first edited: its
  // marker goes amber, the other two stay green, and nothing on screen moves.
  const before = evaluatedLines(['x = 1', 'y = 2', 'z = 3']);
  const after = reanchor(
    before, [edit(0, 0, '5')], shift, against(['x = 5', 'y = 2', 'z = 3']));

  assert.deepEqual(markers(after), [true, false, false]);
  assert.deepEqual(after.map((a) => a.value), ['v0', 'v1', 'v2'],
    'the marker is the whole of what changes; the values are a trace and stay');
  assert.equal(after[1], before[1],
    'an annotation the edit did not touch must not even be rebuilt');
});

test('editing a line records that an edit is why it went stale (#109)', () => {
  // The hover (`render/hover.ts`) has to tell this apart from a dependency
  // mark, and `afterEdit` is the one place that can say it happened here --
  // recovering it later from `stale` alone is not possible, `stale` being
  // only a boolean.
  const [marked] = reanchor(
    evaluatedLines(['x = 1']), [edit(0, 0, '5')], shift, against(['x = 5']));
  assert.equal(marked?.staleReason, 'edited');
});

test('undoing the edit preserves the reason, not only the mark (#109)', () => {
  // `afterEdit`'s undo case returns the same object rather than a copy, so
  // this is really the same guarantee as "undoing the edit does not clear
  // stale" above -- written separately because a reader of this file should
  // not have to infer that identity carries the reason along for free.
  const before = evaluatedLines(['x = 1']);
  const edited = reanchor(
    before, [edit(0, 0, '5')], shift, against(['x = 5']));
  const undone = reanchor(
    edited, [edit(0, 0, '1')], shift, against(['x = 1']));
  assert.equal(undone[0]?.staleReason, 'edited');
});

test('re-evaluating is what clears stale, and nothing else is', () => {
  // Not a rule enforced anywhere: the annotation an evaluation produces simply
  // has no mark on it, and merge puts it where the marked one was. There is no
  // code path that unsets the flag, which is the point.
  const [marked] = reanchor(
    evaluatedLines(['x = 1']), [edit(0, 0, '5')], shift, against(['x = 5']));
  assert.equal(marked?.stale, true);

  const rerun: Valued = {
    range: { start: { line: 0 }, end: { line: 0 } },
    id: 'line0', value: '5', source: 'x = 5',
  };
  assert.deepEqual(merge([marked!], rerun).map((a) => a.stale), [undefined]);
});

test('undoing the edit does not clear stale', () => {
  // The case that decides whether this feature is honest. The buffer can be
  // put back; the kernel cannot, because nobody told it anything. Clearing the
  // marker here would assert that the two agree again, which is a claim
  // nothing has checked -- and the same undo after a re-evaluation would be
  // asserting something flatly untrue.
  const before = evaluatedLines(['x = 1']);
  const edited = reanchor(
    before, [edit(0, 0, '5')], shift, against(['x = 5']));
  const undone = reanchor(
    edited, [edit(0, 0, '1')], shift, against(['x = 1']));

  assert.deepEqual(markers(undone), [true],
    'the text matches again; the value the kernel holds does not');
});

test('a whitespace-only edit is conservatively marked stale', () => {
  const before = evaluatedLines(['x = 1', 'y = 2']);
  const after = reanchor(
    before, [edit(0, 0, ' ')], shift, against(['x = 1  ', 'y = 2']));

  assert.deepEqual(markers(after), [true, false]);
});

test('reindenting a block is conservatively marked stale', () => {
  const before: Valued[] = [{
    range: { start: { line: 0 }, end: { line: 1 } },
    id: 'def', value: '<function f>',
    source: normalizeSource('def f():\n    return 1'),
  }];
  const after = reanchor(
    before, [edit(1, 1, '        ')], shift,
    against(['def f():', '        return 1']));

  assert.deepEqual(markers(after), [true]);
});

test('relative indentation and multiline literal whitespace change the trace', () => {
  for (const [before, after] of [
    ['if a:\n    if b:\n        x = 1\n    y = 2',
      'if a:\n    if b:\n        x = 1\n        y = 2'],
    ['s = """a\n  b\n"""', 's = """a\nb\n"""'],
    ['s = """a\n\nb"""', 's = """a\nb"""'],
    ['s = """a  \nb"""', 's = """a\nb"""'],
  ]) {
    const annotation: Valued = {
      id: 'source', value: 'trace',
      range: { start: { line: 0 }, end: { line: 3 } },
      source: normalizeSource(before),
    };
    assert.equal(afterEdit(annotation, normalizeSource(after))?.stale, true);
  }
});

test('an annotation with no recorded source is marked, not trusted', () => {
  const before: Valued[] = [{
    range: { start: { line: 0 }, end: { line: 0 } }, id: 'a', value: 'v',
  }];
  const after = reanchor(before, [edit(0, 0, 'x')], shift, against(['x = 1']));

  assert.deepEqual(markers(after), [true],
    'unknown has to count as changed, or the marker means nothing');
});

test('an edit that changes the line count still drops what it covered', () => {
  // Splitting a statement in two leaves no statement for the value to sit
  // beside. A marked annotation pinned to half of one, or to whatever the
  // paste put there, is the failure the marker exists to prevent.
  const before = evaluatedLines(['x = 1', 'y = 2']);
  const after = reanchor(
    before, [edit(0, 0, '\n')], shift, against(['x = ', '1', 'y = 2']));

  assert.deepEqual(placed(after), ['line1@2-2']);
  assert.deepEqual(markers(after), [false],
    'the surviving annotation moved; nothing about it changed');
});

test('a mark is decided after every change, not while they are applied', () => {
  // One event, two cursors: a space appended to the annotated line at the
  // bottom, and a line inserted above it. The annotation ends up one line
  // lower than it started, and the whitespace rule only holds if the
  // comparison reads it there. Reading it where it used to be finds a blank
  // line, decides the statement changed beyond recognition, and paints amber
  // for an edit that was a space.
  const before: Valued[] = [
    {
      range: { start: { line: 0 }, end: { line: 0 } },
      id: 'top', value: 'v0', source: 'x = 1',
    },
    {
      range: { start: { line: 2 }, end: { line: 2 } },
      id: 'bottom', value: 'v2', source: 'y = 2',
    },
  ];
  const after = reanchor(
    before, [edit(2, 2, ' '), edit(1, 1, '\n')], shift,
    against(['x = 1', '', '', 'y = 2 ']));

  assert.deepEqual(placed(after), ['top@0-0', 'bottom@3-3']);
  assert.deepEqual(markers(after), [false, true]);
});

// -- orphaned annotations (#96) -----------------------------------------------

test('commenting out a statement drops the annotation instead of marking it stale', () => {
  // The bug's own screenshot: `x = input(...)` becomes `# x = input(...)`.
  // The line count does not change, so this lands in the same branch as an
  // ordinary edit -- the one that used to always answer "stale". Stale would
  // claim a statement is there to be out of sync with the kernel; a comment
  // is not a statement, so there is nothing left to be stale.
  const before = evaluatedLines(['x = 1', 'y = 2']);
  const after = reanchor(
    before, [edit(0, 0, '# ')], shift, against(['# x = 1', 'y = 2']));

  assert.deepEqual(placed(after), ['line1@1-1'],
    'the commented-out statement is gone; the untouched line stays put');
  assert.equal(after[0], before[1],
    'the surviving annotation was not even rebuilt');
});

test("emptying a statement's line drops the annotation, not marks it stale", () => {
  // Selecting the statement's text and deleting it, leaving the blank line
  // behind, is the same shape as commenting it out: the edit does not change
  // the line count, but there is no statement left on that line either.
  const before = evaluatedLines(['x = 1', 'y = 2']);
  const after = reanchor(before, [edit(0, 0, '')], shift, against(['', 'y = 2']));

  assert.deepEqual(placed(after), ['line1@1-1']);
});

test('a fully commented multi-line statement is dropped, not marked stale', () => {
  const before: Valued[] = [{
    range: { start: { line: 0 }, end: { line: 1 } },
    id: 'def', value: '<function f>',
    source: normalizeSource('def f():\n    return 1'),
  }];
  const after = reanchor(
    before, [edit(0, 1, '# def f():\n    # return 1')], shift,
    against(['# def f():', '    # return 1']));

  assert.deepEqual(after, []);
});

test('only part of a multi-line statement commented out still marks it stale', () => {
  // Something is still there -- an unindented `def` with no body is not
  // nothing -- and dropping it would be a bigger guess than this module can
  // make without a parser. Marking it is the safe side of the same guess
  // `normalizeSource` already makes: over-marking over over-dropping.
  const before: Valued[] = [{
    range: { start: { line: 0 }, end: { line: 1 } },
    id: 'def', value: '<function f>',
    source: normalizeSource('def f():\n    return 1'),
  }];
  const after = reanchor(
    before, [edit(0, 1, 'def f():\n    # return 1')], shift,
    against(['def f():', '    # return 1']));

  assert.equal(after.length, 1);
  assert.deepEqual(markers(after), [true]);
});

test('a statement already stale is still dropped once it is commented out', () => {
  // The undo protection that keeps an already-stale mark from clearing itself
  // must not stand in the way of this: going from "the kernel disagrees with
  // this code" to "there is no code" is a stronger claim, and it wins.
  const already: Valued = {
    range: { start: { line: 0 }, end: { line: 0 } },
    id: 'a', value: 'v', source: 'x = 1', stale: true,
  };
  assert.equal(afterEdit(already, '# x = 5'), undefined);
});

test('afterEdit drops when the covered lines are only whitespace', () => {
  const annotation: Valued = {
    range: { start: { line: 0 }, end: { line: 0 } },
    id: 'a', value: 'v', source: 'x = 1',
  };
  assert.equal(afterEdit(annotation, ''), undefined);
});

// -- staleness by dependency --------------------------------------------------

/** An annotation carrying what its statement bound and what it read. */
interface Dependent extends Valued {
  readonly binds?: readonly string[];
  readonly reads?: readonly string[];
}

function on(
  line: number, id: string,
  binds: readonly string[], reads: readonly string[]
): Dependent {
  return {
    range: { start: { line }, end: { line } },
    id, value: `v${line}`, source: id, binds, reads,
  };
}

test('re-evaluating a binding marks the line below that reads it', () => {
  // The ticket's own two lines. Line 2's text never changed, so nothing about
  // line 2 can catch this -- and line 2 is the one describing a world that no
  // longer exists.
  const before = [on(0, 'x', ['x'], []), on(1, 'y', ['y'], ['x'])];
  const after = markDependents(before, before[0]!);

  assert.deepEqual(markers(after), [false, true]);
  assert.deepEqual(after.map((a) => a.value), ['v0', 'v1'],
    'nothing is re-read and nothing is re-run, so no value moves');
});

test('marking a dependant records why, distinctly from an edit (#109)', () => {
  // Same two lines as the ticket's own example. Line 2's mark has to say
  // `'dependency'`, not `'edited'` -- its own text never changed, so telling
  // the hover it did would be exactly the overclaim #109 exists to stop.
  const before = [on(0, 'x', ['x'], []), on(1, 'y', ['y'], ['x'])];
  const after = markDependents(before, before[0]!);
  assert.equal(after[1]?.staleReason, 'dependency');
});

test('marking reaches down the file and skips what does not read the name', () => {
  // Line 40 reads a name bound on line 1, and the thirty-eight lines between
  // that never mention it stay green.
  const bound = on(0, 'source', ['limit'], []);
  const between = Array.from({ length: 38 },
    (_, i) => on(i + 1, `mid${i}`, [`m${i}`], ['unrelated']));
  const reader = on(40, 'reader', ['report'], ['limit']);
  const after = markDependents([bound, ...between, reader], bound);

  assert.deepEqual(after.filter((a) => a.stale).map((a) => a.id), ['reader']);
});

test('marking never goes backwards up the file', () => {
  // File order is the only ordering a reader can see. An annotation above the
  // statement just evaluated did not depend on it, whatever order the two
  // happened to be run in -- and marking it would be marking something the
  // reader has no way to act on.
  const evaluated = on(5, 'evaluated', ['x'], []);
  const before = [on(0, 'above', ['a'], ['x']), evaluated];
  const after = markDependents(before, evaluated);

  assert.equal(after, before, 'the array comes back untouched, by identity');
  assert.deepEqual(markers(after), [false, false]);
});

test('a statement whose names nothing reads marks nothing at all', () => {
  const before = [on(0, 'lonely', ['unused'], []), on(1, 'other', ['b'], ['c'])];
  const after = markDependents(before, before[0]!);

  assert.equal(after, before, 'identity, so the common case costs no repaint');
});

test('a statement that binds nothing marks nothing', () => {
  const before = [on(0, 'call', [], ['lst']), on(1, 'reader', ['z'], ['lst'])];
  assert.equal(markDependents(before, before[0]!), before);
  assert.equal(markDependents(before, { range: before[0]!.range }), before,
    'an annotation from before these fields existed must be inert');
});

test('mutation through an alias is a known miss, and stays one', () => {
  // `y = lst` then `lst.append(4)`: `y` shows something different afterwards
  // and no statement bound `y`. Catching this needs runtime lineage tracking,
  // which nbsafety measured at a 1.44x median slowdown -- and the output here
  // is a marker, so a missed mark costs what the tool cost before this
  // existed. Do not "fix" it by adding a tracer.
  const alias = on(0, 'alias', ['y'], ['lst']);
  const mutate = on(1, 'mutate', [], ['lst']);
  const after = markDependents([alias, mutate], mutate);

  assert.deepEqual(markers(after), [false, false]);
});

test('an annotation already stale is left exactly as it was', () => {
  const evaluated = on(0, 'x', ['x'], []);
  const dependant = { ...on(1, 'y', ['y'], ['x']), stale: true };
  const after = markDependents([evaluated, dependant], evaluated);

  assert.equal(after[1], dependant, 'no churn, and one mark not two');
});

test('re-evaluating the dependant is what clears its mark', () => {
  const evaluated = on(0, 'x', ['x'], []);
  const [, marked] = markDependents(
    [evaluated, on(1, 'y', ['y'], ['x'])], evaluated);
  assert.equal(marked?.stale, true);

  const rerun = on(1, 'y', ['y'], ['x']);
  assert.deepEqual(merge([evaluated, marked!], rerun).map((a) => a.stale),
    [undefined, undefined]);
});

test('the three states are told apart, and stale outranks error', () => {
  assert.equal(markerFor({}), 'evaluated');
  assert.equal(markerFor({ error: { type: 'NameError', message: 'x' } }),
    'error');
  assert.equal(markerFor({ stale: true }), 'stale');
  // A failure whose statement has since been edited is not the current code's
  // failure. Leaving it red asserts that the line in front of the reader
  // raises, and nobody has run the line in front of the reader.
  assert.equal(
    markerFor({ stale: true, error: { type: 'NameError', message: 'x' } }),
    'stale');
});
