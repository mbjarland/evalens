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

/** One instance of a structural falsehood check, as the JSON reading carries it. */
interface FalsehoodLocations {
  readonly orphanAnchor: readonly { line: number; host: string }[];
  readonly bodyCommentAnchor: readonly { line: number; host: string }[];
  readonly importUndercount: readonly {
    line: number; bound: readonly string[]; missing: readonly string[];
    text: string;
  }[];
  readonly unreachedPainted: readonly {
    line: number; text: string; partialAt: number;
  }[];
  readonly address: readonly { line: number; text: string }[];
}

interface FileReading {
  readonly file: string;
  readonly failed: string | null;
  readonly partial: number | null;
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
  readonly withAddress: number;
  readonly falsehoodOrphanAnchor: number;
  readonly falsehoodImportUndercount: number;
  readonly falsehoodBodyCommentAnchor: number;
  readonly falsehoodUnreachedPainted: number;
  readonly falsehoods: FalsehoodLocations;
}

interface Reading {
  readonly corpus: string;
  readonly total: FileReading;
  readonly files: readonly FileReading[];
}

/**
 * Run the harness over a corpus of one or more files and read back what it
 * recorded. Defaults to the shared eight-statement `FIXTURE` under the name
 * every other test in this file already expects it under; a falsehood test
 * passes its own single-purpose fixture instead, because the properties
 * being checked need a source shaped a particular way and the shared fixture
 * is shaped to hit the silence buckets, not these.
 */
function audit(files: Readonly<Record<string, string>> = { 'sample.py': FIXTURE }):
    { reading: Reading; stdout: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalens-audit-'));
  const json = path.join(dir, 'reading.json');
  try {
    for (const [name, source] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), source);
    }
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

/**
 * #98: the checks above prove the harness counts silence correctly. None of
 * them can tell a wrong annotation from a right one -- #96 (an annotation
 * outliving the statement it described) and #92 (an import naming one of
 * three bindings) were both found by the maintainer reading a screenshot,
 * not by anything here.
 *
 * What follows drives five more fixtures through the same real kernel, each
 * built to exhibit one structurally-detectable falsehood -- a property of
 * the annotation against the AST or the buffer, never a recorded expected
 * value. Recording an expected annotation would rot the first time a
 * legitimate rendering change touched its text, and the failure would look
 * exactly like a regression; these instead assert things that stay true
 * regardless of what the renderer decides to say -- a statement's anchor is
 * either on a line with a statement on it or it is not, an import binds a
 * fixed number of names whatever the display says about them, an address is
 * an address.
 *
 * Where the underlying defect is real and currently unfixed on this branch
 * (#93, #92), the fixture below is the minimal shape from the actual
 * ticket, so a fix landing here is a fixture starting to fail rather than a
 * check nobody notices went quiet. Where no known bug can currently produce
 * a true positive through the real kernel (an annotation for a statement a
 * partial load never reached; the generic no-statement-line check on a
 * simple, non-compound statement), the check's predicate is additionally
 * exercised directly against a hand-built response, so a check that stopped
 * working could not hide behind "the corpus happens to be clean".
 */

// `bin/audit-corpus.js` is plain JS with no declaration file. Every other
// test in this file drives it as a subprocess; the two tests below instead
// `require` it directly, because they need to feed `measure` a hand-built
// response no real kernel run can produce -- see those tests for why.
const auditCorpus = require(harness) as {
  measure: (
    response: { statements: number; ran: number; results: readonly unknown[] },
    lines: readonly string[],
    partialAt: number | null,
    imports: readonly { line: number; names: readonly string[]; star: boolean }[],
  ) => { tally: Record<string, number>; falsehoods: FalsehoodLocations };
  importBindings: (source: string, pythonBin: string) =>
    readonly { line: number; names: readonly string[]; star: boolean }[];
};

test('the shared fixture is not itself a false positive', () => {
  // Every other test in this file reads `sample`; this is the one assertion
  // that the ordinary code it contains trips none of the five new checks.
  assert.equal(sample.falsehoodOrphanAnchor, 0);
  assert.equal(sample.falsehoodBodyCommentAnchor, 0);
  assert.equal(sample.falsehoodImportUndercount, 0);
  assert.equal(sample.falsehoodUnreachedPainted, 0);
  assert.equal(sample.withAddress, 0);
});

test('an annotation anchored on the comment opening its body is caught', () => {
  // #93, real and unfixed as of this commit: `_anchor_line` in
  // `kernel/resolver.py` finds a compound statement's header by looking at
  // the line above its first body statement, and a comment is invisible to
  // that walk -- so a body that opens with one pushes the anchor down onto
  // it. This is the minimal repro from the ticket.
  const source = [
    'd = 1',
    'if d:',
    '    # a comment',
    '    z = 9',
    '',
  ].join('\n');
  const { reading } = audit({ 'comment_body.py': source });
  const file = reading.files[0]!;
  assert.equal(file.failed, null);

  // The specific diagnosis: a header-anchored statement (`if` has an
  // `anchor` distinct from its `range`) whose anchor lands on the comment.
  assert.equal(file.falsehoodBodyCommentAnchor, 1);
  assert.equal(file.falsehoods.bodyCommentAnchor.length, 1);
  assert.equal(file.falsehoods.bodyCommentAnchor[0]!.line, 2);
  assert.equal(file.falsehoods.bodyCommentAnchor[0]!.host.trim(), '# a comment');

  // The general property #96 is about -- an annotation beside a line that
  // holds no statement at all -- is also true of this same instance, and is
  // reported under its own count so the two tickets stay two numbers.
  assert.equal(file.falsehoodOrphanAnchor, 1);
  assert.equal(file.falsehoods.orphanAnchor[0]!.line, 2);
});

test('a multi-name import reporting too few names is caught', () => {
  // #92 has since been fixed, so the corpus no longer supplies an instance
  // and the real renderer cannot be made to produce one. The check is
  // therefore proved the way the partial-load one is: `measure` driven
  // directly with an annotation built by hand that names only the first of
  // three bindings. A detector whose test depends on the bug still existing
  // stops testing anything the moment the bug is fixed, which is exactly
  // what happened to this test.
  const response = {
    statements: 1,
    ran: 1,
    results: [
      {
        ok: true, kind: 'ImportFrom', display: 'floor',
        value: 'def floor(x, /)',
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 34 } },
      },
    ],
  };
  const lines = ['from math import floor, ceil, sqrt'];
  // The bindings come from the real helper rather than a hand-written list,
  // so this also proves `importBindings` still counts three names -- it is
  // deliberately a separate parse from the resolver it exists to check.
  const imports = auditCorpus.importBindings(lines.join('\n') + '\n', 'python3');
  const measured = auditCorpus.measure(response, lines, null, imports);
  assert.equal(measured.tally.falsehoodImportUndercount, 1);
  const [found] = measured.falsehoods.importUndercount;
  assert.deepEqual([...found!.bound].sort(), ['ceil', 'floor', 'sqrt']);
  assert.deepEqual([...found!.missing].sort(), ['ceil', 'sqrt']);
  assert.equal(found!.line, 0);

  // And the fixed renderer must not trip it: the same import, driven through
  // the real kernel as it behaves today, names all three and is clean. This
  // half is what would catch a regression of #92.
  const live = audit({ 'multi_import.py': 'from math import floor, ceil, sqrt\n' })
    .reading.files[0]!;
  assert.equal(live.failed, null);
  assert.equal(live.falsehoodImportUndercount, 0,
    'a multi-name import names every binding since #92');

  // A single-name import must never trip this -- there is nothing to
  // under-report when there is only one name to begin with.
  const single = audit({ 'single_import.py': 'import os\n' }).reading.files[0]!;
  assert.equal(single.falsehoodImportUndercount, 0);

  // Nor must `from pkg import *`: its count is decided at runtime by the
  // exporting module and is a different ticket's answer, not this one's.
  const star = audit({ 'star_import.py': 'from os import *\n' }).reading.files[0]!;
  assert.equal(star.falsehoodImportUndercount, 0);
});

test('a 0x address in a painted annotation is caught, with its location', () => {
  // Already counted as `withAddress` -- #73 -- and moved into this group
  // because the project has decided an address is always wrong rather than
  // a matter of degree. A generator's default repr is a reliable source of
  // one; the address itself is not asserted, because the address is real
  // and different on every run -- only the shape and the line are.
  // #73 has since described generators by name rather than by address, so
  // the obvious live source of one is gone. The predicate is proved against
  // a hand-built annotation instead, for the same reason as the import check
  // above -- otherwise fixing the defect silently disarms its own detector.
  const response = {
    statements: 1,
    ran: 1,
    results: [
      {
        ok: true, kind: 'Assign', display: 'g',
        value: '<generator object gen at 0x104a3f2e0>',
        range: { start: { line: 3, character: 0 }, end: { line: 3, character: 9 } },
      },
    ],
  };
  const lines = ['def gen():', '    yield 1', '', 'g = gen()'];
  const measured = auditCorpus.measure(response, lines, null, []);
  assert.equal(measured.tally.withAddress, 1);
  assert.equal(measured.falsehoods.address.length, 1);
  assert.equal(measured.falsehoods.address[0]!.line, 3);
  assert.match(measured.falsehoods.address[0]!.text, /\b0x[0-9a-f]{4,}\b/);

  // The real kernel no longer produces one for this shape, which is #73's
  // whole point and is what a regression there would break.
  const live = audit({
    'address.py': 'def gen():\n    yield 1\n\ng = gen()\n',
  }).reading.files[0]!;
  assert.equal(live.failed, null);
  assert.equal(live.withAddress, 0,
    'a generator is described by name since #73, not by address');
});

test('nothing is painted for a statement a partial load never reached', () => {
  // A file whose tail does not parse is loaded as far as it parses --
  // `parse_prefix` returns a tree built only from the kept prefix, so no
  // form beyond `partial.truncated_at` exists for the loop in `eval_file`
  // to run. This fixture exercises that real path end to end and asserts
  // the count stays zero, which is what "the invariant holds" looks like
  // for a property the current implementation cannot violate by accident.
  const source = [
    'x = 1',
    'y = 2',
    'def broken(',
    '',
  ].join('\n');
  const { reading } = audit({ 'partial_load.py': source });
  const file = reading.files[0]!;
  assert.equal(file.failed, null);
  assert.ok(file.partial !== null, 'the broken def should have truncated the parse');
  assert.equal(file.painted, 2, 'x and y should still have loaded and painted');
  assert.equal(file.falsehoodUnreachedPainted, 0);
  assert.equal(file.falsehoods.unreachedPainted.length, 0);
});

test('the partial-load check would catch a genuine violation', () => {
  // The real kernel cannot be made to produce one -- see the test above --
  // so this drives `measure` directly with a response built by hand: two
  // outcomes, the second anchored on a line at or past a `partialAt` this
  // test chooses itself. Proof that the predicate fires, independent of
  // whether today's corpus ever gives it a reason to.
  const response = {
    statements: 2,
    ran: 2,
    results: [
      {
        ok: true, kind: 'Assign', display: 'x', value: '1',
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      },
      {
        ok: true, kind: 'Assign', display: 'y', value: '2',
        range: { start: { line: 5, character: 0 }, end: { line: 5, character: 5 } },
      },
    ],
  };
  const lines = ['x = 1', '', '', '', '', 'y = 2'];
  const measured = auditCorpus.measure(response, lines, 3, []);
  assert.equal(measured.tally.falsehoodUnreachedPainted, 1);
  assert.equal(measured.falsehoods.unreachedPainted.length, 1);
  assert.equal(measured.falsehoods.unreachedPainted[0]!.line, 5);
});

test('the no-statement-line check fires for a simple statement too, not '
  + 'only a compound one', () => {
  // #93 gives the corpus a real instance for a header-anchored (compound)
  // statement, so the end-to-end test above cannot by itself show that the
  // check is a general property rather than a restatement of #93's own
  // condition. This constructs a simple statement -- no `anchor` field at
  // all -- whose reported line is blank, and confirms the same check still
  // fires on the buffer property alone.
  const response = {
    statements: 1,
    ran: 1,
    results: [
      {
        ok: true, kind: 'Assign', display: 'x', value: '1',
        range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
      },
    ],
  };
  const lines = ['x = (', '    1', ''];
  const measured = auditCorpus.measure(response, lines, null, []);
  assert.equal(measured.tally.falsehoodOrphanAnchor, 1);
  assert.equal(measured.tally.falsehoodBodyCommentAnchor, 0,
    'a simple statement has no anchor field, so this is not #93\'s class');
  assert.equal(measured.falsehoods.orphanAnchor[0]!.line, 2);
});

test('import name counting is independent of the resolver it checks', () => {
  // `importBindings` asks Python's own `ast` rather than
  // `kernel/resolver.py`, which is exactly the module #92 found wrong --
  // cross-checking a claim against the code that produced it proves
  // nothing. A handful of shapes the resolver itself has to get right:
  // several names, an alias, a dotted import (binds only its top package),
  // and a star import (excluded; it is a different ticket's answer).
  const source = [
    'import os, sys',
    'import os.path as osp',
    'from a import (',
    '    b,',
    '    c as cc,',
    ')',
    'from x import *',
  ].join('\n');
  const found = auditCorpus.importBindings(source, 'python3');
  assert.deepEqual(found.map((entry) => entry.names), [
    ['os', 'sys'], ['osp'], ['b', 'cc'], [],
  ]);
  assert.deepEqual(found.map((entry) => entry.star), [false, false, false, true]);
});

test('a capped import that says "…+N more" is disclosure, not undercount', () => {
  // The name cap elides on purpose and says so on the line. That satisfies
  // design rule 1 rather than breaking it, so counting it as a falsehood
  // would make this check cry wolf on the one case already behaving well --
  // and a detector that reports honest disclosure stops being read. Whether
  // the cap keeps the *right* names is #85, a different question from
  // whether the line tells the truth.
  const response = {
    statements: 1,
    ran: 1,
    results: [
      {
        ok: true, kind: 'ImportFrom', display: null, value: null,
        names: [
          { name: 'Optional', value: 'typing.Optional' },
          { name: 'Union', value: 'class Union()' },
        ],
        more_names: 2,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 46 } },
      },
    ],
  };
  const lines = ['from typing import Optional, Union, TypeVar, Generic'];
  const imports = auditCorpus.importBindings(lines.join('\n') + '\n', 'python3');
  const measured = auditCorpus.measure(response, lines, null, imports);
  assert.equal(measured.tally.falsehoodImportUndercount, 0);

  // And the exemption must be the footnote doing the work, not the check
  // being dead: the same import with the same two names and *no* footnote is
  // a genuine undercount and is still caught.
  const silent = JSON.parse(JSON.stringify(response));
  delete silent.results[0].more_names;
  const caught = auditCorpus.measure(silent, lines, null, imports);
  assert.equal(caught.tally.falsehoodImportUndercount, 1);
});
