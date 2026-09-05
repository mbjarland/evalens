import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EvalResponse, PartialParse } from '../kernel/protocol';
import {
  describeLoad, describeRun, partialCause, present,
} from '../render/present';

const range = {
  start: { line: 3, character: 0 },
  end: { line: 3, character: 15 },
};

/** A file whose line 19 did not parse, as the kernel reports it. */
const partial: PartialParse = {
  truncated_at: 18,
  error: {
    type: 'SyntaxError',
    message: 'unterminated string literal (detected at line 19)',
    traceback: 'SyntaxError: unterminated string literal\n',
  },
  range: {
    start: { line: 18, character: 4 }, end: { line: 18, character: 4 },
  },
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

test('what a statement printed reaches the presentation and the hover', () => {
  // The gap this closes: the kernel had been sending `stdout` all along and
  // the cursor path never once looked at it, so `print("hello")` painted the
  // None it returned and the `hello` went nowhere the reader would find it.
  const response: EvalResponse = {
    id: 1, ok: true, resolved: true, value: 'None',
    display: 'print("hello")', kind: 'Expr', range,
    stdout: 'hello\n', stderr: '',
  };
  const shown = present(response, 3) as {
    printed?: { stdout?: string; stderr?: string }; hover: string;
  };
  assert.equal(shown.printed?.stdout, 'hello\n');
  assert.equal(shown.hover, 'print("hello") = None\nprinted: hello');
});

test('a statement that only printed still speaks', () => {
  // A `while` has no target to point at and no value of its own, and its
  // output is the whole of what it had to show. Treating "no value" as
  // "nothing to paint" would throw it away.
  const response: EvalResponse = {
    id: 1, ok: true, resolved: true, value: null, display: null,
    kind: 'While', range, stdout: 'tick 3\ntick 2\ntick 1\n', stderr: '',
  };
  const shown = present(response, 3);
  assert.equal(shown.kind, 'value');
  assert.equal((shown as { hover?: string }).hover,
    'printed:\ntick 3\ntick 2\ntick 1');
});

test('writing to stderr is presented as a value, never as a failure', () => {
  // `ok` is true and there is no error on the presentation, which is what
  // keeps a library's warning out of the error colour. A student taught to
  // fear a line that worked is worse off than one shown nothing.
  const response: EvalResponse = {
    id: 1, ok: true, resolved: true, value: 'None',
    display: 'warn()', kind: 'Expr', range,
    stdout: '', stderr: 'careful\n',
  };
  const shown = present(response, 3);
  assert.equal(shown.kind, 'value', 'stderr is not an error');
  assert.equal((shown as { printed?: { stderr?: string } }).printed?.stderr,
    'careful\n');
});

test('a statement that printed nothing carries no output at all', () => {
  // Absent rather than empty, so nothing downstream has to tell "wrote
  // nothing" from "wrote an empty string" by inspecting two fields.
  const response: EvalResponse = {
    id: 1, ok: true, resolved: true, value: '30', display: 'total',
    kind: 'Assign', range, stdout: '', stderr: '',
  };
  assert.equal((present(response, 3) as { printed?: unknown }).printed,
    undefined);
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

test('a value from a reduced context keeps the caveat with it', () => {
  const response: EvalResponse = {
    id: 1, ok: true, resolved: true, value: '42', display: 'answer',
    kind: 'Assign', range, stdout: '', stderr: '', partial,
  };
  const result = present(response, 3) as { partial?: PartialParse };
  assert.equal(result.partial?.truncated_at, 18);
});

test('the hover of a partial value says what was left out', () => {
  const response: EvalResponse = {
    id: 1, ok: true, resolved: true, value: '42', display: 'answer',
    kind: 'Assign', range, stdout: '', stderr: '', partial,
  };
  const result = present(response, 3) as { hover: string };
  assert.match(result.hover, /evaluated without line 19 onwards/);
  assert.match(result.hover, /unterminated string literal/);
});

test('a failure under a reduced context carries the caveat as well', () => {
  // The lines left out are the likeliest reason the name is not defined.
  const response: EvalResponse = {
    id: 1, ok: false, range, partial,
    error: {
      type: 'NameError', message: "name 'helper' is not defined",
      traceback: '',
    },
  };
  const result = present(response, 3) as { partial?: PartialParse };
  assert.equal(result.partial?.truncated_at, 18);
});

test('a response that parsed whole says nothing about a partial one', () => {
  // Absence is the signal, so it has to be genuinely absent.
  const response: EvalResponse = {
    id: 1, ok: true, resolved: true, value: '42', display: 'answer',
    kind: 'Assign', range, stdout: '', stderr: '',
  };
  const result = present(response, 3) as { partial?: PartialParse };
  assert.equal(result.partial, undefined);
});

test('the break is presented at the line that caused it', () => {
  // The half of the complaint that cost the most: a break on line 19 used to
  // surface as a failed evaluation on line 1, which sends the reader to the
  // wrong end of the file with a message about a line they were not looking
  // at.
  const cause = partialCause(partial);
  assert.equal(cause.kind, 'error');
  assert.equal(cause.range.start.line, 18);
  assert.equal(cause.type, 'SyntaxError');
  assert.equal(cause.hover, 'SyntaxError: unterminated string literal\n');
});

test('a partial load says the count is a count of the part that parsed', () => {
  // "loaded 18 statements" on a file with 30 in it is true and reads as
  // complete.
  assert.equal(describeLoad(18, 18, 0, 18),
    'Evalens: loaded 18 statements; line 19 onwards did not parse');
  assert.equal(describeLoad(16, 18, 2, 18),
    'Evalens: loaded 16 of 18 statements, 2 failed;'
    + ' line 19 onwards did not parse');
});

test('a load of a file that parsed whole says nothing extra', () => {
  assert.equal(describeLoad(18, 18, 0), 'Evalens: loaded 18 statements');
});

test('a partial run says the count is a count of the part that parsed', () => {
  // #14 gave the caveat to `describeLoad` alone, because a selection did not
  // exist yet. Running a selection in a broken file is the same sentence
  // about a smaller thing, and leaving it out would make a narrowed run the
  // one command that quietly drops the reason its count is short.
  assert.equal(describeRun(3, 3, 0, false, 18),
    'Evalens: ran 3 statements; line 19 onwards did not parse');
  assert.equal(describeRun(2, 3, 1, true, 18),
    'Evalens: ran 2 of 3 statements, 1 failed, widened to whole statements;'
    + ' line 19 onwards did not parse');
});

test('a selection below the break says why nothing ran', () => {
  // The composition case that matters most. "nothing to run in the selection"
  // on its own reads as "you selected comments", and the user selected code:
  // it is below the line the file stops parsing at, so it is not in the tree
  // and cannot run. Without the reason, the extension looks broken again --
  // which is the complaint #14 was filed about.
  assert.equal(describeRun(0, 0, 0, false, 18),
    'Evalens: nothing to run in the selection; line 19 onwards did not parse');
});

test('a run over a file that parsed whole says nothing extra', () => {
  // Absence is the signal here too, so it has to stay genuinely absent.
  assert.equal(describeRun(3, 3, 0, false), 'Evalens: ran 3 statements');
  assert.equal(describeRun(0, 0, 0, false),
    'Evalens: nothing to run in the selection');
});
