import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorDetails, errorDetails, errorGuidance } from '../render/errorGuidance';
import { present } from '../render/present';

for (const builtinType of ['NameError', 'ValueError'] as const) {
  test(`${builtinType} guidance preserves the original structured error and traceback`, () => {
    const error = {
      type: builtinType, builtinType, message: 'untouched message',
      traceback: 'Traceback (most recent call last):\n  example.py, line 1\nexact error\n',
    };
    const presentation = present({ id: 1, ok: false, error }, 2);
    assert.equal(presentation.kind, 'error');
    if (presentation.kind !== 'error') return;
    assert.equal(presentation.hover, error.traceback);
    assert.equal(presentation.message, error.message);
    assert.deepEqual(errorDetails(presentation), {
      type: builtinType, builtinType, message: error.message,
    });
    const guidance = errorGuidance(presentation)!;
    assert.ok(guidance);
    assert.doesNotMatch(guidance, /command:|https?:/);
    if (builtinType === 'NameError') {
      assert.match(guidance, /referenced name/);
      assert.match(guidance, /spelling/);
      assert.match(guidance, /defines it has run/);
      assert.match(guidance, /Evaluate Above Cursor/);
      assert.match(guidance, /resets state and runs earlier statements/);
    } else {
      assert.match(guidance, /For example, `int\("hello"\)`/);
      assert.match(guidance, /Check the original error message/);
      assert.doesNotMatch(guidance, /your input|you typed/);
    }
  });
}

test('missing, unknown and mismatched class identity never produce guidance', () => {
  const message = 'NameError: name is missing\nValueError: invalid literal';
  for (const error of [undefined,
    { type: 'NameError', message },
    { type: 'ValueError', message },
    { type: 'RuntimeError', message },
    { type: 'Custom', builtinType: 'NameError', message },
    { type: 'NameError', builtinType: 'ValueError', message },
    { type: '__proto__', builtinType: '__proto__', message },
  ]) {
    assert.equal(errorGuidance(error as ErrorDetails | undefined), undefined);
  }
});
