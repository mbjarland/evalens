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
 *
 * Every `COLOR_*` constant in `src/`, not only `decorations.ts`'s own: that
 * was this test's original scope, on the assumption that every theme colour
 * the extension owns is declared in that one file, which held only because
 * nothing checked it. `flash.ts` reuses `COLOR_REGION` and
 * `COLOR_FLASH_REGION` from there today, but nothing requires a colour's
 * declaration to live where `decorations.ts` happens to be, and widening the
 * search is what keeps that from becoming a second, quieter place a colour
 * could go uncontributed.
 *
 * This checks every *declaration*, not every *use*. A call-site scan --
 * following each `new vscode.ThemeColor(...)` back to what it was built from
 * -- was tried and does not hold up: `flash.ts`'s `typeFor(color: string)`
 * takes `color` as a parameter, so the identifier at that call site is
 * `color` itself, and resolving *that* to `COLOR_REGION` or
 * `COLOR_FLASH_REGION` needs tracing which `FlashStyle` a caller passed in --
 * real data flow, not something a regex can do without pretending to be a
 * type checker. Checking the declaration instead sidesteps needing to follow
 * that: every colour id the extension owns is declared once, as `export
 * const COLOR_NAME = '...'`, however many places go on to reuse the
 * constant. What this still cannot catch is a `ThemeColor` built straight
 * from a string literal with no `COLOR_*` constant behind it at all -- there
 * is no such call today (`git grep "new vscode.ThemeColor('"` finds none),
 * but a future one would paint invisibly without this test ever seeing it.
 */
test('every declared COLOR_* constant is contributed', () => {
  const contributed = new Set<string>(
    (manifest.contributes?.colors ?? []).map((c: { id: string }) => c.id));

  const files = fs.readdirSync(path.join(root, 'src'), { recursive: true })
    .filter((f): f is string => typeof f === 'string' && f.endsWith('.ts')
      && !f.startsWith('test'));

  const declared = new Map<string, string>();
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, 'src', file), 'utf8');
    for (const match of source.matchAll(/^export const COLOR_\w+ = '([^']+)';$/gm)) {
      declared.set(match[1]!, file);
    }
  }

  assert.ok(declared.size > 0, 'no COLOR_* constant declared anywhere in src/');
  for (const [id, file] of declared) {
    assert.ok(contributed.has(id),
      `${file} declares "${id}" but package.json does not contribute it`);
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

/**
 * A colour's alpha channel, when it has one -- the last two hex digits of an
 * 8-digit value. Every default in this file without one (a plain 6-digit
 * colour) is fully opaque.
 */
function alpha(hex: string): number {
  return hex.length > 7 ? parseInt(hex.slice(-2), 16) : 255;
}

test('the stale tint is fainter than the evaluated one, not merely a ' +
  'different hue (#109)', () => {
  // The report this ticket was filed over: a stale chip stayed exactly as
  // loud as an evaluated one, because both painted the same tint at the
  // same strength. Locking in "fainter", not just "different", is what
  // stops a future edit from re-solving only the hue and reintroducing the
  // same defect under a new name.
  const tint = defaults('evalens.annotationTint');
  const staleTint = defaults('evalens.staleTint');
  for (const kind of Object.keys(EDITOR_BACKGROUND)) {
    assert.ok(alpha(staleTint[kind]!) < alpha(tint[kind]!),
      `${kind}: the stale tint is not fainter than the evaluated one`);
  }
});

test('the stale border is quieter than the evaluated border (#109)', () => {
  // The bar is the other half of the chip's chrome, and the ticket's
  // constraint is the same for both: the surface must recede, and the
  // value's own text -- untouched by either of these ids -- must not.
  const border = defaults('evalens.annotationBorder');
  const staleBorder = defaults('evalens.staleBorder');
  for (const [kind, background] of Object.entries(EDITOR_BACKGROUND)) {
    const evaluatedContrast = contrast(border[kind]!, background);
    const staleContrast = contrast(staleBorder[kind]!, background);
    assert.ok(evaluatedContrast >= 3,
      `${kind}: the evaluated accent must remain visible at 3:1 or better`);
    assert.ok(staleContrast < evaluatedContrast,
      `${kind}: the stale border (${staleContrast.toFixed(2)}:1) is not `
      + `quieter than the evaluated one (${evaluatedContrast.toFixed(2)}:1)`);
  }
});
