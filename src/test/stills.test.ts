import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Public screenshots are captured from the extension in native VS Code.
 * Their review manifest keeps each PNG tied to its fixture and recorded
 * dimensions. These checks catch broken links and replaced assets; a hash
 * does not prove a native capture or readable text. The release procedure
 * separately requires actual VS Code and Marketplace-width inspection.
 */
const root = path.resolve(__dirname, '..', '..');
const reviewDir = path.join(root, 'docs/reviews/196-marketplace-page-refresh');
const manifestPath = path.join(reviewDir, 'captures.json');
const documents = ['README.md', 'docs/user-guide.md'].map((file) => ({
  file,
  text: fs.readFileSync(path.join(root, file), 'utf8'),
}));

interface Capture {
  image: string;
  sha256: string;
  width: number;
  height: number;
  fixture: string;
  description: string;
}

function manifest(): { captureMethod: string; captures: Capture[] } {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

/** Resolve an image from the document that references it, not the cwd. */
function publicImages(): Set<string> {
  const images = new Set<string>();
  for (const { file, text } of documents) {
    const sources = [
      ...Array.from(text.matchAll(/<img\s[^>]*src="([^"]+)"/g), (m) => m[1]!),
      ...Array.from(text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g), (m) => m[1]!),
    ];
    for (const source of sources) {
      assert.doesNotMatch(source, /^(?:https?:|data:|\/)/,
        `${file}: public images must have a reviewed repository asset`);
      images.add(path.relative(root,
        path.resolve(root, path.dirname(file), source)).split(path.sep).join('/'));
    }
  }
  return images;
}

test('public documentation images and local links resolve in the repo', () => {
  const images = publicImages();
  assert.ok(images.size > 0, 'public documentation references no images');
  for (const image of images) {
    assert.ok(fs.existsSync(path.join(root, image)), `missing image: ${image}`);
  }
  for (const { file, text } of documents) {
    for (const match of text.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1]!;
      if (/^(?:https?:|#)/.test(target)) continue;
      const pathname = target.split('#')[0]!;
      assert.ok(fs.existsSync(path.resolve(root, path.dirname(file), pathname)),
        `${file}: missing local link target ${target}`);
    }
    // vsce rewrites Markdown links but leaves raw HTML hrefs relative to
    // the Marketplace host. That produced three broken example links.
    if (file === 'README.md') {
      for (const match of text.matchAll(/<a\s[^>]*href="([^"]+)"/g)) {
        assert.match(match[1]!, /^(?:https?:\/\/|#)/,
          'README raw HTML links must be absolute or in-page anchors');
      }
    }
  }
});

test('each native screenshot records an existing fixture and description', () => {
  const recorded = manifest();
  assert.equal(recorded.captureMethod, 'native-vscode');
  assert.ok(recorded.captures.length > 0, 'capture manifest is empty');
  const images = new Set<string>();
  for (const capture of recorded.captures) {
    assert.match(capture.image, /^media\/demo\/[a-z-]+\.png$/);
    assert.ok(!images.has(capture.image), `duplicate capture: ${capture.image}`);
    images.add(capture.image);
    assert.ok(capture.description.trim(), `${capture.image}: missing description`);
    assert.match(capture.fixture, /^fixtures\/[a-z0-9-]+\.py$/);
    assert.ok(fs.existsSync(path.join(reviewDir, capture.fixture)),
      `${capture.image}: missing fixture ${capture.fixture}`);
  }
});

test('public screenshot bytes and dimensions match the reviewed capture', () => {
  for (const capture of manifest().captures) {
    const png = fs.readFileSync(path.join(root, capture.image));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a',
      `${capture.image}: not a PNG`);
    assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
    assert.ok(capture.width > 0 && capture.height > 0);
    assert.equal(png.readUInt32BE(16), capture.width, `${capture.image}: width`);
    assert.equal(png.readUInt32BE(20), capture.height, `${capture.image}: height`);
    assert.equal(createHash('sha256').update(png).digest('hex'), capture.sha256,
      `${capture.image}: image changed after its capture was recorded`);
  }
});

test('every public demo image has capture evidence and a documentation use', () => {
  const images = new Set([...publicImages()].filter((p) => p.startsWith('media/demo/')));
  const captured = new Set(manifest().captures.map((capture) => capture.image));
  assert.deepEqual([...captured].sort(), [...images].sort(),
    'public demo references and native capture manifest must cover the same assets');
});
