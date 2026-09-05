import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InOrder } from '../load';
import { Annotated, PaintedAbove } from '../render/repeats';

/**
 * A painter that records what it was handed, in the order it was handed it.
 *
 * The whole assertion of this file is about that order, so nothing else is
 * needed: `InOrder` decides *which* statement is painted next and nothing about
 * what painting one looks like.
 */
function recorder(): { seen: string[]; paint: (o: string, i: number) => void } {
  const seen: string[] = [];
  return { seen, paint: (outcome, index) => seen.push(`${index}:${outcome}`) };
}

test('frames arriving in order paint in order', () => {
  const { seen, paint } = recorder();
  const order = new InOrder(paint);

  assert.equal(order.offer(0, 'a'), true);
  assert.equal(order.offer(1, 'b'), true);
  assert.equal(order.offer(2, 'c'), true);

  assert.deepEqual(seen, ['0:a', '1:b', '2:c']);
  assert.equal(order.painted, 3);
  assert.equal(order.interrupted, false);
});

test('the response paints only what the frames did not', () => {
  // The ordinary healthy load: every statement was announced while it ran, so
  // `results` arrives with nothing left to do. Painting it again would put a
  // second copy of the file through repeat suppression, which is where the
  // damage would show rather than in a doubled annotation.
  const { seen, paint } = recorder();
  const order = new InOrder(paint);

  order.offer(0, 'a');
  order.offer(1, 'b');
  order.settle(['a', 'b']);

  assert.deepEqual(seen, ['0:a', '1:b']);
});

test('a kernel that streams nothing still paints the whole file, in order', () => {
  // The control channel is optional -- a kernel spawned with three pipes has
  // none -- and the old behaviour has to survive exactly. This is that
  // behaviour: no frames at all, and the response does all of it.
  const { seen, paint } = recorder();
  const order = new InOrder(paint);

  order.settle(['a', 'b', 'c']);

  assert.deepEqual(seen, ['0:a', '1:b', '2:c']);
  assert.equal(order.painted, 3);
});

test('the response finishes a load whose last frames have not arrived', () => {
  // Not hypothetical: the frames travel on one pipe and the response on
  // another, and nothing orders two pipes against each other. The response can
  // and does overtake the last frame or two.
  const { seen, paint } = recorder();
  const order = new InOrder(paint);

  order.offer(0, 'a');
  order.settle(['a', 'b', 'c']);

  assert.deepEqual(seen, ['0:a', '1:b', '2:c']);
});

test('a frame that lost the race to the response is dropped, not repainted', () => {
  const { seen, paint } = recorder();
  const order = new InOrder(paint);

  order.offer(0, 'a');
  order.settle(['a', 'b', 'c']);
  // Frames 1 and 2 turn up afterwards, having been queued behind the response.
  assert.equal(order.offer(1, 'b'), false);
  assert.equal(order.offer(2, 'c'), false);

  assert.deepEqual(seen, ['0:a', '1:b', '2:c'],
    'each statement painted exactly once, in file order');
  assert.equal(order.interrupted, false,
    'losing that race is expected, not an anomaly');
});

test('a frame that skips one is refused, and the rest with it', () => {
  // The failure that must never reach the screen. Painting statement 2 while
  // statement 1 is missing would leave repeat suppression comparing against
  // the wrong "above" for every line under it -- and a wrongly suppressed
  // annotation is indistinguishable from a statement that had nothing to say.
  const { seen, paint } = recorder();
  const order = new InOrder(paint);

  order.offer(0, 'a');
  assert.equal(order.offer(2, 'c'), false);
  assert.equal(order.offer(3, 'd'), false);

  assert.deepEqual(seen, ['0:a']);
  assert.equal(order.interrupted, true);
});

test('a load that stopped streaming still paints everything, in order', () => {
  // The cost of a lost frame is that the file stops appearing progressively
  // and appears all at once at the end. That is where this ticket started, so
  // it is an acceptable floor -- what is not acceptable is a gap on screen.
  const { seen, paint } = recorder();
  const order = new InOrder(paint);

  order.offer(0, 'a');
  order.offer(2, 'c');
  order.settle(['a', 'b', 'c', 'd']);

  assert.deepEqual(seen, ['0:a', '1:b', '2:c', '3:d']);
});

test('the suppressor is only ever fed statements top to bottom', () => {
  // Stated against the real rule rather than against a counter, because
  // `PaintedAbove` is the whole reason the ordering matters. The file rebinds
  // `x` between two lines that read it, so the reader under each binding is a
  // repeat and each binding itself is news -- an answer only a downward walk
  // produces, and one that survives a lost frame here only because the
  // reconciliation resumes where the frames stopped.
  const above = new PaintedAbove();
  const painted: (string | null)[] = [];
  const order = new InOrder<Annotated>((outcome) => {
    painted.push(above.keep(outcome) === undefined ? null : outcome.display!);
  });

  const file: Annotated[] = [
    { display: 'x', value: '1' },
    { display: 'print(x)', value: 'None', names: [{ name: 'x', value: '1' }] },
    { display: 'x', value: '2' },
    { display: 'print(x)', value: 'None', names: [{ name: 'x', value: '2' }] },
  ];

  // Delivered with a gap, then reconciled: between them the two paths must
  // still walk the file exactly once, downward.
  order.offer(0, file[0]!);
  order.offer(3, file[3]!);
  order.settle(file);

  assert.deepEqual(painted, ['x', null, 'x', null],
    'the repeat under each binding is suppressed, and neither binding is');
});
