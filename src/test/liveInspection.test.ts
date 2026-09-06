import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CancellationToken } from 'vscode';
import { KernelClient } from '../kernel/client';
import { Inspected } from '../kernel/protocol';
import { LiveInspection } from '../render/liveInspection';
import { literalBlock, literalCell } from '../render/markdown';

test('optional inspection times out, coalesces and never accumulates a queue',
async () => {
  let calls = 0;
  let finish!: (value: undefined) => void;
  const client = { requestIfIdle: () => {
    calls++;
    return new Promise<Inspected | undefined>((r) => { finish = r; });
  } } as unknown as KernelClient;
  const reader = new LiveInspection(10);
  assert.deepEqual(await Promise.all([
    reader.ask(client, 'x'), reader.ask(client, 'x'), reader.ask(client, 'y'),
  ]), [undefined, undefined, undefined]);
  assert.equal(calls, 1);
  await reader.ask(client, 'x');
  assert.equal(calls, 1, 'a deadline must not release the in-flight slot');
  finish(undefined);
  await new Promise((r) => setImmediate(r));
  const next = reader.ask(client, 'x');
  assert.equal(calls, 2);
  finish(undefined);
  await next;
});

test('cancellation returns without waiting for the optional read', async () => {
  let cancel!: () => void;
  let disposed = false;
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: (callback: () => void) => {
      cancel = callback;
      return { dispose: () => { disposed = true; } };
    },
  } as CancellationToken;
  const client = {
    requestIfIdle: () => new Promise(() => {}),
  } as unknown as KernelClient;
  const reading = new LiveInspection(10000).ask(client, 'x', token);
  cancel();
  assert.equal(await reading, undefined);
  assert.equal(disposed, true);
});

test('value fences and table cells cannot create Markdown command links', () => {
  const payload = '```\n[run](command:evalens.inspectValue?%5B%22x%22%5D)\n````';
  assert.equal(literalBlock(payload), `\`\`\`\`\`\n${payload}\n\`\`\`\`\``);
  assert.match(literalCell(payload), /\\\[run\\\]\\\(command:/);
  assert.doesNotMatch(literalCell(payload), /(?<!\\)\[run\]/);
});
