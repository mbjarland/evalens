import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * README stills are generated, never drawn -- #113. These tests exist so
 * that a broken or forgotten regeneration fails `npm test` rather than
 * shipping: a missing `<img>` target is a broken listing on the
 * marketplace, and a spec edited without re-running `npm run stills` is a
 * picture that no longer matches the code it claims to show.
 *
 * `specHash` comes from `bin/stills-hash.js` rather than being reimplemented
 * here, on the same reasoning `readme.test.ts` already applies to
 * `keybindingSnippet`: two copies of the same check drift, and the one
 * inside the test is the one that silently stops meaning anything.
 * `bin/render-stills.js` itself cannot be required for this -- see that
 * file's own header -- so the hash lives in a module with no side effects
 * that both it and this test can share.
 */
const stillsHash = require('../../bin/stills-hash.js') as {
  specHash: (spec: Record<string, unknown>) => string;
};

const root = path.resolve(__dirname, '..', '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const stillsDir = path.join(root, 'docs', 'stills');
const specFiles = fs.readdirSync(stillsDir).filter((f) => f.endsWith('.json'));

/** Every `<img src="media/...">` the README references, in document order. */
function readmeImages(): string[] {
  const found: string[] = [];
  const re = /<img\s[^>]*src="(media\/[^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(readme)) !== null) {
    found.push(m[1]!);
  }
  return found;
}

test('every README image exists in the repo', () => {
  // The marketplace inlines README images from GitHub raw; one that 404s is
  // a broken listing, not a broken link a reader can shrug off.
  const images = readmeImages();
  assert.ok(images.length > 0, 'no <img src="media/..."> found in the README');
  for (const src of images) {
    assert.ok(fs.existsSync(path.join(root, src)),
      `README references "${src}", which does not exist in the repo`);
  }
});

test('docs/stills/ has at least one spec', () => {
  assert.ok(specFiles.length > 0, 'no specs found under docs/stills/');
});

test('every still spec has been rendered, and matches what it rendered', () => {
  // `render-stills.js` stamps a spec with the hash of its own content the
  // moment it renders it. A stamped hash that no longer matches the spec's
  // current content means the spec changed and nobody ran `npm run stills`
  // afterwards -- the forgotten regeneration this test exists to catch. It
  // reads content rather than mtimes on purpose: a fresh checkout can hand
  // every file the same mtime, or one derived from checkout order rather
  // than commit order, so mtime is not a bound CI can trust the way a hash
  // computed from the file's own bytes is.
  for (const file of specFiles) {
    const specPath = path.join(stillsDir, file);
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8')) as Record<string, unknown>;

    assert.equal(typeof spec.hash, 'string',
      `docs/stills/${file} has never been rendered -- run "npm run stills"`);
    assert.equal(stillsHash.specHash(spec), spec.hash,
      `docs/stills/${file} has changed since it was last rendered -- `
        + 'run "npm run stills"');

    assert.equal(typeof spec.output, 'string',
      `docs/stills/${file} has no "output" field`);
    const output = spec.output as string;
    assert.match(output, /\.png$/,
      `docs/stills/${file} must render to a .png -- the marketplace refuses `
        + 'SVG (vsce package.js:652)');
    assert.ok(fs.existsSync(path.join(root, output)),
      `docs/stills/${file} says it renders to "${output}", which does not `
        + 'exist -- run "npm run stills"');
  }
});

test('every rendered still is referenced by the README it illustrates', () => {
  // The inverse of the two checks above: a spec whose PNG nothing in the
  // README links to is a generator nobody has a reason to keep running,
  // quietly bit-rotting under docs/stills/ instead of failing loudly.
  const images = new Set(readmeImages());
  for (const file of specFiles) {
    const spec = JSON.parse(
      fs.readFileSync(path.join(stillsDir, file), 'utf8')) as { output?: string };
    assert.ok(spec.output && images.has(spec.output),
      `docs/stills/${file} renders to "${spec.output}", which no README `
        + '<img> references');
  }
});
