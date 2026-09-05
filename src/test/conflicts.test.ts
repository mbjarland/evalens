import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '..', '..');

/**
 * Files worth reading. Everything tracked by git, minus the binaries -- a
 * marker can only be a defect in something a person reads or a machine parses.
 */
const TEXT = /\.(md|ts|js|py|json|jsonc|yml|yaml|sh|txt)$/;

/**
 * A conflict marker, anchored to the start of a line.
 *
 * Seven identical characters at column zero is not something anyone writes on
 * purpose, which is what makes this safe to assert across every file at once
 * rather than maintaining a list of exceptions. The `=======` form is
 * deliberately not matched on its own: a Markdown setext heading underline is
 * exactly that, and flagging every document with one would make this test
 * something people learn to ignore.
 */
const MARKER = /^(<{7}|>{7})(?: |$)/m;

function tracked(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\0').filter((f) => f !== '' && TEXT.test(f));
}

test('no tracked file contains a git conflict marker', () => {
  // Filed as #103 after markers reached master inside README.md and were
  // packaged into a .vsix handed to a real user. Every suite passed the whole
  // time: the TypeScript compiler never reads Markdown, the Python suite
  // never reads TypeScript, and nothing at all read the README. A merge is
  // the one moment this repository routinely produces broken text, and until
  // now nothing looked.
  const offenders: string[] = [];
  for (const file of tracked()) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const found = MARKER.exec(text);
    if (found) {
      const line = text.slice(0, found.index).split('\n').length;
      offenders.push(`${file}:${line}  ${found[0].trim()}`);
    }
  }
  assert.deepEqual(offenders, [],
    `conflict markers left in tracked files:\n  ${offenders.join('\n  ')}`);
});

test('the marker pattern catches what it is for and nothing else', () => {
  // A test asserting an absence is worthless unless the detector works, and
  // this one is easy to render inert by over-narrowing the pattern.
  assert.match('<<<<<<< HEAD', MARKER);
  assert.match('>>>>>>> abc1234 (a commit summary)', MARKER);
  assert.match('a line\n<<<<<<< HEAD\nmore', MARKER);

  // Not a marker: a setext heading underline, a horizontal rule, a diff, or
  // angle brackets that happen to start a line.
  assert.doesNotMatch('Heading\n=======\n', MARKER);
  assert.doesNotMatch('-------', MARKER);
  assert.doesNotMatch('>>> python prompt', MARKER);
  assert.doesNotMatch('<<< not seven', MARKER);
  assert.doesNotMatch('  <<<<<<< indented, so not a marker', MARKER);
});
