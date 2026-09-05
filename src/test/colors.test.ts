import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

/**
 * A ThemeColor naming an id the manifest does not contribute resolves to
 * nothing and paints invisibly. Nothing fails, nothing logs -- the value is
 * simply not there, which reads as "the extension is broken" and is the
 * hardest kind of rendering bug to track down.
 */
test('every theme colour used in the source is contributed', () => {
  const contributed = new Set<string>(
    (manifest.contributes?.colors ?? []).map((c: { id: string }) => c.id));
  const source = fs.readFileSync(
    path.join(root, 'src', 'render', 'decorations.ts'), 'utf8');

  const used = [...source.matchAll(/^export const COLOR_\w+ = '([^']+)';$/gm)]
    .map((m) => m[1]!);

  assert.ok(used.length > 0, 'no theme colours found in decorations.ts');
  for (const id of used) {
    assert.ok(contributed.has(id),
      `${id} is used as a ThemeColor but not contributed in package.json`);
  }
});

test('every contributed colour has defaults for all four theme kinds', () => {
  for (const color of manifest.contributes?.colors ?? []) {
    for (const kind of ['dark', 'light', 'highContrast', 'highContrastLight']) {
      assert.ok(color.defaults?.[kind],
        `${color.id} has no ${kind} default; it will be invisible in that theme`);
    }
  }
});
