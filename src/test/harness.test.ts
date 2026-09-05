import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A placeholder that earns its place by failing for the two reasons a fresh
 * clone actually breaks: the TypeScript did not compile, or `node --test` is
 * pointed somewhere with nothing in it. The first real tests arrive with the
 * kernel (#4) and the resolver (#5).
 *
 * Nothing here may import `vscode`: that module only exists inside the
 * extension host, so anything this runner touches has to be the pure half of
 * the code. Keeping that split is what makes the logic testable at all.
 */
test('the build produced loadable output', () => {
  const out = path.resolve(__dirname, '..');
  assert.ok(fs.existsSync(path.join(out, 'extension.js')),
    'out/extension.js is missing -- did `npm run compile` run?');
});

test('compiled output is CommonJS, as the extension host requires', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(src, /exports\.activate/,
    'extension.js does not export activate as CommonJS');
});
