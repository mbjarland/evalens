import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { KernelClient } from '../kernel/client';
import {
  Evaluated, EvalResponse, Failed, FileLoaded, LoopTrace,
} from '../kernel/protocol';
import { errorText, resultText } from '../render/format';
import { describeRun, present } from '../render/present';
import { LineRange, selectedLines, widenedBeyond } from '../selection';

/**
 * The only test that checks the TypeScript and the Python agree.
 *
 * Everything else on either side runs against a fake: the client tests drive a
 * fake process, the kernel tests drive a real process but speak to it in
 * Python. A protocol drift -- a renamed field, a coordinate base changed on
 * one side -- passes both suites and fails only in a real editor. This runs
 * the real kernel over a real pipe.
 */
const KERNEL = path.resolve(__dirname, '..', '..', 'kernel', 'evalens_kernel.py');

function connect(): KernelClient {
  return new KernelClient({
    resolvePython: async () => 'python3',
    kernelPath: KERNEL,
  });
}

async function evaluate(
  client: KernelClient, source: string, line: number, allowStdin = false
) {
  return (await client.request({
    op: 'eval', source, line, character: 0, filename: '/tmp/evalens-test.py',
    allow_stdin: allowStdin,
  })) as EvalResponse;
}

test('the IDEA.md example round-trips through the real kernel', async (t) => {
  const client = connect();
  t.after(() => client.dispose());

  const source = 'lst = [1, 2, 3]\ny = lst\ny.append(4)\nlst\n';

  const first = await evaluate(client, source, 0) as Evaluated;
  assert.equal(first.ok, true);
  assert.equal(first.resolved, true);
  assert.equal(first.display, 'lst');
  assert.equal(first.value, '[1, 2, 3]');

  await evaluate(client, source, 1);
  await evaluate(client, source, 2);

  const last = await evaluate(client, source, 3) as Evaluated;
  assert.equal(last.value, '[1, 2, 3, 4]',
    'the namespace should remember, and append should have run exactly once');
});

test('the range the kernel returns is in VS Code coordinates', async (t) => {
  const client = connect();
  t.after(() => client.dispose());

  // Third line of the file: 0-based line 2, not ast\'s 1-based 3.
  const result = await evaluate(client, 'a = 1\nb = 2\ntotal = a + b\n', 2) as Evaluated;
  assert.equal(result.range.start.line, 2);
  assert.equal(result.range.start.character, 0);
  assert.equal(result.range.end.line, 2);
  assert.equal(result.range.end.character, 13);
});

test('a failure arrives as a typed error, not a rejection', async (t) => {
  const client = connect();
  t.after(() => client.dispose());

  const result = await evaluate(client, 'undefined_name\n', 0) as Failed;
  assert.equal(result.ok, false);
  assert.equal(result.error.type, 'NameError');
  assert.match(result.error.traceback, /NameError/);
});

test('a blank line resolves to nothing without erroring', async (t) => {
  const client = connect();
  t.after(() => client.dispose());

  const result = await evaluate(client, 'a = 1\n\nb = 2\n', 1);
  assert.equal(result.ok, true);
  assert.equal((result as { resolved: boolean }).resolved, false);
});

test('printed output survives the protocol channel', async (t) => {
  const client = connect();
  t.after(() => client.dispose());

  const result = await evaluate(client, "print('hi')\n", 0) as Evaluated;
  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'hi\n');
});

/** Everything except the call to setDecorations, as one string per line. */
async function paint(
  client: KernelClient, source: string, lines: readonly number[]
): Promise<string[]> {
  const painted: string[] = [];
  for (const line of lines) {
    const shown = present(await evaluate(client, source, line), line);
    if (shown.kind !== 'value') {
      painted.push(`!! ${shown.kind}`);
      continue;
    }
    painted.push(
      resultText(shown.value, shown.display, shown.loop, shown.names)
        .replace(/ /g, ' '));
  }
  return painted;
}

test('the whole pipeline produces the annotation IDEA.md promises', async (t) => {
  // Kernel -> resolver -> client -> present -> format, i.e. everything except
  // the call to setDecorations. This is the acceptance clip, minus the pixels.
  const client = connect();
  t.after(() => client.dispose());

  const source = 'lst = [1, 2, 3]\ny = lst\ny.append(4)\nlst\n';

  assert.deepEqual(await paint(client, source, [0, 1, 2, 3]), [
    'lst: [1, 2, 3]',
    'y: [1, 2, 3]   lst: [1, 2, 3]',
    // `=> None` is what this line said before, and it is the one line whose
    // whole job is to show that `lst` and `y` are the same list.
    'y: [1, 2, 3, 4]',
    'lst: [1, 2, 3, 4]',
  ]);
});

test('the teaching file from the ticket annotates the lesson, not None', async (t) => {
  // The shape #35 was filed against: the two `print` lines are the entire
  // point of the file, and the column said `None` on both of them.
  const client = connect();
  t.after(() => client.dispose());

  const source = [
    'x = [1, 2, 3]',
    'y = x',
    'y.append(4)',
    'print("x after mutating y:", x)',
    'x = [1, 2, 3]',
    'print("y unaffected by rebind:", y)',
  ].join('\n') + '\n';

  assert.deepEqual(await paint(client, source, [0, 1, 2, 3, 4, 5]), [
    'x: [1, 2, 3]',
    'y: [1, 2, 3]   x: [1, 2, 3]',
    'y: [1, 2, 3, 4]',
    'x: [1, 2, 3, 4]',
    'x: [1, 2, 3]',
    'y: [1, 2, 3, 4]',
  ]);
});

test('an expression keeps its arrow, and a call keeps its result', async (t) => {
  // The three shapes that look alike and are not. `sum([10, 20]): 30` would
  // repeat the line back at the reader, so it keeps the arrow. `y.pop()`
  // returned the 4 that a "hide the value when something changed" rule would
  // have thrown away. And a `None` survives exactly where the line has
  // nothing else to say -- which `print()` has and `d.get('k')` does not,
  // because `d` is right there and its contents are the better answer.
  const client = connect();
  t.after(() => client.dispose());

  const source = 'sum([10, 20])\ny = [1, 2, 3, 4]\ny.pop()\nd = {}\n'
    + 'd.get("k")\nprint("done")\n';

  assert.deepEqual(await paint(client, source, [0, 1, 2, 3, 4, 5]), [
    '=> 30',
    'y: [1, 2, 3, 4]',
    'y: [1, 2, 3]   => 4',
    'd: {}',
    'd: {}',
    '=> None',
  ]);
});

test('re-evaluating a def paints the same thing every time', async (t) => {
  // The inner-loop move this project is built around. With the address in the
  // annotation it changed on every keypress while the code did not, which
  // teaches the reader to distrust the one signal the extension provides.
  const client = connect();
  t.after(() => client.dispose());

  const source = 'def area(w: int, h: int = 2) -> int:\n    return w * h\n';
  const painted: string[] = [];
  const hovers: string[] = [];

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const shown = present(await evaluate(client, source, 0), 0);
    assert.equal(shown.kind, 'value');
    painted.push(resultText((shown as { value: string }).value,
      (shown as { display: string }).display));
    hovers.push((shown as { hover: string }).hover);
  }

  assert.deepEqual(painted.map((p) => p.replace(/ /g, ' ')), [
    'area: area(w: int, h: int = 2) -> int',
    'area: area(w: int, h: int = 2) -> int',
    'area: area(w: int, h: int = 2) -> int',
  ]);
  // The address is not lost, only moved off the line -- and it is still the
  // thing that differs between evaluations, which is why it cannot live there.
  for (const hover of hovers) {
    assert.match(hover, /^area = <function area at 0x[0-9a-f]+>$/);
  }
  assert.notEqual(hovers[0], hovers[1]);
});

test('a module docstring paints nothing, a bare string still does', async (t) => {
  // Line 1 of any well-documented file, and so the first impression the
  // extension makes. The same statement out of docstring position is someone
  // looking at a literal and still answers.
  const client = connect();
  t.after(() => client.dispose());

  const source = '"""Module 01 -- names and mutability."""\nx = 1\n"hello"\n';

  const docstring = present(await evaluate(client, source, 0), 0);
  assert.equal(docstring.kind, 'value', 'it ran; the region still highlights');
  assert.equal((docstring as { value: string | null }).value, null);

  const literal = present(await evaluate(client, source, 2), 2);
  assert.equal((literal as { value: string | null }).value, "'hello'");
});

test('a def is painted on the def line, not beside its return', async (t) => {
  // `greet: <function greet>` next to `return f"hello {name}"` says the
  // return statement produced a function. The region highlight still covers
  // the whole definition, which is what shows how much code ran.
  const client = connect();
  t.after(() => client.dispose());

  const source = 'def greet(name):\n    return f"hello {name}"\n';
  const shown = present(await evaluate(client, source, 1), 1) as {
    anchor?: number; range: { end: { line: number } };
  };

  assert.equal(shown.anchor, 0, 'the value belongs on the `def` line');
  assert.equal(shown.range.end.line, 1, 'the region still covers the body');
});

test('a loop is painted on its header, not beside its last body line', async (t) => {
  const client = connect();
  t.after(() => client.dispose());

  const source = 'squares = [1, 4, 9, 16]\nfor p in squares:\n    print(p)\n';
  await evaluate(client, source, 0);
  const shown = present(await evaluate(client, source, 1), 1) as {
    anchor?: number; range: { end: { line: number } };
  };

  assert.equal(shown.anchor, 1, '`p: 16` beside `print(p)` says print returned 16');
  assert.equal(shown.range.end.line, 2);
});

test('an undefined name paints as an error, not as a crash', async (t) => {
  const client = connect();
  t.after(() => client.dispose());

  const shown = present(await evaluate(client, 'nope\n', 0), 0);
  assert.equal(shown.kind, 'error');
  assert.equal(
    errorText((shown as { type: string }).type,
      (shown as { message: string }).message).replace(/ /g, ' '),
    "=> NameError: name 'nope' is not defined");
});

test('loading a file makes a line near the bottom evaluate straight away', async (t) => {
  // The command's whole reason to exist: without it the first thirty seconds
  // are a NameError and a walk down the file.
  const client = connect();
  t.after(() => client.dispose());

  const source = [
    'import sys',
    "GREETING = 'hello'",
    'def shout():',
    '    return GREETING.upper()',
    "if __name__ == '__main__':",
    "    sys.exit('the main guard ran')",
    'shout()',
  ].join('\n') + '\n';

  const loaded = await client.request({
    op: 'eval_file', allow_stdin: false, source, filename: '/tmp/evalens-load.py',
  }) as FileLoaded;
  assert.equal(loaded.ok, true);

  const called = await evaluate(client, source, 6) as Evaluated;
  assert.equal(called.value, "'HELLO'",
    'the namespace should be populated without evaluating line by line');
});

test('the __main__ guard does not run on load', async (t) => {
  // Load File means "import the module", and an imported module does not run
  // its main guard. True here because __name__ is "__evalens__" -- pinned on
  // both sides because it is a consequence of the namespace setup rather
  // than an explicit rule.
  const client = connect();
  t.after(() => client.dispose());

  const source = "import sys\nif __name__ == '__main__':\n    sys.exit(9)\n";
  const loaded = await client.request({
    op: 'eval_file', allow_stdin: false, source, filename: '/tmp/evalens-main.py',
  }) as FileLoaded;
  assert.equal(loaded.ok, true, 'sys.exit would have made this a failure');

  const name = await evaluate(client, '__name__\n', 0) as Evaluated;
  assert.equal(name.value, "'__evalens__'");
});

test('loading a file paints what walking down it would have', async (t) => {
  const client = connect();
  t.after(() => client.dispose());

  const source = 'lst = [1, 2, 3]\ny = lst\ny.append(4)\nlst\n';
  const loaded = await client.request({
    op: 'eval_file', allow_stdin: false, source, filename: '/tmp/evalens-tour.py',
  }) as FileLoaded;

  assert.equal(loaded.ok, true);
  assert.equal(loaded.ran, 4);
  assert.deepEqual(
    loaded.results.map((r) => (r.ok ? [r.display, r.value] : ['!', r.error.type])),
    [['lst', '[1, 2, 3]'], ['y', '[1, 2, 3]'],
     ['y.append(4)', 'None'], ['lst', '[1, 2, 3, 4]']],
    'one keystroke should produce the same four values as four keystrokes');
});

test('a broken line does not stop the rest of the file loading', async (t) => {
  // The tour file contains a deliberate NameError two thirds of the way down,
  // and stopping there made Load File refuse to set up a session.
  const client = connect();
  t.after(() => client.dispose());

  const source = 'a = 1\nundefined_one\nb = 2\nundefined_two\nc = 3\n';
  const loaded = await client.request({
    op: 'eval_file', allow_stdin: false, source, filename: '/tmp/evalens-partial.py',
  }) as FileLoaded;

  assert.equal(loaded.ok, true, 'a broken line is not a broken load');
  assert.equal(loaded.ran, 3);
  assert.equal(loaded.results.filter((r) => !r.ok).length, 2);

  // The statement below BOTH failures is usable.
  const c = await evaluate(client, source, 4) as Evaluated;
  assert.equal(c.value, '3');
});

/** `eval_file`, narrowed to a 0-based inclusive line range when one is given. */
async function load(
  client: KernelClient, source: string, lines?: LineRange, filename?: string
): Promise<FileLoaded> {
  return (await client.request({
    op: 'eval_file',
    allow_stdin: false,
    source,
    filename: filename ?? '/tmp/evalens-selection.py',
    ...(lines ?? {}),
  })) as FileLoaded;
}

/** 0: a = 1  1: b = 2  2-4: def f  5: c = f(1) */
const SELECTABLE = 'a = 1\nb = 2\ndef f(x):\n    y = x + 1\n    return y\nc = f(1)\n';

test('a selection runs its statements and nothing below them', async (t) => {
  const client = connect();
  t.after(() => client.dispose());

  const ran = await load(client, SELECTABLE, selectedLines({
    start: { line: 0, character: 0 }, end: { line: 1, character: 5 },
  }));

  assert.equal(ran.ok, true);
  assert.equal(ran.statements, 2, 'the count is the selection, not the file');
  assert.equal(ran.ran, 2);
  assert.equal((await evaluate(client, 'b\n', 0) as Evaluated).value, '2');
  assert.equal((await evaluate(client, 'f\n', 0) as Failed).error.type,
    'NameError', 'the def below the selection must not have run');
});

test('a selection starting mid-statement runs it whole and says it widened',
  async (t) => {
    // The whole path: a selection inside a `def` body, over the wire, back
    // through the two pieces the status message is built from. Lines 3-5 run
    // as written are a stray assignment and a `return` at module level.
    const client = connect();
    t.after(() => client.dispose());

    const selection = {
      start: { line: 3, character: 4 }, end: { line: 5, character: 8 },
    };
    const ran = await load(client, SELECTABLE, selectedLines(selection));

    assert.equal(ran.statements, 2);
    assert.equal(ran.ran, 2, 'the def and the call that needs it');
    assert.notEqual(ran.range, undefined);
    assert.deepEqual(ran.range?.start, { line: 2, character: 0 },
      'the run reached back to the `def` line');
    assert.equal(widenedBeyond(ran.range!, selection), true);
    assert.equal(describeRun(ran.ran, ran.statements, 0, true),
      'Evalens: ran 2 statements, widened to whole statements');
    assert.equal((await evaluate(client, 'c\n', 0) as Evaluated).value, '2');
  });

test('a selection holding no complete statement reports nothing to run',
  async (t) => {
    const client = connect();
    t.after(() => client.dispose());

    const source = 'a = 1\n\n# a comment\n\nb = 2\n';
    const ran = await load(client, source, selectedLines({
      start: { line: 1, character: 0 }, end: { line: 3, character: 0 },
    }));

    assert.equal(ran.ok, true, 'nothing to run is an outcome, not an error');
    assert.equal(ran.statements, 0);
    assert.equal(ran.range, undefined);
    assert.equal(describeRun(0, 0, 0, false),
      'Evalens: nothing to run in the selection');
    assert.equal((await evaluate(client, 'a\n', 0) as Failed).error.type,
      'NameError', 'and nothing nearby ran in its place');
  });

test('an annotation from a selection lands on the real line of the real file',
  async (t) => {
    // The reason the request carries a line range and not the selected text.
    // Line 5 of the file is line 0 of any slice that starts at 5, and both the
    // range an annotation is painted at and the line a traceback quotes would
    // be off by everything above the selection.
    const client = connect();
    t.after(() => client.dispose());

    const source = 'a = 1\nb = 2\nc = undefined_name\n';
    const ran = await load(client, source, { start_line: 2, end_line: 2 });

    const failure = ran.results[0]!;
    assert.equal(failure.ok, false);
    assert.equal(failure.range?.start.line, 2);
    assert.match((failure as { error: { traceback: string } }).error.traceback,
      /line 3\b/, 'the traceback quotes the file, not the fragment');
  });

test('the tour loaded in two selections is the tour loaded whole', async (t) => {
  // The regression check with real code behind it: 500 lines of every
  // statement shape the project knows about, run once as a file and once as
  // two selections meeting at whatever statement boundary the midpoint snaps
  // to. Anything the narrowing perturbs -- a statement run twice, one
  // skipped between the halves, a docstring suppressed because it opened a
  // selection rather than the module -- shows up as a differing value.
  const tour = path.resolve(__dirname, '..', '..', 'examples', 'tour.py');
  const source = fs.readFileSync(tour, 'utf8');
  const lastLine = source.split('\n').length - 1;

  const whole = connect();
  t.after(() => whole.dispose());
  const together = await load(whole, source, undefined, tour);

  const split = connect();
  t.after(() => split.dispose());
  const first = await load(
    split, source, { start_line: 0, end_line: Math.floor(lastLine / 2) }, tour);
  assert.notEqual(first.range, undefined);
  // Where the first half actually stopped, which is a statement boundary
  // wherever the midpoint happened to fall.
  const second = await load(
    split, source,
    { start_line: first.range!.end.line + 1, end_line: lastLine }, tour);

  const shown = (loaded: FileLoaded) => loaded.results.map(
    (r) => (r.ok ? [r.display, r.value] : ['!', r.error.type]));

  assert.ok(first.statements > 0 && second.statements > 0,
    'a split with an empty half would pass without proving anything');
  assert.equal(first.statements + second.statements, together.statements,
    'every statement of the tour ran exactly once across the two halves');
  assert.deepEqual([...shown(first), ...shown(second)], shown(together));
  assert.equal(first.ran + second.ran, together.ran);
});

test('an instance keeps whichever repr its class actually has', async (t) => {
  // The rule the description feature is subordinate to: a repr someone wrote
  // is a deliberate statement about how the object should read, so only the
  // inherited default is ever replaced.
  const client = connect();
  t.after(() => client.dispose());

  const written = 'class Temp:\n'
    + '    def __repr__(self):\n'
    + "        return 'warm'\n"
    + 'today = Temp()\n';
  await evaluate(client, written, 0);
  const kept = await evaluate(client, written, 3) as Evaluated;
  assert.equal(kept.value, 'warm');
  assert.equal(kept.repr, undefined,
    'nothing was substituted, so there is nothing to keep');

  const plain = 'class Temp2:\n    pass\ntoday2 = Temp2()\n';
  await evaluate(client, plain, 0);
  const described = await evaluate(client, plain, 2) as Evaluated;
  assert.equal(described.value, '<Temp2 instance>');
  assert.match(described.repr ?? '', /0x[0-9a-f]+/);
});

test('a loop annotates its whole sequence, through the real kernel', async (t) => {
  // The ticket's acceptance case, end to end: kernel -> resolver -> loop
  // rewrite -> client -> present -> format. `p: 4` is what this replaces.
  const client = connect();
  t.after(() => client.dispose());

  const source = 'for p in [1, 2, 3, 4]:\n    pass\n';
  const shown = present(await evaluate(client, source, 0), 0) as {
    kind: string; value: string | null; display: string | null; loop?: LoopTrace;
  };

  assert.equal(shown.kind, 'value');
  assert.equal(
    resultText(shown.value ?? '', shown.display, shown.loop).replace(/ /g, ' '),
    'p: 1, 2, 3, 4');
});

test('a ten thousand row loop arrives bounded, not whole', async (t) => {
  // The wire must not carry ten thousand strings, and the line must not try
  // to render them.
  const client = connect();
  t.after(() => client.dispose());

  const result = await evaluate(
    client, 'for p in range(10000):\n    pass\n', 0) as Evaluated;
  assert.equal(result.loop?.count, 10000);
  assert.equal(result.loop?.values.length, 5);
  assert.equal(
    resultText(result.value ?? '', result.display, result.loop)
      .replace(/ /g, ' '),
    'p: 0, 1, 2, 3, 4, … (+9,994 more) … 9999');
});

test('a mutable loop reports each iteration, not the end state', async (t) => {
  // The same list three times, mutated by the body. A repr() taken at the end
  // would say [0, 1, 2] three times -- which looks like three observations.
  const client = connect();
  t.after(() => client.dispose());

  const source = 'row = []\nfor r in [row, row, row]:\n    r.append(len(r))\n';
  await evaluate(client, source, 0);
  const result = await evaluate(client, source, 1) as Evaluated;
  assert.deepEqual(result.loop?.values, ['[]', '[0]', '[0, 1]']);
});

test('a loop stopped by break annotates the value it broke on', async (t) => {
  const client = connect();
  t.after(() => client.dispose());

  const result = await evaluate(
    client,
    'for p in [1, 2, 3, 4]:\n    if p == 3:\n        break\n', 0) as Evaluated;
  assert.equal(
    resultText(result.value ?? '', result.display, result.loop)
      .replace(/ /g, ' '),
    'p: 1, 2, 3');
});

/**
 * A `while True:` that reports when it has actually started running.
 *
 * Waiting for the marker rather than for a fixed delay is what makes the
 * interrupt land inside the user's loop instead of in the gap before it -- two
 * different code paths, and a test that could hit either proves neither.
 */
function spinner(marker: string): string {
  return [
    'started = False',
    'while True:',
    '    if not started:',
    `        open(${JSON.stringify(marker)}, 'w').close()`,
    '        started = True',
    '',
  ].join('\n');
}

function markerPath(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'evalens-')), name);
}

async function waitFor(marker: string): Promise<void> {
  for (let tick = 0; tick < 1000 && !fs.existsSync(marker); tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(fs.existsSync(marker), 'the evaluated code never started running');
}

test('an interrupt stops a real loop and keeps the namespace', async (t) => {
  // The ticket's acceptance test through the whole stack: the real client, the
  // real five-pipe spawn, the real kernel. Nothing here would work if the
  // control channel were not actually wired -- an interrupt written to stdin
  // would sit unread behind a loop that never ends.
  const client = connect();
  t.after(() => client.dispose());

  const marker = markerPath('running');
  const source = `x = 41\n${spinner(marker)}`;

  assert.equal((await evaluate(client, source, 0) as Evaluated).value, '41');
  await evaluate(client, source, 1);

  const spinning = evaluate(client, source, 2);
  await waitFor(marker);

  assert.equal(await client.interrupt(), 'interrupted');

  const stopped = await spinning as Failed;
  assert.equal(stopped.ok, false);
  assert.equal(stopped.error.type, 'KeyboardInterrupt');

  const survivor = await evaluate(client, 'x\n', 0) as Evaluated;
  assert.equal(survivor.value, '41',
    'stopping an evaluation must not cost the session its namespace');
});

test('an interrupt reaches a kernel parked in a blocking call', async (t) => {
  // `time.sleep` is the case a flag-setting interrupt does not cover: the main
  // thread is inside a C call and reaches no bytecode boundary to notice at.
  // Measured, not assumed -- interrupt_main() alone sleeps the whole time.
  const client = connect();
  t.after(() => client.dispose());

  const marker = markerPath('sleeping');
  const source = 'import time\n'
    + `open(${JSON.stringify(marker)}, 'w').close()\n`
    + 'time.sleep(60)\n';

  await evaluate(client, source, 0);
  await evaluate(client, source, 1);

  const started = Date.now();
  const sleeping = evaluate(client, source, 2);
  await waitFor(marker);
  assert.equal(await client.interrupt(), 'interrupted');

  const stopped = await sleeping as Failed;
  assert.equal(stopped.error.type, 'KeyboardInterrupt');
  assert.ok(Date.now() - started < 30_000, 'the sleep ran to completion');
});

/** A client that answers every prompt the way `answer` says to. */
function connectAnswering(
  answer: (prompt: string, password: boolean) => string | null,
  onStream?: (text: string) => void
): { client: KernelClient; prompts: string[] } {
  const prompts: string[] = [];
  const client = new KernelClient({
    resolvePython: async () => 'python3',
    kernelPath: KERNEL,
    onInput: async (request) => {
      prompts.push(request.prompt);
      return answer(request.prompt, request.password);
    },
    onStream: (_name, text) => onStream?.(text),
  });
  return { client, prompts };
}

test('input() prompts, and the answer becomes the value', async (t) => {
  // The ticket's acceptance case through the whole stack. Nothing here works
  // unless the control channel is really wired: the kernel is blocked inside
  // input() and cannot read the request pipe at all while it waits.
  const { client, prompts } = connectAnswering(() => 'Ada');
  t.after(() => client.dispose());

  const result = await evaluate(
    client, "name = input('Your name? ')\n", 0, true) as Evaluated;

  assert.deepEqual(prompts, ['Your name? ']);
  assert.equal(result.ok, true);
  assert.equal(result.value, "'Ada'");
});

test('cancelling a prompt raises EOFError, which is the way out', async (t) => {
  const { client } = connectAnswering(() => null);
  t.after(() => client.dispose());

  const result = await evaluate(
    client, "name = input('Your name? ')\n", 0, true) as Failed;

  assert.equal(result.ok, false);
  assert.equal(result.error.type, 'EOFError');

  // And the session survives it, so the next line still runs.
  const after = await evaluate(client, 'ok = 1\n', 0) as Evaluated;
  assert.equal(after.value, '1');
});

test('loading a file does not prompt, it raises and says why', async (t) => {
  // A load exists to avoid waiting. Twenty prompts in a teaching file would
  // stop it dead on the first one until a human noticed, and twenty modal
  // boxes are not the better version of that.
  const { client, prompts } = connectAnswering(() => 'Ada');
  t.after(() => client.dispose());

  const loaded = await client.request({
    op: 'eval_file',
    allow_stdin: false,
    source: "before = 1\nname = input('Your name? ')\nafter = 3\n",
    filename: '/tmp/evalens-course.py',
  }) as FileLoaded;

  assert.deepEqual(prompts, [], 'a load must never open a box');
  assert.equal(loaded.ok, true);
  assert.equal(loaded.ran, 2, 'the statements around it still ran');

  const failure = loaded.results[1]!;
  assert.equal(failure.ok, false);
  assert.equal((failure as { error: { type: string } }).error.type, 'EOFError');
  assert.match((failure as { error: { message: string } }).error.message,
    /evaluate the line on its own/,
    'the message has to say how to be asked instead');
});

test('a password read is marked so the box does not echo it', async (t) => {
  // getpass is out of scope and is not wrapped -- but where there is no
  // terminal it falls back to sys.stdin and lands in the stub like any other
  // read, and echoing it would leak the one thing it exists to hide.
  let asked = false;
  const { client } = connectAnswering((_prompt, password) => {
    asked = password;
    return 'hunter2';
  });
  t.after(() => client.dispose());

  await evaluate(client, 'import getpass\n', 0);
  const result = await evaluate(
    client, "secret = getpass.fallback_getpass('Password: ')\n", 0, true
  ) as Evaluated;

  assert.equal(asked, true, 'the box would have shown the password');
  assert.equal(result.value, "'hunter2'");
});

test('printed output arrives while the statement is still running', async (t) => {
  // Invisible in a test that only reads the response, whose stdout would look
  // identical either way. Here the printed line is observed while the kernel
  // is demonstrably still inside the statement, because it is blocked waiting
  // to be answered.
  const streamed: string[] = [];
  let printedBeforeAnswering = '';
  const { client } = connectAnswering(
    () => { printedBeforeAnswering = streamed.join(''); return 'yes'; },
    (text) => streamed.push(text));
  t.after(() => client.dispose());

  const source = 'def announce():\n'
    + "    print('working')\n"
    + "    return input('done? ')\n";
  await evaluate(client, source, 0);
  const result = await evaluate(client, 'reply = announce()\n', 0, true) as Evaluated;

  assert.match(printedBeforeAnswering, /working\n/,
    'the print reached the extension before the statement finished');
  assert.equal(result.value, "'yes'");
  assert.equal(result.stdout, 'working\ndone? ',
    'and the response still carries the whole of it');
});
