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

/**
 * VS Code's own `editor.background` for each theme kind, which is what an
 * annotation is actually read against. Hard-coded rather than derived: they
 * are the numbers the palette was measured against, and a test that read them
 * from somewhere else would silently start checking a different claim.
 */
const EDITOR_BACKGROUND: Record<string, string> = {
  dark: '#1f1f1f',
  light: '#ffffff',
  highContrast: '#000000',
  highContrastLight: '#ffffff',
};

/** WCAG relative luminance, which is what a contrast ratio is built from. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map(
    (at) => parseInt(hex.slice(at, at + 2), 16) / 255);
  const linear = channels.map(
    (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(one: string, other: string): number {
  const [high, low] = [luminance(one), luminance(other)].sort((a, b) => b - a);
  return (high! + 0.05) / (low! + 0.05);
}

function defaults(id: string): Record<string, string> {
  const found = (manifest.contributes?.colors ?? []).find(
    (colour: { id: string }) => colour.id === id);
  assert.ok(found, `${id} is not contributed`);
  return found.defaults;
}

/**
 * The three properties the palette was chosen for, in the order they were
 * solved for. Written as a test rather than only as a comment because a
 * plausible-looking hex is exactly the kind of edit that gets made by eye, and
 * by eye is how the three roles stopped being distinguishable in the first
 * place.
 */
test('values dominate both labels in every theme', () => {
  // A visible step in contrast, so the eye lands on what the program produced
  // before it lands on what this extension wrote around it.
  const value = defaults('evalens.resultForeground');
  const label = defaults('evalens.labelForeground');
  const output = defaults('evalens.outputLabelForeground');

  for (const [kind, background] of Object.entries(EDITOR_BACKGROUND)) {
    const above = contrast(value[kind]!, background);
    const labels = [['name', label], ['stream', output]] as const;
    for (const [name, chrome] of labels) {
      const below = contrast(chrome[kind]!, background);
      assert.ok(above > below,
        `${kind}: the ${name} label at ${below.toFixed(2)}:1 is not below the `
        + `value at ${above.toFixed(2)}:1`);
    }
  }
});

test('a label is dimmer than a value and still legible', () => {
  // 3:1 is the floor WCAG puts under large text and user-interface parts, and
  // it is roughly where VS Code puts its own deliberately-subordinate text.
  // Below it a label stops being subordinate and starts being unreadable.
  for (const id of ['evalens.labelForeground',
    'evalens.outputLabelForeground', 'evalens.resultForeground']) {
    for (const [kind, background] of Object.entries(EDITOR_BACKGROUND)) {
      const ratio = contrast(defaults(id)[kind]!, background);
      assert.ok(ratio >= 3,
        `${id} is ${ratio.toFixed(2)}:1 against the ${kind} background`);
    }
  }
});

test('the two labels are peers, separated by hue and not by brightness', () => {
  // The accessibility half of the decision. They differ only in hue, warm
  // against cool -- the blue-yellow axis, which is the one both protanopia and
  // deuteranopia leave intact. Separating them by brightness instead would
  // make one out-shout the other and read as a third level of hierarchy;
  // separating them by red-green would have collapsed for roughly one boy in
  // twelve in the class this is built for.
  const label = defaults('evalens.labelForeground');
  const output = defaults('evalens.outputLabelForeground');

  for (const kind of Object.keys(EDITOR_BACKGROUND)) {
    const between = contrast(label[kind]!, output[kind]!);
    assert.ok(between < 1.2,
      `${kind}: the two labels differ in luminance by ${between.toFixed(2)}, `
      + 'which reads as a hierarchy rather than as two kinds of one thing');
    assert.notEqual(label[kind], output[kind],
      `${kind}: the two labels are the same colour, so nothing separates them`);
  }
});
