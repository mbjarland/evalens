import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { EVALUATE_AT_CURSOR, EVALUATE_WHEN, evaluateKey } from '../keybindings';

const root = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

interface ManifestKeybinding {
  readonly command: string;
  readonly key: string;
  readonly mac?: string;
  readonly when?: string;
}

const keybindings: ManifestKeybinding[] = manifest.contributes?.keybindings ?? [];

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

test('the default stays on ctrl/cmd+enter', () => {
  // AREPL owns this key too, and the fix for that is a user keybinding, not a
  // different default: ctrl/cmd+enter is what Calva uses, what AREPL uses,
  // and what this audience's fingers know. Ceding it would trade a solvable
  // collision for a permanently worse default.
  const binding = keybindings.find((b) => b.command === EVALUATE_AT_CURSOR);
  assert.ok(binding, `${EVALUATE_AT_CURSOR} has no keybinding`);
  assert.equal(binding.key, evaluateKey('other'));
  assert.equal(binding.mac, evaluateKey('mac'));
});

test('the offered fix repeats the manifest context exactly', () => {
  // The user keybinding Evalens hands out has to behave like the default it
  // replaces. If the manifest's `when` is edited and this constant is not,
  // the fix quietly starts binding a different context.
  const binding = keybindings.find((b) => b.command === EVALUATE_AT_CURSOR);
  assert.equal(binding?.when, EVALUATE_WHEN);
});

test('activation is scoped, not eager', () => {
  const events: string[] = manifest.activationEvents ?? [];
  assert.ok(!events.includes('*'),
    'activating on * makes every VS Code window pay for this extension');
  assert.ok(events.includes('onLanguage:python'), 'expected onLanguage:python');
});
