import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  EVALUATE_AND_ADVANCE, EVALUATE_AT_CURSOR, EVALUATE_WHEN, TOP_LEVEL_KEY,
  advanceKey, evaluateKey, evaluateKeys,
} from '../keybindings';

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

const atCursor = keybindings.filter((b) => b.command === EVALUATE_AT_CURSOR);

test('the default stays on ctrl/cmd+enter', () => {
  // AREPL owns this key too, and the fix for that is a user keybinding, not a
  // different default: ctrl/cmd+enter is what Calva uses, what AREPL uses,
  // and what this audience's fingers know. Ceding it would trade a solvable
  // collision for a permanently worse default.
  const binding = atCursor.find((b) => b.key === evaluateKey('other'));
  assert.ok(binding, `${EVALUATE_AT_CURSOR} has no ctrl+enter keybinding`);
  assert.equal(binding.mac, evaluateKey('mac'));
});

test('the top-level form key is bound to alt+enter, on every platform', () => {
  // `evaluateAtCursor` resolves the enclosing *top-level* statement, and
  // alt+enter is the key Calva puts the top-level form on -- so this is what
  // the semantics already said, not a workaround for the collision above. It
  // is not an escape from that collision either: AREPL's `extension.printDir`
  // sits here under the same `when`, which is why the offered fix covers both
  // keys. When the inner-form command lands it takes ctrl+enter, and none of
  // this has to be undone.
  const binding = atCursor.find((b) => b.key === TOP_LEVEL_KEY);
  assert.ok(binding, `${EVALUATE_AT_CURSOR} has no ${TOP_LEVEL_KEY} keybinding`);
  // No `mac` override, deliberately: alt is alt everywhere, and adding one
  // would be the same mistake that read Jupyter's missing override as absence.
  assert.equal(binding.mac, undefined);
});

test('the manifest binds exactly the keys the code hands out', () => {
  // The fix Evalens copies to the clipboard binds `evaluateKeys`. If the
  // manifest grows or loses a key without that list following, the fix either
  // misses a dead key or rebinds one nothing contests.
  assert.deepEqual(atCursor.map((b) => b.key).sort(),
    [...evaluateKeys('other')].sort());
  assert.deepEqual(
    atCursor.map((b) => b.mac ?? b.key).sort(),
    [...evaluateKeys('mac')].sort());
});

test('the offered fix repeats the manifest context exactly', () => {
  // The user keybinding Evalens hands out has to behave like the default it
  // replaces. If a manifest `when` is edited and this constant is not, the fix
  // quietly starts binding a different context -- on either key.
  assert.ok(atCursor.length > 0, `${EVALUATE_AT_CURSOR} has no keybinding`);
  for (const binding of atCursor) {
    assert.equal(binding.when, EVALUATE_WHEN, `${binding.key} binds a different context`);
  }
});

test('evaluate-and-advance is bound to ctrl/cmd+shift+enter', () => {
  // Pinned for the same reason the two above are: shift+enter is what the
  // convention wants and is claimed four times over in a Python file, so this
  // key is a decision rather than a default, and a later edit that quietly
  // moved it back onto the contested chord would present as a dead key.
  const advance = keybindings.filter((b) => b.command === EVALUATE_AND_ADVANCE);
  assert.equal(advance.length, 1, `${EVALUATE_AND_ADVANCE} has no keybinding`);
  assert.equal(advance[0].key, advanceKey('other'));
  assert.equal(advance[0].mac, advanceKey('mac'));
  // The same context as the evaluate keys: a command that behaves like
  // Evaluate at Cursor has to be live in exactly the places it is.
  assert.equal(advance[0].when, EVALUATE_WHEN);
});

test('the advance key is not shift+enter, on any platform', () => {
  // python.execSelectionInTerminal, python.execInREPL,
  // jupyter.execSelectionInteractive and jupyter.runcurrentcelladvance all
  // sit there in a Python file. Taking it would repeat the AREPL tie exactly.
  for (const key of [advanceKey('mac'), advanceKey('other')]) {
    assert.notEqual(key, 'shift+enter');
  }
});

test('the key is a keybinding, never a setting', () => {
  // VS Code rebinds any command from its own keybindings editor. A setting for
  // the key would be a worse copy of that, with its own precedence rules to
  // explain and no conflict view to show them in.
  const settings = Object.keys(manifest.contributes?.configuration?.properties ?? {});
  assert.ok(settings.length > 0, 'no settings contributed');
  for (const name of settings) {
    assert.doesNotMatch(name, /key(binding|board)?$/i,
      `${name} looks like a setting for a keybinding`);
  }
});

test('the evaluateFile keybinding uses the same context as evaluate', () => {
  // Not covered by any test above, which only ever filters `keybindings` down
  // to `EVALUATE_AT_CURSOR` and `EVALUATE_AND_ADVANCE` -- so a `when` typo or
  // a stale copy-paste on this third binding would ship silently.
  const evaluateFile = keybindings.filter((b) => b.command === 'evalens.evaluateFile');
  assert.equal(evaluateFile.length, 1, 'evalens.evaluateFile has no keybinding');
  assert.equal(evaluateFile[0]!.key, 'ctrl+alt+enter');
  assert.equal(evaluateFile[0]!.mac, 'cmd+alt+enter');
  assert.equal(evaluateFile[0]!.when, EVALUATE_WHEN,
    "evaluateFile's keybinding binds a different context than " +
    'evaluateAtCursor and evaluateAndAdvance do, which is either a ' +
    'deliberate divergence nothing documents or a drifted copy-paste');
});

test("the clearResults keybinding's when clause names the flag the code " +
  'actually sets', () => {
  // `HAS_ANNOTATIONS` lives in `render/annotations.ts`, which imports
  // `vscode` -- so it is read out of the source text here, the way
  // `audit.test.ts` reads `MAX_LOAD_ANNOTATIONS` out of `evaluate.ts`, rather
  // than imported. Importing it would require a `vscode` module to exist at
  // test time, which is exactly the gap #42 is about; `extension.test.ts`
  // carries the harness that supplies one where it is actually needed.
  const source = fs.readFileSync(
    path.join(root, 'src', 'render', 'annotations.ts'), 'utf8');
  const match = /^export const HAS_ANNOTATIONS = '([^']+)';$/m.exec(source);
  assert.ok(match, 'HAS_ANNOTATIONS not found in render/annotations.ts');
  const contextKey = match![1]!;

  const clearResults = keybindings.filter((b) => b.command === 'evalens.clearResults');
  assert.equal(clearResults.length, 1, 'evalens.clearResults has no keybinding');
  assert.ok(clearResults[0]!.when?.includes(contextKey),
    `evalens.clearResults's when clause "${clearResults[0]!.when}" does not ` +
    `reference ${contextKey}, the context key the code actually sets`);
});

test('activation is scoped, not eager', () => {
  const events: string[] = manifest.activationEvents ?? [];
  assert.ok(!events.includes('*'),
    'activating on * makes every VS Code window pay for this extension');
  assert.ok(events.includes('onLanguage:python'), 'expected onLanguage:python');
});
