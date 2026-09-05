import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The two things about the output channel that can only be checked as text.
 *
 * Both live in modules that import `vscode`, so this runner cannot load them
 * and has to read them instead. That is worth doing rather than skipping,
 * because both failures are silent at runtime: a hover link naming a command
 * that is not contributed does nothing at all when clicked, and a channel
 * shown without `preserveFocus` steals the cursor without anything logging
 * that it did.
 */
const root = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function source(...parts: string[]): string {
  return fs.readFileSync(path.join(root, 'src', ...parts), 'utf8');
}

/** Every source file except the tests, which are allowed to say anything. */
function extensionSources(): [string, string][] {
  return fs.readdirSync(path.join(root, 'src'), { recursive: true })
    .filter((file): file is string =>
      typeof file === 'string' && file.endsWith('.ts')
      && !file.startsWith('test'))
    .map((file) => [file, source(file)]);
}

test('the command the hover links to is one the manifest contributes', () => {
  const contributed = new Set<string>(
    (manifest.contributes?.commands ?? [])
      .map((command: { command: string }) => command.command));
  const linked = /^export const SHOW_OUTPUT = '([^']+)';$/m
    .exec(source('render', 'decorations.ts'))?.[1];

  assert.ok(linked, 'no SHOW_OUTPUT command id found in decorations.ts');
  assert.ok(contributed.has(linked),
    `${linked} is linked from the hover but not contributed in package.json`);
});

test('the output channel is only ever shown with the focus preserved', () => {
  // The decision the ticket turned on. A panel that takes the cursor puts the
  // answer somewhere other than the code -- which is the notebook's mistake
  // and the exact gap this project exists to close. Output goes on the line;
  // the channel is overflow, and reaching it must not cost the reader their
  // place in the file.
  let found = 0;
  for (const [file, text] of extensionSources()) {
    for (const call of text.matchAll(/\boutput\??\.show\(([^)]*)\)/g)) {
      found += 1;
      assert.equal(call[1]!.trim(), 'true',
        `${file} shows the output channel without preserveFocus`);
    }
  }
  assert.equal(found, 1, 'expected exactly one way to open the channel');
});

test('the one way to open it is a command the user asked for', () => {
  // Nothing auto-opens it, on any path: the single `show` is the body of the
  // command, reached from the palette or from the link on an annotation that
  // printed more than fits on the line.
  assert.match(source('extension.ts'),
    /registerCommand\(\s*'evalens\.showOutput',\s*\(\)\s*=>\s*\{\s*output\?\.show\(true\);\s*\}\s*\)/);
});
