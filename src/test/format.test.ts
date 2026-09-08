import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { BindingTrace, LoopTrace, NamedValue } from '../kernel/protocol';
import {
  DEFAULT_MAX_VALUE_LENGTH, GAP, Rendered, SEPARATOR, alignmentGap,
  bindingText, collapseLines, columnWidth, errorText, hasOutput, hoverText,
  joinSegments, opensDefinition, outputPieces, partialNote, preserveSpacing,
  printedFrom, restatesLine, resultSegments, resultText, sequenceText,
  truncateValue,
} from '../render/format';

function trace(
  values: string[], last: string | null, count = values.length
): LoopTrace {
  return { values, last, count };
}

function bound(
  name: string, values: string[], count = values.length,
  extra: { last?: string | null; constant?: boolean } = {}
): BindingTrace {
  return { name, values, last: extra.last ?? null, count,
    ...(extra.constant === undefined ? {} : { constant: extra.constant }) };
}

function pairs(...entries: [string, string][]): NamedValue[] {
  return entries.map(([name, value]) => ({ name, value }));
}

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
  const text = resultText({ value: '[1, 2, 3]' });
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
  assert.equal(resultText({ value: 'None' }), preserveSpacing('=> None'));
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
  assert.equal(resultText({ value: '[1, 2, 3]', display: 'lst' }),
    preserveSpacing('lst: [1, 2, 3]'));
});

test('a dotted name is still a binding', () => {
  assert.equal(resultText({ value: '7', display: 'self.count' }),
    preserveSpacing('self.count: 7'));
});

test('an expression keeps the arrow instead of being echoed', () => {
  // `sum([10, 20]): 30` repeats the line back at the reader and crowds out
  // the only new information on it.
  assert.equal(resultText({ value: '30', display: 'sum([10, 20])' }),
    preserveSpacing('=> 30'));
  assert.equal(resultText({ value: '12', display: 'area(3, 4)' }),
    preserveSpacing('=> 12'));
  assert.equal(resultText({ value: "'k'", display: "d['k']" }),
    preserveSpacing("=> 'k'"));
});

test('a subscript target is labelled once the wire says it is a binding', () => {
  // #81. `led['a'] = 1` is exactly as much a binding as `x = 1` is; the old
  // regex called it an expression only because `led['a']` does not read as
  // a bare name, which is a fact about the target's syntax and not about
  // whether the statement bound anything.
  assert.equal(
    resultText({ value: '1', display: "led['a']", isBinding: true }),
    preserveSpacing("led['a']: 1"));
});

test('an attribute target is labelled the same way', () => {
  assert.equal(
    resultText({ value: '5', display: 'o.attr', isBinding: true }),
    preserveSpacing('o.attr: 5'));
});

test('without the flag, a subscript still falls back to the old guess', () => {
  // The regex this replaces stays as a fallback for a caller that has not
  // reached the wire flag yet (`isBinding` left `undefined`) -- see
  // `isBoundTarget`. Documented here because it is the one case #81 is not
  // yet fixed for: whoever wires `is_binding` into the object this is built
  // from removes the gap this test pins down.
  assert.equal(resultText({ value: '1', display: "led['a']" }),
    preserveSpacing("=> 1"));
});

test('an explicit false is trusted over a name-shaped display', () => {
  // The false positive the naive fix would have introduced: `x` alone on a
  // line is a bare expression statement reading an existing value, not a
  // binding, even though `x` reads exactly like one. `isBinding: false`
  // (the resolver's actual answer for an `ast.Expr`) overrides the guess a
  // bare identifier would otherwise pass.
  assert.equal(resultText({ value: '5', display: 'x', isBinding: false }),
    preserveSpacing('=> 5'));
});

test('no display at all falls back to the arrow', () => {
  assert.equal(resultText({ value: '42' }), preserveSpacing('=> 42'));
  assert.equal(resultText({ value: '42', display: null }),
    preserveSpacing('=> 42'));
});

test('a value that already says the name is not labelled with it as well', () => {
  // `greet: def greet(name)` was two features colliding: one labels a binding
  // with its name, the other describes a function as its signature. Neither
  // knew about the other, so every function definition in every file said its
  // name twice.
  assert.equal(resultText({ value: 'def greet(name)', display: 'greet' }),
    preserveSpacing('def greet(name)'));
  assert.equal(resultText({ value: 'class Config(name, port=8080)',
    display: 'Config' }),
    preserveSpacing('class Config(name, port=8080)'));
});

test('a label that is not a repetition is exactly what the line needs', () => {
  // The case the whole `def` prefix exists for: this line does not say what
  // `f` now is, and the annotation does.
  assert.equal(resultText({ value: 'def greet(name)', display: 'f' }),
    preserveSpacing('f: def greet(name)'));
  // And an alias, where the label carries the only fact the reader is short
  // of -- that `Record` is a `SimpleNamespace`.
  assert.equal(resultText({ value: 'class SimpleNamespace(**kwargs)',
    display: 'Record' }),
    preserveSpacing('Record: class SimpleNamespace(**kwargs)'));
});

test('a name that merely starts the value is not the value saying it', () => {
  // `greeting` opens `greeting_card` and is not the name it binds. A bare
  // prefix test would drop the label here and leave the reader guessing.
  assert.equal(resultText({ value: 'def greeting_card(to)',
    display: 'greeting' }),
    preserveSpacing('greeting: def greeting_card(to)'));
});

test('the dropped label leaves everything else on the line alone', () => {
  // The reads still follow what the statement did, in the same order.
  assert.equal(
    resultText({ value: 'def greet(name)', display: 'greet', loop: null,
      names: pairs(['salutation', "'hi'"]) }),
    preserveSpacing("def greet(name)   salutation: 'hi'"));
});

test('a loop shows the sequence, not the value it stopped on', () => {
  // The point of the whole feature: `p: 4` is true and nearly useless.
  assert.equal(resultText({ value: '4', display: 'p',
    loop: trace(['1', '2', '3', '4'], null) }),
    preserveSpacing('p ×4: 1, 2, 3, 4'));
});

test("a loop's count is said in a glyph that survives every font", () => {
  // #36: `p: 16` and `x: 16` are the same shape, and a comma-joined sequence
  // does not fix that on its own -- it still reads as *a* value rather than
  // as a history. The count is the cue, and `×` is the one candidate
  // that measured clean in Menlo, SF Mono, Monaco and Courier New alike.
  assert.equal(resultText({ value: '16', display: 'p',
    loop: trace(['0', '1', '4', '9', '16'], null) }),
    preserveSpacing('p ×5: 0, 1, 4, 9, 16'));
});

test('a loop that ran once still says so', () => {
  assert.equal(resultText({ value: '1', display: 'p', loop: trace(['1'], null) }),
    preserveSpacing('p ×1: 1'));
});

test('the count is grouped the same way the elision already is', () => {
  assert.equal(resultText({ value: '10000', display: 'p',
    loop: trace(['1'], '10000', 10000) }),
    preserveSpacing('p ×10,000: 1, … (+9,998 more) … 10000'));
});

test('a tuple loop target carries its count on the arrow, not on a name', () => {
  // `(key, value)` has no identifier to attach the count to, so it goes where
  // the label would have gone: right after `=>`.
  assert.equal(
    resultText({ value: "('b', 2)", display: '(key, value)',
      loop: trace(["('a', 1)", "('b', 2)"], null) }),
    preserveSpacing("=> ×2 ('a', 1), ('b', 2)"));
});

test('the count is overridable, for a font that has its own arrow', () => {
  // `evalens.loopGlyph` (#36) is meant to reach here; this is the half
  // `format.ts` owns -- `Rendered.loopGlyph` threads a caller's choice down
  // to the one place the glyph is used.
  assert.equal(
    resultText({ value: '4', display: 'p',
      loop: trace(['1', '2', '3', '4'], null), loopGlyph: '↻' }),
    preserveSpacing('p ↻4: 1, 2, 3, 4'));
});

test('a long loop is elided with a count of what is not shown', () => {
  // Ten thousand values would not fit and would not be read. The count is
  // what stops the summary from pretending to be the whole run.
  assert.equal(
    sequenceText(trace(['1', '2', '3', '4', '5'], '10000', 10000)),
    '1, 2, 3, 4, 5, … (+9,994 more) … 10000');
});

test('the elided count is grouped the same way wherever it runs', () => {
  // toLocaleString() renders 9.994 on a German machine, which is ambiguous
  // next to a Python repr() and makes this test depend on where it runs.
  assert.equal(sequenceText(trace(['0'], '999999', 1000000)),
    '0, … (+999,998 more) … 999999');
  assert.equal(sequenceText(trace(['0'], '999', 1000)),
    '0, … (+998 more) … 999');
});

test('nothing is elided when the last value is the next one along', () => {
  assert.equal(sequenceText(trace(['1', '2', '3', '4', '5'], '6', 6)),
    '1, 2, 3, 4, 5, 6');
});

test('a loop that ran zero times says so', () => {
  // The target keeps whatever an earlier run left in it, so "the sequence was
  // empty" and "the sequence ended at 4" look identical without this.
  assert.equal(sequenceText(trace([], null, 0)), '(no iterations)');
  assert.equal(
    resultText({ value: '', display: 'p', loop: trace([], null, 0) }),
    preserveSpacing('p: (no iterations)'));
});

test('a multi-line value in a sequence still collapses to one line', () => {
  // A decoration is one line whether it holds one value or six.
  assert.equal(sequenceText(trace(['Point(\n  x=1\n)', '2'], null)),
    'Point( x=1 ), 2');
  assert.equal(sequenceText(trace(['1'], 'Point(\n  x=9\n)', 40)),
    '1, … (+38 more) … Point( x=9 )');
});

test('several names share one line, Rider-style', () => {
  assert.equal(
    resultText({ value: null, display: null, loop: null,
      names: pairs(['tier', "'large'"], ['budget', '525']) }),
    preserveSpacing("tier: 'large'   budget: 525"));
});

test('a binding leads and the names it read follow it', () => {
  // `y = x` did one thing and depended on another; the order says which.
  assert.equal(resultText({ value: '[1, 2, 3]', display: 'y', loop: null,
    names: pairs(['x', '[1, 2, 3]']) }),
    preserveSpacing('y: [1, 2, 3]   x: [1, 2, 3]'));
});

test('an expression result follows the reads it came from', () => {
  // `y.pop()` read `y` and produced 4; the 4 is the consequence, so it lands
  // where a reader looks last.
  assert.equal(resultText({ value: '4', display: 'y.pop()', loop: null,
    names: pairs(['y', '[1, 2, 3]']) }),
    preserveSpacing('y: [1, 2, 3]   => 4'));
});

test('a produced None gives way to anything else on the line', () => {
  // The shape of every mutating method in Python. The None adds nothing the
  // reader has not already read immediately to its left.
  assert.equal(
    resultText({ value: 'None', display: 'y.append(4)', loop: null,
      names: pairs(['y', '[1, 2, 3, 4]']) }),
    preserveSpacing('y: [1, 2, 3, 4]'));
  assert.equal(
    resultText({ value: 'None', display: "print('y:', y)", loop: null,
      names: pairs(['y', '[1, 2, 3, 4]']) }),
    preserveSpacing('y: [1, 2, 3, 4]'));
});

test('a produced None survives when it is the only answer', () => {
  // `d.get('missing')` really did answer None, and blanking it would leave
  // the line looking like nothing happened.
  assert.equal(resultText({ value: 'None', display: "d.get('missing')" }),
    preserveSpacing('=> None'));
  assert.equal(resultText({ value: 'None', display: "d.get('missing')",
    loop: null, names: [] }),
    preserveSpacing('=> None'));
});

test('a name bound to None keeps it, however much else is shown', () => {
  // `noise = lst.append(99)` is the case where there is a value to show and
  // it happens to be nothing -- which is the lesson, not the noise.
  assert.equal(resultText({ value: 'None', display: 'noise', loop: null,
    names: pairs(['lst', '[1, 2]']) }),
    preserveSpacing('noise: None   lst: [1, 2]'));
});

test('an unpacking assignment reads as one pair per binding', () => {
  // `d1, d2 = {'a': 1}, {'b': 2}` painted `=> ({'a': 1}, {'b': 2})` -- the
  // right-hand side echoed back, which is already on the line. The kernel now
  // leaves the display slot empty and sends the bindings as names, so this
  // composes with the rendering above rather than adding a shape of its own.
  assert.equal(
    resultText({ value: null, display: null, loop: null,
      names: pairs(['d1', "{'a': 1}"], ['d2', "{'b': 2}"]) }),
    preserveSpacing("d1: {'a': 1}   d2: {'b': 2}"));
  assert.equal(
    resultText({ value: null, display: null, loop: null,
      names: pairs(['head', '1'], ['rest', '[2, 3, 4]']) }),
    preserveSpacing('head: 1   rest: [2, 3, 4]'));
});

test('a multi-name import reads as one pair per name it bound', () => {
  // `from math import floor, ceil, sqrt` painted `def floor(x, /)` -- the
  // first binding, presented as though it were the statement's whole value,
  // with `ceil` and `sqrt` bound and never mentioned. The same composition as
  // an unpacking assignment: the kernel leaves the display slot empty and
  // sends every bound name as a pair.
  assert.equal(
    resultText({ value: null, display: null, loop: null,
      names: pairs(['floor', 'def floor(x, /)'], ['ceil', 'def ceil(x, /)'],
        ['sqrt', 'def sqrt(x, /)']) }),
    preserveSpacing(
      'floor: def floor(x, /)   ceil: def ceil(x, /)   sqrt: def sqrt(x, /)'));
});

test('a statement with no value of its own still shows its names', () => {
  // An `if` produces nothing and can still be the most informative line in a
  // file: what it bound is the answer.
  assert.equal(resultText({ value: null, display: null, loop: null,
    names: pairs(['tier', "'large'"]) }),
    preserveSpacing("tier: 'large'"));
});

test("a loop's sequence leads and the names it read follow", () => {
  assert.equal(
    resultText({ value: '16', display: 'p',
      loop: trace(['1', '4', '9', '16'], null),
      names: pairs(['squares', '[1, 4, 9, 16]']) }),
    preserveSpacing('p ×4: 1, 4, 9, 16   squares: [1, 4, 9, 16]'));
});

test('a tuple loop target still leads with its sequence', () => {
  // `(key, value)` is too much of an expression to label with, and the
  // sequence is still what the statement did. The count lands on the arrow,
  // for the same reason a name would have carried it.
  assert.equal(
    resultText({ value: "('b', 2)", display: '(key, value)',
      loop: trace(["('a', 1)", "('b', 2)"], null),
      names: pairs(['shelf', "{'a': 1, 'b': 2}"]) }),
    preserveSpacing("=> ×2 ('a', 1), ('b', 2)   shelf: {'a': 1, 'b': 2}"));
});

test('what the loop computed is shown as a sequence, not as where it stopped', () => {
  // The ticket's case. `u` took 4, 8 and 12, and the annotation said `u: 12`
  // beside a target rendered as a history -- so one of the two names on the
  // line read as the other's last entry.
  //
  // `v` and `u` share a count here, but `x` sits beside them with none of its
  // own -- a plain read, not a loop trace -- so #118 does not fold `×3` to
  // the front: that would put it where it reads as a claim about `x` too.
  assert.equal(
    resultText({ value: '3', display: 'v', loop: trace(['1', '2', '3'], null),
      names: pairs(['x', '[1, 2, 3]']),
      bindings: [bound('u', ['4', '8', '12'])] }),
    preserveSpacing('v ×3: 1, 2, 3   u ×3: 4, 8, 12   x: [1, 2, 3]'));
});

test('a body binding shorter than the loop still renders', () => {
  // A filter loop: three iterations, two results, because the iteration that
  // hit `continue` computed nothing. Anything that zipped or padded the two
  // sequences would invent an observation here. The counts differing --
  // `×3` beside `×2` -- is itself the fact that a filter ran, so #118 leaves
  // both counts where they are rather than folding one that would misstate
  // the other.
  assert.equal(
    resultText({ value: '3', display: 'v', loop: trace(['1', '2', '3'], null),
      names: [], bindings: [bound('u', ['4', '12'], 2)] }),
    preserveSpacing('v ×3: 1, 2, 3   u ×2: 4, 12'));
});

// -- #118: a shared iteration count is said once, as a leading group -------

test('#118: equal iteration counts fold into one leading count', () => {
  // The width this ticket exists to buy back: two repeats of `×3` become
  // one, ahead of both names rather than inside either of them.
  assert.equal(
    resultText({ value: '3', display: 'v', loop: trace(['1', '2', '3'], null),
      names: [], bindings: [bound('u', ['4', '8', '12'])] }),
    preserveSpacing('×3   v: 1, 2, 3   u: 4, 8, 12'));
});

test('#118: a solo loop keeps its inline count', () => {
  // Folding buys width only by removing a repeat. With one name there is
  // nothing to remove: `×3` as its own leading piece is longer than the
  // ` ×3` it would replace, so a lone loop is left exactly as #36 shows it.
  assert.equal(
    resultText({ value: '3', display: 'p', loop: trace(['1', '2', '3'], null) }),
    preserveSpacing('p ×3: 1, 2, 3'));
});

test('#118: a line with no loop at all is unaffected', () => {
  assert.equal(
    resultText({ value: null, display: null,
      names: pairs(['x', '1'], ['y', '2']) }),
    preserveSpacing('x: 1   y: 2'));
});

test('an unchanging binding is one reading beside a moving one', () => {
  // `c: 7, 7, 7, 7` is four observations of one fact, and it crowds out the
  // sequence next to it that is actually moving. `c: 7` still says it ran
  // four times, which `c: 7` alone would not -- #118 folds that count into
  // the leading `×4`, shared with `v` and `d`, rather than dropping it.
  assert.equal(
    resultText({ value: '4', display: 'v',
      loop: trace(['1', '2', '3', '4'], null), names: [],
      bindings: [bound('c', ['7'], 4, { constant: true }),
        bound('d', ['1', '4', '9', '16'])] }),
    preserveSpacing('×4   v: 1, 2, 3, 4   c: 7   d: 1, 4, 9, 16'));
});

test('a body binding is bounded exactly as the target is', () => {
  assert.equal(
    bindingText(bound('u', ['0', '2', '4', '6', '8'], 10000,
      { last: '19998' })),
    'u ×10,000: 0, 2, 4, 6, 8, … (+9,994 more) … 19998');
});

test('a line says when the cap left names off it', () => {
  // Silently is the problem, not the cap. A reader who counts five names on
  // the line and four beside it cannot tell whether the fifth was omitted,
  // unreadable, or somehow not a name.
  assert.equal(
    resultText({ value: null, display: null, loop: null,
      names: pairs(['a', '1'], ['b', '2'], ['c', '3'], ['d', '4']),
      bindings: [], more: 1 }),
    preserveSpacing('a: 1   b: 2   c: 3   d: 4   \u2026+1 more'));
});

test('the footnote lands after the result, not among the values', () => {
  // It is a note about the line rather than another value on it.
  assert.equal(
    resultText({ value: '4', display: 'y.pop()', loop: null,
      names: pairs(['y', '[1, 2, 3]']), bindings: [], more: 2 }),
    preserveSpacing('y: [1, 2, 3]   => 4   \u2026+2 more'));
});

test('the cap footnote survives even where output is all that is left', () => {
  // #74: reachable once output can be the only thing on a line -- the repeat
  // rule drops every name as already-shown, and the output stays because it
  // is this run's own. `more` is still true here, and a footnote that reads
  // a little like a remark about the output is a smaller wrong than a line
  // that hides that a cap bit at all.
  assert.equal(
    resultText({ value: null, display: null, loop: null, names: [],
      bindings: [], printed: { stdout: 'hello\n' }, more: 1 }),
    preserveSpacing('printed: hello   \u2026+1 more'));
  // With a name still on the line the footnote reads exactly as it always
  // did -- a footnote to the name beside it.
  assert.equal(
    resultText({ value: null, display: null, loop: null,
      names: pairs(['a', '1']), bindings: [], printed: { stdout: 'hello\n' },
      more: 1 }),
    preserveSpacing('a: 1   printed: hello   \u2026+1 more'));
});

test('a line the cap did not touch says nothing about it', () => {
  assert.equal(resultText({ value: null, display: null, loop: null,
    names: pairs(['a', '1']), bindings: [], more: 0 }),
    preserveSpacing('a: 1'));
  assert.equal(resultText({ value: null, display: null, loop: null,
    names: pairs(['a', '1']) }),
    preserveSpacing('a: 1'));
});

test('a multi-line value in a pair collapses like any other', () => {
  assert.equal(resultText({ value: null, display: null, loop: null,
    names: pairs(['p', 'Point(\n  x=1\n)']) }),
    preserveSpacing('p: Point( x=1 )'));
});

test('an annotation that only restates its own line is recognised as one', () => {
  // The question this answers is about text and its answer here is still yes.
  // Whether the line is therefore left bare is the caller's decision, and for
  // a definition it is no -- see `opensDefinition` and the test below it.
  const painted = resultText({ value: 'def greet(name)', display: 'greet' });
  assert.equal(restatesLine(painted, 'def greet(name):'), true);
  assert.equal(restatesLine(painted, '    def greet(name):'), true,
    'indentation is not something the reader is being told');
  assert.equal(restatesLine(painted, 'def greet(name):  # says hello'), true,
    'a trailing comment is not part of the statement');
  assert.equal(restatesLine(painted, 'def  greet(name) :'), true,
    'spacing folds, the way it does everywhere else here');
});

test('a decorated function still says what the decorator produced', () => {
  // The decorator REPLACED the function and the line cannot show that, so this
  // one differs from its line as text and would paint on those terms alone --
  // which is why the exemption below can be added without putting this case at
  // anybody's mercy.
  assert.equal(
    restatesLine(resultText({ value: 'def <lambda>()', display: 'greeting' }),
      'def greeting():'),
    false);
});

test('a definition is exempt from the question, whatever its answer', () => {
  // Every shape of definition header, so the family cannot split again on
  // whether one description happens to be a prefix of its own line.
  assert.equal(opensDefinition('def greet(name):'), true);
  assert.equal(opensDefinition('async def fetch(url):'), true);
  assert.equal(opensDefinition('class Config:'), true);
  assert.equal(opensDefinition('    def inner(k):'), true,
    'a nested def is a definition wherever it is indented to');
  assert.equal(opensDefinition('\tclass Inner:'), true,
    'a file indented with tabs is still Python');
});

test('the exemption reads the line, and only Python at the start of it', () => {
  // The defect this exemption exists to repair, arriving from the other side:
  // an object of the user's own whose repr begins with `def ` must not collect
  // it, and nothing that merely contains the word may either.
  assert.equal(opensDefinition('handler = registry.lookup()'), false,
    'the annotation may read `def run(x)`; the line is still an assignment');
  assert.equal(opensDefinition('default = 3'), false,
    'a word that starts with def is not the keyword');
  assert.equal(opensDefinition('classes = []'), false);
  assert.equal(opensDefinition('x = "def greet(name):"'), false,
    'a definition inside a string is a string');
  assert.equal(opensDefinition('async for row in cursor:'), false,
    '`async` qualifies `def` here and nothing else');
  assert.equal(opensDefinition('async with lock:'), false);
});

test('a line the annotation only half restates keeps its annotation', () => {
  // Each of these says something the line does not: what awaiting gives you,
  // what constructing one takes, and what the other names on the line held.
  assert.equal(
    restatesLine(resultText({ value: 'def drain(stream) -> coroutine',
      display: 'drain' }),
      'async def drain(stream):'),
    false);
  assert.equal(
    restatesLine(resultText({ value: 'class Config(name, port=8080)',
      display: 'Config' }),
      'class Config:'),
    false);
  assert.equal(
    restatesLine(resultText({ value: 'def greet(name)', display: 'greet',
      loop: null, names: pairs(['salutation', "'hi'"]) }), 'def greet(name):'),
    false);
});

test('an ordinary binding is never mistaken for a restatement', () => {
  // `x: 1` and `x = 1` are the same fact said twice only to someone who
  // already knows the answer, which is the reader this extension is not for.
  assert.equal(restatesLine(resultText({ value: '1', display: 'x' }),
    'x = 1'), false);
  assert.equal(restatesLine(resultText({ value: '30',
    display: 'sum([10, 20])' }),
    'sum([10, 20])'), false);
  assert.equal(restatesLine('', 'def greet(name):'), false,
    'an empty annotation is a prefix of everything');
});

test('a hover carries the production a line suppressed', () => {
  // Demoted, not destroyed: `y = y.append(4)` binding None is a real trap,
  // learned exactly once, and then noise on every mutating call after that.
  assert.equal(
    hoverText({ display: 'y.append(4)', value: 'None', loop: null,
      names: pairs(['y', '[1, 2, 3, 4]']) }),
    'y.append(4) = None\ny = [1, 2, 3, 4]');
});

test('a hover with nothing produced starts with the names', () => {
  assert.equal(hoverText({ display: null, value: null, loop: null,
    names: pairs(['tier', "'large'"]) }),
    "tier = 'large'");
});

test('a hover prefers the untouched repr a pair describes', () => {
  // The same rule the produced value follows: describing hides nothing, it
  // only moves the address one hover away.
  assert.equal(
    hoverText({ display: 'cfg', value: '<Config instance>', loop: null,
      names: [{ name: 'other', value: '<Config instance>',
        repr: '<Config at 0x1>' }] }),
    'cfg = <Config instance>\nother = <Config at 0x1>');
});

test('a hover names the binding and says how many iterations there were', () => {
  // The line is elided; the hover is where the count belongs.
  assert.equal(hoverText({ display: 'p', value: '10000',
    loop: trace(['1'], '10000', 10000) }),
    'p = 1, … (+9,998 more) … 10000\n10000 iterations');
  assert.equal(hoverText({ display: 'p', value: '1',
    loop: trace(['1'], null, 1) }),
    'p = 1\n1 iteration');
});

test('a hover spells out what a short binding means', () => {
  // Inline, `u: 4, 12` and `c: 7` are both just short. The hover is where the
  // difference between "the body took an early exit" and "this never changed"
  // has room to be said.
  assert.equal(
    hoverText({ display: 'v', value: '3', loop: trace(['1', '2', '3'], null),
      names: [], bindings: [bound('u', ['4', '12'], 2)] }),
    'v = 1, 2, 3\n3 iterations\nu = 4, 12 (bound on 2 of 3 iterations)');
  assert.equal(
    hoverText({ display: 'v', value: '3', loop: trace(['1', '2', '3'], null),
      names: [], bindings: [bound('c', ['7'], 3, { constant: true })] }),
    'v = 1, 2, 3\n3 iterations\nc = 7 (unchanged over 3 iterations)');
});

test('a hover says nothing extra about a binding that kept up', () => {
  assert.equal(
    hoverText({ display: 'v', value: '3', loop: trace(['1', '2', '3'], null),
      names: [], bindings: [bound('u', ['4', '8', '12'])] }),
    'v = 1, 2, 3\n3 iterations\nu = 4, 8, 12');
});

test('a hover without a loop is unchanged', () => {
  assert.equal(hoverText({ display: 'lst', value: '[1, 2, 3]' }),
    'lst = [1, 2, 3]');
  assert.equal(hoverText({ display: null, value: '[1, 2, 3]' }), '[1, 2, 3]');
});

test('one line of output IS the annotation, and the None gives way', () => {
  // The ticket. `print("hello")` returned None and the extension painted it,
  // throwing away the only thing the user pressed the key to see. For the
  // audience this is built for, print() is not one feature among many.
  assert.equal(
    resultText({ value: 'None', display: 'print("hello")', loop: null,
      names: [], bindings: [], printed: { stdout: 'hello\n' } }),
    preserveSpacing('printed: hello'));
});

test('the label is a word in the grammar already on the line', () => {
  // Bare `hello` would invite the reader to conclude the expression evaluated
  // to `hello`. `printed: hello` is the same `<label>: <value>` shape as
  // `x: [1, 2, 3]`, so there is nothing new to learn.
  assert.ok(outputPieces({ stdout: 'hello\n' })[0]!.startsWith('printed: '));
});

test('several lines show the first and say how many there were', () => {
  // A decoration is one line. The count is what stops the summary pretending
  // to be the whole of the output.
  assert.equal(
    resultText({ value: 'None', display: 'print("a\\nb\\nc")', loop: null,
      names: [], bindings: [],
      printed: { stdout: 'warming up\nstill going\ndone\n' } }),
    preserveSpacing('printed: warming up …(3 lines)'));
});

test('the newline that ends a print is not a line of its own', () => {
  // Counting it would report every one-line print as two.
  assert.deepEqual(outputPieces({ stdout: 'hello\n' }), ['printed: hello']);
  assert.deepEqual(outputPieces({ stdout: 'hello' }), ['printed: hello']);
  assert.deepEqual(outputPieces({ stdout: 'hello\r\n' }), ['printed: hello']);
  assert.deepEqual(outputPieces({ stdout: 'a\nb\n' }),
    ['printed: a …(2 lines)']);
});

test('a blank line is named rather than left as an empty label', () => {
  // `print()` on its own is a thing beginners write, and `printed:` followed
  // by nothing reads as a bug in the extension rather than as the answer.
  assert.deepEqual(outputPieces({ stdout: '\n' }),
    ['printed: (blank line)']);
});

test('output and a binding both appear, and the binding leads', () => {
  // `x = compute()` where compute prints wants both: they answer different
  // questions, and neither displaces the other.
  assert.equal(
    resultText({ value: '42', display: 'x', loop: null, names: [], bindings: [],
      printed: { stdout: 'warming up\n' } }),
    preserveSpacing('x: 42   printed: warming up'));
});

test('output follows the names a line read, and the result it produced', () => {
  assert.equal(
    resultText({ value: '4', display: 'y.pop()', loop: null,
      names: pairs(['y', '[1, 2, 3]']), bindings: [],
      printed: { stdout: 'popping\n' } }),
    preserveSpacing('y: [1, 2, 3]   => 4   printed: popping'));
});

test('stderr keeps its own name whatever stdout is called', () => {
  // Writing to stderr is not a beginner action, and anyone doing it knows the
  // term. It is also not a failure -- this is a label, never a colour.
  assert.deepEqual(
    outputPieces({ stdout: 'fine\n', stderr: 'careful\n' }),
    ['printed: fine', 'stderr: careful']);
  assert.deepEqual(
    outputPieces({ stderr: 'careful\n', label: '»' }),
    ['stderr: careful']);
});

test('a stderr-only line still suppresses the None it returned', () => {
  // `logging.warning("x")` returns None and writes a warning. `=> None` is
  // the wrong half of that.
  assert.equal(
    resultText({ value: 'None', display: 'logging.warning("x")', loop: null,
      names: [], bindings: [], printed: { stderr: 'WARNING:root:x\n' } }),
    preserveSpacing('stderr: WARNING:root:x'));
});

test('a terse marker drops the colon rather than stacking punctuation', () => {
  // `»: hello` is punctuation on punctuation for no gain.
  assert.deepEqual(outputPieces({ stdout: 'hello\n', label: '»' }),
    ['» hello']);
});

test('a name bound to None survives beside its own output', () => {
  // The suppression rule is unchanged: a *bound* None is the lesson, not the
  // noise, however much else the line has to say.
  assert.equal(
    resultText({ value: 'None', display: 'noise', loop: null, names: [],
      bindings: [], printed: { stdout: 'side effect\n' } }),
    preserveSpacing('noise: None   printed: side effect'));
});

test('a line that printed nothing is exactly what it was before', () => {
  // The empty string is what the kernel sends for a statement that wrote
  // nothing, and it must not become a `printed:` segment with nothing in it.
  assert.equal(printedFrom('', ''), undefined);
  assert.equal(hasOutput(printedFrom('', '')), false);
  assert.equal(hasOutput(undefined), false);
  assert.equal(
    resultText({ value: 'None', display: "d.get('missing')", loop: null,
      names: [], bindings: [], printed: printedFrom('', '') }),
    preserveSpacing('=> None'));
});

test('the hover carries the whole of what the line elided', () => {
  // Where `…(3 lines)` is redeemed, alongside the None the line suppressed.
  assert.equal(
    hoverText({ display: 'print("x")', value: 'None', loop: null, names: [],
      bindings: [], printed: { stdout: 'warming up\nstill going\ndone\n' } }),
    'print("x") = None\nprinted:\nwarming up\nstill going\ndone');
});

test('a one-line output is repeated on the hover, not assumed read', () => {
  // Without it the hover for `print("hello")` says only
  // `print("hello") = None`, which reads as a contradiction of the line.
  assert.equal(
    hoverText({ display: 'print("hello")', value: 'None', loop: null, names: [],
      bindings: [], printed: { stdout: 'hello\n' } }),
    'print("hello") = None\nprinted: hello');
});

test('both streams reach the hover, each under its own name', () => {
  assert.equal(
    hoverText({ display: 'run()', value: 'None', loop: null, names: [],
      bindings: [], printed: { stdout: 'fine\n', stderr: 'careful\n' } }),
    'run() = None\nprinted: fine\nstderr: careful');
});

test('a value from a reduced context says so on the line', () => {
  // A value computed without the rest of the file is a weaker claim than one
  // computed with it. Painting the two identically would make every
  // annotation on screen mean "one of these two things".
  const text = resultText({ value: '42', display: 'answer', loop: null, more: 0,
    partialFrom: 18 });
  assert.equal(text, preserveSpacing(`answer: 42${GAP}(partial: line 19)`));
});

test('the caveat is 1-based, because it is read in a gutter', () => {
  assert.equal(partialNote(0), '(partial: line 1)');
  assert.equal(partialNote(18), '(partial: line 19)');
});

test('the caveat goes last, after every value on the line', () => {
  // It qualifies the whole line rather than any one value on it.
  const text = resultText({ value: null, display: null, loop: null,
    names: pairs(['a', '1'], ['b', '2']), more: 0, partialFrom: 4 });
  assert.equal(text, preserveSpacing(`a: 1${GAP}b: 2${GAP}(partial: line 5)`));
});

test('a suppressed None does not take the caveat down with it', () => {
  const text = resultText({ value: 'None', display: 'y.append(4)', loop: null,
    names: pairs(['y', '[1, 2]']), more: 0, partialFrom: 7 });
  assert.equal(text, preserveSpacing(`y: [1, 2]${GAP}(partial: line 8)`));
});

test('a value that parsed whole carries no caveat', () => {
  assert.equal(resultText({ value: '42', display: 'answer' }),
    preserveSpacing('answer: 42'));
});

test('a failure under a reduced context carries the caveat too', () => {
  // This is where it matters most: the lines left out are the likeliest
  // reason a name is not defined, and a NameError that does not say so sends
  // the reader hunting for a typo that is not there.
  assert.equal(errorText('NameError', "name 'helper' is not defined", 18),
    preserveSpacing(
      `${SEPARATOR} NameError: name 'helper' is not defined`
      + `${GAP}(partial: line 19)`));
});

test('an ordinary failure is unchanged', () => {
  assert.equal(errorText('NameError', 'nope'),
    preserveSpacing(`${SEPARATOR} NameError: nope`));
});

test('the hover explains what the line only hints at', () => {
  // `(partial: line 19)` is short enough to raise the question without room
  // to answer it. The answer goes here.
  assert.equal(
    hoverText({ display: 'answer', value: '42', loop: null,
      partial: { truncated_at: 18, message: 'unterminated string literal' } }),
    'answer = 42\nevaluated without line 19 onwards'
    + '\nSyntaxError: unterminated string literal');
});

test('a value under the limit is left exactly as it is', () => {
  assert.equal(truncateValue('[1, 2, 3]', 80), '[1, 2, 3]');
  assert.equal(truncateValue('x'.repeat(80), 80), 'x'.repeat(80),
    'exactly at the limit is not over it');
});

test('a long value is cut and says so, never left looking complete', () => {
  // #12. A truncated list must not look like a short list, so the marker is
  // never optional once the limit is crossed.
  assert.equal(truncateValue('x'.repeat(90), 80),
    `${'x'.repeat(80)}… (+10 more characters)`);
});

test('one character over says "character", not "characters"', () => {
  assert.equal(truncateValue('x'.repeat(81), 80),
    `${'x'.repeat(80)}… (+1 more character)`);
});

test('the removed count is grouped the same way every other count here is', () => {
  assert.equal(truncateValue('x'.repeat(1200), 80),
    `${'x'.repeat(80)}… (+1,120 more characters)`);
});

test('a cut lands on a grapheme boundary, not a code unit', () => {
  // A flag is two UTF-16 surrogate pairs acting as one character; slicing by
  // code unit would cut it in half and paint half a flag.
  const flags = '🇸🇪'.repeat(50);
  const cut = truncateValue(flags, 10);
  assert.ok(cut.startsWith('🇸🇪'.repeat(10)), cut);
  assert.equal([...new Intl.Segmenter().segment(cut.split('…')[0]!)].length, 10);
});

test('a value already cut by the kernel is not cut through its own notice', () => {
  // `_capped` in evalens_kernel.py produces exactly this shape. A generous
  // limit that comfortably covers the kernel's notice leaves it untouched.
  const capped = `${'x'.repeat(8192)}… <truncated from 50000 chars>`;
  assert.equal(truncateValue(capped, 8192 + 40), capped,
    'the kernel already said enough; nothing here needed to say more');
});

test("a narrower limit replaces the kernel's notice rather than cutting into it", () => {
  // Chopping "… <truncated from 50000 chars>" in half would print a broken
  // sentence with a count belonging to neither cut -- the defect #12 flagged
  // by name. This must never happen: the kernel's notice is either kept
  // whole or dropped whole, never partially there.
  const capped = `${'x'.repeat(8192)}… <truncated from 50000 chars>`;
  const cut = truncateValue(capped, 80);
  assert.equal(cut, `${'x'.repeat(80)}… (+8,112 more characters)`);
  assert.doesNotMatch(cut, /truncated from/,
    'no fragment of the kernel notice survives half-said');
});

/** Painted text with its non-breaking spaces read back as ordinary ones. */
function plain(text: string): string {
  return text.split(NBSP).join(' ');
}

test('the display limit is overridable, and defaults to a measured width', () => {
  assert.equal(DEFAULT_MAX_VALUE_LENGTH, 120);
  const long = '[' + Array.from({ length: 60 }, (_, i) => i).join(', ') + ']';
  assert.ok(long.length > DEFAULT_MAX_VALUE_LENGTH, 'the fixture must be long enough to bite');
  const shown = plain(resultText({ value: long, display: 'nums' }));
  assert.ok(shown.includes('more character'), shown);

  const untouched = resultText({ value: long, display: 'nums', maxValueLength: 500 });
  assert.ok(!plain(untouched).includes('more character'), untouched);
  assert.equal(untouched, preserveSpacing(`nums: ${long}`));
});

test('the full value is still on the hover once the line truncates it', () => {
  // #12's other half. The line is bounded; the hover is where the whole of a
  // long value still lives, up to the kernel's own wire cap.
  const long = '[' + Array.from({ length: 60 }, (_, i) => i).join(', ') + ']';
  assert.ok(
    plain(resultText({ value: long, display: 'nums' })).includes('more character'));
  assert.equal(hoverText({ value: long, display: 'nums' }), `nums = ${long}`,
    'the hover is never cut, whatever the line had to do');
});

test('a loop sequence long enough to be a screenful is truncated the same way', () => {
  // The line-width problem is the same whether the long value came from a
  // single binding or from several short iterations added together.
  const shown = plain(resultText({ value: '9', display: 'p',
    loop: trace(Array.from({ length: 40 }, (_, i) => String(i)), null) }));
  assert.ok(shown.includes('more character'), shown);
});

test('a truncated value never carries the label past its own count', () => {
  // Truncation only ever shortens a `value` segment; the `×N` and the name
  // it is attached to are chrome, and chrome is never cut.
  const shown = resultText({ value: '9', display: 'p',
    loop: trace(Array.from({ length: 40 }, (_, i) => String(i)), null) });
  assert.ok(shown.startsWith(preserveSpacing('p ×40: ')), shown);
});

/** Segments as `role "text"`, with the non-breaking spaces read back. */
function coloured(rendered: Rendered): string[] {
  return resultSegments(rendered).map(
    (segment) => `${segment.role} ${JSON.stringify(
      segment.text.split(NBSP).join(' '))}`);
}

/**
 * One of every shape a line can take, for the claims that hold across all of
 * them: that the segments join back into the string, and that splitting the
 * line does not change how wide it is.
 */
const SHAPES: readonly [string, Rendered][] = [
  ['a bare expression', { value: '30', display: 'sum([10, 20])' }],
  ['a binding', { value: '[1, 2, 3]', display: 'lst' }],
  ['a dropped label', { value: 'def greet(name)', display: 'greet' }],
  ['several names', {
    value: null, display: null, names: pairs(['tier', "'large'"],
      ['budget', '525']),
  }],
  ['a loop and its reads', {
    value: '16', display: 'p', loop: trace(['1', '4', '9', '16'], null),
    names: pairs(['squares', '[1, 4, 9, 16]']),
  }],
  ['a loop with body bindings', {
    value: '3', display: 'v', loop: trace(['1', '2', '3'], null),
    names: pairs(['x', '[1, 2, 3]']), bindings: [bound('u', ['4', '8', '12'])],
  }],
  ['an elided loop', {
    value: '10000', display: 'p', loop: trace(['1'], '10000', 10000),
  }],
  ['a loop that ran zero times', {
    value: '', display: 'p', loop: trace([], null, 0),
  }],
  ['output alone', {
    value: 'None', display: 'print("hello")', printed: { stdout: 'hello\n' },
  }],
  ['output over several lines', {
    value: 'None', display: 'print("a")', printed: { stdout: 'a\nb\nc\n' },
  }],
  ['a blank line printed', {
    value: 'None', display: 'print()', printed: { stdout: '\n' },
  }],
  ['a terse marker', {
    value: 'None', display: 'print("hi")',
    printed: { stdout: 'hi\n', label: '»' },
  }],
  ['both streams', {
    value: 'None', display: 'run()',
    printed: { stdout: 'fine\n', stderr: 'careful\n' },
  }],
  ['a binding and its output', {
    value: '42', display: 'x', printed: { stdout: 'warming up\n' },
  }],
  ['the cap footnote', {
    value: null, display: null,
    names: pairs(['a', '1'], ['b', '2']), more: 3,
  }],
  ['the reduced-context caveat', {
    value: '42', display: 'answer', partialFrom: 18,
  }],
  ['everything at once', {
    value: '12', display: 'total', names: pairs(['x', '3'], ['y', '9']),
    printed: { stdout: 'adding\n', stderr: 'careful\n' }, more: 2,
    partialFrom: 4,
  }],
];

test('the segments join back into exactly the line that was painted', () => {
  // The fallback, and the reason it is safe to leave in place: painting one
  // string is painting the same characters in the same order. Several `after`
  // attachments at one position is not a documented VS Code behaviour, so the
  // single-colour path has to stay correct rather than merely still compile.
  for (const [shape, rendered] of SHAPES) {
    assert.equal(joinSegments(resultSegments(rendered)),
      resultText(rendered), shape);
  }
});

test('splitting the line does not change how wide it is', () => {
  // The alignment column is measured off the code, but every segment lands
  // after it, so the widths have to add up to what one string would have been
  // or the annotation stops ending where it used to.
  for (const [shape, rendered] of SHAPES) {
    const segments = resultSegments(rendered);
    const apart = segments.reduce(
      (total, segment) => total + columnWidth(segment.text, 4), 0);
    assert.equal(apart, columnWidth(resultText(rendered), 4), shape);
  }
});

test('every space in a segment is non-breaking, gaps included', () => {
  // Each segment is its own inline-block, which trims its own leading and
  // trailing spaces -- so an ordinary space at a segment boundary is a column
  // that silently disappears. The substitution has to happen per segment, and
  // a gap has to belong to one segment rather than straddle two.
  for (const [shape, rendered] of SHAPES) {
    for (const segment of resultSegments(rendered)) {
      assert.ok(!segment.text.includes(' '),
        `${shape}: ${JSON.stringify(segment.text)} carries an ordinary space`);
    }
  }
});

test('labels are chrome and values are content', () => {
  // The rule in one line of a real file: `total = x + y` that also printed.
  assert.deepEqual(
    coloured({
      value: '12', display: 'total', names: pairs(['x', '3'], ['y', '9']),
      printed: { stdout: 'adding\n' },
    }),
    ['nameLabel "total: "', 'value "12"',
      'nameLabel "   "',
      'nameLabel "x: "', 'value "3"',
      'nameLabel "   "',
      'nameLabel "y: "', 'value "9"',
      'nameLabel "   "',
      'streamLabel "printed: "', 'value "adding"']);
});

test('the text a statement printed is a value, not a label', () => {
  // The decision the ticket turns on. `printed:` is the extension's word and
  // `hello` is the program's, so a reader scanning for what their code
  // produced finds one colour everywhere -- output included.
  assert.deepEqual(
    coloured({ value: 'None', display: 'print("hello")',
      printed: { stdout: 'hello\n' } }),
    ['streamLabel "printed: "', 'value "hello"']);
});

test('the arrow is a label and the value after it is not', () => {
  assert.deepEqual(coloured({ value: '30', display: 'sum([10, 20])' }),
    ['nameLabel "=> "', 'value "30"']);
});

test('both stream labels are stream labels, and neither is an error', () => {
  // `stderr` keeps its own word and its own colour: a library logging a
  // warning has not failed, and painting it red would teach a student to fear
  // a line that worked.
  assert.deepEqual(
    coloured({ value: 'None', display: 'run()',
      printed: { stdout: 'fine\n', stderr: 'careful\n' } }),
    ['streamLabel "printed: "', 'value "fine"',
      'nameLabel "   "',
      'streamLabel "stderr: "', 'value "careful"']);
});

test('a terse marker is still the stream label, colon or no colon', () => {
  assert.deepEqual(
    coloured({ value: 'None', display: 'print("hi")',
      printed: { stdout: 'hi\n', label: '»' } }),
    ['streamLabel "» "', 'value "hi"']);
});

test('a dropped label leaves the value on its own', () => {
  // There is no chrome left in front of it to colour, and what is on the line
  // is entirely what the statement produced.
  assert.deepEqual(coloured({ value: 'def greet(name)', display: 'greet' }),
    ['value "def greet(name)"']);
});

test('an elision stays inside the value it shortens', () => {
  // `…(3 lines)` and `… (+9,994 more) …` describe the shape of what the
  // program produced rather than label it, so the split falls in the same
  // place every time: the punctuation this extension wrote, then what ran.
  assert.deepEqual(
    coloured({ value: 'None', display: 'print("a")',
      printed: { stdout: 'warming up\nstill going\ndone\n' } }),
    ['streamLabel "printed: "', 'value "warming up …(3 lines)"']);
  assert.deepEqual(
    coloured({ value: '10000', display: 'p',
      loop: trace(['1'], '10000', 10000) }),
    ['nameLabel "p ×10,000: "', 'value "1, … (+9,998 more) … 10000"']);
});

test('repeated loops put observed values before separately colored aggregate counts', () => {
  const loop = { ...trace(['0', '1', '2', '3', '4'], '99', 10000),
    invocations: 100 };
  assert.deepEqual(coloured({ value: null, display: 'y', loop }), [
    'nameLabel "y: "', 'value "0, 1, 2, 3, 4, …, 99"',
    'nameLabel " · 100 runs · 10,000 iterations total"',
  ]);
  // Character truncation is still applied to the value only; it cannot
  // hide or recolor the run/count qualification appended after that value.
  assert.deepEqual(coloured({ value: null, display: 'y', loop, maxValueLength: 5 }), [
    'nameLabel "y: "', 'value "0, 1,… (+15 more characters)"',
    'nameLabel " · 100 runs · 10,000 iterations total"',
  ]);
});

test('aggregate counts cannot be hoisted into a shared single-run count', () => {
  assert.deepEqual(coloured({ value: null, display: 'y',
    loop: { ...trace(['1', '2', '1', '2'], null), invocations: 2 },
    bindings: [bound('u', ['4', '8', '4', '8'])],
  }), [
    'nameLabel "y: "', 'value "1, 2, 1, 2"',
    'nameLabel " · 2 runs · 4 iterations total"',
    'nameLabel "   "', 'nameLabel "u ×4: "', 'value "4, 8, 4, 8"',
  ]);
});

test('aggregate elision preserves the supplied head and final observation without inferring a range', () => {
  const loop = { ...trace(['9', '9'], '-4', 8), invocations: 3 };
  assert.equal(resultText({ value: null, display: 'y', loop }).split(NBSP).join(' '),
    'y: 9, 9, …, -4 · 3 runs · 8 iterations total');
  assert.match(hoverText({ value: null, display: 'y', loop }),
    /y = 9, 9, … \(\+5 more\) … -4/);
  assert.match(hoverText({ value: null, display: 'y', loop }),
    /first 2 and final observation/);
  // An adjacent final observation is not an omission, and one total
  // iteration among several empty runs still uses the singular noun.
  assert.equal(resultText({ value: null, display: 'y', loop: {
    ...loop, values: ['9', '9'], count: 3,
  } }).split(NBSP).join(' '), 'y: 9, 9, -4 · 3 runs · 3 iterations total');
  assert.equal(resultText({ value: null, display: 'y', loop: {
    ...loop, values: ['-4'], last: null, count: 1,
  } }).split(NBSP).join(' '), 'y: -4 · 3 runs · 1 iteration total');
});

test('the footnote and the caveat are remarks, not values', () => {
  // Both are this extension talking about the line rather than reporting what
  // ran on it, which is exactly what the label colour is for.
  assert.deepEqual(
    coloured({ value: '42', display: 'answer', names: pairs(['a', '1']),
      more: 2, partialFrom: 18 }),
    ['nameLabel "answer: "', 'value "42"',
      'nameLabel "   "',
      'nameLabel "a: "', 'value "1"',
      'nameLabel "   "',
      'nameLabel "…+2 more"',
      'nameLabel "   "',
      'nameLabel "(partial: line 19)"']);
});

test('a loop sequence is one value however many iterations it holds', () => {
  // The commas belong to the sequence, not to the annotation: they are how a
  // Python value of several parts is written, so colouring them as chrome
  // would claim this extension put them there. The `×3` is chrome, though --
  // it is this extension's own count, not part of the value that follows it.
  // `v` and `u` ran the same three times, so #118 folds their count into one
  // leading piece rather than repeating it on each name.
  assert.deepEqual(
    coloured({ value: '3', display: 'v', loop: trace(['1', '2', '3'], null),
      bindings: [bound('u', ['4', '8', '12'])] }),
    ['nameLabel "×3"',
      'nameLabel "   "',
      'nameLabel "v: "', 'value "1, 2, 3"',
      'nameLabel "   "',
      'nameLabel "u: "', 'value "4, 8, 12"']);
});

test('a line with nothing on it has no segments at all', () => {
  // `resultText` has always returned an empty string here, and an empty list
  // is the same claim: there is nothing to paint, so there is nothing to
  // colour.
  assert.deepEqual(resultSegments({ value: null, display: null }), []);
  assert.equal(resultText({ value: null, display: null }), '');
});


test('huge inline previews keep bounded heap and exact ASCII/Unicode grapheme counts', () => {
  // Run under the current test runtime, including CI's Node 20, with a small
  // heap. Eagerly collecting Segmenter records previously exhausted 4 GB
  // before the million-character Values fixture could render its preview.
  const checked = spawnSync(process.execPath, ['--max-old-space-size=96', '-e', `
    const assert = require('node:assert/strict');
    const { truncateValue } = require(process.argv[1]);
    assert.equal(truncateValue('x'.repeat(1000000), 120),
      'x'.repeat(120) + '… (+999,880 more characters)');
    assert.equal(truncateValue('line\\r\\n'.repeat(200000), 6),
      'line\\r\\nl… (+999,994 more characters)');
    const cluster = '🇸🇪e\\u0301👩‍👩‍👧‍👦';
    assert.equal(truncateValue(cluster.repeat(10000), 4),
      cluster + '🇸🇪… (+29,996 more characters)');
    process.stdout.write('ok');
  `, require.resolve('../render/format')], { encoding: 'utf8', timeout: 15000 });
  assert.equal(checked.error, undefined, String(checked.error));
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(checked.stdout, 'ok');
});
