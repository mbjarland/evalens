import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

/**
 * The manifest and the code declare the same things in two places, and
 * nothing at build time makes them agree. A command contributed in
 * package.json but never registered shows up in the palette and fails with
 * "command not found" when a user picks it -- a runtime failure for a
 * mismatch that is visible statically.
 */
test('every contributed command is registered in the source', () => {
  const declared: string[] =
    (manifest.contributes?.commands ?? []).map((c: { command: string }) => c.command);
  assert.ok(declared.length > 0, 'no commands contributed');

  const sources = fs.readdirSync(path.join(root, 'src'), { recursive: true })
    .filter((f): f is string => typeof f === 'string' && f.endsWith('.ts'))
    .map((f) => fs.readFileSync(path.join(root, 'src', f), 'utf8'))
    .join('\n');

  for (const id of declared) {
    assert.match(sources, new RegExp(`registerCommand\\(\\s*['"\`]${id}['"\`]`),
      `${id} is contributed in package.json but never registered`);
  }
});

test('main points at a file the build produces', () => {
  assert.ok(fs.existsSync(path.join(root, manifest.main)),
    `${manifest.main} does not exist -- did the compile run?`);
});

test('activation is scoped, not eager', () => {
  const events: string[] = manifest.activationEvents ?? [];
  assert.ok(!events.includes('*'),
    'activating on * makes every VS Code window pay for this extension');
  assert.ok(events.includes('onLanguage:python'), 'expected onLanguage:python');
});
