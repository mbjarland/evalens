import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  Announceable, NOTHING_HERE, SPOKEN_LIMIT, STILL_RUNNING, annotationAt,
  announcement, announcesAutomatically, capSpoken, spokenText, statusText,
} from '../render/announce';
import { resultText } from '../render/format';

const root = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

/**
 * The announced channel exists because a decoration cannot be labelled, and
 * every assertion here is about what a listener is told rather than about what
 * is painted. Nothing in this file proves that a screen reader actually speaks
 * any of it -- that check needs VoiceOver and a human, and has not been
 * performed. What it does prove is that when something is spoken it is the
 * same answer the line carries, with the caveats a picture was carrying.
 */

const value = (over: Partial<Announceable> = {}): Announceable => ({
  value: '[1, 2, 3]', display: 'lst', ...over,
});

/** What `preserveSpacing` puts in the painted text and must never speak. */
const NBSP = ' ';

test('a binding is spoken with its name and its value', () => {
  assert.equal(spokenText(value()), 'lst is [1, 2, 3]');
});

test('a value the painted line would truncate is still spoken in full', () => {
  // #12 cuts a painted value at DEFAULT_MAX_VALUE_LENGTH (120 characters) --
  // format.ts's own concern, applied only in the painter's private pipeline.
  // Speech goes through the shared `paintedSlots` and has its own, more
  // generous limit (SPOKEN_LIMIT, 300); it must not inherit the shorter one
  // just because the two channels start from the same slots.
  const long = `[${Array.from({ length: 50 }, (_, i) => i).join(', ')}]`;
  assert.ok(long.length > 120 && long.length < SPOKEN_LIMIT, `${long.length}`);
  assert.equal(spokenText({ value: long, display: 'nums' }), `nums is ${long}`);
});

test('a subscript binding is spoken with its name, once the wire says so', () => {
  // #81, the spoken half. `paintedSlots` is the shared function this reads
  // through, so the fix reaches speech on the same evidence as the line.
  assert.equal(
    spokenText({ value: '1', display: "led['a']", isBinding: true }),
    "led['a'] is 1");
});

test('a bare expression is spoken as its value, without the arrow', () => {
  // `=>` is punctuation: skipped at the default verbosity, spelled out as
  // "equals greater than" above it, and never the word "result".
  const spoken = spokenText({ value: '30', display: 'sum([10, 20])' });
  assert.equal(spoken, '30');
  assert.doesNotMatch(spoken!, /=>/);
});

test('two answers on one line are separated by something audible', () => {
  // The painted separator is three non-breaking spaces, and a run of
  // whitespace is one pause. Heard, `v: 1, 2   x: [1, 2]` is a single list.
  const spoken = spokenText({
    value: null, display: null,
    names: [{ name: 'x', value: '[1, 2]' }, { name: 'y', value: '5' }],
  })!;
  assert.equal(spoken, 'x is [1, 2]. y is 5');
});

test('a label the value states is still spoken', () => {
  // Deliberately unlike the painted text, which drops it. That rule buys
  // columns; speech has none to buy, and the label is what tells a listener
  // which value is being reported.
  assert.equal(
    spokenText({ value: 'def greet(name)', display: 'greet' }),
    'greet is def greet(name)');
  assert.equal(
    resultText({ value: 'def greet(name)', display: 'greet' })
      .split(NBSP).join(' '),
    'def greet(name)');
});

test('nothing spoken carries the non-breaking spaces the line is painted with', () => {
  // `preserveSpacing` substitutes them because VS Code eats ordinary spaces in
  // a decoration's `contentText`. That is a rendering workaround and has no
  // business in a string handed to a screen reader, some of which announce the
  // character by name.
  const painted = resultText({ value: '{"a": 1, "b": 2}', display: 'd' });
  assert.ok(painted.includes(NBSP), 'the painted text should have them');
  const spoken = spokenText({ value: '{"a": 1, "b": 2}', display: 'd' })!;
  assert.ok(!spoken.includes(NBSP), `spoken text carried one: ${spoken}`);
});

test('a failure says the word error, because the colour is invisible', () => {
  const spoken = spokenText({
    error: { type: 'NameError', message: "name 'x' is not defined" },
  })!;
  assert.equal(spoken, "error, NameError: name 'x' is not defined");
});

test('a failure with no message still names its type', () => {
  assert.equal(
    spokenText({ error: { type: 'KeyboardInterrupt', message: '  ' } }),
    'error, KeyboardInterrupt');
});

test('staleness is said, and said first', () => {
  // The gutter marker is a picture and carries the project's defining caveat.
  // A caveat that arrives after the value arrives after it is believed.
  const spoken = spokenText(value({ stale: true }))!;
  assert.match(spoken, /^stale, edited since it ran\. lst is/);
});

test('a stale failure is spoken as stale rather than as an error', () => {
  // The same ranking `markerFor` applies to the gutter: a failure whose
  // statement has since been edited is not this code's failure.
  const spoken = spokenText({
    stale: true, error: { type: 'NameError', message: 'no' },
  })!;
  assert.match(spoken, /^stale, edited since it ran\./);
});

test('a reduced context is spoken in full, not as the line abbreviates it', () => {
  const spoken = spokenText(value({ partialFrom: 18 }))!;
  assert.equal(spoken, 'lst is [1, 2, 3]. evaluated without line 19 onwards');
});

test('what a statement printed is spoken after its value', () => {
  const spoken = spokenText({
    value: '42', display: 'x', printed: { stdout: 'hello\n' },
  })!;
  assert.equal(spoken, 'x is 42. printed: hello');
});

test('a loop is spoken as the sequence the line shows', () => {
  // #36: painted, the same fact is `p: 1, 2, 3 · 3 iterations` -- a listener needs the
  // same "this is a history" cue a sighted reader gets from the count, or
  // the two channels would tell two different stories about one line.
  const spoken = spokenText({
    value: '3', display: 'p',
    loop: { values: ['1', '2', '3'], last: null, count: 3 },
  })!;
  assert.equal(spoken, 'p is 1, 2, 3, 3 iterations');
});

test('repeated-loop speech qualifies the total across runs, including repeated empty runs', () => {
  const loop = { values: ['0', '1', '2', '3', '4'], last: '99',
    count: 10000, invocations: 100 };
  assert.equal(spokenText({ value: null, display: 'y', loop }),
    'y is 0, 1, 2, 3, 4, …, 99, 10000 iterations total across 100 loop runs');
  assert.equal(spokenText({ value: null, display: 'y', loop: {
    values: [], last: null, count: 0, invocations: 2,
  } }), 'y is (no iterations), 0 iterations total across 2 loop runs');
  assert.equal(spokenText({ value: null, display: 'y', loop: {
    values: [], last: null, count: 0, invocations: 0,
  } }), 'y is (not reached)');
});

test("a loop body binding's count is spoken beside the target's", () => {
  const spoken = spokenText({
    value: '3', display: 'v',
    loop: { values: ['1', '2', '3'], last: null, count: 3 },
    bindings: [{ name: 'u', values: ['4', '12'], last: null, count: 2 }],
  })!;
  assert.equal(spoken, 'v is 1, 2, 3, 3 iterations. u is 4, 12, 2 iterations');
});

test('a statement with nothing to report says nothing', () => {
  assert.equal(spokenText({ value: null, display: null }), undefined);
});

test('a statement with nothing to report but a caveat still says the caveat', () => {
  assert.equal(
    spokenText({ value: null, display: null, stale: true }),
    'stale, edited since it ran');
});

test('an unfinished statement says so rather than staying silent', () => {
  assert.equal(spokenText({ pending: {} }), STILL_RUNNING);
  assert.equal(
    spokenText({ pending: { message: 'Enter a value:' } }),
    `${STILL_RUNNING}: Enter a value:`);
});

test('the names the kernel capped are counted out loud', () => {
  const spoken = spokenText({
    value: null, display: null,
    names: [{ name: 'x', value: '1' }], more: 3,
  })!;
  assert.match(spoken, /and 3 more names$/);
});

test('the count is spoken even where the only slot on the line is its own', () => {
  // #74/#85: `more` is only ever positive because a cap left something off
  // this exact line, so it does not need a read name beside it to be true --
  // and a spoken answer that stayed silent here would say less than the
  // painted one, which is exactly the drift this module exists to prevent.
  const spoken = spokenText({ value: '1', display: 'x', more: 3 })!;
  assert.match(spoken, /and 3 more names$/);
});

// -- truncation ------------------------------------------------------------

test('a long value is cut and says that it was cut', () => {
  const long = `x is ${'a'.repeat(9000)}`;
  const spoken = capSpoken(long);
  assert.ok(spoken.length < long.length);
  assert.match(spoken, /truncated from 9005 characters$/);
});

test('an answer inside the limit is left exactly as it is', () => {
  assert.equal(capSpoken('x is 5'), 'x is 5');
  const edge = 'a'.repeat(SPOKEN_LIMIT);
  assert.equal(capSpoken(edge), edge);
});

test('the cut lands on a word boundary when one is near enough', () => {
  const words = `${'word '.repeat(100)}end`;
  const spoken = capSpoken(words);
  const head = spoken.slice(0, spoken.indexOf('…'));
  assert.ok(head.endsWith('word'), `cut mid-word: ${JSON.stringify(head)}`);
});

test('a value with no spaces in it is cut anyway', () => {
  // A 9,000-character repr of a bytes object has no boundary to find, and
  // reading it out for nine minutes is not the accessible outcome.
  const spoken = capSpoken('b'.repeat(9000));
  assert.ok(spoken.length < 400);
});

test('an over-long answer is truncated by spokenText itself', () => {
  const spoken = spokenText({ value: 'x'.repeat(9000), display: 'big' })!;
  assert.match(spoken, /truncated from \d+ characters$/);
});

test('truncation never eats a caveat', () => {
  // A caveat cut off by the length limit leaves an answer asserting more than
  // we know, which is the exact failure the caveat exists to prevent. Both of
  // them are one short sentence; only the value is at risk of being long.
  const spoken = spokenText({
    value: 'x'.repeat(9000), display: 'big', stale: true, partialFrom: 18,
  })!;
  assert.match(spoken, /^stale, edited since it ran\./);
  assert.match(spoken, /truncated from \d+ characters\. /);
  assert.match(spoken, /evaluated without line 19 onwards$/);
});

test('a long failure is truncated and still says what was missing', () => {
  const spoken = spokenText({
    error: { type: 'ValueError', message: 'y'.repeat(9000) },
    partialFrom: 4,
  })!;
  assert.match(spoken, /^error, ValueError: y+… truncated from \d+ characters/);
  assert.match(spoken, /evaluated without line 5 onwards$/);
});

// -- the status bar item's text --------------------------------------------

test('the status bar gets a short form of the same answer', () => {
  assert.equal(statusText('lst is [1, 2, 3]'), 'lst is [1, 2, 3]');
  assert.equal(statusText(`x is ${'a'.repeat(200)}`).length, 60);
  assert.match(statusText(`x is ${'a'.repeat(200)}`), /…$/);
});

test('the status bar text is one line, whatever the answer contained', () => {
  assert.equal(statusText('x is 1\n2\t3'), 'x is 1 2 3');
});

// -- when the channel speaks unasked ---------------------------------------

test('never means never, whatever the editor thinks', () => {
  assert.equal(announcesAutomatically('never', 'on'), false);
  assert.equal(announcesAutomatically('never', 'auto'), false);
});

test('always means always, including with no screen reader anywhere', () => {
  assert.equal(announcesAutomatically('always', 'off'), true);
  assert.equal(announcesAutomatically('always', undefined), true);
});

test('auto follows the one declaration VS Code lets an extension read', () => {
  // `editor.accessibilitySupport: "on"` is what VS Code's own accessibility
  // documentation tells a screen-reader user to set when detection fails, so
  // it is a deliberate statement rather than an inference.
  assert.equal(announcesAutomatically('auto', 'on'), true);
  assert.equal(announcesAutomatically('auto', 'off'), false);
});

test('auto stays silent on "auto", because that value is not an answer', () => {
  // VS Code's own auto-detection does not write its result back to the
  // setting, so `"auto"` reads the same whether a screen reader was found or
  // not. Treating it as "yes" would give every default install a notification
  // on every keypress; treating it as "no" is what the `always` value is for.
  assert.equal(announcesAutomatically('auto', 'auto'), false);
  assert.equal(announcesAutomatically('auto', undefined), false);
});

// -- which annotation the cursor is asking about ---------------------------

const span = (start: number, end: number, anchor?: number) => ({
  range: { start: { line: start }, end: { line: end } },
  ...(anchor === undefined ? {} : { anchor }),
});

test('the line a value is painted on answers for that line', () => {
  const annotations = [span(0, 0), span(4, 4)];
  assert.equal(annotationAt(annotations, 4), annotations[1]);
});

test('a compound statement answers on its header, where the value sits', () => {
  const def = span(3, 12, 3);
  assert.equal(annotationAt([def], 3), def);
});

test('a line inside a statement answers with that statement', () => {
  // Silence on nineteen lines of a twenty-line `def` would make the command
  // useless exactly where the reader cannot see which line the value is on.
  const def = span(3, 12, 3);
  assert.equal(annotationAt([def], 8), def);
});

test('the innermost statement wins where two cover the line', () => {
  const outer = span(0, 20, 0);
  const inner = span(8, 9, 8);
  assert.equal(annotationAt([outer, inner], 8), inner);
});

test('a line with nothing on it answers with nothing', () => {
  assert.equal(annotationAt([span(0, 0), span(4, 4)], 2), undefined);
  assert.equal(annotationAt([], 0), undefined);
});

test('everything said is attributed to the extension that said it', () => {
  // A toast reading `Info: [1, 2, 3]` names nobody, and a window with a dozen
  // extensions in it raises toasts from all of them. Three syllables buys the
  // listener the source, and every other notification here is prefixed the
  // same way.
  assert.equal(announcement('lst is [1, 2, 3]'), 'Evalens: lst is [1, 2, 3]');
  assert.equal(announcement(NOTHING_HERE), 'Evalens: no result on this line');
  // The answer itself carries no prefix, so it is not said twice when the
  // status bar item and the notification both quote it.
  assert.doesNotMatch(spokenText(value())!, /Evalens/);
});

// -- the manifest and the source say the same thing ------------------------

test('the command the status bar item runs is one the manifest contributes', () => {
  // Same check `output.test.ts` makes of the hover's link, for the same
  // reason: a status bar item whose command does not exist is a button that
  // does nothing when a keyboard user activates it, and nothing reports it.
  const contributed = new Set<string>(
    (manifest.contributes?.commands ?? [])
      .map((command: { command: string }) => command.command));
  const declared = /^export const READ_AT_CURSOR = '([^']+)';$/m
    .exec(fs.readFileSync(
      path.join(root, 'src', 'render', 'announcer.ts'), 'utf8'))?.[1];

  assert.ok(declared, 'no READ_AT_CURSOR command id found in announcer.ts');
  assert.ok(contributed.has(declared),
    `${declared} is on the status bar item but not contributed`);
});

test('the announce setting offers exactly the three modes the code handles', () => {
  const property =
    manifest.contributes?.configuration?.properties?.['evalens.announceResults'];
  assert.ok(property, 'evalens.announceResults is not contributed');
  assert.deepEqual(property.enum, ['auto', 'always', 'never']);
  // Not `always`. The announced surface is a notification, and one on every
  // keypress would make the extension unusable for everyone who does not need
  // it -- the same argument that keeps a file load silent.
  assert.equal(property.default, 'auto');
});
