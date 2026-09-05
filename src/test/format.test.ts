import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BindingTrace, LoopTrace, NamedValue } from '../kernel/protocol';
import {
  SEPARATOR, alignmentGap, bindingText, collapseLines, columnWidth, errorText,
  hoverText, preserveSpacing, restatesLine, resultText, sequenceText,
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

test('a value that already says the name is not labelled with it as well', () => {
  // `greet: def greet(name)` was two features colliding: one labels a binding
  // with its name, the other describes a function as its signature. Neither
  // knew about the other, so every function definition in every file said its
  // name twice.
  assert.equal(resultText('def greet(name)', 'greet'),
    preserveSpacing('def greet(name)'));
  assert.equal(resultText('class Config(name, port=8080)', 'Config'),
    preserveSpacing('class Config(name, port=8080)'));
});

test('a label that is not a repetition is exactly what the line needs', () => {
  // The case the whole `def` prefix exists for: this line does not say what
  // `f` now is, and the annotation does.
  assert.equal(resultText('def greet(name)', 'f'),
    preserveSpacing('f: def greet(name)'));
  // And an alias, where the label carries the only fact the reader is short
  // of -- that `Record` is a `SimpleNamespace`.
  assert.equal(resultText('class SimpleNamespace(**kwargs)', 'Record'),
    preserveSpacing('Record: class SimpleNamespace(**kwargs)'));
});

test('a name that merely starts the value is not the value saying it', () => {
  // `greeting` opens `greeting_card` and is not the name it binds. A bare
  // prefix test would drop the label here and leave the reader guessing.
  assert.equal(resultText('def greeting_card(to)', 'greeting'),
    preserveSpacing('greeting: def greeting_card(to)'));
});

test('the dropped label leaves everything else on the line alone', () => {
  // The reads still follow what the statement did, in the same order.
  assert.equal(
    resultText('def greet(name)', 'greet', null, pairs(['salutation', "'hi'"])),
    preserveSpacing("def greet(name)   salutation: 'hi'"));
});

test('a loop shows the sequence, not the value it stopped on', () => {
  // The point of the whole feature: `p: 4` is true and nearly useless.
  assert.equal(resultText('4', 'p', trace(['1', '2', '3', '4'], null)),
    preserveSpacing('p: 1, 2, 3, 4'));
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
  assert.equal(resultText('', 'p', trace([], null, 0)),
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
    resultText(null, null, null, pairs(['tier', "'large'"], ['budget', '525'])),
    preserveSpacing("tier: 'large'   budget: 525"));
});

test('a binding leads and the names it read follow it', () => {
  // `y = x` did one thing and depended on another; the order says which.
  assert.equal(resultText('[1, 2, 3]', 'y', null, pairs(['x', '[1, 2, 3]'])),
    preserveSpacing('y: [1, 2, 3]   x: [1, 2, 3]'));
});

test('an expression result follows the reads it came from', () => {
  // `y.pop()` read `y` and produced 4; the 4 is the consequence, so it lands
  // where a reader looks last.
  assert.equal(resultText('4', 'y.pop()', null, pairs(['y', '[1, 2, 3]'])),
    preserveSpacing('y: [1, 2, 3]   => 4'));
});

test('a produced None gives way to anything else on the line', () => {
  // The shape of every mutating method in Python. The None adds nothing the
  // reader has not already read immediately to its left.
  assert.equal(
    resultText('None', 'y.append(4)', null, pairs(['y', '[1, 2, 3, 4]'])),
    preserveSpacing('y: [1, 2, 3, 4]'));
  assert.equal(
    resultText('None', "print('y:', y)", null, pairs(['y', '[1, 2, 3, 4]'])),
    preserveSpacing('y: [1, 2, 3, 4]'));
});

test('a produced None survives when it is the only answer', () => {
  // `d.get('missing')` really did answer None, and blanking it would leave
  // the line looking like nothing happened.
  assert.equal(resultText('None', "d.get('missing')"),
    preserveSpacing('=> None'));
  assert.equal(resultText('None', "d.get('missing')", null, []),
    preserveSpacing('=> None'));
});

test('a name bound to None keeps it, however much else is shown', () => {
  // `noise = lst.append(99)` is the case where there is a value to show and
  // it happens to be nothing -- which is the lesson, not the noise.
  assert.equal(resultText('None', 'noise', null, pairs(['lst', '[1, 2]'])),
    preserveSpacing('noise: None   lst: [1, 2]'));
});

test('an unpacking assignment reads as one pair per binding', () => {
  // `d1, d2 = {'a': 1}, {'b': 2}` painted `=> ({'a': 1}, {'b': 2})` -- the
  // right-hand side echoed back, which is already on the line. The kernel now
  // leaves the display slot empty and sends the bindings as names, so this
  // composes with the rendering above rather than adding a shape of its own.
  assert.equal(
    resultText(null, null, null, pairs(['d1', "{'a': 1}"], ['d2', "{'b': 2}"])),
    preserveSpacing("d1: {'a': 1}   d2: {'b': 2}"));
  assert.equal(
    resultText(null, null, null, pairs(['head', '1'], ['rest', '[2, 3, 4]'])),
    preserveSpacing('head: 1   rest: [2, 3, 4]'));
});

test('a statement with no value of its own still shows its names', () => {
  // An `if` produces nothing and can still be the most informative line in a
  // file: what it bound is the answer.
  assert.equal(resultText(null, null, null, pairs(['tier', "'large'"])),
    preserveSpacing("tier: 'large'"));
});

test("a loop's sequence leads and the names it read follow", () => {
  assert.equal(
    resultText('16', 'p', trace(['1', '4', '9', '16'], null),
      pairs(['squares', '[1, 4, 9, 16]'])),
    preserveSpacing('p: 1, 4, 9, 16   squares: [1, 4, 9, 16]'));
});

test('a tuple loop target still leads with its sequence', () => {
  // `(key, value)` is too much of an expression to label with, and the
  // sequence is still what the statement did.
  assert.equal(
    resultText("('b', 2)", '(key, value)', trace(["('a', 1)", "('b', 2)"], null),
      pairs(['shelf', "{'a': 1, 'b': 2}"])),
    preserveSpacing("=> ('a', 1), ('b', 2)   shelf: {'a': 1, 'b': 2}"));
});

test('what the loop computed is shown as a sequence, not as where it stopped', () => {
  // The ticket's case. `u` took 4, 8 and 12, and the annotation said `u: 12`
  // beside a target rendered as a history -- so one of the two names on the
  // line read as the other's last entry.
  assert.equal(
    resultText('3', 'v', trace(['1', '2', '3'], null),
      pairs(['x', '[1, 2, 3]']), [bound('u', ['4', '8', '12'])]),
    preserveSpacing('v: 1, 2, 3   u: 4, 8, 12   x: [1, 2, 3]'));
});

test('a body binding shorter than the loop still renders', () => {
  // A filter loop: three iterations, two results, because the iteration that
  // hit `continue` computed nothing. Anything that zipped or padded the two
  // sequences would invent an observation here.
  assert.equal(
    resultText('3', 'v', trace(['1', '2', '3'], null), [],
      [bound('u', ['4', '12'], 2)]),
    preserveSpacing('v: 1, 2, 3   u: 4, 12'));
});

test('an unchanging binding is one reading beside a moving one', () => {
  // `c: 7, 7, 7, 7` is four observations of one fact, and it crowds out the
  // sequence next to it that is actually moving.
  assert.equal(
    resultText('4', 'v', trace(['1', '2', '3', '4'], null), [],
      [bound('c', ['7'], 4, { constant: true }),
        bound('d', ['1', '4', '9', '16'])]),
    preserveSpacing('v: 1, 2, 3, 4   c: 7   d: 1, 4, 9, 16'));
});

test('a body binding is bounded exactly as the target is', () => {
  assert.equal(
    bindingText(bound('u', ['0', '2', '4', '6', '8'], 10000,
      { last: '19998' })),
    'u: 0, 2, 4, 6, 8, … (+9,994 more) … 19998');
});

test('a line says when the cap left names off it', () => {
  // Silently is the problem, not the cap. A reader who counts five names on
  // the line and four beside it cannot tell whether the fifth was omitted,
  // unreadable, or somehow not a name.
  assert.equal(
    resultText(null, null, null,
      pairs(['a', '1'], ['b', '2'], ['c', '3'], ['d', '4']), [], 1),
    preserveSpacing('a: 1   b: 2   c: 3   d: 4   \u2026+1 more'));
});

test('the footnote lands after the result, not among the values', () => {
  // It is a note about the line rather than another value on it.
  assert.equal(
    resultText('4', 'y.pop()', null, pairs(['y', '[1, 2, 3]']), [], 2),
    preserveSpacing('y: [1, 2, 3]   => 4   \u2026+2 more'));
});

test('a line the cap did not touch says nothing about it', () => {
  assert.equal(resultText(null, null, null, pairs(['a', '1']), [], 0),
    preserveSpacing('a: 1'));
  assert.equal(resultText(null, null, null, pairs(['a', '1'])),
    preserveSpacing('a: 1'));
});

test('a multi-line value in a pair collapses like any other', () => {
  assert.equal(resultText(null, null, null, pairs(['p', 'Point(\n  x=1\n)'])),
    preserveSpacing('p: Point( x=1 )'));
});

test('an annotation that only restates its own line is not worth painting', () => {
  // Even with the name said once and the `def` in front of it, this is tidier
  // duplication rather than information. The evaluated-region highlight is
  // what still reports that it ran.
  const painted = resultText('def greet(name)', 'greet');
  assert.equal(restatesLine(painted, 'def greet(name):'), true);
  assert.equal(restatesLine(painted, '    def greet(name):'), true,
    'indentation is not something the reader is being told');
  assert.equal(restatesLine(painted, 'def greet(name):  # says hello'), true,
    'a trailing comment is not part of the statement');
  assert.equal(restatesLine(painted, 'def  greet(name) :'), true,
    'spacing folds, the way it does everywhere else here');
});

test('a decorated function still says what the decorator produced', () => {
  // The case a naive "skip FunctionDef" would have destroyed, and the reason
  // the comparison is against the rendered text rather than the statement
  // kind: the decorator REPLACED the function and the line cannot show that.
  assert.equal(
    restatesLine(resultText('def <lambda>()', 'greeting'), 'def greeting():'),
    false);
});

test('a line the annotation only half restates keeps its annotation', () => {
  // Each of these says something the line does not: what awaiting gives you,
  // what constructing one takes, and what the other names on the line held.
  assert.equal(
    restatesLine(resultText('def drain(stream) -> coroutine', 'drain'),
      'async def drain(stream):'),
    false);
  assert.equal(
    restatesLine(resultText('class Config(name, port=8080)', 'Config'),
      'class Config:'),
    false);
  assert.equal(
    restatesLine(resultText('def greet(name)', 'greet', null,
      pairs(['salutation', "'hi'"])), 'def greet(name):'),
    false);
});

test('an ordinary binding is never mistaken for a restatement', () => {
  // `x: 1` and `x = 1` are the same fact said twice only to someone who
  // already knows the answer, which is the reader this extension is not for.
  assert.equal(restatesLine(resultText('1', 'x'), 'x = 1'), false);
  assert.equal(restatesLine(resultText('30', 'sum([10, 20])'),
    'sum([10, 20])'), false);
  assert.equal(restatesLine('', 'def greet(name):'), false,
    'an empty annotation is a prefix of everything');
});

test('a hover carries the production a line suppressed', () => {
  // Demoted, not destroyed: `y = y.append(4)` binding None is a real trap,
  // learned exactly once, and then noise on every mutating call after that.
  assert.equal(
    hoverText('y.append(4)', 'None', null, pairs(['y', '[1, 2, 3, 4]'])),
    'y.append(4) = None\ny = [1, 2, 3, 4]');
});

test('a hover with nothing produced starts with the names', () => {
  assert.equal(hoverText(null, null, null, pairs(['tier', "'large'"])),
    "tier = 'large'");
});

test('a hover prefers the untouched repr a pair describes', () => {
  // The same rule the produced value follows: describing hides nothing, it
  // only moves the address one hover away.
  assert.equal(
    hoverText('cfg', '<Config instance>', null,
      [{ name: 'other', value: '<Config instance>', repr: '<Config at 0x1>' }]),
    'cfg = <Config instance>\nother = <Config at 0x1>');
});

test('a hover names the binding and says how many iterations there were', () => {
  // The line is elided; the hover is where the count belongs.
  assert.equal(hoverText('p', '10000', trace(['1'], '10000', 10000)),
    'p = 1, … (+9,998 more) … 10000\n10000 iterations');
  assert.equal(hoverText('p', '1', trace(['1'], null, 1)),
    'p = 1\n1 iteration');
});

test('a hover spells out what a short binding means', () => {
  // Inline, `u: 4, 12` and `c: 7` are both just short. The hover is where the
  // difference between "the body took an early exit" and "this never changed"
  // has room to be said.
  assert.equal(
    hoverText('v', '3', trace(['1', '2', '3'], null), [],
      [bound('u', ['4', '12'], 2)]),
    'v = 1, 2, 3\n3 iterations\nu = 4, 12 (bound on 2 of 3 iterations)');
  assert.equal(
    hoverText('v', '3', trace(['1', '2', '3'], null), [],
      [bound('c', ['7'], 3, { constant: true })]),
    'v = 1, 2, 3\n3 iterations\nc = 7 (unchanged over 3 iterations)');
});

test('a hover says nothing extra about a binding that kept up', () => {
  assert.equal(
    hoverText('v', '3', trace(['1', '2', '3'], null), [],
      [bound('u', ['4', '8', '12'])]),
    'v = 1, 2, 3\n3 iterations\nu = 4, 8, 12');
});

test('a hover without a loop is unchanged', () => {
  assert.equal(hoverText('lst', '[1, 2, 3]'), 'lst = [1, 2, 3]');
  assert.equal(hoverText(null, '[1, 2, 3]'), '[1, 2, 3]');
});
