'use strict';

// This renders design concepts, not a native VS Code screenshot.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const runtime = process.env.EVALENS_RUNTIME_ROOT || root;
const puppeteer = require(path.join(runtime, 'node_modules/puppeteer-core'));
const { KernelClient } = require(path.join(runtime, 'out/kernel/client'));
const { present } = require(path.join(runtime, 'out/render/present'));
const { rowsFor } = require(path.join(runtime, 'out/panel/html'));
const { loopExplorerHtml, newLoopViewState, LOOP_EXPLORER_STYLE } =
  require(path.join(runtime, 'out/panel/loopExplorer'));

const fixture = 'docs/reviews/196-marketplace-page-refresh/fixtures/nested-loops.py';
const source = fs.readFileSync(path.join(root, fixture), 'utf8');
const escape = text => text.replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const variants = [
  {
    id: 'A', name: 'Neutral elbows',
    description: 'The full tree connects both outer iterations and the inner loop. Clear ownership, quiet color.',
    meaning: 'Full ownership tree',
  },
  {
    id: 'B', name: 'Amber elbows',
    description: 'The same tree is easier to spot. Its warm color competes more with the orange bar and values.',
    meaning: 'Full ownership tree',
  },
  {
    id: 'C', name: 'Dotted tree',
    description: 'The same connections feel lighter. Dots make the route less continuous, especially at small sizes.',
    meaning: 'Full ownership tree',
  },
  {
    id: 'D', name: 'Expanded path',
    description: 'Only the open branch gets a guide. Less linework; the collapsed iteration relies on indentation.',
    meaning: 'Expanded ownership path',
  },
];

async function main() {
  for (const file of ['src/panel/loopExplorer.ts', 'src/panel/html.ts',
    'src/render/present.ts', 'src/kernel/client.ts']) {
    assert.equal(hash(fs.readFileSync(path.join(root, file))),
      hash(fs.readFileSync(path.join(runtime, file))), 'runtime source differs: ' + file);
  }
  const kernel = new KernelClient({
    resolvePython: async () => 'python3',
    kernelPath: path.join(root, 'kernel/evalens_kernel.py'),
  });
  let response;
  try {
    response = await kernel.request({
      op: 'eval', source, line: 0, character: 0,
      filename: path.join(root, fixture), allow_stdin: false,
    });
    assert.equal(response.ok, true);
  } finally {
    kernel.dispose();
  }

  const lines = source.split('\n');
  const rows = rowsFor({ lineCount: lines.length,
    lineAt: line => ({ text: lines[line] }) }, [present(response)], 'printed');
  const model = rows[0].loopExplorer;
  assert.ok(model);
  const iterations = model.children.get(model.roots[0].id)
    .filter(entry => entry.kind === 'iteration');
  assert.equal(iterations.length, 2);
  const state = newLoopViewState();
  state.expanded.set(iterations[0].id, true);
  state.expanded.set(iterations[1].id, false);
  const result = loopExplorerHtml(model, 0, state);
  const cards = variants.map(variant =>
    '<article class="option" data-option="' + variant.id + '">'
    + '<header class="option-heading"><span class="letter">' + variant.id + '</span>'
    + '<h2>' + variant.name + '</h2><span class="meaning">' + variant.meaning + '</span></header>'
    + '<div class="sample"><span class="outer-fold" aria-hidden="true">▾</span>'
    + result + '<svg class="tree-guide" aria-hidden="true"></svg></div>'
    + '<p class="caption">' + variant.description + '</p></article>'
  ).join('\n');

  const template = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
  const html = template.replace('__PRODUCTION_STYLE__', LOOP_EXPLORER_STYLE)
    .replace('__SOURCE__', escape(source.trimEnd()))
    .replace('__OPTIONS__', cards);
  const target = path.join(__dirname, 'comparison.html');
  fs.writeFileSync(target, html);

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.EVALENS_CHROME_PATH
      || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.setViewport({ width: 1960, height: 1400, deviceScaleFactor: 2 });
    await page.goto('file://' + target);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.drawGuides());
    const checks = await page.evaluate(() => [...document.querySelectorAll('.option')].map(card => {
      const explorer = card.querySelector('.loop-explorer');
      const visible = node => node.getClientRects().length > 0;
      const headers = [...card.querySelectorAll('.loop-iteration-header')];
      const targets = [...card.querySelectorAll('.loop-data .loop-target')].map(node =>
        node.innerText.trim());
      const output = [...card.querySelectorAll('.loop-data .loop-output')].map(node =>
        node.innerText.trim());
      const guides = card.querySelectorAll('.tree-guide path');
      const column = card.querySelector('.loop-columns').getBoundingClientRect();
      const sample = card.querySelector('.sample').getBoundingClientRect();
      const rows = [...card.querySelectorAll('.loop-data')].map(node =>
        [...node.children].map(child => child.getBoundingClientRect().left - sample.left));
      const headingLefts = [...card.querySelector('.loop-columns').children].map(node =>
        node.getBoundingClientRect().left - sample.left);
      return {
        option: card.dataset.option,
        root: card.querySelector('.loop-root-source').innerText,
        inner: card.querySelector('[data-loop-depth="1"] > .loop-source').innerText,
        sharedHeadings: card.querySelectorAll('.loop-columns').length,
        helpControls: card.querySelectorAll('.loop-recording-details').length,
        firstOpen: headers[0].querySelector('button').getAttribute('aria-expanded'),
        secondOpen: headers[1].querySelector('button').getAttribute('aria-expanded'),
        visibleTargets: targets, visibleOutput: output,
        finalValues: card.querySelector('.loop-final').innerText,
        guidePaths: guides.length,
        pathGeometry: [...guides].map(node => node.getAttribute('d')),
        headingLefts, rows,
        sampleWidth: sample.width, sampleHeight: sample.height,
        bodyWidth: explorer.getBoundingClientRect().width,
        extraTimingRows: card.querySelectorAll('.loop-owner, .loop-value-timing').length,
        visibleRepeatedLabels: [...card.querySelectorAll('.loop-stack-label')].filter(visible).length,
        columnsWidth: column.width,
      };
    }));
    assert.equal(checks.length, 4);
    for (const check of checks) {
      assert.equal(check.sharedHeadings, 1);
      assert.equal(check.helpControls, 1);
      assert.equal(check.firstOpen, 'true');
      assert.equal(check.secondOpen, 'false');
      assert.match(check.root, /for x in range\(2\).*2 iterations/);
      assert.match(check.inner, /for y in range\(3\).*3 iterations.*line 2/);
      assert.deepEqual(check.visibleTargets, ['y = 0, v = 0', 'y = 1, v = 1', 'y = 2, v = 2']);
      assert.deepEqual(check.visibleOutput, ['0 0', '0 1', '0 2']);
      assert.match(check.finalValues, /x = 1, y = 2, v = 3/);
      assert.equal(check.extraTimingRows, 0);
      assert.equal(check.visibleRepeatedLabels, 0);
      assert.equal(check.guidePaths, check.option === 'D' ? 2 : 3);
      for (const row of check.rows) {
        row.forEach((left, index) => assert.ok(Math.abs(left - check.headingLefts[index]) < 1));
      }
      assert.equal(check.sampleHeight, checks[0].sampleHeight);
      assert.equal(check.sampleWidth, checks[0].sampleWidth);
      assert.deepEqual(check.headingLefts, checks[0].headingLefts);
    }
    assert.deepEqual(errors, []);
    const png = path.join(__dirname, 'comparison.png');
    await page.screenshot({ path: png, fullPage: true });
    const bytes = fs.readFileSync(png);
    const report = {
      kind: 'unimplemented design concepts',
      rendererSource: 'compiled production loopExplorerHtml and LOOP_EXPLORER_STYLE',
      fixture, fixtureSha256: hash(source),
      kernelRequests: 1,
      screenshot: { file: 'comparison.png', sha256: hash(bytes),
        width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20),
        deviceScaleFactor: 2 },
      checks, browserErrors: errors,
      limitations: 'Concept HTML in headless Chrome; no native VS Code connection, runtime changes, user choice, or implementation acceptance.',
    };
    fs.writeFileSync(path.join(__dirname, 'checks.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('Four concepts verified. Image: ' + png);
    console.log(report.screenshot.width + ' × ' + report.screenshot.height);
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
