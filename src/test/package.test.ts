import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

/**
 * What `npm run package` would put in the `.vsix`, asked of the same tool
 * that builds it.
 *
 * `.vscodeignore` is a list of globs with no feedback loop: a directory added
 * to the repository is shipped by default, and a rule that stops matching
 * fails silently. Both had already happened -- `examples/` and every
 * `__pycache__/*.pyc` left behind by a kernel test run were being packaged,
 * including the compiled bytecode of the test modules the file was written to
 * exclude. Asking `vsce` rather than re-implementing its glob semantics is
 * the point: the answer has to come from the thing that packages.
 */
const packaged: string[] = (() => {
  const vsce = path.join(root, 'node_modules', '.bin', 'vsce');
  assert.ok(fs.existsSync(vsce),
    'vsce is not installed; run npm ci -- the packaged file list is untestable without it');
  return execFileSync(vsce, ['ls'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
})();

test('the kernel ships', () => {
  // Without these the extension installs, activates, and can evaluate
  // nothing: the TypeScript spawns an interpreter on a script that is not
  // there. It is the one omission that turns the whole package inert, and it
  // is invisible until someone installs the .vsix on a machine.
  for (const file of ['kernel/evalens_kernel.py', 'kernel/resolver.py',
    'kernel/loops.py']) {
    assert.ok(packaged.includes(file), `${file} is missing from the package`);
  }
});

test('the entry point ships', () => {
  assert.ok(packaged.includes(manifest.main.replace(/^\.\//, '')),
    `${manifest.main} is missing from the package`);
});

test('the licence ships', () => {
  // `license` in the manifest with no file behind it is what vsce warns
  // about, and what a marketplace listing shows as unlicensed.
  assert.ok(packaged.includes('LICENSE'), 'LICENSE is missing from the package');
  assert.equal(manifest.license, 'MIT');
});

test('nothing that is not the extension ships', () => {
  // Everything here is either dead weight in a download or something that
  // should never leave the repository. The kernel's own tests are the sharp
  // case: they sit in the directory that must ship, so the rule keeping them
  // out is one glob away from being the rule that ships them.
  const forbidden: ReadonlyArray<readonly [string, RegExp]> = [
    ['the kernel test modules', /^kernel\/test_/],
    ['TypeScript source', /^src\//],
    ['compiled tests', /^out\/test\//],
    ['documentation', /^docs\//],
    ['examples', /^examples\//],
    ['the prototype', /^prototype\//],
    ['dependencies', /^node_modules\//],
    ['Python bytecode', /(^|\/)__pycache__\/|\.pyc$/],
    ['source maps', /\.map$/],
  ];

  for (const [what, pattern] of forbidden) {
    const shipped = packaged.filter((file) => pattern.test(file));
    assert.deepEqual(shipped, [], `${what} is in the package`);
  }
});

test('npm run package is the one command that builds it', () => {
  // A remembered incantation is a command nobody but its author can run.
  assert.equal(manifest.scripts?.package, 'vsce package');
  // vsce runs this itself before packaging, so a stale `out/` cannot ship.
  assert.equal(manifest.scripts?.['vscode:prepublish'], 'npm run compile');
});

// Walkthrough media is installed product content, unlike repository demos.
test('every walkthrough instruction and exercise ships in the VSIX', () => {
  for (const walkthrough of manifest.contributes.walkthroughs ?? []) {
    for (const step of walkthrough.steps) {
      assert.ok(packaged.includes(step.media.markdown), step.media.markdown);
      const exercise = `media/learning/${step.id}.py`;
      assert.ok(packaged.includes(exercise), exercise);
      const markdown = fs.readFileSync(path.join(root, step.media.markdown), 'utf8');
      const images = [...markdown.matchAll(/!\[([^\n]*?)\]\(([^)\n]+)\)/g)];
      assert.ok(images.length > 0, `${step.id} has no rendered example`);
      for (const [, alt, relative] of images) {
        assert.ok(alt.trim(), `${relative} needs alternative text`);
        // VS Code's native walkthrough image rewriting turns an alt containing
        // Python list brackets into an empty image source (#191 Host review).
        assert.doesNotMatch(alt, /[\[\]]/, `${relative}: use words for lists in image alt text`);
        const image = path.posix.join(path.posix.dirname(step.media.markdown), relative);
        assert.ok(packaged.includes(image), `${image} is missing from the package`);
        const png = fs.readFileSync(path.join(root, image));
        assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], image);
        assert.equal(png.toString('ascii', 12, 16), 'IHDR', image);
        assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0,
          `${image} has no drawable image dimensions`);
      }
    }
  }
  assert.ok(packaged.includes('out/learning.js'));
});
