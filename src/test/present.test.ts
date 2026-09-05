import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EvalResponse } from '../kernel/protocol';
import { present } from '../render/present';

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
