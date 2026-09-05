import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { KernelClient } from '../kernel/client';
import {
  Evaluated, EvalResponse, Failed, FileLoaded, LoopTrace,
} from '../kernel/protocol';
import { errorText, resultText } from '../render/format';
import { present } from '../render/present';

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

async function evaluate(client: KernelClient, source: string, line: number) {
  return (await client.request({
    op: 'eval', source, line, character: 0, filename: '/tmp/evalens-test.py',
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
    op: 'eval_file', source, filename: '/tmp/evalens-load.py',
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
    op: 'eval_file', source, filename: '/tmp/evalens-main.py',
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
    op: 'eval_file', source, filename: '/tmp/evalens-tour.py',
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
    op: 'eval_file', source, filename: '/tmp/evalens-partial.py',
  }) as FileLoaded;

  assert.equal(loaded.ok, true, 'a broken line is not a broken load');
  assert.equal(loaded.ran, 3);
  assert.equal(loaded.results.filter((r) => !r.ok).length, 2);

  // The statement below BOTH failures is usable.
  const c = await evaluate(client, source, 4) as Evaluated;
  assert.equal(c.value, '3');
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
