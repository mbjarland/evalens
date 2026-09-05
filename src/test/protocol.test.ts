import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LatestWins, LineDecoder } from '../kernel/protocol';

test('a response split across chunks is reassembled', () => {
  const decoder = new LineDecoder();
  assert.deepEqual(decoder.push('{"id":1,'), []);
  assert.deepEqual(decoder.push('"ok":true'), []);
  assert.deepEqual(decoder.push('}\n'), ['{"id":1,"ok":true}']);
});

test('several responses in one chunk all come out, in order', () => {
  const decoder = new LineDecoder();
  assert.deepEqual(decoder.push('{"id":1}\n{"id":2}\n{"id":3}\n'),
    ['{"id":1}', '{"id":2}', '{"id":3}']);
});

test('a chunk boundary mid-message leaves the tail buffered', () => {
  const decoder = new LineDecoder();
  assert.deepEqual(decoder.push('{"id":1}\n{"id":2'), ['{"id":1}']);
  assert.equal(decoder.pending, '{"id":2');
  assert.deepEqual(decoder.push('}\n'), ['{"id":2}']);
});

test('windows line endings are stripped', () => {
  // Python's text-mode stdout writes \r\n there, and a trailing \r makes
  // JSON.parse fail on a message that is otherwise fine.
  const decoder = new LineDecoder();
  assert.deepEqual(decoder.push('{"id":1}\r\n'), ['{"id":1}']);
});

test('blank lines are not delivered as messages', () => {
  const decoder = new LineDecoder();
  assert.deepEqual(decoder.push('\n\n{"id":1}\n\n'), ['{"id":1}']);
});

test('latest-wins keeps only the newest token per key', () => {
  const gate = new LatestWins<string>();
  const first = gate.claim('a.py');
  const second = gate.claim('a.py');
  assert.equal(gate.isCurrent('a.py', first), false,
    'the earlier evaluation must not paint over the later one');
  assert.equal(gate.isCurrent('a.py', second), true);
});

test('latest-wins tracks documents independently', () => {
  const gate = new LatestWins<string>();
  const a = gate.claim('a.py');
  gate.claim('b.py');
  assert.equal(gate.isCurrent('a.py', a), true,
    'evaluating in one document must not invalidate another');
});
