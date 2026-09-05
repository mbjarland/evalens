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

/**
 * The gutter takes an image, not a `ThemeColor`, so the three state markers
 * are files. A `gutterIconPath` pointing at a file that is not there paints
 * nothing and logs nothing -- the same silent failure as an uncontributed
 * colour, one directory over.
 */
test('every gutter marker icon exists, in both theme variants', () => {
  const source = fs.readFileSync(
    path.join(root, 'src', 'render', 'decorations.ts'), 'utf8');
  const markers = /^const MARKERS: readonly Marker\[\] = \[([^\]]+)\];$/m
    .exec(source)?.[1];
  assert.ok(markers, 'no MARKERS list found in decorations.ts');

  const names = [...markers.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  assert.equal(names.length, 3, 'expected evaluated, stale and error');

  for (const name of names) {
    for (const theme of ['dark', 'light']) {
      const icon = path.join(root, 'media', 'gutter', `${name}-${theme}.svg`);
      assert.ok(fs.existsSync(icon), `${icon} is missing`);
    }
  }
});

test('the marker icons ship in the package', () => {
  // .vscodeignore is a deny list, so an entry that swept up media/ would take
  // the icons out of the .vsix and out of nowhere else -- invisible until
  // somebody installs the published extension.
  const ignored = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
  assert.ok(!/^media/m.test(ignored), 'media/ is excluded from the package');
});

test('every contributed colour has defaults for all four theme kinds', () => {
  for (const color of manifest.contributes?.colors ?? []) {
    for (const kind of ['dark', 'light', 'highContrast', 'highContrastLight']) {
      assert.ok(color.defaults?.[kind],
        `${color.id} has no ${kind} default; it will be invisible in that theme`);
    }
  }
});
