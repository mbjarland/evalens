import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Segment, resultGroups, resultSegments, resultText,
} from '../render/format';
import {
  SEGMENT_SLOTS, afterClassName, chipSlots, coalesce, paintOrder,
} from '../render/layers';

/** Decoration types as the renderer sees them: a key and nothing else. */
function types(...numbers: number[]): { key: string }[] {
  return numbers.map((n) => ({ key: `TextEditorDecorationType${n}` }));
}

function keys(sorted: readonly { key: string }[]): string[] {
  return sorted.map((type) => type.key.replace('TextEditorDecorationType', ''));
}

test('the class name is the one the renderer compares', () => {
  // `ced-` + key + the rule number for an `after` attachment. The instance id
  // the main thread prefixes is the same for every type in one extension host
  // and cannot change the relative order, so it is left out.
  assert.equal(afterClassName('TextEditorDecorationType7'),
    'ced-TextEditorDecorationType7-4');
});

test('creation order is not paint order across a digit boundary', () => {
  // The case that makes this function necessary rather than decorative. The
  // renderer compares class names as strings, so `Type10` sorts before `Type9`
  // because `'1' < '9'` -- six segments created in the right order paint as
  // `3 printed: hi => 12 x:`. The counter is shared by every extension in the
  // host, so which integers this extension gets is not knowable in advance and
  // this case is not rare.
  assert.deepEqual(keys(paintOrder(types(7, 8, 9, 10, 11, 12))),
    ['10', '11', '12', '7', '8', '9']);
});

test('a run that does not cross a boundary is left where it was', () => {
  // The control. A test that only ever ran with a low counter would pass
  // while the real editor shuffled, which is why the case above is named.
  assert.deepEqual(keys(paintOrder(types(1, 2, 3, 4, 5, 6))),
    ['1', '2', '3', '4', '5', '6']);
});

test('the sort holds wherever the shared counter happens to start', () => {
  // The counter belongs to the extension host, so Evalens gets whatever is
  // left after every other extension has registered its own types. These are
  // the prefix families where string and numeric order disagree.
  for (const start of [1, 7, 96, 100, 998, 1234]) {
    const pool = types(...Array.from({ length: 8 }, (_, n) => start + n));
    const sorted = paintOrder(pool);
    const names = sorted.map((type) => afterClassName(type.key));
    for (let at = 1; at < names.length; at += 1) {
      assert.ok(names[at - 1]! < names[at]!,
        `starting at ${start}: ${names[at - 1]} is not before ${names[at]}`);
    }
  }
});

test('sorting the same pool twice gives the same order', () => {
  // Slots are assigned by position in this list on every paint, so an unstable
  // order would move segments between paints rather than only get them wrong.
  const pool = types(9, 10, 11, 3, 40, 5);
  assert.deepEqual(keys(paintOrder(pool)), keys(paintOrder(paintOrder(pool))));
});

test('neighbouring chrome becomes one attachment, saying the same', () => {
  // A gap is chrome like the label after it, so the two are one node -- which
  // is also the only arrangement in which nothing can be trimmed between them.
  const segments: Segment[] = [
    { role: 'value', text: '3' },
    { role: 'nameLabel', text: '   ' },
    { role: 'nameLabel', text: 'y: ' },
    { role: 'value', text: '9' },
  ];
  assert.deepEqual(coalesce(segments), [
    { role: 'value', text: '3' },
    { role: 'nameLabel', text: '   y: ' },
    { role: 'value', text: '9' },
  ]);
});

test('coalescing never changes a character of what is painted', () => {
  // It is an economy in the number of decoration types, and nothing else. If
  // it ever changed the text it would be changing the annotation.
  const shapes = [
    { value: '12', display: 'total',
      names: [{ name: 'x', value: '3' }, { name: 'y', value: '9' }],
      printed: { stdout: 'adding\n', stderr: 'careful\n' },
      more: 2, partialFrom: 4 },
    { value: 'def greet(name)', display: 'greet' },
    { value: 'None', display: 'print("hi")', printed: { stdout: 'hi\n' } },
    { value: null, display: null },
  ];
  for (const shape of shapes) {
    const segments = coalesce(resultSegments(shape));
    assert.equal(segments.map((one) => one.text).join(''), resultText(shape));
  }
});

test('coalescing leaves a stream label standing on its own', () => {
  // The gap before `printed:` is chrome and `printed:` is not, so they cannot
  // merge -- which is the point: the two label kinds have to stay separable
  // or the colour that distinguishes them has nothing to attach to.
  const segments = coalesce(resultSegments({
    value: '42', display: 'x', printed: { stdout: 'warming up\n' },
  }));
  assert.deepEqual(segments.map((one) => one.role),
    ['nameLabel', 'value', 'nameLabel', 'streamLabel', 'value']);
});

test('the widest line the renderer can produce still fits the pool', () => {
  // The pool is fixed, so the number in it has to be derived from the caps
  // rather than eyeballed. Four names is `evalens.readNamesPerLine`'s own
  // default -- the display cap `capNames` applies in `repeats.ts`, not the
  // kernel's own `NAME_LIMIT`, which since #85 is a generous transport bound
  // rather than the number a line actually shows -- and `BINDING_LIMIT` is 3
  // in the kernel; everything else a line can carry is here too. If a cap is
  // raised and this is not, the widest lines quietly fall back to one colour.
  const widest = coalesce(resultSegments({
    value: '12',
    display: 'total',
    loop: { values: ['1', '2', '3', '4', '5'], last: '99', count: 40 },
    names: [1, 2, 3, 4].map((n) => ({ name: `name${n}`, value: `v${n}` })),
    bindings: [1, 2, 3].map((n) => ({
      name: `b${n}`, values: ['1', '2'], last: null, count: 2,
    })),
    printed: { stdout: 'out\n', stderr: 'err\n' },
    more: 9,
    partialFrom: 18,
  }));
  assert.ok(widest.length <= SEGMENT_SLOTS,
    `the widest line takes ${widest.length} segments and the pool holds `
    + `${SEGMENT_SLOTS}`);
});

test('the widest line still fits the pool painted as #95 chips, gaps included', () => {
  // The same worst case as above, but counted the way #95 actually paints
  // it: one slot per gap between groups as well as per content segment,
  // since a gap can no longer merge into a neighbouring chip to save one.
  const groups = resultGroups({
    value: '12',
    display: 'total',
    loop: { values: ['1', '2', '3', '4', '5'], last: '99', count: 40 },
    names: [1, 2, 3, 4].map((n) => ({ name: `name${n}`, value: `v${n}` })),
    bindings: [1, 2, 3].map((n) => ({
      name: `b${n}`, values: ['1', '2'], last: null, count: 2,
    })),
    printed: { stdout: 'out\n', stderr: 'err\n' },
    more: 9,
    partialFrom: 18,
  }).map(coalesce).filter((group) => group.length > 0);
  const content = groups.reduce((total, group) => total + group.length, 0);
  const gaps = Math.max(0, groups.length - 1);
  assert.ok(content + gaps <= SEGMENT_SLOTS,
    `the widest #95 line takes ${content} segments and ${gaps} gaps, `
    + `${content + gaps} slots total, and the pool holds ${SEGMENT_SLOTS}`);
});

test('chipSlots: a lone segment is its own whole chip', () => {
  assert.deepEqual(chipSlots(1, true), [{ edge: 'single', leading: true }]);
  assert.deepEqual(chipSlots(1, false), [{ edge: 'single', leading: false }]);
});

test('chipSlots: a two-segment group is a leading and a trailing edge', () => {
  assert.deepEqual(chipSlots(2, true), [
    { edge: 'first', leading: true },
    { edge: 'last', leading: false },
  ]);
  assert.deepEqual(chipSlots(2, false), [
    { edge: 'first', leading: false },
    { edge: 'last', leading: false },
  ]);
});

test('chipSlots: only the first segment of the first group ever leads', () => {
  // `leading` is what earns the #95 accent bar, and it must land on exactly
  // one segment across a whole annotation -- never on a later group's first
  // segment, whatever its own edge is.
  for (const size of [1, 2, 3, 4]) {
    const slots = chipSlots(size, false);
    assert.ok(slots.every((slot) => !slot.leading),
      `a non-first group of size ${size} produced a leading segment`);
  }
});

test('chipSlots: the middle of a longer group carries neither edge', () => {
  const slots = chipSlots(3, true);
  assert.deepEqual(slots.map((slot) => slot.edge), ['first', 'middle', 'last']);
  assert.deepEqual(slots.map((slot) => slot.leading), [true, false, false]);
});
