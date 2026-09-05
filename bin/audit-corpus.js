#!/usr/bin/env node
'use strict';

/**
 * Drive a whole corpus of Python files through the real kernel and count what
 * a reader would actually see.
 *
 * This exists because quality was being judged from screenshots. That found
 * real defects -- #68 through #74 all came out of one session of looking --
 * but a screenshot cannot say whether the tool is getting better, and it
 * cannot catch a regression at all. Design rule 10 says verify against
 * reality; this is the part of that which can be re-run.
 *
 * What makes the numbers worth anything is that nothing here is a fixture.
 * The kernel is spawned as a subprocess and spoken to over both its pipes by
 * the same `KernelClient` the extension uses; every response is turned into an
 * annotation by the same `annotationFor` rules `evaluate.ts` applies, passed
 * through the same `PaintedAbove` repeat rule, rendered by the same
 * `resultText`, and dropped by the same `restatesLine` check the decorator
 * makes at paint time. The compiled output is required rather than the source,
 * so a reading taken here is a reading of the code that ships.
 *
 * The one thing it cannot do is look at the screen. It knows the string that
 * would be painted and the range it would be painted at; it does not know that
 * a human found it legible. Design rule 11: that is stated rather than papered
 * over, and `--listings` exists so a human can read the whole corpus end to end
 * and form the other half of the judgement.
 *
 * None of the above can tell a right answer from a wrong one -- it counts
 * silence, and a wrong value paints exactly as loudly as a right one. #96 (an
 * annotation surviving on a line that had been commented out) and #92 (an
 * import naming one of three bindings) were both found by the maintainer's
 * eye, not by this file. So alongside the counts above, this harness also
 * asserts five properties of a painted annotation against the AST or the
 * buffer -- never against a recorded expected value, which would rot on the
 * first legitimate rendering change and call it a regression:
 *
 *   - an annotation beside a line that holds no statement (#96's class);
 *   - a line reporting fewer names than its statement bound (#92's class);
 *   - a value anchored inside a statement's body rather than its header,
 *     where the body opens with a comment (#93's class);
 *   - an annotation for a statement a partial load never reached;
 *   - a `0x` address in a painted annotation, already counted above and
 *     repeated here because the project has decided it is always wrong.
 *
 * Structural because none of them ask "is this the right value" -- only "is
 * this claim consistent with the file it is painted on."
 *
 * Usage:
 *
 *     node bin/audit-corpus.js [--corpus DIR] [--include GLOB] [options]
 *
 * The corpus defaults to `examples/` inside the repository, so the harness
 * runs for anyone who clones it. The maintainer's course is passed in with
 * `--corpus`, and is deliberately not committed.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Python must not leave `__pycache__` directories behind in a corpus it was
// only asked to read. A course directory audited from here is somebody's
// teaching material, and an audit that mutates what it measures is not one.
// Set before the kernel is spawned, since the child inherits it.
process.env.PYTHONDONTWRITEBYTECODE = '1';

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');

if (!fs.existsSync(path.join(OUT, 'kernel', 'client.js'))) {
  console.error(
    'bin/audit-corpus.js reads the compiled extension, and out/ is not built.\n'
    + 'Run `npm run compile` first.');
  process.exit(2);
}

const { KernelClient } = require(path.join(OUT, 'kernel', 'client.js'));
const {
  errorText, hasOutput, opensDefinition, printedFrom, restatesLine,
  resultText,
} = require(path.join(OUT, 'render', 'format.js'));
const { PaintedAbove } = require(path.join(OUT, 'render', 'repeats.js'));

const KERNEL = path.join(ROOT, 'kernel', 'evalens_kernel.py');

/**
 * The cap `evaluate.ts` puts on one load, mirrored rather than imported --
 * it is a module-private constant there, and the alternative to copying it is
 * changing a file another agent holds. A test pins the two together.
 */
const MAX_LOAD_ANNOTATIONS = 200;

/** VS Code eats ordinary spaces in a decoration, so painted text carries these. */
const NBSP = ' ';

// -- what a reader sees ------------------------------------------------------

/**
 * `evaluate.ts`'s `annotationFor`, minus the two fields only an editor can
 * fill in.
 *
 * `source` is dropped because it exists to compare against a later edit and
 * nothing here edits anything; `hover` is dropped because a hover is not
 * painted. Everything that decides *whether* a line gets an annotation and
 * *what text* it carries is kept, and kept in the same order, because the
 * whole value of this harness is that it does not have opinions of its own.
 */
function annotationFor(outcome) {
  if (!outcome.ok) {
    return outcome.range
      ? {
          range: outcome.range,
          ...(outcome.anchor === undefined ? {} : { anchor: outcome.anchor }),
          error: { type: outcome.error.type, message: outcome.error.message },
        }
      : undefined;
  }
  const printed = printedFrom(outcome.stdout, outcome.stderr);
  if (outcome.value === null && outcome.loop === undefined
      && !(outcome.names && outcome.names.length) && !hasOutput(printed)) {
    // It ran and has nothing to report: a `pass`, a `del`, an `if` that took
    // no branch worth naming. This is the bucket the silent count is really
    // about, so it is counted rather than merely skipped.
    return undefined;
  }
  return {
    range: outcome.range,
    ...(outcome.anchor === undefined ? {} : { anchor: outcome.anchor }),
    ...(outcome.value === null ? {} : { value: outcome.value }),
    display: outcome.display,
    ...(outcome.loop === undefined ? {} : { loop: outcome.loop }),
    ...(outcome.bindings === undefined ? {} : { bindings: outcome.bindings }),
    ...(outcome.names === undefined ? {} : { names: outcome.names }),
    ...(printed === undefined ? {} : { printed }),
    ...(outcome.more_names === undefined ? {} : { more: outcome.more_names }),
  };
}

/**
 * The text the decorator would paint for one annotation, or null where it
 * would paint nothing at all.
 *
 * The branch order is `Decorator.show`'s: a failure paints its message and is
 * never compared against its line, and a value paints only if it says
 * something the line does not already say.
 */
function paintedText(annotation, lineText) {
  if (annotation.error) {
    return {
      text: errorText(annotation.error.type, annotation.error.message),
      restates: false,
    };
  }
  const named = annotation.names ? annotation.names.length : 0;
  if (annotation.value === undefined && annotation.loop === undefined
      && named === 0 && !hasOutput(annotation.printed)) {
    return null;
  }
  const text = resultText({
    value: annotation.value === undefined ? null : annotation.value,
    display: annotation.display,
    loop: annotation.loop,
    names: annotation.names,
    bindings: annotation.bindings,
    printed: annotation.printed,
    more: annotation.more,
  });
  // Mirrors the guard in `decorations.ts`: a definition is exempt from the
  // restatement check, because `def greet(name)` beside `def greet(name):`
  // is the same characters and a different claim. Measuring the old rule
  // here would report a suppression the extension no longer performs.
  const restates = !opensDefinition(lineText)
    && restatesLine(text, lineText);
  return { text, restates };
}

/** Painted text with its non-breaking spaces put back, for reading and matching. */
function plain(text) {
  return text.split(NBSP).join(' ');
}

// -- structural falsehood checks ---------------------------------------------
//
// Everything above counts silence: a statement that ran and painted nothing.
// None of it can tell a wrong answer from a right one, because a wrong value
// paints exactly as loudly as a right one -- #96 (an annotation surviving on
// a commented-out line) and #92 (an import naming one of three bindings) were
// both found by reading a screenshot, not by this file.
//
// What follows are five properties checked against the AST or the buffer
// instead: not "is this the value we expect", which would rot the moment a
// legitimate rendering change altered a string this file had recorded, but
// "is this claim consistent with the file it is painted beside". A statement
// either does or does not sit under the line an annotation claims for it,
// regardless of what the renderer looks like next month.

/** A buffer line that cannot open a statement: nothing on it, or a comment. */
function isBlankOrComment(lineText) {
  const stripped = lineText.trim();
  return stripped === '' || stripped.startsWith('#');
}

/**
 * How many names each module-level import binds, per Python's own `ast` --
 * not `kernel/resolver.py`, which is exactly the module #92 found wrong.
 * Cross-checking a claim against the code that produced it proves nothing;
 * this asks the same question a second, independent way, so a check built on
 * it cannot be fooled by the bug it exists to catch.
 *
 * Scoped to the module body, matching `forms_in`: a nested import has no
 * outcome of its own to hold accountable, since nothing below the top level
 * is annotated. `from x import *` is excluded -- its name count is decided at
 * runtime by the exporting module, which is a different ticket with a
 * different answer, not an instance of this one.
 *
 * A file that fails to parse at all yields no import records rather than
 * throwing, so one broken lesson file costs this one check its answer for
 * that one file rather than the whole corpus its reading.
 */
function importBindings(source, pythonBin) {
  const script = [
    'import ast, json, sys',
    'try:',
    '    tree = ast.parse(sys.stdin.read())',
    'except SyntaxError:',
    '    print("[]")',
    '    sys.exit(0)',
    'out = []',
    'for node in tree.body:',
    '    if not isinstance(node, (ast.Import, ast.ImportFrom)):',
    '        continue',
    '    names = []',
    '    star = False',
    '    for alias in node.names:',
    '        if alias.name == "*":',
    '            star = True',
    '            continue',
    '        names.append(alias.asname or alias.name.split(".")[0])',
    '    out.append({',
    '        "line": (node.end_lineno or node.lineno) - 1,',
    '        "names": names,',
    '        "star": star,',
    '    })',
    'print(json.dumps(out))',
  ].join('\n');
  try {
    return JSON.parse(execFileSync(pythonBin, ['-c', script], {
      input: source, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }));
  } catch {
    return [];
  }
}

function emptyFalsehoods() {
  return {
    orphanAnchor: [],
    bodyCommentAnchor: [],
    importUndercount: [],
    unreachedPainted: [],
    address: [],
  };
}

/**
 * How a painted annotation reports `None`, if it does.
 *
 * The original complaint was 160 lines that said only `=> None`, and #11 has
 * since answered a large part of it by painting what the statement printed
 * instead. So the count has to be split, or a fix and a regression would move
 * the same number in the same direction:
 *
 * - `bare` is the original complaint exactly: the whole annotation is
 *   `=> None`, so the line carries nothing else at all.
 * - `labelled` is `x: None`, a binding that really does hold `None`. It names
 *   something and is a fact about the namespace, which is not the defect.
 * - `beside` is `None` sitting among other values on the line. Not a defect
 *   under any reading -- something else on the line is carrying the answer.
 *
 * **What cannot be decided here is whether the reader wanted something else.**
 * `d.get("missing")` really did evaluate to `None` and no other answer exists;
 * `queue.put(x)` also evaluates to `None` and the reader wanted the queue.
 * Telling those apart is a judgement about intent, and a number invented for
 * it would be worse than no number. So the raw bare count is what gets
 * reported, with the expressions that produced it listed for a human.
 */
function noneKind(text) {
  const said = plain(text);
  if (said === '=> None') {
    return 'bare';
  }
  if (/^[A-Za-z_][A-Za-z0-9_.]*: None$/.test(said)) {
    return 'labelled';
  }
  return /(^|[\s:])None($|[\s,])/.test(said) ? 'beside' : null;
}

/**
 * Rough shape of the expression a bare `=> None` came from.
 *
 * Only three buckets, and only because the first of them is a genuine
 * regression test: after #11 a `print(...)` that paints `=> None` means its
 * output was captured and then thrown away. The other two are for a human to
 * read, not for a threshold.
 */
function noneSource(display) {
  if (typeof display !== 'string') {
    return 'other';
  }
  if (/^print\s*\(/.test(display)) {
    return 'print';
  }
  return /\)\s*$/.test(display) ? 'call' : 'other';
}

// -- driving one file --------------------------------------------------------

/**
 * A tally for one file, and the per-line record behind it.
 *
 * Every count here is derived from the same walk, so the invariants hold by
 * construction rather than by arithmetic done twice: `ran + errored` is
 * `statements`, and `painted + silent` is `ran` plus the failures that had a
 * range to paint on.
 */
function emptyTally() {
  return {
    statements: 0,
    ran: 0,
    errored: 0,
    painted: 0,
    paintedErrors: 0,
    noneBare: 0,
    noneLabelled: 0,
    noneBeside: 0,
    /** Ran, and nothing at all ended up on the line. The number that matters. */
    silent: 0,
    /** ...because the statement had no value, no names and no output. */
    silentNothingToSay: 0,
    /** ...because every pair on it was already painted, unchanged, above. */
    suppressedRepeat: 0,
    /** ...because the annotation only restated the line it sits on. */
    suppressedRestates: 0,
    /** Painted, but with some names dropped as repeats. */
    trimmedRepeat: 0,
    /** Annotations the per-load cap refused to make. */
    capped: 0,
    /** Failures with no range, which cannot be painted anywhere. */
    errorsWithoutRange: 0,
    /** Painted text still carrying a memory address -- #73. */
    withAddress: 0,
    /** Painted text saying names were dropped by the kernel's cap -- #74, #85. */
    withMoreNames: 0,
    /** `input()` calls answered with end-of-file, since nobody is watching. */
    prompts: 0,
    /** Output written after the statement that started it returned -- #72. */
    lateOutput: 0,
    /** Painted beside a line that holds no statement of its own -- #96's class. */
    falsehoodOrphanAnchor: 0,
    /** A multi-name import reporting fewer names than it bound -- #92's class. */
    falsehoodImportUndercount: 0,
    /** A header-anchored value landing on a comment that opens its body -- #93. */
    falsehoodBodyCommentAnchor: 0,
    /** Painted for a statement a partial load never reached. */
    falsehoodUnreachedPainted: 0,
  };
}

/**
 * Walk one file's load response the way the extension walks it.
 *
 * The order is `evaluateFile`'s and it is load-bearing in one place: the cap
 * counts annotations that survived the repeat rule, and the repeat rule runs
 * in file order because that is the direction a reader's eye travels looking
 * for the value it is a repeat of.
 *
 * `partialAt` is `response.partial.truncated_at` when the file's parse broke
 * partway through, or `null` for an ordinary whole-file load; `imports` is
 * `importBindings`'s independent count of what each import statement bound.
 * Both are computed by the caller because both need information `measure`
 * does not otherwise touch -- the raw response's `partial` field, and a
 * second parse of the source text.
 */
function measure(response, lines, partialAt, imports) {
  const tally = emptyTally();
  const records = [];
  const bareNones = [];
  const silentKinds = new Map();
  const falsehoods = emptyFalsehoods();
  const importsByLine = new Map((imports || []).map((entry) => [entry.line, entry]));
  const painted = new PaintedAbove();
  let annotated = 0;

  tally.statements = response.statements;
  tally.ran = response.ran;

  for (const outcome of response.results) {
    const at = outcome.anchor !== undefined
      ? outcome.anchor
      : (outcome.range ? outcome.range.end.line : null);
    const record = {
      line: at,
      kind: outcome.kind || (outcome.ok ? 'unknown' : 'error'),
      ok: outcome.ok === true,
      display: outcome.display === undefined ? null : outcome.display,
      text: null,
      reason: null,
    };

    if (!outcome.ok) {
      tally.errored += 1;
    }

    if (annotated >= MAX_LOAD_ANNOTATIONS) {
      tally.capped += 1;
      record.reason = 'over the 200-annotation load cap';
      records.push(record);
      continue;
    }

    const annotation = annotationFor(outcome);
    if (annotation === undefined) {
      if (outcome.ok) {
        tally.silent += 1;
        tally.silentNothingToSay += 1;
        record.reason = 'ran, nothing to show';
        silentKinds.set(record.kind, (silentKinds.get(record.kind) || 0) + 1);
      } else {
        tally.errorsWithoutRange += 1;
        record.reason = 'failed with no range to paint on';
      }
      records.push(record);
      continue;
    }

    const fresh = painted.keep(annotation);
    if (fresh === undefined) {
      tally.silent += 1;
      tally.suppressedRepeat += 1;
      record.reason = 'repeat of a value already painted above';
      records.push(record);
      continue;
    }
    annotated += 1;
    if (fresh !== annotation) {
      tally.trimmedRepeat += 1;
    }

    const host = record.line !== null && lines[record.line] !== undefined
      ? lines[record.line]
      : '';
    const shown = paintedText(fresh, host);
    if (shown === null) {
      // Reachable only if the repeat rule empties an annotation that had
      // nothing but names on it, which it is written not to do. Counted rather
      // than asserted: a harness that throws on a corpus stops measuring it.
      tally.silent += 1;
      tally.silentNothingToSay += 1;
      record.reason = 'ran, nothing left to show';
      records.push(record);
      continue;
    }
    if (shown.restates) {
      tally.silent += 1;
      tally.suppressedRestates += 1;
      record.reason = 'restates the line it sits on';
      records.push(record);
      continue;
    }

    tally.painted += 1;
    if (fresh.error) {
      tally.paintedErrors += 1;
    }
    record.text = shown.text;
    records.push(record);

    const said = plain(shown.text);
    const none = noneKind(shown.text);
    if (none === 'bare') {
      tally.noneBare += 1;
      bareNones.push({
        line: record.line, display: record.display,
        source: noneSource(record.display),
      });
    } else if (none === 'labelled') {
      tally.noneLabelled += 1;
    } else if (none === 'beside') {
      tally.noneBeside += 1;
    }
    if (/\b0x[0-9a-f]{4,}\b/.test(said)) {
      tally.withAddress += 1;
      falsehoods.address.push({ line: record.line, text: said });
    }
    if (/…\+[\d,]+ more/.test(said)) {
      tally.withMoreNames += 1;
    }

    // -- the five structural falsehood checks --------------------------------
    // See the module docstring. Every one of these looks at what is actually
    // on screen (`record.line`, `host`, `said`) rather than at anything the
    // resolver claims about itself, because the resolver is exactly what #92
    // and #93 show can be wrong.

    if (isBlankOrComment(host)) {
      // #96's class: the line this annotation sits on holds no statement --
      // a comment, or nothing at all. `fresh.anchor` is present only for a
      // header-anchored compound statement (`_anchor_of` omits it otherwise),
      // so a plain assignment or call can only land here through a genuinely
      // orphaned line; a header-anchored one lands here through #93, and is
      // also reported below with that more specific diagnosis.
      tally.falsehoodOrphanAnchor += 1;
      falsehoods.orphanAnchor.push({ line: record.line, host });
      if (fresh.anchor !== undefined) {
        tally.falsehoodBodyCommentAnchor += 1;
        falsehoods.bodyCommentAnchor.push({ line: record.line, host });
      }
    }

    if (partialAt !== null && partialAt !== undefined
        && record.line !== null && record.line >= partialAt) {
      // A partial load's own `results` cannot include a statement past the
      // line parsing stopped at -- `parse_prefix` re-parses only the source
      // text kept, so no form beyond it exists to run. This asserts that
      // invariant rather than assuming it, so a change to the cut logic that
      // broke it would be caught here rather than by a reader noticing a
      // value beside code the load visibly never reached.
      tally.falsehoodUnreachedPainted += 1;
      falsehoods.unreachedPainted.push({ line: record.line, text: said, partialAt });
    }

    const importEntry = importsByLine.get(record.line);
    // A line carrying the `…+N more` footnote is not under-reporting, it is
    // disclosing. The per-line name cap elides on purpose and says so, which
    // is design rule 1 satisfied rather than broken -- whether the cap picks
    // the *right* names to keep is #85 and is a different question from
    // whether the line tells the truth. Counting it here would make this
    // check cry wolf on the one case that already behaves correctly, and a
    // detector that reports honest disclosure as falsehood stops being read.
    const discloses = /…\+\d+ more/.test(said);
    if (importEntry && !importEntry.star && importEntry.names.length > 1
        && !discloses) {
      const missing = importEntry.names.filter(
        (name) => !new RegExp(`\\b${name}\\b`).test(said));
      if (missing.length > 0) {
        tally.falsehoodImportUndercount += 1;
        falsehoods.importUndercount.push({
          line: record.line, bound: importEntry.names, missing, text: said,
        });
      }
    }
  }

  return { tally, records, bareNones, silentKinds, falsehoods };
}

/**
 * Load one file into a kernel of its own.
 *
 * A fresh interpreter per file rather than one for the corpus, for two
 * reasons that are both about the number being honest. A shared namespace
 * would let file 05 read a name file 04 bound, so a file that only works
 * second in the list would count as working. And a file that leaves a thread
 * running -- which one in this corpus does, on purpose -- would go on printing
 * into the next file's reading.
 */
async function auditFile(file, options) {
  const source = fs.readFileSync(file, 'utf8');
  const lines = source.split(/\r?\n/);
  const stderr = [];
  let prompts = 0;
  let lateOutput = 0;

  const client = new KernelClient({
    resolvePython: async () => options.python,
    kernelPath: KERNEL,
    onStderr: (text) => stderr.push(text),
    onStream: (_name, _text, unattributed) => {
      if (unattributed) {
        // Output the kernel could not attribute to any statement: a thread or
        // an executor still going after the statement that started it
        // returned. Counted because it is exactly what #72 is about and it
        // is invisible in the response.
        lateOutput += 1;
      }
    },
    onInput: async () => {
      prompts += 1;
      // End-of-file, because nobody is watching this run. It is what the
      // client does with no handler at all; saying it out loud is what lets
      // the count of prompts be reported, and `--answer` override it.
      return options.answer;
    },
  });

  const started = Date.now();
  let response;
  try {
    response = await withTimeout(
      client.request({
        op: 'eval_file',
        source,
        filename: file,
        allow_stdin: true,
      }),
      options.timeout,
      `${path.basename(file)} did not finish within ${options.timeout}ms`);
  } catch (error) {
    client.dispose();
    return {
      file,
      failed: error instanceof Error ? error.message : String(error),
      tally: emptyTally(),
      records: [],
      bareNones: [],
      silentKinds: new Map(),
      falsehoods: emptyFalsehoods(),
      stderr,
      ms: Date.now() - started,
    };
  }
  client.dispose();

  if (!response.ok) {
    // The whole file failed to parse. Nothing ran, so there is nothing to
    // count -- but the file is still in the corpus and must appear in the
    // table, or a file that stopped parsing would look like a file that
    // vanished.
    return {
      file,
      failed: `${response.error.type}: ${response.error.message}`,
      tally: emptyTally(),
      records: [],
      bareNones: [],
      silentKinds: new Map(),
      falsehoods: emptyFalsehoods(),
      stderr,
      ms: Date.now() - started,
    };
  }

  const partialAt = response.partial ? response.partial.truncated_at : null;
  // A second, independent parse of the same source text, so the import check
  // is never answered by the code it exists to distrust -- see
  // `importBindings`.
  const imports = importBindings(source, options.python);
  const measured = measure(response, lines, partialAt, imports);
  measured.tally.prompts = prompts;
  measured.tally.lateOutput = lateOutput;
  return {
    file,
    failed: null,
    ...measured,
    partial: partialAt,
    stderr,
    lines,
    ms: Date.now() - started,
  };
}

function withTimeout(work, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); });
  });
}

// -- reporting ---------------------------------------------------------------

function sum(tallies) {
  const total = emptyTally();
  for (const tally of tallies) {
    for (const key of Object.keys(total)) {
      total[key] += tally[key];
    }
  }
  return total;
}

function row(cells, widths) {
  return `| ${cells.map((cell, i) => String(cell).padEnd(widths[i])).join(' | ')} |`;
}

/**
 * The table, in the shape the ticket's baseline is already written in, so the
 * two can be read side by side without either being transcribed.
 */
function report(results) {
  const headers = [
    'file', 'stmts', 'ran', 'err', 'painted', '=> None', 'silent',
    'repeat', 'restates', 'no value',
  ];
  const rows = results.map((result) => {
    const t = result.tally;
    return [
      path.basename(result.file),
      result.failed ? '-' : t.statements,
      result.failed ? '-' : t.ran,
      result.failed ? '-' : t.errored,
      result.failed ? '-' : t.painted,
      result.failed ? '-' : t.noneBare,
      result.failed ? '-' : t.silent,
      result.failed ? '-' : t.suppressedRepeat,
      result.failed ? '-' : t.suppressedRestates,
      result.failed ? '-' : t.silentNothingToSay,
    ];
  });
  const total = sum(results.filter((r) => !r.failed).map((r) => r.tally));
  rows.push([
    '**total**', total.statements, total.ran, total.errored, total.painted,
    total.noneBare, total.silent, total.suppressedRepeat,
    total.suppressedRestates, total.silentNothingToSay,
  ]);

  const widths = headers.map((header, i) => Math.max(
    header.length, ...rows.map((cells) => String(cells[i]).length)));

  const lines = [
    row(headers, widths),
    `|${widths.map((width) => '-'.repeat(width + 2)).join('|')}|`,
    ...rows.map((cells) => row(cells, widths)),
  ];
  return lines.join('\n');
}

/**
 * The whole of a file as a reader would meet it: every source line, with the
 * annotation that would sit beside it, and the reason where there is none.
 *
 * The ticket asks for these to be kept, and the reason is worth restating: an
 * end-to-end read of one of these files is the closest thing to using the tool
 * that does not require an editor, and it has caught defects that every unit
 * test missed. What it still is not is a look at the screen.
 */
function listing(result) {
  if (result.failed) {
    return `${path.basename(result.file)}: ${result.failed}\n`;
  }
  const byLine = new Map();
  for (const record of result.records) {
    if (record.line === null) {
      continue;
    }
    byLine.set(record.line, record);
  }
  const width = Math.min(
    76, Math.max(...result.lines.map((line) => line.length), 20));
  const out = [`# ${path.basename(result.file)}`, ''];
  result.lines.forEach((line, index) => {
    const record = byLine.get(index);
    const shown = record === undefined
      ? ''
      : record.text !== null
        ? plain(record.text)
        : `· ${record.reason}`;
    out.push(shown === '' ? line : `${line.padEnd(width)}  ${shown}`);
  });
  return `${out.join('\n')}\n`;
}

// -- entry point -------------------------------------------------------------

/**
 * `*`, `?` and a character class. Enough for `*.py` and `[0-9]*.py`, and
 * deliberately nothing else -- a corpus is one flat directory of files, so
 * `**` would only be a way to sweep a `.venv` into the reading.
 */
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}$`);
}

function parseArguments(argv) {
  const options = {
    corpus: path.join(ROOT, 'examples'),
    include: '*.py',
    python: 'python3',
    listings: null,
    json: null,
    answer: null,
    timeout: 120000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--corpus': options.corpus = path.resolve(value); i += 1; break;
      case '--include': options.include = value; i += 1; break;
      case '--python': options.python = value; i += 1; break;
      case '--listings': options.listings = path.resolve(value); i += 1; break;
      case '--json': options.json = path.resolve(value); i += 1; break;
      case '--answer': options.answer = value; i += 1; break;
      case '--timeout': options.timeout = Number(value); i += 1; break;
      case '--help': case '-h': options.help = true; break;
      default:
        throw new Error(`unknown option: ${flag}`);
    }
  }
  return options;
}

const USAGE = `
Drive every Python file in a corpus through the real kernel and count what a
reader would see beside each line.

  node bin/audit-corpus.js [options]

  --corpus DIR     directory to audit (default: examples/ in this repository)
  --include GLOB   which files in it (default: *.py, top level only)
  --python BIN     interpreter to run the kernel with (default: python3)
  --answer TEXT    what to type at every input() prompt (default: end-of-file)
  --listings DIR   write <file>.annotated.txt, one per file
  --json FILE      write the whole reading as JSON
  --timeout MS     per-file limit (default: 120000)
`.trim();

async function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  if (!fs.existsSync(options.corpus)) {
    console.error(`no such corpus: ${options.corpus}`);
    return 2;
  }
  const pattern = globToRegExp(options.include);
  const files = fs.readdirSync(options.corpus)
    .filter((name) => pattern.test(name))
    .filter((name) => fs.statSync(path.join(options.corpus, name)).isFile())
    .sort()
    .map((name) => path.join(options.corpus, name));

  if (files.length === 0) {
    console.error(
      `nothing matching ${options.include} in ${options.corpus}`);
    return 2;
  }

  const results = [];
  for (const file of files) {
    results.push(await auditFile(file, options));
  }

  const measured = results.filter((result) => !result.failed);
  const total = sum(measured.map((result) => result.tally));

  console.log(`corpus: ${options.corpus}  (${files.length} files, `
    + `${options.include}, python ${options.python})`);
  console.log('');
  console.log(report(results));
  console.log('');
  console.log(`annotations painted:          ${total.painted}`
    + ` (${total.paintedErrors} of them errors)`);
  console.log(`  whole annotation is => None: ${total.noneBare}`);
  console.log(`  a name bound to None:        ${total.noneLabelled}`);
  console.log(`  None beside other values:    ${total.noneBeside}`);
  console.log(`ran but painted nothing:      ${total.silent}`);
  console.log(`  no value, no names, no output: ${total.silentNothingToSay}`);
  console.log(`  repeat of something above:     ${total.suppressedRepeat}`);
  console.log(`  restates its own line:         ${total.suppressedRestates}`);
  console.log(`names trimmed as repeats:     ${total.trimmedRepeat}`);
  console.log(`over the load cap:            ${total.capped}`);
  console.log(`failures with nowhere to go:  ${total.errorsWithoutRange}`);
  console.log(`painted with a 0x address:    ${total.withAddress}`);
  console.log(`painted with "…+N more":      ${total.withMoreNames}`);
  console.log(`input() prompts, EOF-ed:      ${total.prompts}`);
  console.log(`unattributed late output:     ${total.lateOutput}`);

  console.log('');
  console.log('structural falsehoods -- properties of a painted annotation');
  console.log('against the AST or the buffer, never against a recorded value:');
  console.log(`  on a line with no statement of its own (#96's class): `
    + `${total.falsehoodOrphanAnchor}`);
  console.log(`  anchored on the comment that opens its body (#93):    `
    + `${total.falsehoodBodyCommentAnchor}`);
  console.log(`  a multi-name import reporting too few names (#92):    `
    + `${total.falsehoodImportUndercount}`);
  console.log(`  painted for a statement a partial load never reached: `
    + `${total.falsehoodUnreachedPainted}`);
  console.log(`  a 0x address in a painted annotation:                 `
    + `${total.withAddress}`);

  const falsehoodSections = [
    ['orphanAnchor', "on a line with no statement of its own (#96's class)",
      (item) => (item.host.trim() === ''
        ? 'the line is blank'
        : `the line reads: ${item.host.trim()}`)],
    ['bodyCommentAnchor', 'anchored on the comment/blank line opening its body (#93)',
      (item) => `the line reads: ${item.host.trim() === '' ? '(blank)' : item.host.trim()}`],
    ['importUndercount', 'a multi-name import reporting too few names (#92)',
      (item) => `bound ${item.bound.join(', ')} -- painted "${item.text}", `
        + `missing ${item.missing.join(', ')}`],
    ['unreachedPainted', 'painted for a statement a partial load never reached',
      (item) => `painted "${item.text}", but the load stopped parsing at line `
        + `${item.partialAt + 1}`],
    ['address', 'a 0x address in a painted annotation',
      (item) => `painted "${item.text}"`],
  ];
  for (const [key, label, describe] of falsehoodSections) {
    const instances = measured.flatMap((result) => result.falsehoods[key].map(
      (item) => ({ file: path.basename(result.file), ...item })));
    if (instances.length > 0) {
      console.log('');
      console.log(`${label}:`);
      for (const item of instances) {
        console.log(`  ${item.file}:${item.line + 1}  ${describe(item)}`);
      }
    }
  }

  const bare = measured.flatMap((result) => result.bareNones.map(
    (each) => ({ ...each, file: path.basename(result.file) })));
  if (bare.length > 0) {
    console.log('');
    console.log('every bare `=> None`, so a human can judge what the reader'
      + ' wanted -- this harness cannot:');
    for (const each of bare) {
      console.log(`  ${each.file}:${each.line + 1}  [${each.source}] `
        + `${each.display}`);
    }
  }

  const kinds = new Map();
  for (const result of measured) {
    for (const [kind, count] of result.silentKinds) {
      kinds.set(kind, (kinds.get(kind) || 0) + count);
    }
  }
  if (kinds.size > 0) {
    console.log('');
    console.log('statements that ran with nothing to show, by kind:');
    for (const [kind, count] of [...kinds].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(4)}  ${kind}`);
    }
  }

  for (const result of results) {
    if (result.failed) {
      console.log('');
      console.log(`${path.basename(result.file)}: ${result.failed}`);
    }
    if (result.stderr.length > 0) {
      console.log('');
      console.log(`${path.basename(result.file)} -- kernel stderr:`);
      console.log(result.stderr.join('').trimEnd());
    }
  }

  if (options.listings) {
    fs.mkdirSync(options.listings, { recursive: true });
    for (const result of results) {
      fs.writeFileSync(
        path.join(options.listings,
          `${path.basename(result.file, '.py')}.annotated.txt`),
        listing(result));
    }
    console.log('');
    console.log(`listings written to ${options.listings}`);
  }

  if (options.json) {
    fs.writeFileSync(options.json, `${JSON.stringify({
      corpus: options.corpus,
      include: options.include,
      python: options.python,
      total,
      files: results.map((result) => ({
        file: path.basename(result.file),
        failed: result.failed,
        partial: result.partial === undefined ? null : result.partial,
        ms: result.ms,
        ...result.tally,
        bareNones: result.bareNones,
        silentKinds: Object.fromEntries(result.silentKinds),
        falsehoods: result.falsehoods,
      })),
    }, null, 2)}\n`);
  }

  return 0;
}

module.exports = {
  MAX_LOAD_ANNOTATIONS, annotationFor, auditFile, emptyFalsehoods, emptyTally,
  globToRegExp, importBindings, isBlankOrComment, listing, measure, noneKind,
  noneSource, paintedText, plain, report, sum,
};

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
