'use strict';

// Reuses the existing real recording and HTML; no new kernel evaluation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const runtime = process.env.EVALENS_RUNTIME_ROOT || path.resolve(__dirname, '../../..');
const puppeteer = require(path.join(runtime, 'node_modules/puppeteer-core'));
const hash = value => createHash('sha256').update(value).digest('hex');
const e = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const originals = Object.fromEntries(fs.readdirSync(__dirname)
  .filter(file => !file.startsWith('n-base-position-') && fs.statSync(path.join(__dirname, file)).isFile())
  .map(file => [file, hash(fs.readFileSync(path.join(__dirname, file)))]));
async function main() {
  const previous = fs.readFileSync(path.join(__dirname, 'n-body-values-comparison.html'), 'utf8');
  const record = JSON.parse(fs.readFileSync(path.join(__dirname, 'before-inner-checks.json'), 'utf8'));
  const fixture = fs.readFileSync(path.join(__dirname, 'before-inner-fixture.py'), 'utf8');
  assert.equal(hash(fixture), record.fixtureSha256);
  const revisedN = previous.match(/<article class="option" data-option="N" data-variant="revised">[\s\S]*?<\/article>/)[0];
  const variants = [
    ['after', 'Previous revised N', 'base is below the inner-loop readings, with an iteration-end cue.'],
    ['before', 'New revised N · base above for y', 'base now appears directly below Iteration 2, in Variables beside printed base: 10.'],
  ];
  const cards = variants.map(([placement, title, caption]) => revisedN
    .replace('data-variant="revised"', 'data-variant="revised" data-placement="' + placement + '"')
    .replace('<h2>Revised N · a row for base</h2>', '<h2>' + e(title) + '</h2>')
    .replace(/<p class="caption">[\s\S]*?<\/p>/, '<p class="caption">' + e(caption) + '</p>')).join('');
  const numbered = fixture.trimEnd().split('\n').map((line, index) =>
    '<div class="source-line"><span class="line-number">' + (index + 1)
    + '</span><code>' + e(line) + '</code></div>').join('');
  const html = fs.readFileSync(path.join(__dirname, 'n-base-position-template.html'), 'utf8')
    .replace('__SOURCE__', numbered).replace('__OPTIONS__', cards)
    .replace('__GROUPS__', JSON.stringify(record.capturedGroups));
  const target = path.join(__dirname, 'n-base-position-comparison.html');
  fs.writeFileSync(target, html);
  const browser = await puppeteer.launch({ headless: true,
    executablePath: process.env.EVALENS_CHROME_PATH
      || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.setViewport({ width: 1960, height: 1000, deviceScaleFactor: 2 });
    await page.goto('file://' + target);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.drawGuides());
    const png = path.join(__dirname, 'n-base-position-comparison.png');
    await page.screenshot({ path: png, fullPage: true });
    console.log('First placement image: ' + png);
    const checks = await page.evaluate(() => window.checkConcepts());
    for (const check of checks) {
      assert.equal(check.columnPairs, 1);
      assert.deepEqual(check.expanded, [false, true]);
      assert.deepEqual(check.summaries, ['x = 0, base = 0', 'x = 1']);
      assert.deepEqual(check.visibleBaseRows, ['10']);
      assert.deepEqual(check.output, ['base: 10', '1 0', '1 1', '1 2']);
      assert.equal(check.overflow, false);
    }
    assert.deepEqual(checks[0].timingCues, ['at iteration end']);
    assert.deepEqual(checks[1].timingCues, []);
    const interactions = await page.evaluate(() => window.checkFolding());
    for (const check of interactions) {
      assert.deepEqual(check.allOpen.output, ['base: 0', '0 0', '0 1', '0 2', 'base: 10', '1 0', '1 1', '1 2']);
      assert.deepEqual(check.allOpen.baseRows, ['0', '10']);
      assert.deepEqual(check.allClosed.output, []);
      assert.deepEqual(check.allClosed.baseRows, []);
      assert.deepEqual(check.allClosed.summaries, ['x = 0, base = 0', 'x = 1, base = 10']);
      assert.deepEqual(check.restored.output, ['base: 10', '1 0', '1 1', '1 2']);
    }
    const position = await page.evaluate(() => {
      const card = document.querySelector('[data-placement="before"]');
      const group = groupsFor(card)[1], body = group.querySelector(':scope > .loop-body');
      const row = body.querySelector(':scope > .loop-parent-reading');
      const base = row.querySelector('.body-reading');
      const output = row.querySelector('.loop-output');
      const source = body.querySelector('[data-loop-depth="1"] > .loop-source');
      const header = group.querySelector('.loop-iteration-header');
      const textLeft = node => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().left; };
      const columns = card.querySelectorAll('.loop-columns > span');
      return {
        firstBodyRow: body.firstElementChild === row,
        baseText: base.innerText, printedText: output.innerText,
        belowIterationHeading: row.getBoundingClientRect().top >= header.getBoundingClientRect().bottom,
        beforeInnerSource: row.getBoundingClientRect().bottom <= source.getBoundingClientRect().top,
        baseColumnDifference: textLeft(base) - textLeft(columns[0]),
        printedColumnDifference: textLeft(output) - textLeft(columns[1]),
        basePrintedTopDifference: base.getBoundingClientRect().top - output.getBoundingClientRect().top,
        trailingBaseRows: card.querySelectorAll('.loop-outer-body-value').length,
        visibleTimingCues: [...card.querySelectorAll('.reading-time')].filter(visible).length,
      };
    });
    assert.equal(position.firstBodyRow, true);
    assert.equal(position.baseText, 'base = 10');
    assert.equal(position.printedText, 'base: 10');
    assert.equal(position.belowIterationHeading, true);
    assert.equal(position.beforeInnerSource, true);
    assert.ok(Math.abs(position.baseColumnDifference) < 1);
    assert.ok(Math.abs(position.printedColumnDifference) < 1);
    assert.ok(Math.abs(position.basePrintedTopDifference) < 1);
    assert.equal(position.trailingBaseRows, 0);
    assert.equal(position.visibleTimingCues, 0);
    await page.setViewport({ width: 980, height: 1000, deviceScaleFactor: 1 });
    const narrow = await page.evaluate(() => {
      window.drawGuides();
      return { checks: window.checkConcepts(),
        lefts: [...document.querySelectorAll('.option')].map(node => node.getBoundingClientRect().left),
        overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.equal(new Set(narrow.lefts).size, 1);
    assert.equal(narrow.overflow, false);
    assert.ok(narrow.checks.every(check => !check.overflow));
    const stackedPair = await page.evaluate(() => {
      const card = document.querySelector('[data-placement="before"]');
      card.querySelector('.sample').style.width = '380px';
      window.drawGuides();
      const row = [...card.querySelectorAll('.loop-parent-reading')].find(visible);
      const base = row.querySelector('.body-reading');
      const output = row.querySelector('.loop-output');
      return {
        headerHidden: getComputedStyle(card.querySelector('.loop-columns')).display === 'none',
        baseVisible: visible(base), baseText: base.innerText,
        printedText: output.innerText,
        printedBelowBase: output.getBoundingClientRect().top > base.getBoundingClientRect().bottom,
        outputOnlyClass: row.classList.contains('loop-direct'),
      };
    });
    assert.equal(stackedPair.headerHidden, true);
    assert.equal(stackedPair.baseVisible, true);
    assert.equal(stackedPair.baseText, 'base = 10');
    assert.equal(stackedPair.printedText, 'base: 10');
    assert.equal(stackedPair.printedBelowBase, true);
    assert.equal(stackedPair.outputOnlyClass, false);
    assert.deepEqual(errors, []);
    for (const [file, digest] of Object.entries(originals)) {
      assert.equal(hash(fs.readFileSync(path.join(__dirname, file))), digest, 'earlier artifact changed: ' + file);
    }
    const bytes = fs.readFileSync(png);
    const report = {
      kind: 'draft placement correction; no implementation selected',
      recordingSource: 'before-inner-checks.json', kernelRequests: 0,
      fixtureSha256: record.fixtureSha256,
      screenshot: { file: 'n-base-position-comparison.png', sha256: hash(bytes),
        width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), deviceScaleFactor: 2 },
      checks, interactions, position, narrow, stackedPair, browserErrors: errors,
      unchangedEarlierArtifacts: originals,
      limitations: 'Presentation-only prototype. base remains the captured end-of-outer-iteration snapshot; no assignment-time capture is implied. No runtime changes or native VS Code connection.',
    };
    fs.writeFileSync(path.join(__dirname, 'n-base-position-checks.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('Placement and local folds checked: ' + report.screenshot.width + ' × ' + report.screenshot.height);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
