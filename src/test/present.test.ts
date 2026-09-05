import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EvalResponse } from '../kernel/protocol';
import { describeLoad, describeRun, present } from '../render/present';

const range = {
  start: { line: 3, character: 0 },
  end: { line: 3, character: 15 },
};

test('a value is presented at the range the kernel evaluated', () => {
  const response: EvalResponse = {
    id: 1, ok: true, resolved: true, value: '[1, 2, 3]', display: 'lst',
    kind: 'Assign', range, stdout: '', stderr: '',
  };
  const result = present(response, 3);
  assert.equal(result.kind, 'value');
  assert.deepEqual((result as { range: unknown }).range, range);
});

test('the hover names what was shown, not just its value', () => {
  const response: EvalResponse = {
    id: 1, ok: true, resolved: true, value: '[1, 2, 3]', display: 'lst',
    kind: 'Assign', range, stdout: '', stderr: '',
  };
  assert.equal((present(response, 3) as { hover: string }).hover,
    'lst = [1, 2, 3]');
});

test('the hover keeps the untouched repr the line describes', () => {
  // `def area(w, h)` is on the line because `<function area at 0x10614a610>`
  // changed on every evaluation. The address is not wrong, only unstable, so
  // it stays one hover away rather than being thrown out.
  const response: EvalResponse = {
    id: 1, ok: true, resolved: true,
    value: 'def area(w, h)', repr: '<function area at 0x10614a610>',
    display: 'area', kind: 'FunctionDef', range, stdout: '', stderr: '',
  };
  const shown = present(response, 3);
  assert.equal((shown as { value: string }).value, 'def area(w, h)');
  assert.equal((shown as { hover: string }).hover,
    'area = <function area at 0x10614a610>');
});

test('a value the kernel did not describe hovers as itself', () => {
  const response: EvalResponse = {
    id: 1, ok: true, resolved: true, value: '$4.00', display: 'price',
    kind: 'Assign', range, stdout: '', stderr: '',
  };
  assert.equal((present(response, 3) as { hover: string }).hover,
    'price = $4.00');
});

test('"ran with nothing to show" is not "nothing to run"', () => {
  // Both are ok:true. Conflating them either hides that an `if` executed, or
  // claims a blank line did.
  const ranSilently: EvalResponse = {
    id: 1, ok: true, resolved: true, value: null, display: null,
    kind: 'If', range, stdout: '', stderr: '',
  };
  const nothingThere: EvalResponse = { id: 2, ok: true, resolved: false };

  const first = present(ranSilently, 3);
  assert.equal(first.kind, 'value', 'the region should still be highlighted');
  assert.equal((first as { value: string | null }).value, null);

  assert.equal(present(nothingThere, 3).kind, 'nothing');
});

test('the names a line mentions reach the presentation and the hover', () => {
  const response: EvalResponse = {
    id: 1, ok: true, resolved: true, value: 'None',
    display: "print('y:', y)", kind: 'Expr', range, stdout: '', stderr: '',
    names: [{ name: 'y', value: '[1, 2, 3, 4]' }],
  };
  const shown = present(response, 3) as {
    names?: { name: string }[]; hover: string;
  };
  assert.deepEqual((shown.names ?? []).map((each) => each.name), ['y']);
  assert.equal(shown.hover, "print('y:', y) = None\ny = [1, 2, 3, 4]");
});

test('a statement with no value of its own still speaks through its names', () => {
  // An `if` produced nothing and bound `tier`. Treating "no value" as
  // "nothing to paint" throws away the only thing the line had to say.
  const response: EvalResponse = {
    id: 1, ok: true, resolved: true, value: null, display: null,
    kind: 'If', range, stdout: '', stderr: '',
    names: [{ name: 'tier', value: "'large'" }],
  };
  const shown = present(response, 3);
  assert.equal(shown.kind, 'value');
  assert.equal((shown as { hover?: string }).hover, "tier = 'large'");
});

test('a failure carries its traceback to the hover, not to the line', () => {
  const response: EvalResponse = {
    id: 1, ok: false,
    error: {
      type: 'NameError',
      message: "name 'x' is not defined",
      traceback: 'Traceback (most recent call last):\n  ...\nNameError',
    },
    range,
  };
  const result = present(response, 3);
  assert.equal(result.kind, 'error');
  assert.equal((result as { message: string }).message, "name 'x' is not defined");
  assert.match((result as { hover: string }).hover, /Traceback/);
});

test('a failure with no range is anchored where the user was looking', () => {
  const response: EvalResponse = {
    id: 1, ok: false,
    error: { type: 'ProtocolError', message: 'bad json', traceback: '' },
  };
  const result = present(response, 7) as { range: { start: { line: number } } };
  assert.equal(result.range.start.line, 7,
    'dropping it silently would make the keypress look ignored');
});

test('an error with an empty traceback still has something to hover', () => {
  const response: EvalResponse = {
    id: 1, ok: false,
    error: { type: 'UnknownOp', message: "unknown op 'nonsense'", traceback: '' },
  };
  assert.equal((present(response, 0) as { hover: string }).hover,
    "unknown op 'nonsense'");
});

test("a compound statement's anchor reaches the presentation", () => {
  // The range still covers the whole `def`; the anchor is the `def` line.
  const response: EvalResponse = {
    id: 1, ok: true, resolved: true, value: 'def greet(name)',
    display: 'greet',
    kind: 'FunctionDef', anchor: 3, stdout: '', stderr: '',
    range: { start: { line: 3, character: 0 }, end: { line: 4, character: 20 } },
  };
  assert.equal((present(response, 3) as { anchor?: number }).anchor, 3);
});

test('a statement with no anchor of its own says nothing about one', () => {
  // Absent means "the end of the range", which is where results have always
  // gone; inventing a number here would be a second source of truth.
  const response: EvalResponse = {
    id: 1, ok: true, resolved: true, value: '30', display: 'total',
    kind: 'Assign', range, stdout: '', stderr: '',
  };
  assert.equal((present(response, 3) as { anchor?: number }).anchor, undefined);
});

test('a failure inside a compound statement keeps its header anchor', () => {
  const response: EvalResponse = {
    id: 1, ok: false, anchor: 3, range,
    error: { type: 'NameError', message: 'nope', traceback: '' },
  };
  assert.equal((present(response, 9) as { anchor?: number }).anchor, 3);
});

test("a loop's sequence reaches the presentation intact", () => {
  const response: EvalResponse = {
    id: 1, ok: true, resolved: true, value: '4', display: 'p',
    kind: 'For', range, stdout: '', stderr: '',
    loop: { values: ['1', '2', '3', '4'], last: null, count: 4 },
  };
  const result = present(response, 3) as { loop: { count: number }; hover: string };
  assert.equal(result.loop.count, 4);
  assert.equal(result.hover, 'p = 1, 2, 3, 4\n4 iterations');
});

test("what a loop's body bound reaches the presentation and the hover", () => {
  const response: EvalResponse = {
    id: 1, ok: true, resolved: true, value: '3', display: 'v',
    kind: 'For', range, stdout: '', stderr: '',
    loop: { values: ['1', '2', '3'], last: null, count: 3 },
    bindings: [{ name: 'u', values: ['4', '12'], last: null, count: 2 }],
  };
  const result = present(response, 3) as {
    bindings: readonly { name: string }[]; hover: string;
  };
  assert.deepEqual(result.bindings.map((each) => each.name), ['u']);
  assert.equal(result.hover,
    'v = 1, 2, 3\n3 iterations\nu = 4, 12 (bound on 2 of 3 iterations)');
});

test('a loop that ran zero times is still something to paint', () => {
  // value is null, as it is for an `if` -- but unlike an `if`, this has an
  // answer, and skipping it leaves the previous run's value on screen.
  const response: EvalResponse = {
    id: 1, ok: true, resolved: true, value: null, display: 'p',
    kind: 'For', range, stdout: '', stderr: '',
    loop: { values: [], last: null, count: 0 },
  };
  const result = present(response, 3);
  assert.equal(result.kind, 'value');
  assert.equal((result as { hover?: string }).hover,
    'p = (no iterations)\n0 iterations');
});

test('running a selection says how many statements ran, not how many loaded', () => {
  // "loaded 3 statements" beside a run of three selected lines is a true
  // sentence about the wrong thing: it reads as a whole file that happened to
  // be short.
  assert.equal(describeRun(3, 3, 0, false), 'Evalens: ran 3 statements');
  assert.equal(describeRun(1, 1, 0, false), 'Evalens: ran 1 statement');
});

test('a widened run says that it widened', () => {
  // A statement runs whole or not at all, so a selection starting inside a
  // `def` executed the entire `def`. A count with no word about that is a
  // count the reader will attribute to the lines they highlighted.
  assert.equal(describeRun(2, 2, 0, true),
    'Evalens: ran 2 statements, widened to whole statements');
});

test('a failure inside a selection is reported the way a load reports one', () => {
  // Failures do not stop the run, so the count has to distinguish what ran
  // from what was attempted -- the same distinction, said the same way.
  assert.equal(describeRun(2, 3, 1, false),
    'Evalens: ran 2 of 3 statements, 1 failed');
  assert.equal(describeLoad(2, 3, 1),
    'Evalens: loaded 2 of 3 statements, 1 failed');
});

test('a selection with no complete statement in it is not an error', () => {
  // Selecting a comment. The same answer a blank line under the cursor gets,
  // and said in the same place rather than in an error box.
  assert.equal(describeRun(0, 0, 0, false),
    'Evalens: nothing to run in the selection');
});
