import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The smoke test for `bin/audit-corpus.js`, which is the thing that measures
 * whether this extension is getting better.
 *
 * A measuring instrument nobody tests rots quietly and then reports a number
 * that looks like progress. So this runs the harness end to end -- a real
 * Python kernel, over both its pipes, rendering through the compiled renderer
 * -- against a fixture small enough that every count in it can be reasoned
 * about by hand.
 *
 * The fixture is eight statements chosen to land one in each bucket the
 * harness distinguishes, because a harness that reports a total and gets the
 * split wrong is worse than one that reports nothing. It is written to a
 * temporary directory rather than committed: a corpus file in `src/test`
 * would be a Python file the packaging rules have to know about, for no gain.
 */

const root = path.resolve(__dirname, '..', '..');
const harness = path.join(root, 'bin', 'audit-corpus.js');

/**
 * One statement per bucket, and nothing else.
 *
 * - `x = [1, 2]` and `x.append(3)` paint a value; the second is the mutating
 *   call whose `None` must give way to the name it changed.
 * - `print("hello")` must paint its output rather than `=> None`, which is
 *   the whole of what #11 bought and the first thing a regression would take
 *   back.
 * - `y = None` is a name genuinely bound to `None`, which is a fact and not
 *   the defect the `=> None` count is about.
 * - `if d:` says only `d: 1`, already painted a line above, so the whole
 *   annotation is a repeat.
 * - `def f(a):` says only what the line says, so it restates.
 * - `pass` ran and has nothing to report at all.
 */
const FIXTURE = [
  'x = [1, 2]',
  'x.append(3)',
  'print("hello")',
  'y = None',
  'd = 1',
  'if d:',
  '    pass',
  '',
  '',
  'def f(a):',
  '    return a',
  '',
  '',
  'pass',
  '',
].join('\n');

interface FileReading {
  readonly file: string;
  readonly failed: string | null;
  readonly statements: number;
  readonly ran: number;
  readonly errored: number;
  readonly painted: number;
  readonly noneBare: number;
  readonly noneLabelled: number;
  readonly silent: number;
  readonly silentNothingToSay: number;
  readonly suppressedRepeat: number;
  readonly suppressedRestates: number;
}

interface Reading {
  readonly corpus: string;
  readonly total: FileReading;
  readonly files: readonly FileReading[];
}

/** Run the harness over a one-file corpus and read back what it recorded. */
function audit(): { reading: Reading; stdout: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalens-audit-'));
  const json = path.join(dir, 'reading.json');
  try {
    fs.writeFileSync(path.join(dir, 'sample.py'), FIXTURE);
    const stdout = execFileSync(
      process.execPath, [harness, '--corpus', dir, '--json', json],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return {
      reading: JSON.parse(fs.readFileSync(json, 'utf8')) as Reading,
      stdout,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const { reading, stdout } = audit();
const sample = reading.files[0];

test('the harness drives the real kernel over a whole file', () => {
  assert.equal(reading.files.length, 1);
  assert.equal(sample.failed, null,
    'the fixture did not load -- is python3 on the PATH?');
  assert.equal(sample.statements, 8);
  assert.equal(sample.ran, 8);
  assert.equal(sample.errored, 0);
});

test('every statement that ran is either painted or accounted for', () => {
  // The invariant that makes the report readable: nothing falls off the
  // bottom. A statement that ran was painted, or one of the three reasons
  // below says why it was not.
  assert.equal(sample.painted + sample.silent, sample.ran);
  assert.equal(
    sample.silentNothingToSay + sample.suppressedRepeat
      + sample.suppressedRestates,
    sample.silent);
});

test('the totals are the sum of the rows they sit under', () => {
  // Filed as a test because the recorded baseline in #77 usability-baseline
  // failed it: its stated totals of 467 and 450 do not equal the 432 and 416
  // its own per-file rows add up to, which is exactly the kind of error that
  // makes a "measure it, do not eyeball it" ticket useless.
  const keys = ['statements', 'ran', 'errored', 'painted', 'silent'] as const;
  for (const key of keys) {
    assert.equal(
      reading.total[key],
      reading.files.reduce((count, file) => count + file[key], 0),
      `the ${key} total does not match its rows`);
  }
});

test('a print paints what it printed, not the None it evaluated to', () => {
  // The single most valuable thing the corpus reading measures: 160 lines of
  // the course said only `=> None`, and nearly all of them were `print(...)`
  // calls whose captured output the renderer threw away.
  assert.equal(sample.noneBare, 0);
  assert.match(stdout, /whole annotation is => None: 0/);
});

test('a name bound to None is counted apart from a bare => None', () => {
  // `y = None` is a fact about the namespace. Folding it into the `=> None`
  // count would make a fix and a regression move the same number the same
  // way, which is the one thing a measurement may not do.
  assert.equal(sample.noneLabelled, 1);
});

test('each reason a line stayed empty is counted separately', () => {
  assert.equal(sample.suppressedRepeat, 1, 'the `if d:` repeat');
  assert.equal(sample.silentNothingToSay, 1, 'the bare `pass`');
});

test('a definition is no longer suppressed for restating its own line', () => {
  // #87. `def f(a)` beside `def f(a):` is the same characters and a different
  // claim -- the line says what happens when it runs, the annotation says it
  // has run -- so the whole family paints and the fixture's `def` is counted
  // as painted rather than as a restatement.
  //
  // The restatement bucket is now expected to be empty, and that is worth
  // asserting rather than deleting: the guard still exists and still runs, so
  // a change that made it start firing again would be a silent regression to
  // the behaviour #87 was filed against.
  assert.equal(sample.suppressedRestates, 0);
});

test('the load cap the harness applies is the one the extension applies', () => {
  // The harness cannot import the constant: it is module-private in
  // `evaluate.ts`, and exporting it would mean editing a file to suit a
  // measurement. So it is copied, and pinned here -- a copy nothing checks is
  // a number that silently stops describing the product.
  const capOf = (file: string): string | undefined =>
    /MAX_LOAD_ANNOTATIONS = (\d+)/
      .exec(fs.readFileSync(path.join(root, file), 'utf8'))?.[1];
  const extension = capOf(path.join('src', 'evaluate.ts'));
  assert.ok(extension, 'evaluate.ts no longer declares MAX_LOAD_ANNOTATIONS');
  assert.equal(capOf(path.join('bin', 'audit-corpus.js')), extension);
});

test('the corpus defaults to somewhere inside the repository', () => {
  // So the harness runs for anyone who clones this. The maintainer's course
  // is passed in with `--corpus` and is deliberately not committed.
  const source = fs.readFileSync(harness, 'utf8');
  assert.match(source, /corpus: path\.join\(ROOT, 'examples'\)/);
  assert.ok(fs.existsSync(path.join(root, 'examples')));
});
