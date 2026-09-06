'use strict';
/**
 * `specHash` on its own, in a module with no side effects -- #113.
 *
 * `render-stills.js` cannot be required just for this one function: its top
 * level patches `Module._resolveFilename`/`_load` so every `require('vscode')`
 * in the process resolves to the mock, and requires the compiled renderer to
 * do it. That is exactly right for a script that is going to run the whole
 * pipeline, and exactly wrong for a test process that only wants to check a
 * hash -- it would leave every other test in the same process quietly
 * talking to a fake `vscode`. This file is the one piece both
 * `render-stills.js` and `stills.test.ts` can share safely.
 */
const crypto = require('crypto');

/**
 * A sha256 over every field of `spec` except `hash` itself, so a spec can
 * carry its own freshness check -- see the longer doc comment on this
 * function's one caller in `render-stills.js`.
 */
function specHash(spec) {
  const { hash: _hash, ...rest } = spec;
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

module.exports = { specHash };
