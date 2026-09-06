import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BindingTrace, LoopTrace, NamedValue } from '../kernel/protocol';
import { resultText } from '../render/format';
import { Annotated, PaintedAbove, capNames } from '../render/repeats';

const NBSP = / /g;

function pairs(...entries: [string, string][]): NamedValue[] {
  return entries.map(([name, value]) => ({ name, value }));
}

/** A binding: `x = 1` shows `x: 1`, and may report what it read alongside. */
function binds(
  name: string, value: string, ...read: [string, string][]
): Annotated {
  return { display: name, value, names: pairs(...read) };
}

/** A line that is not a binding: `print(x)` produced None and read `x`. */
function reads(display: string, ...read: [string, string][]): Annotated {
  return { display, value: 'None', names: pairs(...read) };
}

/**
 * A file annotated top to bottom, as the strings it would paint.
 *
 * `null` is a line that paints nothing at all -- which is a different outcome
 * from an empty string, and the one this rule produces most.
 */
function walk(
  ...lines: readonly Annotated[]
): (string | null)[] {
  return walkCapped(4, ...lines);
}

/** `walk`, with the display cap set to `cap` rather than the default four. */
function walkCapped(
  cap: number, ...lines: readonly Annotated[]
): (string | null)[] {
  const above = new PaintedAbove(cap);
  return lines.map((line) => {
    const kept = above.keep(line);
    return kept === undefined
      ? null
      : resultText({ value: kept.value ?? null, display: kept.display,
        loop: kept.loop, names: kept.names, bindings: kept.bindings,
        more: kept.more })
        .replace(NBSP, ' ');
  });
}

test('a value bound once and used three times is shown once', () => {
  // The ticket's acceptance case. Without this every line that mentions a
  // variable restates what the file already said, and the repetition is the
  // difference between a worked example and a log.
  assert.deepEqual(
    walk(
      binds('x', '1'),
      reads('print(x)', ['x', '1']),
      reads('print(x + 1)', ['x', '1']),
      reads('print(x * 2)', ['x', '1'])
    ),
    ['x: 1', null, null, null]);
});

test('the four lines from the real file leave one annotation', () => {
  // The evidence the ticket was filed on: one dict, three lines calling
  // methods on it, four identical annotations.
  const inventory = "{'apples': 3, 'pears': 5}";
  assert.deepEqual(
    walk(
      binds('inventory', inventory),
      reads('print(inventory.get("bananas", 0))', ['inventory', inventory]),
      reads('print(list(inventory.items()))', ['inventory', inventory]),
      reads('print("apples" in inventory)', ['inventory', inventory])
    ),
    [`inventory: ${inventory}`, null, null, null]);
});

test('a line with nothing left to say paints nothing, not => None', () => {
  // The interaction that would replace one wall with a worse one. `print(x)`
  // produced None, which the formatter gives way to the names on the line;
  // re-promoting it once those names are suppressed would rebuild the
  // `=> None` column this display exists to get rid of.
  const above = new PaintedAbove();
  above.keep(binds('x', '1'));
  assert.equal(above.keep(reads('print(x)', ['x', '1'])), undefined);
});

test('a rebinding shows the value again', () => {
  assert.deepEqual(
    walk(binds('x', '1'), reads('print(x)', ['x', '1']), binds('x', '2')),
    ['x: 1', null, 'x: 2']);
});

test('a mutated value shows again, because the shown value changed', () => {
  // Identity would say `lst` is the same object it always was. What the
  // reader needs is whether the value on screen changed, which is why the
  // comparison is on the rendered string -- and here the append is the whole
  // lesson of the IDEA.md example.
  assert.deepEqual(
    walk(
      binds('lst', '[1, 2, 3]'),
      binds('y', '[1, 2, 3]', ['lst', '[1, 2, 3]']),
      { display: 'y.append(4)', value: 'None',
        names: pairs(['y', '[1, 2, 3, 4]']) },
      { display: 'lst', value: '[1, 2, 3, 4]' }
    ),
    ['lst: [1, 2, 3]', 'y: [1, 2, 3]', 'y: [1, 2, 3, 4]', 'lst: [1, 2, 3, 4]']);
});

test('a value that returns to an earlier one is a change, not a repeat', () => {
  // The nearest mention above is what a reader looking up actually finds. A
  // rule keyed on every value ever painted would suppress the last line here,
  // where `lst` has just gone back to three elements and the line above says
  // four.
  assert.deepEqual(
    walk(
      binds('lst', '[1, 2, 3]'),
      { display: 'y', value: '[1, 2, 3]', names: pairs(['lst', '[1, 2, 3]']) },
      { display: 'y.append(4)', value: 'None',
        names: pairs(['y', '[1, 2, 3, 4]']) },
      reads('print(lst)', ['lst', '[1, 2, 3, 4]']),
      { display: 'y.pop()', value: '4', names: pairs(['y', '[1, 2, 3]']) },
      reads('print(lst)', ['lst', '[1, 2, 3]'])
    ),
    ['lst: [1, 2, 3]', 'y: [1, 2, 3]', 'y: [1, 2, 3, 4]', 'lst: [1, 2, 3, 4]',
     'y: [1, 2, 3]   => 4', 'lst: [1, 2, 3]']);
});

test('a statement\'s own value is never suppressed as a repeat', () => {
  // An annotation's position is a claim about the line it sits on: `x = 1`
  // bound something, and a line that did something says so even where the
  // value is the one it already had. Only the names a line reads are context
  // borrowed from further up the file.
  assert.deepEqual(walk(binds('x', '1'), binds('x', '1')), ['x: 1', 'x: 1']);
});

test('only the repeated pair goes; the rest of the line stays', () => {
  assert.deepEqual(
    walk(
      binds('a', '1'),
      binds('b', '2'),
      reads('print(a, b)', ['a', '1'], ['b', '3'])
    ),
    ['a: 1', 'b: 2', 'b: 3']);
});

test('an annotation with no pairs at all comes back untouched', () => {
  // An error, or a bare `=> 30`. Nothing to compare, nothing to suppress --
  // and returned by identity, so nothing downstream has to work out whether
  // it was rewritten.
  const above = new PaintedAbove();
  const failure: Annotated & { error: { type: string; message: string } } = {
    error: { type: 'NameError', message: 'nope' },
  };
  assert.equal(above.keep(failure), failure);

  const expression = { display: 'sum([10, 20])', value: '30' };
  assert.equal(above.keep(expression), expression);
});

test('a loop keeps its sequence, and a later read of the target is news', () => {
  // `p: 1, 2, 3, 4` is what the loop painted for `p`, so what a later line
  // compares against is that -- and `p: 4`, the value it stopped on, is not
  // the same claim.
  const loop: LoopTrace = { values: ['1', '2', '3', '4'], last: null, count: 4 };
  assert.deepEqual(
    walk(
      { display: 'p', value: '4', loop },
      reads('print(p)', ['p', '4'])
    ),
    ['p ×4: 1, 2, 3, 4', 'p: 4']);
});

test('what a loop body bound is the statement\'s own, not a repeat', () => {
  // `u: 4, 8, 12` is a history this statement recorded, so it is painted on
  // the same terms as the target's sequence however many times a file runs
  // the same loop -- and a later line reading `u` compares against what was
  // painted for it, which is the sequence rather than the value it ended on.
  // `v` and `u` ran the same three times, so #118 folds that count into one
  // leading `×3` rather than repeating it on each.
  const loop: LoopTrace = { values: ['1', '2', '3'], last: null, count: 3 };
  const binding: BindingTrace = {
    name: 'u', values: ['4', '8', '12'], last: null, count: 3,
  };
  assert.deepEqual(
    walk(
      { display: 'v', value: '3', loop, bindings: [binding] },
      reads('print(u)', ['u', '12'])
    ),
    ['×3   v: 1, 2, 3   u: 4, 8, 12', 'u: 12']);
});

test('distance up the file does not weaken the rule', () => {
  // "Above" is earlier in the file, not scrolled into view -- nothing here is
  // told a line number or a viewport, and that is the point. The group of
  // bindings and the line restating them are eleven lines apart in the file
  // this came from, and in a longer one would never be on screen together.
  const lines: Annotated[] = [
    binds('lst', '[1, 2, 3]'), binds('tup', '(1, 2)'), binds('d', "{'a': 1}"),
    binds('s', '{1, 2}'),
  ];
  for (let filler = 0; filler < 8; filler += 1) {
    lines.push(binds(`spacer${filler}`, String(filler)));
  }
  lines.push(reads(
    'print(type(lst), type(tup), type(d), type(s))',
    ['lst', '[1, 2, 3]'], ['tup', '(1, 2)'], ['d', "{'a': 1}"],
    ['s', '{1, 2}']));

  assert.equal(walk(...lines).at(-1), null,
    'the line still carries nothing, twelve lines down');
});

test('a name reassigned out of sight survives the cap (#85)', () => {
  // The measured case: five names bound at the top of the file, one of them
  // reassigned inside a function nobody re-read, then a line that reads all
  // five. A cap applied before suppression -- the bug -- keeps the four the
  // reader has already seen and drops `e`, the one that changed; capping
  // after suppression keeps `e` because it is the only one left to keep.
  assert.deepEqual(
    walkCapped(4,
      binds('a', '1'), binds('b', '2'), binds('c', '3'), binds('d', '4'),
      binds('e', '5'),
      binds('total', '109', ['a', '1'], ['b', '2'], ['c', '3'], ['d', '4'],
        ['e', '99'])
    ),
    ['a: 1', 'b: 2', 'c: 3', 'd: 4', 'e: 5', 'total: 109   e: 99']);
});

test('novel names past the display cap are counted, not dropped silently', () => {
  // The other half of #85: capping is still a real thing the display does,
  // it just happens after suppression now, and what it leaves off is still
  // owed a footnote -- same as when the kernel did the capping itself.
  assert.deepEqual(
    walkCapped(2, reads('print(a, b, c)', ['a', '1'], ['b', '2'], ['c', '3'])),
    ['a: 1   b: 2   …+1 more']);
});

test('a name the cap counted rather than painted is still news later', () => {
  // The ledger must record what the reader actually saw, not everything the
  // kernel sent: `c` is cut from the first line and only counted, so a later
  // line naming it is not suppressed even though its value never changed --
  // the reader has genuinely not seen it yet.
  assert.deepEqual(
    walkCapped(2,
      reads('print(a, b, c)', ['a', '1'], ['b', '2'], ['c', '3']),
      reads('print(c)', ['c', '3'])
    ),
    ['a: 1   b: 2   …+1 more', 'c: 3']);
});

test('capNames leaves an annotation that already fits untouched', () => {
  const annotation: Annotated = { display: 'x', value: '1',
    names: pairs(['a', '1']) };
  assert.equal(capNames(annotation, 4), annotation);
});

test('capNames folds its overflow into more rather than replacing it', () => {
  // A response can already carry a nonzero `more` of its own -- the kernel's
  // transport bound is generous, not infinite -- so a display cap applied on
  // top has to add to that count, not overwrite the part of it it never saw.
  const annotation: Annotated = {
    names: pairs(['a', '1'], ['b', '2'], ['c', '3']), more: 5,
  };
  const result = capNames(annotation, 1);
  assert.deepEqual(result.names, pairs(['a', '1']));
  assert.equal(result.more, 7);
});
