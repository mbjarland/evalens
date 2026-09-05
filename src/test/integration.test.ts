import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { nextStop } from '../advance';
import { LoadPrompts } from '../input';
import { KernelClient } from '../kernel/client';
import { InOrder } from '../load';
import {
  Evaluated, EvalResponse, Failed, FileLoaded, LoopTrace, Outlined,
  StatementOutcome,
} from '../kernel/protocol';
import {
  GAP, errorText, hasOutput, opensDefinition, partialNote, preserveSpacing,
  printedFrom, restatesLine, resultText,
} from '../render/format';
import {
  describeLoad, describeRun, partialCause, present,
} from '../render/present';
import { PaintedAbove } from '../render/repeats';
import { markDependents } from '../render/registry';
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

test('one evaluation of print("hello") shows hello, and no None', async (t) => {
  // The whole of the ticket, at the smallest scale it has. This exact line is
  // the first thing the audience will try, and until now it painted `None`
  // and dropped the `hello` -- the value was true, useless, and read as the
  // extension being unreliable rather than as it not doing this yet.
  const client = connect();
  t.after(() => client.dispose());

  const shown = present(await evaluate(client, 'print("hello")\n', 0), 0);
  assert.equal(shown.kind, 'value');

  const painted = (await paint(client, 'print("hello")\n', [0]))[0]!;
  assert.equal(painted, 'printed: hello');
  assert.ok(!painted.includes('None'),
    'the None print returns is suppressed, exactly as a redundant None is');
  // Demoted, not destroyed: the hover is the third use of the same shelf.
  assert.equal((shown as { hover: string }).hover,
    "print('hello') = None\nprinted: hello");
});

test('multi-line output shows a count, with all of it on the hover', async (t) => {
  // A decoration is one line, so three lines of output cannot all be on it.
  // The first plus a count is the same elision a long loop already uses, and
  // it is what stops the summary pretending to be the whole thing.
  const client = connect();
  t.after(() => client.dispose());

  const source = 'for word in ["one", "two", "three"]:\n    print(word)\n';

  assert.deepEqual(await paint(client, source, [0]),
    ["word: 'one', 'two', 'three'   printed: one …(3 lines)"]);

  const shown = present(await evaluate(client, source, 0), 0);
  assert.equal((shown as { hover: string }).hover,
    "word = 'one', 'two', 'three'\n3 iterations\nprinted:\none\ntwo\nthree",
    'the line elides; the hover is where the whole of it lives');
});

test('a statement that binds and prints shows both, binding first', async (t) => {
  // They answer different questions -- what is `x` now, and what did the code
  // say -- so neither displaces the other.
  const client = connect();
  t.after(() => client.dispose());

  const source = 'def compute():\n    print("warming up")\n    return 42\n'
    + 'x = compute()\n';
  await evaluate(client, source, 0);

  assert.deepEqual(await paint(client, source, [3]),
    ['x: 42   printed: warming up']);
});

test('writing to stderr is labelled, and is not a failure', async (t) => {
  // A library logging a warning must not paint red: it would teach a student
  // to fear a line that worked. The kernel already keeps the two apart, and
  // this is the render side of the same claim -- a value presentation, with
  // its own label, and no error anywhere on it.
  const client = connect();
  t.after(() => client.dispose());

  const source = 'import sys\nsys.stderr.write("careful\\n")\n';
  await evaluate(client, source, 0);

  const response = await evaluate(client, source, 1) as Evaluated;
  assert.equal(response.ok, true, 'writing to stderr is not a failure');
  const shown = present(response, 1);
  assert.equal(shown.kind, 'value', 'not an error presentation');
  assert.equal((shown as { error?: unknown }).error, undefined);
  // `write` returns the character count, which is a real value and stays.
  assert.deepEqual(await paint(client, source, [1]),
    ['=> 8   stderr: careful']);
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
      resultText({ value: shown.value, display: shown.display, loop: shown.loop,
        names: shown.names, bindings: shown.bindings, printed: shown.printed,
        more: shown.more })
        .replace(/ /g, ' '));
  }
  return painted;
}

/**
 * A file loaded in one keystroke, as the string each statement paints.
 *
 * The other half of `paint`: the same kernel and the same formatter, with the
 * repeat rule in between -- which is what a bulk annotation has and a
 * keypress does not. `null` is a statement that paints nothing at all.
 */
async function paintLoad(
  client: KernelClient, source: string, filename?: string
): Promise<(string | null)[]> {
  const loaded = await load(client, source, undefined, filename);
  assert.equal(loaded.ok, true);

  const above = new PaintedAbove();
  return loaded.results.map((outcome) => paintOutcome(above, outcome));
}

/** One statement's annotation, through the repeat rule standing above it. */
function paintOutcome(
  above: PaintedAbove, outcome: StatementOutcome
): string | null {
  if (!outcome.ok) {
    return `!! ${outcome.error.type}`;
  }
  // The streams become a `Printed` here, exactly as `annotationFor` does it
  // on the real path: a statement that only printed still has something to
  // say, and a helper that dropped it would be testing a pipeline the
  // extension does not have.
  const printed = printedFrom(outcome.stdout, outcome.stderr);
  if (outcome.value === null && outcome.loop === undefined
      && !outcome.names?.length && !hasOutput(printed)) {
    return null;
  }
  const kept = above.keep({ ...outcome, printed });
  return kept === undefined
    ? null
    : resultText({ value: kept.value, display: kept.display,
      loop: kept.loop, names: kept.names, bindings: kept.bindings,
      printed: kept.printed, more: kept.more_names })
      .replace(/ /g, ' ');
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

  // The names come first and the output follows: they answer different
  // questions, and on these two lines the reader wanted both. `x` is what the
  // namespace holds; `printed:` is what the program said, which is the thing
  // the student wrote the line for and the half that used to vanish.
  assert.deepEqual(await paint(client, source, [0, 1, 2, 3, 4, 5]), [
    'x: [1, 2, 3]',
    'y: [1, 2, 3]   x: [1, 2, 3]',
    'y: [1, 2, 3, 4]',
    'x: [1, 2, 3, 4]   printed: x after mutating y: [1, 2, 3, 4]',
    'x: [1, 2, 3]',
    'y: [1, 2, 3, 4]   printed: y unaffected by rebind: [1, 2, 3, 4]',
  ]);
});

test('a comprehension does not paint an unrelated variable of the same name', async (t) => {
  // The screenshot the ticket was filed from, driven through the real kernel.
  // A comprehension has a scope of its own in Python 3 and its `x` never
  // leaves it, so `x: [1, 2, 3]` beside these lines is a different variable
  // presented as part of the statement -- a false claim, and worse than an
  // empty column because the value looks plausible.
  const client = connect();
  t.after(() => client.dispose());

  const source = [
    'x = [1, 2, 3]',
    'squares = [x**2 for x in range(10)]',
    'pairs = [(x, y) for x in range(3) for y in range(2)]',
    'factor = 10',
    'data = [1, 2]',
    'scaled = [x * factor for x in data]',
  ].join('\n') + '\n';

  assert.deepEqual(await paint(client, source, [0, 1, 2, 3, 4, 5]), [
    'x: [1, 2, 3]',
    'squares: [0, 1, 4, 9, 16, 25, 36, 49, 64, 81]',
    'pairs: [(0, 0), (0, 1), (1, 0), (1, 1), (2, 0), (2, 1)]',
    'factor: 10',
    'data: [1, 2]',
    // Only the loop target is scoped away; what the line reads from the
    // enclosing scope is still the context that makes it make sense.
    'scaled: [10, 20]   factor: 10   data: [1, 2]',
  ]);

  const outer = await evaluate(client, 'x\n', 0) as Evaluated;
  assert.equal(outer.value, '[1, 2, 3]',
    'the comprehensions never touched it, which is the whole point');
});

test('unpacking names each binding rather than echoing the line', async (t) => {
  // The other half of the screenshot. `=> ({'a': 1}, {'b': 2})` restated the
  // right-hand side, which the reader can already see, and left the question
  // it exists to answer -- what is `d1` now -- unanswered. The swap is the
  // case that proves these are read from the namespace afterwards rather than
  // re-evaluated: there is no right-hand side to echo that would agree.
  const client = connect();
  t.after(() => client.dispose());

  const source = [
    'd1, d2 = {"a": 1}, {"b": 2}',
    'head, *rest = [1, 2, 3, 4]',
    'a, (b, c) = 1, (2, 3)',
    'd1, d2 = d2, d1',
  ].join('\n') + '\n';

  assert.deepEqual(await paint(client, source, [0, 1, 2, 3]), [
    "d1: {'a': 1}   d2: {'b': 2}",
    'head: 1   rest: [2, 3, 4]',
    'a: 1   b: 2   c: 3',
    "d1: {'b': 2}   d2: {'a': 1}",
  ]);
});

test('an expression keeps its arrow, and a call keeps its result', async (t) => {
  // The three shapes that look alike and are not. `sum([10, 20]): 30` would
  // repeat the line back at the reader, so it keeps the arrow. `y.pop()`
  // returned the 4 that a "hide the value when something changed" rule would
  // have thrown away. And a `None` survives exactly where the line has
  // nothing else to say, which `d.get('k')` on a line mentioning `d` does
  // not. `print("done")` is the third: the line has no names on it at all,
  // and what it printed is still better than the None it returned -- so
  // output displaces a `None` on the same rule a shown name does.
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
    'printed: done',
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
    painted.push(resultText({ value: (shown as { value: string }).value,
      display: (shown as { display: string }).display }));
    hovers.push((shown as { hover: string }).hover);
  }

  assert.deepEqual(painted.map((p) => p.replace(/ /g, ' ')), [
    'def area(w: int, h: int = 2) -> int',
    'def area(w: int, h: int = 2) -> int',
    'def area(w: int, h: int = 2) -> int',
  ]);
  // The address is not lost, only moved off the line -- and it is still the
  // thing that differs between evaluations, which is why it cannot live there.
  for (const hover of hovers) {
    assert.match(hover, /^area = <function area at 0x[0-9a-f]+>$/);
  }
  assert.notEqual(hovers[0], hovers[1]);
});

/**
 * What the editor would paint beside `line`, and whether it would paint it.
 *
 * The four steps the decorator takes, in the order it takes them: the kernel
 * answers, `resultText` renders the answer, the line is asked whether it opens
 * a definition, and only if it does not is the rendered text measured against
 * it. Put together here because that whole path is what a reader sees, and
 * every layer of it can be right on its own while the line still comes out
 * blank or saying its own name twice.
 */
async function painted(client: KernelClient, source: string, line: number) {
  const shown = present(await evaluate(client, source, line), line) as {
    value: string | null; display: string | null;
    anchor?: number; range: { end: { line: number } };
  };
  const at = shown.anchor ?? shown.range.end.line;
  const code = source.split('\n')[at] ?? '';
  const rendered = resultText({ value: shown.value, display: shown.display });
  return {
    code,
    text: rendered.replace(/\u00a0/g, ' '),
    // The raw text, non-breaking spaces and all, exactly as the decorator
    // hands it over.
    suppressed: !opensDefinition(code) && restatesLine(rendered, code),
  };
}

/** Every definition form, in one file, so the family can be read at once. */
const DEFINITIONS = [
  'def greet(name):',                 // 0
  '    return f"hello {name}"',
  'def area(w, h=1):',                // 2
  '    return w * h',
  'class Config:',                    // 4
  '    pass',
  'def gen(n):',                      // 6
  '    yield n',
  'async def fetch(url):',            // 8
  '    return url',
  'lam = lambda q: q * 2',            // 10
  'f = greet',                        // 11
  '',
].join('\n');

test('every definition paints, and the family is uniform', async (t) => {
  // The seven cases together, because apart they looked like six correct
  // behaviours and one deliberate silence. They were not: a class escaped
  // suppression on its parentheses, a generator on an arrow that runs past the
  // end of its line, a lambda and an alias on their labels -- and the plain
  // synchronous function, the one form a first-year student writes on page
  // one, was suppressed for being a character-for-character prefix of itself.
  //
  // What each of these annotations claims is not what its line says. The line
  // says *bind a function to this name when this runs*; the annotation says
  // *it has run, and here is what the name now holds*. That is the fact the
  // reader cannot see, and a definition edited without being re-evaluated is
  // the hazard this whole style of working has.
  const client = connect();
  t.after(() => client.dispose());

  const shown = [];
  for (const line of [0, 2, 4, 6, 8, 10, 11]) {
    const { code, text, suppressed } = await painted(client, DEFINITIONS, line);
    shown.push([suppressed ? 'silent' : 'paints', code, text]);
  }

  assert.deepEqual(shown, [
    ['paints', 'def greet(name):', 'def greet(name)'],
    ['paints', 'def area(w, h=1):', 'def area(w, h=1)'],
    ['paints', 'class Config:', 'class Config()'],
    ['paints', 'def gen(n):', 'def gen(n) -> generator'],
    ['paints', 'async def fetch(url):', 'def fetch(url) -> coroutine'],
    ['paints', 'lam = lambda q: q * 2', 'lam: def <lambda>(q)'],
    ['paints', 'f = greet', 'f: def greet(name)'],
  ]);
});

test('a decorated def still says what the decorator produced', async (t) => {
  // The case that must survive whatever else changes: `@shout` REPLACED the
  // function with a lambda and the line cannot show that, so this annotation
  // is worth every character of its width. It differs from its line as text
  // as well as by exemption, which is what makes it a check on both.
  const client = connect();
  t.after(() => client.dispose());

  const source = 'def shout(fn):\n    return lambda: fn().upper()\n'
    + '@shout\ndef greeting():\n    return "ok"\n';
  await evaluate(client, source, 0);

  const shown = await painted(client, source, 3);
  assert.equal(shown.code, 'def greeting():');
  assert.equal(shown.text, 'greeting: def <lambda>()');
  assert.equal(shown.suppressed, false);
});

test('a definition saying more than its line says it anyway', async (t) => {
  // `-> generator` is the explanation for why iterating the result a second
  // time found it empty, and a class's signature is how to construct one.
  // These were the members of the family that painted by accident; they still
  // paint, now for the same reason the rest of it does.
  const client = connect();
  t.after(() => client.dispose());

  const generator = await painted(
    client, 'def counted(n):\n    yield n\n', 0);
  assert.equal(generator.text, 'def counted(n) -> generator');
  assert.equal(generator.suppressed, false);

  const klass = await painted(
    client,
    'class Config:\n    def __init__(self, name, port=8080):\n'
    + '        self.name = name\n',
    0);
  assert.equal(klass.text, 'class Config(name, port=8080)');
  assert.equal(klass.suppressed, false);
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
  // its main guard. False here because __name__ is the file's own name --
  // which is what an import gives it, and is what the annotations and reprs
  // the user reads are printed with. Pinned on both sides because a load that
  // ran the guarded block would run code nobody pointed at and still report a
  // successful load.
  const client = connect();
  t.after(() => client.dispose());

  const source = "import sys\nif __name__ == '__main__':\n    sys.exit(9)\n"
    + '__name__\n';
  const loaded = await client.request({
    op: 'eval_file', allow_stdin: false, source, filename: '/tmp/evalens-main.py',
  }) as FileLoaded;
  assert.equal(loaded.ok, true, 'sys.exit would have made this a failure');

  const name = loaded.results[loaded.results.length - 1] as Evaluated;
  assert.equal(name.value, "'evalens-main'");
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

test('a dependency crosses the wire and reaches the marking rule', async (t) => {
  // The two-line example, end to end. The kernel says what each statement
  // bound and read; `markDependents` turns that into one mark and nothing
  // else. A renamed field on either side passes both suites and fails only in
  // a real editor, which is what this whole file exists for.
  const client = connect();
  t.after(() => client.dispose());

  const source = 'x = 1\ny = x + 1\n';
  const first = await evaluate(client, source, 0) as Evaluated;
  const second = await evaluate(client, source, 1) as Evaluated;

  assert.deepEqual(first.binds, ['x']);
  assert.deepEqual(second.reads, ['x']);

  const annotations = [first, second].map((response) => {
    const painted = present(response, response.range.start.line);
    assert.equal(painted.kind, 'value');
    const value = painted as Extract<typeof painted, { kind: 'value' }>;
    return {
      range: {
        start: { line: value.range.start.line },
        end: { line: value.range.end.line },
      },
      value: value.value,
      ...(value.binds === undefined ? {} : { binds: value.binds }),
      ...(value.reads === undefined ? {} : { reads: value.reads }),
      stale: false,
    };
  });

  // Re-evaluating line 1 is what the user does after editing it, and line 2
  // is the one describing a world that has moved on.
  const marked = markDependents(annotations, annotations[0]!);
  assert.deepEqual(marked.map((a) => a.stale === true), [false, true]);
  assert.deepEqual(marked.map((a) => a.value), ['1', '2'],
    'and nothing was re-run, so neither value moved');
});

test('the inventory block from the ticket annotates exactly once', async (t) => {
  // The evidence #28 was filed on, through the real kernel over a real pipe:
  // one dict, three lines calling methods on it, and four identical
  // annotations where the repetition was the file's dominant visual problem.
  // Two of those lines could have mutated `inventory`, which is why the
  // comparison is on the value each line reported rather than on identity.
  const client = connect();
  t.after(() => client.dispose());

  const source = [
    'inventory = {"apples": 3, "pears": 5}',
    'print(inventory.get("bananas", 0))',
    'print(list(inventory.items()))',
    'print("apples" in inventory)',
  ].join('\n') + '\n';

  const painted = await paintLoad(client, source, '/tmp/evalens-inventory.py');
  assert.deepEqual(painted, [
    "inventory: {'apples': 3, 'pears': 5}",
    // What each `print` wrote, which is different on all three lines and was
    // on none of them before. The wall the ticket was filed on is gone all
    // the same: `inventory` is named once, and the three lines below carry
    // only what they themselves produced.
    'printed: 0',
    "printed: [('apples', 3), ('pears', 5)]",
    'printed: True',
  ]);
  assert.equal(
    painted.filter((line) => line?.includes('inventory:')).length, 1,
    'the value appears once, however many lines go on to read it');
});

test('an explicit evaluation annotates whether or not it repeats', async (t) => {
  // The exception that matters, on the same four lines. Somebody pressed a
  // key: staying silent because the value has not changed since the line
  // above is indistinguishable from the keypress being ignored.
  const client = connect();
  t.after(() => client.dispose());

  const source = [
    'inventory = {"apples": 3, "pears": 5}',
    'print(inventory.get("bananas", 0))',
    'print(list(inventory.items()))',
    'print("apples" in inventory)',
  ].join('\n') + '\n';

  const shown = "inventory: {'apples': 3, 'pears': 5}";
  assert.deepEqual(await paint(client, source, [0, 1, 2, 3]), [
    shown,
    `${shown}   printed: 0`,
    `${shown}   printed: [('apples', 3), ('pears', 5)]`,
    `${shown}   printed: True`,
  ], 'the repeated value is painted every time, and so is what each printed');
});

test('a rebinding is painted, and the lines that only read it are not', async (t) => {
  // The rule may not cost a changed value: that is the most interesting thing
  // this extension can show, and the append is the whole IDEA.md example.
  const client = connect();
  t.after(() => client.dispose());

  const source = [
    'x = 1', 'print(x)', 'print(x + 1)', 'x = 2', 'print(x)',
  ].join('\n') + '\n';

  assert.deepEqual(await paintLoad(client, source, '/tmp/evalens-rebind.py'),
    // `x: 1` is not said four times; the rebinding to 2 always is. What the
    // three `print` lines wrote is their own and stands above nothing, so the
    // repeat rule has nothing to compare it against and never suppresses it.
    ['x: 1', 'printed: 1', 'printed: 2', 'x: 2', 'printed: 2']);
});

test('a mutation shows again, because the value on screen changed', async (t) => {
  const client = connect();
  t.after(() => client.dispose());

  const source = 'lst = [1, 2, 3]\ny = lst\ny.append(4)\nlst\n';

  assert.deepEqual(await paintLoad(client, source, '/tmp/evalens-mutate.py'), [
    'lst: [1, 2, 3]',
    // `lst` is already above, unchanged, so `y` is all this line has to add.
    'y: [1, 2, 3]',
    'y: [1, 2, 3, 4]',
    'lst: [1, 2, 3, 4]',
  ]);
});

test('a line past the name cap says how many it left off', async (t) => {
  // Observed on a real file: five names, four values, and no way to tell
  // whether the fifth was omitted, unreadable, or somehow not a name.
  const client = connect();
  t.after(() => client.dispose());

  const source = [
    'lst = [1]', 'tup = (1,)', 'd = {}', 's = {1}', 'empty_set = set()',
    'print(type(lst), type(tup), type(d), type(s), type(empty_set))',
  ].join('\n') + '\n';

  const walked = await paint(client, source, [0, 1, 2, 3, 4, 5]);
  // The footnote is last of all, after what the line printed: it is a note
  // about the annotation rather than another thing the statement produced.
  assert.equal(walked[5],
    "lst: [1]   tup: (1,)   d: {}   s: {1}   printed: <class 'list'> "
    + "<class 'tuple'> <class 'dict'> <class 'set'> <class 'set'>"
    + '   \u2026+1 more');

  // And on the same file loaded in one keystroke every one of those values is
  // unchanged from the lines just above, so the cap never bites and the line
  // is left with what it printed and nothing else.
  assert.equal((await paintLoad(client, source, '/tmp/evalens-cap.py')).at(-1),
    "printed: <class 'list'> <class 'tuple'> <class 'dict'> <class 'set'> "
    + "<class 'set'>");
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
    resultText({ value: shown.value ?? '', display: shown.display,
      loop: shown.loop }).replace(/ /g, ' '),
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
    resultText({ value: result.value ?? '', display: result.display,
      loop: result.loop })
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

test('a loop annotates what its body computed, through the real kernel', async (t) => {
  // The ticket's acceptance case end to end. stdout said 4, 8 and 12 while
  // the annotation said `u: 12` -- the input's whole history beside the
  // result's final value, which is the wrong way round.
  const client = connect();
  t.after(() => client.dispose());

  const source = [
    'x = [1, 2, 3]',
    'for v in x:',
    '    u = 4 * v',
    "    print('value is ' + str(u))",
    '',
  ].join('\n');
  await evaluate(client, source, 0);

  const result = await evaluate(client, source, 1) as Evaluated;
  assert.equal(result.stdout, 'value is 4\nvalue is 8\nvalue is 12\n',
    'the kernel saw every value u took');
  // Three lines of output cannot fit in a decoration, so the first leads and
  // the count says how much is not on screen. Every one of them is in the
  // channel already, and all three are on the hover.
  assert.deepEqual(await paint(client, source, [1]),
    ['v: 1, 2, 3   u: 4, 8, 12   x: [1, 2, 3]   printed: value is 4 …(3 lines)']);
});

test('a filter loop paints two sequences of different lengths', async (t) => {
  // The iteration that hit `continue` computed no result, so `u` has one
  // entry fewer than `v` does. Rendering the two as parallel columns is wrong
  // the first time anyone writes this loop, which is why it is an acceptance
  // case rather than a corner one.
  const client = connect();
  t.after(() => client.dispose());

  const source = [
    'for v in [1, 2, 3]:',
    '    if v == 2:',
    '        continue',
    '    u = 4 * v',
    '',
  ].join('\n');

  assert.deepEqual(await paint(client, source, [0]),
    ['v: 1, 2, 3   u: 4, 12']);
});

test('a loop body binding one value every time says it once', async (t) => {
  // `c: 7, 7, 7, 7` would crowd out the sequence beside it that is moving.
  const client = connect();
  t.after(() => client.dispose());

  const source = [
    'for v in [1, 2, 3, 4]:',
    '    c = 7',
    '    d = v * v',
    '',
  ].join('\n');

  assert.deepEqual(await paint(client, source, [0]),
    ['v: 1, 2, 3, 4   c: 7   d: 1, 4, 9, 16']);
});

test('a loop stopped by break annotates the value it broke on', async (t) => {
  const client = connect();
  t.after(() => client.dispose());

  const result = await evaluate(
    client,
    'for p in [1, 2, 3, 4]:\n    if p == 3:\n        break\n', 0) as Evaluated;
  assert.equal(
    resultText({ value: result.value ?? '', display: result.display,
      loop: result.loop })
      .replace(/ /g, ' '),
    'p: 1, 2, 3');
});

test('the display limits a setting produces reach the real kernel', async (t) => {
  // A setting is only real if the number the extension sends is the number
  // the kernel applies. Both sides pass their own suites with a `limits`
  // field one of them quietly ignores, and the drift then shows up as a
  // setting that does nothing -- which reads as a broken extension.
  const client = connect();
  t.after(() => client.dispose());

  const source = 'for p in range(20):\n    pass\n';
  const ask = (limits: { loop_values: number; names: number }) =>
    client.request({
      op: 'eval', source, line: 0, character: 0,
      filename: '/tmp/evalens-test.py', allow_stdin: false, limits,
    }) as Promise<Evaluated>;

  const wider = await ask({ loop_values: 8, names: 4 });
  assert.equal(wider.loop?.values.length, 8,
    'the kernel kept its own five rather than the eight it was asked for');

  const off = await ask({ loop_values: 0, names: 0 });
  assert.equal(off.loop, undefined, 'zero must leave the loop uninstrumented');
  assert.equal(off.value, '19', 'and still report what the target ended on');
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

/** The error type one loaded statement failed with, or its value. */
function outcome(result: StatementOutcome): string {
  return result.ok ? String(result.value) : result.error.type;
}

test('loading a file asks, and carries on with the answer', async (t) => {
  // The reversal. A load refused to prompt, citing the flag Jupyter sets false
  // for nbconvert and papermill -- but those run unattended, and this is
  // somebody pressing a key and waiting. Refusing painted a red EOFError on
  // the prompt line and a cascade of NameError beneath it, because nothing
  // downstream had the value, on exactly the teaching files the command exists
  // to set up.
  const { client, prompts } = connectAnswering(() => 'Ada');
  t.after(() => client.dispose());

  const loaded = await client.request({
    op: 'eval_file',
    allow_stdin: true,
    source: "before = 1\nname = input('Your name? ')\ngreeting = 'hi ' + name\n",
    filename: '/tmp/evalens-course.py',
  }) as FileLoaded;

  assert.deepEqual(prompts, ['Your name? ']);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.ran, 3, 'the whole file loaded');
  assert.equal(outcome(loaded.results[2]!), "'hi Ada'",
    'the line below the prompt had the answer to work with');
});

test('a prompt during a load says which line is asking', async (t) => {
  // The half of the design that stops the box feeling disembodied. The
  // extension sent a whole file, so without this it cannot tell which of its
  // statements stopped -- and cannot mark that line or scroll to it.
  const asked: (number | undefined)[] = [];
  const client = new KernelClient({
    resolvePython: async () => 'python3',
    kernelPath: KERNEL,
    onInput: async (request) => {
      asked.push(request.range?.start.line);
      return 'Ada';
    },
  });
  t.after(() => client.dispose());

  await client.request({
    op: 'eval_file',
    allow_stdin: true,
    source: "a = 1\nb = 2\nname = input('Your name? ')\n",
    filename: '/tmp/evalens-where.py',
  });

  assert.deepEqual(asked, [2]);
});

test('cancelling one prompt costs that statement and nothing else', async (t) => {
  // The way out has to stay cheap, or a student who cannot answer a prompt is
  // stuck in it. Cancelling sends end-of-file, that statement raises EOFError,
  // and the load carries on -- a broken line is not a broken load.
  const answers: (string | null)[] = [null, 'B'];
  const { client, prompts } = connectAnswering(() => answers.shift() ?? null);
  t.after(() => client.dispose());

  const loaded = await client.request({
    op: 'eval_file',
    allow_stdin: true,
    source: "first = input('a? ')\nsecond = input('b? ')\nthird = 3\n",
    filename: '/tmp/evalens-cancel.py',
  }) as FileLoaded;

  assert.deepEqual(prompts, ['a? ', 'b? '], 'the next prompt was still asked');
  assert.deepEqual(loaded.results.map(outcome), ['EOFError', "'B'", '3']);
});

test('skipping the rest stops the asking without stopping the load', async (t) => {
  // A file with twenty prompts must not mean twenty boxes with no way out.
  // Driven by the same LoadPrompts the extension uses, because the decision is
  // its own -- the kernel keeps asking, and what changes is that every prompt
  // after the choice is answered with end-of-file without a box.
  const load = new LoadPrompts();
  const boxes: string[] = [];
  const client = new KernelClient({
    resolvePython: async () => 'python3',
    kernelPath: KERNEL,
    onInput: async (request) => {
      if (load.quiet) {
        return null;
      }
      boxes.push(request.prompt);
      // The offer appears on the second prompt, and is taken there.
      const chosen = load.offerSkip ? 'skip' : 'value';
      load.record(chosen);
      return chosen === 'skip' ? null : 'answer';
    },
  });
  t.after(() => client.dispose());

  const loaded = await client.request({
    op: 'eval_file',
    allow_stdin: true,
    // Four prompts: one answered, one skipped at, two that must not be asked.
    source: "one = input('1? ')\ntwo = input('2? ')\n"
      + "three = input('3? ')\nfour = input('4? ')\nfive = 5\n",
    filename: '/tmp/evalens-skip.py',
  }) as FileLoaded;

  assert.deepEqual(boxes, ['1? ', '2? '],
    'a box opened for a prompt after the user asked to skip the rest');
  assert.deepEqual(loaded.results.map(outcome),
    ["'answer'", 'EOFError', 'EOFError', 'EOFError', '5'],
    'skipping is cancelling the rest, and the lines that do not ask still run');
});

test('a load told not to prompt still does not, and says so plainly', async (t) => {
  // The flag is still the caller's, and a caller with nobody attached has to
  // get an error rather than a kernel stopped and waiting for a human nobody
  // told to look.
  const { client, prompts } = connectAnswering(() => 'Ada');
  t.after(() => client.dispose());

  const loaded = await client.request({
    op: 'eval_file',
    allow_stdin: false,
    source: "name = input('Your name? ')\nafter = 3\n",
    filename: '/tmp/evalens-unattended.py',
  }) as FileLoaded;

  assert.deepEqual(prompts, [], 'nothing was told not to ask, and it asked');
  assert.deepEqual(loaded.results.map(outcome), ['EOFError', '3']);
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

test('the advance walk visits every top-level statement of the tour', async (t) => {
  // The end-to-end claim of #65: hold the key from the top of a real file and
  // it steps through the statements -- over the comment blocks, over the blank
  // lines, over a `def` body in one press -- and stops at the bottom. The
  // fixture is `examples/tour.py` because it is the file the manual test and
  // the demo use, and it contains every statement shape the resolver knows.
  const client = connect();
  t.after(() => client.dispose());

  const file = path.resolve(__dirname, '..', '..', 'examples', 'tour.py');
  const source = fs.readFileSync(file, 'utf8');
  const lines = source.split('\n');

  const outlined = await client.request({
    op: 'outline', source, filename: file,
  }) as Outlined;
  assert.equal(outlined.ok, true);

  const visited: number[] = [];
  let cursor = 0;
  for (;;) {
    const step = nextStop(outlined.statements, cursor, (line) => lines[line]!);
    if (step.kind === 'end') {
      break;
    }
    cursor = step.position.line;
    visited.push(cursor);
    assert.ok(visited.length <= outlined.statements.length,
      'the walk is not making progress towards the end of the file');
  }

  // Every statement reached, in order, exactly once. Distinct lines rather
  // than statements because case 46 writes two statements on one line, and a
  // cursor gives a line: stopping there twice would evaluate the first of
  // them twice and never reach the second (#18).
  assert.deepEqual(
    visited,
    [...new Set(outlined.statements.map((s) => s.range.start.line))],
    'the walk must reach each statement line once, in file order');

  // Independent of the outline: nothing it stopped on is a blank line or a
  // comment, and no stop is inside a statement it has already run.
  for (const line of visited) {
    const text = lines[line]!;
    assert.notEqual(text.trim(), '', `stopped on a blank line (${line + 1})`);
    assert.ok(!text.trimStart().startsWith('#'),
      `stopped on a comment line (${line + 1})`);
  }

  // The `def area` of case 5 is three lines; the walk crosses it in one step.
  const area = lines.findIndex((line) => line.startsWith('def area('));
  assert.ok(visited.includes(area), 'the def itself is a stop');
  for (const inside of [area + 1, area + 2]) {
    assert.ok(!visited.includes(inside),
      `a def body must not be a stop (line ${inside + 1})`);
  }

  // And the last stop is the last statement in the file, not a wrap.
  const last = outlined.statements[outlined.statements.length - 1]!;
  assert.equal(visited[visited.length - 1], last.range.start.line);
  assert.deepEqual(
    nextStop(outlined.statements, last.range.start.line, (line) => lines[line]!),
    { kind: 'end' });
});

test('a broken last line does not make the whole file unevaluable', async (t) => {
  // The complaint, end to end. `ast` is all-or-nothing, so one half-typed
  // line used to take the file down with it -- at exactly the moment a file
  // is half-written, which is why anyone was evaluating anything.
  const client = connect();
  t.after(() => client.dispose());

  const source = 'a = 1\nb = 2\ntotal = a + b\ns = "half-typ\n';
  // Every one of these used to answer with a complaint about line 4.
  await evaluate(client, source, 0);
  await evaluate(client, source, 1);
  const result = await evaluate(client, source, 2) as Evaluated;

  assert.equal(result.ok, true, 'line 3 is perfectly valid Python');
  assert.equal(result.value, '3');
  assert.equal(result.partial?.truncated_at, 3);
});

test('a partial answer says so on the line it paints', async (t) => {
  // "Which mode answered" all the way to the string the user reads. A value
  // computed without the rest of the file is a weaker claim, and the two must
  // not paint identically.
  const client = connect();
  t.after(() => client.dispose());

  const source = 'total = 1 + 2\ns = "half-typ\n';
  const response = await evaluate(client, source, 0);
  const shown = present(response, 0) as {
    kind: string; value: string; display: string;
    partial?: { truncated_at: number };
  };

  assert.equal(shown.kind, 'value');
  // Compared against `preserveSpacing`, because what reaches `contentText`
  // has non-breaking spaces in it -- VS Code eats the ordinary kind.
  assert.equal(
    resultText({ value: shown.value, display: shown.display, loop: null,
      more: 0, partialFrom: shown.partial?.truncated_at }),
    preserveSpacing(`total: 3${GAP}${partialNote(1)}`));
});

test('the break is painted on the line that broke, not on the cursor', async (t) => {
  // The other half of the ticket, and arguably the more valuable one: the
  // cause belongs where the eye goes and where the fix is typed.
  const client = connect();
  t.after(() => client.dispose());

  const source = 'a = 1\nb = 2\nc = 3\ns = "half-typ\n';
  const response = await evaluate(client, source, 0) as Evaluated;
  const cause = partialCause(response.partial!);

  assert.equal(cause.range.start.line, 3, 'the break is on line 4, not line 1');
  assert.equal(cause.type, 'SyntaxError');
  assert.match(errorText(cause.type, cause.message), /SyntaxError/);
});

test('a syntax error under the cursor still reports normally', async (t) => {
  // The fallback is for a break somewhere else. A broken statement where you
  // are pointing is a real answer, and answering it from a truncated file
  // would be answering a question nobody asked.
  const client = connect();
  t.after(() => client.dispose());

  const source = 'a = 1\nb = 2\ns = "half-typ\n';
  const response = await evaluate(client, source, 2) as Failed;

  assert.equal(response.ok, false);
  assert.equal(response.error.type, 'SyntaxError');
  assert.equal(response.partial, undefined,
    'nothing was answered from a reduced context, so nothing to caveat');

  const shown = present(response, 2) as { kind: string; range: { start: { line: number } } };
  assert.equal(shown.kind, 'error');
  assert.equal(shown.range.start.line, 2);
});

test('a load takes the part of the file that parses', async (t) => {
  // #25 settled that a broken line must not stop a load. A line that does not
  // parse is the same argument one step earlier.
  const client = connect();
  t.after(() => client.dispose());

  const source = 'a = 1\nb = 2\nc = a + b\nd = broken(\n';
  const loaded = await client.request({
    op: 'eval_file', allow_stdin: false, source,
    filename: '/tmp/evalens-halftyped.py',
  }) as FileLoaded;

  assert.equal(loaded.ok, true, 'a half-typed line is not a broken load');
  assert.equal(loaded.ran, 3);
  assert.equal(loaded.partial?.truncated_at, 3);
  assert.equal(
    describeLoad(loaded.ran, loaded.statements, 0, loaded.partial?.truncated_at),
    'Evalens: loaded 3 statements; line 4 onwards did not parse');

  // The bindings really are in the namespace, which is what loading is for.
  const c = await evaluate(client, source, 2) as Evaluated;
  assert.equal(c.value, '3');
});

test('the tour file still parses whole and answers with no caveat', async (t) => {
  // The fixture the demo is recorded from, driven over a real pipe. A
  // fallback that engaged on a file that parses would put "(partial)" on
  // every annotation in the demo.
  const client = connect();
  t.after(() => client.dispose());

  const tour = path.resolve(__dirname, '..', '..', 'examples', 'tour.py');
  const source = fs.readFileSync(tour, 'utf8');

  const loaded = await client.request({
    op: 'eval_file', allow_stdin: false, source, filename: tour,
  }) as FileLoaded;

  assert.equal(loaded.ok, true);
  assert.equal(loaded.partial, undefined, 'the tour must parse whole');
  // The tour carries a deliberate NameError; what must not happen is a
  // truncation, which would silently drop everything below it.
  assert.equal(loaded.statements, loaded.results.length);
  assert.ok(loaded.ran > 40, `only ${loaded.ran} statements ran`);
});

/**
 * 0: docstring  1: a  2-4: def f  5: c  6: "hello"  7: d
 * 8: the half-typed line, and 9-10 below it looking perfectly runnable.
 */
const BROKEN_SELECTABLE = '"""doc"""\na = 1\ndef f(x):\n    y = x + 1\n'
  + '    return y\nc = f(1)\n"hello"\nd = 2\ns = "half-typ\nt = 3\nu = 4\n';

test('a selection below the break runs nothing and says why', async (t) => {
  // The composition neither ticket anticipated, over a real pipe. Eight
  // statements parsed and are sitting above this selection; the user pointed
  // at lines 10-11; not one of the eight may run. Falling back to the prefix
  // is the failure mode both features exist to prevent, and it is the
  // tempting mistake here because there is something runnable right there.
  const client = connect();
  t.after(() => client.dispose());

  const ran = await load(client, BROKEN_SELECTABLE,
    { start_line: 9, end_line: 10 }, '/tmp/evalens-broken-selection.py');

  assert.equal(ran.ok, true, 'nothing to run is an outcome, not an error');
  assert.equal(ran.statements, 0);
  assert.equal(ran.ran, 0);
  assert.equal(ran.range, undefined, 'nothing ran, so nothing to report a span for');
  assert.equal(ran.partial?.truncated_at, 8);
  assert.equal(
    describeRun(ran.ran, ran.statements, 0, false, ran.partial?.truncated_at),
    'Evalens: nothing to run in the selection; line 9 onwards did not parse');
  assert.equal(
    (await evaluate(client, 'a\n', 0) as Failed).error.type, 'NameError',
    'the prefix must not have run in the selection\'s place');
});

test('a selection spanning the break runs the part above it', async (t) => {
  const client = connect();
  t.after(() => client.dispose());

  const ran = await load(client, BROKEN_SELECTABLE,
    { start_line: 7, end_line: 8 }, '/tmp/evalens-broken-selection.py');

  assert.equal(ran.ran, 1, 'only `d = 2`; the half-typed line is not a statement');
  assert.equal((await evaluate(client, 'd\n', 0) as Evaluated).value, '2');
  assert.equal((await evaluate(client, 's\n', 0) as Failed).error.type,
    'NameError');
});

test('what ran and where parsing stopped are two facts, both on the wire',
  async (t) => {
    // The run ended on line 8 because that is where the last selected
    // statement ended; parsing stopped on line 9 because that is where the
    // file broke. Neither number can be derived from the other, so both
    // travel and the extension paints two different things with them.
    const client = connect();
    t.after(() => client.dispose());

    const ran = await load(client, BROKEN_SELECTABLE,
      { start_line: 7, end_line: 8 }, '/tmp/evalens-broken-selection.py');

    assert.equal(ran.range?.end.line, 7);
    assert.equal(ran.partial?.truncated_at, 8);
    assert.equal(partialCause(ran.partial!).range.start.line, 8,
      'the red annotation goes on the break, not on the end of the run');
  });

test('a selection still snaps outward inside a file that does not parse',
  async (t) => {
    // Lines 4-5 are the body of `f`. Truncating the file did not cost the
    // selection its statement boundaries, because the narrowing is applied to
    // the tree the prefix produced rather than to the text.
    const client = connect();
    t.after(() => client.dispose());

    const selection = {
      start: { line: 3, character: 4 }, end: { line: 4, character: 12 },
    };
    const ran = await load(client, BROKEN_SELECTABLE, selectedLines(selection),
      '/tmp/evalens-broken-selection.py');

    assert.equal(ran.ran, 1);
    assert.deepEqual(ran.range?.start, { line: 2, character: 0 },
      'the run reached back to the `def` line');
    assert.equal(widenedBeyond(ran.range!, selection), true);
    assert.equal((await evaluate(client, 'f\n', 0) as Evaluated).display, 'f');
  });

/**
 * A statement that starts a thread which writes once `gate` appears.
 *
 * What the write meets is whatever the kernel leaves in `sys.stdout` between
 * evaluations, which for the life of this project was the pipe every response
 * travels on -- so it has to happen with nothing running, and has to be
 * *known* to have happened then rather than merely be likely to. A sleep long
 * enough to outlast the statement is a wager on the scheduler: it assumes the
 * kernel gets from `start()` to writing the response inside the interval.
 * Waiting for a file costs the same line and proves it, because the kernel
 * puts the statement's capture buffer away before it answers -- so a gate
 * created after that answer has been read cannot be seen by the thread until
 * there is provably no statement to attribute the write to.
 *
 * The thread is a daemon because it now waits on something a failed test may
 * never create, and a live non-daemon thread would keep the kernel running.
 */
function lateWriter(write: string, gate: string): string {
  const until = `while not os.path.exists(${JSON.stringify(gate)})`;
  return 'import os, sys, threading, time\n'
    + 'def late():\n'
    + `    ${until}: time.sleep(0.005)\n`
    + `    ${write}\n`
    + 'worker = threading.Thread(target=late, daemon=True)\n'
    + 'worker.start()\n';
}

/** Start the thread, then let it write -- in that order, provably. */
async function startLateWriter(
  client: KernelClient, write: string
): Promise<void> {
  const gate = markerPath('go');
  const source = lateWriter(write, gate);
  for (let line = 0; line < source.split('\n').length - 1; line++) {
    await evaluate(client, source, line);
  }
  // The response to `worker.start()` is in hand, so the statement is over and
  // its buffer put away. Only now is the thread let go.
  fs.writeFileSync(gate, '');
}

/** A client that collects the output frames, so a test can wait for one. */
function connectWatchingOutput(): {
  client: KernelClient;
  streamed: Array<{ text: string; unattributed: boolean }>;
  reported: string[];
} {
  const streamed: Array<{ text: string; unattributed: boolean }> = [];
  const reported: string[] = [];
  const client = new KernelClient({
    resolvePython: async () => 'python3',
    kernelPath: KERNEL,
    onStream: (_name, text, unattributed) => streamed.push({ text, unattributed }),
    onStderr: (text) => reported.push(text),
  });
  return { client, streamed, reported };
}

/** Wait for the thread's write to have happened, or fail saying it never did. */
async function waitForOutput(
  streamed: ReadonlyArray<{ text: string }>, needle: string
): Promise<void> {
  for (let tick = 0; tick < 200; tick++) {
    if (streamed.some((frame) => frame.text.includes(needle))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`the kernel never delivered ${needle}`);
}

/** Fail rather than hang: a wedged session is a promise that never settles. */
function withinFiveSeconds<T>(work: Promise<T>, what: string): Promise<T> {
  // When the wait runs out the request is still pending, and it is rejected
  // later when the kernel is disposed with nobody left listening. An unhandled
  // rejection takes the whole file down rather than failing this one test,
  // which for a regression test is the difference between a red line naming
  // the defect and a run that stops before it reaches the rest.
  work.catch(() => undefined);
  return Promise.race([
    work,
    new Promise<T>((_resolve, reject) => setTimeout(
      () => reject(new Error(`${what} never settled -- the session is wedged`)),
      5000).unref()),
  ]);
}

test('a thread printing after its statement returned does not wedge the session',
  async (t) => {
    // The mild half of the defect: with a trailing newline the text arrives as
    // its own line, fails JSON.parse, and is reported to the user as the
    // extension malfunctioning. It is their own print.
    const { client, streamed, reported } = connectWatchingOutput();
    t.after(() => client.dispose());

    await startLateWriter(client, "print('LATE THREAD PRINT')");
    await waitForOutput(streamed, 'LATE THREAD PRINT');

    const answer = await withinFiveSeconds(
      evaluate(client, 'answer = 42\n', 0), 'the request after the late print'
    ) as Evaluated;
    assert.equal(answer.value, '42');
    assert.equal(reported.join(''), '',
      "the user's own print must not be reported as a kernel fault");
  });

test('a thread writing without a newline does not splice onto the next answer',
  async (t) => {
    // The dangerous half. Unterminated text lands on the *front* of the next
    // response: the value is computed correctly and thrown away, `deliver`
    // returns without touching the pending request, and with no per-request
    // timeout the spinner runs until the kernel is restarted and the session's
    // namespace goes with it.
    const { client, streamed, reported } = connectWatchingOutput();
    t.after(() => client.dispose());

    await startLateWriter(client, "sys.stdout.write('PARTIAL FROM THREAD')");
    await waitForOutput(streamed, 'PARTIAL FROM THREAD');

    const answer = await withinFiveSeconds(
      evaluate(client, 'answer = 42\n', 0), 'the request after the late write'
    ) as Evaluated;
    assert.equal(answer.value, '42');
    assert.equal(answer.display, 'answer');
    assert.equal(reported.join(''), '');

    // And the session is still usable, which is the claim the ticket is about.
    const after = await withinFiveSeconds(
      evaluate(client, 'again = answer + 1\n', 0), 'the request after that'
    ) as Evaluated;
    assert.equal(after.value, '43');
  });

test('late output reaches the user, saying it belongs to no line', async (t) => {
  const { client, streamed } = connectWatchingOutput();
  t.after(() => client.dispose());

  await startLateWriter(client, "print('LATE THREAD PRINT')");
  await waitForOutput(streamed, 'LATE THREAD PRINT');

  const late = streamed.find((frame) => frame.text.includes('LATE THREAD PRINT'));
  assert.equal(late?.unattributed, true,
    'which statement started the thread is not knowable, and is not guessed');
});

/**
 * A file loaded through the real kernel, painted as each statement finishes.
 *
 * The counterpart to `paintLoad`, and the difference between them is the whole
 * of #82: that one waits for the response and paints the file at the end, this
 * one paints on the frames as they come off the control channel. Same kernel,
 * same formatter, same repeat rule -- only the moment differs, which is what
 * the reader is complaining about.
 *
 * `onAsk` is called when the running code stops for input, and is handed what
 * is on screen *at that moment*. That snapshot is the assertion this whole
 * file exists to make: it is taken inside the client's control-channel
 * handler, so nothing about the test's own scheduling can make it look better
 * than it is.
 */
async function streamLoad(
  source: string, filename: string,
  onAsk: (paintedSoFar: readonly (string | null)[]) => string | null
): Promise<{
  painted: (string | null)[];
  loaded: FileLoaded;
  order: InOrder<StatementOutcome>;
}> {
  const painted: (string | null)[] = [];
  const above = new PaintedAbove();
  const order = new InOrder<StatementOutcome>((outcome) => {
    painted.push(paintOutcome(above, outcome));
  });

  const client = new KernelClient({
    resolvePython: async () => 'python3',
    kernelPath: KERNEL,
    onInput: async () => onAsk([...painted]),
  });
  try {
    const loaded = await client.request(
      { op: 'eval_file', source, filename, allow_stdin: true },
      (frame) => order.offer(frame.index, frame.outcome)
    ) as FileLoaded;
    // Whatever the frames did not deliver, exactly as `evaluateFile` does it.
    order.settle(loaded.results);
    return { painted, loaded, order };
  } finally {
    client.dispose();
  }
}

test('the lines above a prompt are already painted when the box opens', async () => {
  // The ticket, end to end, through the real kernel over both real pipes.
  //
  // The maintainer's report: *"the lines before that line which were evaled
  // should already have their inline values displayed"*. Before this they were
  // not -- every outcome was collected and returned in one response, so a load
  // that stopped on `input()` had run everything above it and shown none of
  // it. The reader was asked to type a value into a program whose behaviour so
  // far was invisible, which is also why marking the blocked line harder was
  // never the fix: prominence is contrast, and there was nothing on screen to
  // contrast against.
  let whenAsked: readonly (string | null)[] | undefined;

  const source = [
    "greeting = 'hello'",
    'count = 3',
    'print(greeting * count)',
    "name = input('who? ')",
    'shouted = name.upper()',
  ].join('\n') + '\n';

  const { painted, loaded } = await streamLoad(
    source, '/tmp/evalens-streamed.py',
    (paintedSoFar) => {
      whenAsked = paintedSoFar;
      return 'Ada';
    });

  assert.deepEqual(whenAsked, [
    "greeting: 'hello'",
    'count: 3',
    'printed: hellohellohello',
  ], 'every statement above the prompt, in file order, before it was asked');

  assert.deepEqual(painted, [
    "greeting: 'hello'",
    'count: 3',
    'printed: hellohellohello',
    // The prompt itself is what the statement printed, so it is on the line
    // beside the answer -- which is right: `who?` is code output like any
    // other, and the reader sees the question next to what they said to it.
    `name: 'Ada'${GAP}printed: who?`,
    "shouted: 'ADA'",
  ], 'and the two below it once the answer let them run');
  assert.equal(loaded.ran, 5);
});

test('a statement below the prompt is painted only once it has run', async () => {
  // Design rule 1, in the shape it takes here: an absent annotation is the
  // only honest thing to put beside a line that has not run. The failure to
  // avoid is a line below the prompt looking as though it produced nothing.
  let whenAsked: readonly (string | null)[] | undefined;

  const source = [
    'first = 1',
    "answer = input('? ')",
    'second = 2',
    'third = 3',
  ].join('\n') + '\n';

  await streamLoad(source, '/tmp/evalens-below.py', (paintedSoFar) => {
    whenAsked = paintedSoFar;
    return 'x';
  });

  assert.deepEqual(whenAsked, ['first: 1'],
    'nothing at all for the three statements that had not finished');
});

test('a streamed load paints exactly what the batched one did', async () => {
  // The regression that would be invisible otherwise. Repeat suppression reads
  // what is painted above, so it is a function of the order the statements
  // reach it -- and painting them as they arrive is a new order. If the two
  // paths ever disagreed, the difference would be a *missing* annotation,
  // which looks exactly like a statement that had nothing to say.
  const client = connect();
  const source = [
    'inventory = {"apples": 3, "pears": 5}',
    'print(inventory.get("bananas", 0))',
    'print(list(inventory.items()))',
    'inventory["apples"] = 4',
    'print("apples" in inventory)',
    'total = sum(inventory.values())',
  ].join('\n') + '\n';

  const batched = await paintLoad(client, source, '/tmp/evalens-batch.py');
  client.dispose();

  const { painted } = await streamLoad(
    source, '/tmp/evalens-batch.py', () => null);

  assert.deepEqual(painted, batched);
});

test('a load with no control channel still paints the whole file', async (t) => {
  // A kernel spawned with three pipes hears nothing and says nothing on the
  // channel that does not exist, so every statement arrives in `results` and
  // the gate paints all of them, in order. This is the behaviour the streaming
  // path is an addition to rather than a replacement for -- and it is the
  // fallback a lost frame degrades to.
  const client = connect();
  t.after(() => client.dispose());

  const source = 'a = 1\nb = a + 1\nc = b + 1\n';
  const painted: (string | null)[] = [];
  const above = new PaintedAbove();
  const order = new InOrder<StatementOutcome>((outcome) => {
    painted.push(paintOutcome(above, outcome));
  });

  const loaded = await client.request({
    op: 'eval_file', source, filename: '/tmp/evalens-batchonly.py',
    allow_stdin: false,
  }) as FileLoaded;
  order.settle(loaded.results);

  assert.deepEqual(painted, ['a: 1', 'b: 2', 'c: 3']);
  assert.equal(order.interrupted, false);
});
