import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LatestWins, LineDecoder, salvageResponse } from '../kernel/protocol';

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

test('an ordinary response salvages to itself, with nothing in front', () => {
  const { response, stray } = salvageResponse('{"id":1,"ok":true}');
  assert.deepEqual(response, { id: 1, ok: true });
  assert.equal(stray, '');
});

test('output spliced onto the front of a response does not destroy it', () => {
  // The shape that wedges a session: a write with no trailing newline lands on
  // the same line as the next response, so the whole line fails to parse and
  // an answer that was computed correctly is thrown away.
  const { response, stray } = salvageResponse(
    'PARTIAL FROM THREAD{"id":7,"ok":true,"value":"42"}');
  assert.deepEqual(response, { id: 7, ok: true, value: '42' });
  assert.equal(stray, 'PARTIAL FROM THREAD');
});

test('stray output containing a brace is skipped past, not parsed', () => {
  const { response, stray } = salvageResponse(
    'printed {a dict-ish thing}{"id":2,"ok":true}');
  assert.deepEqual(response, { id: 2, ok: true });
  assert.equal(stray, 'printed {a dict-ish thing}');
});

test('a line with no response in it salvages nothing', () => {
  const { response, stray } = salvageResponse('LATE THREAD PRINT');
  assert.equal(response, undefined);
  assert.equal(stray, 'LATE THREAD PRINT');
});

test('valid JSON that is not an object is not a response', () => {
  // `42` and `"hello"` parse. Treating either as a response would look up an
  // `id` on a number and drop it silently, which reads as the answer arriving.
  assert.equal(salvageResponse('42').response, undefined);
  assert.equal(salvageResponse('[{"id":1}]').response, undefined);
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
