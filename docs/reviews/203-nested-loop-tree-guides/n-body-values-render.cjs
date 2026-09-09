'use strict';

// Uses the existing fixture recording and renderer markup; no new evaluation.
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
  .filter(file => !file.startsWith('n-body-values-') && fs.statSync(path.join(__dirname, file)).isFile())
  .map(file => [file, hash(fs.readFileSync(path.join(__dirname, file)))]));
async function main() {
  const previous = fs.readFileSync(path.join(__dirname, 'before-inner-comparison.html'), 'utf8');
  const recorded = JSON.parse(fs.readFileSync(path.join(__dirname, 'before-inner-checks.json'), 'utf8'));
  const fixture = fs.readFileSync(path.join(__dirname, 'before-inner-fixture.py'), 'utf8');
  assert.equal(hash(fixture), recorded.fixtureSha256);
  const originalN = previous.match(/<article class="option" data-option="N">[\s\S]*?<\/article>/)[0];
  const variants = [
    ['original', 'Original N', 'base stays in the heading with x, whether the iteration is folded or open.'],
    ['revised', 'Revised N · a row for base', 'The guide stops at for y. Indented y/v rows show its contents; base returns to the outer level at iteration end.'],
  ];
  const cards = variants.map(([variant, title, caption]) => originalN
    .replace('data-option="N"', 'data-option="N" data-variant="' + variant + '"')
    .replace('<h2>Anchor the whole iteration</h2>', '<h2>' + e(title) + '</h2>')
    .replace(/<p class="caption">[\s\S]*?<\/p>/, '<p class="caption">' + e(caption) + '</p>')).join('');
  const numbered = fixture.trimEnd().split('\n').map((line, index) =>
    '<div class="source-line"><span class="line-number">' + (index + 1)
    + '</span><code>' + e(line) + '</code></div>').join('');
  const html = fs.readFileSync(path.join(__dirname, 'n-body-values-template.html'), 'utf8')
    .replace('__SOURCE__', numbered).replace('__OPTIONS__', cards)
    .replace('__GROUPS__', JSON.stringify(recorded.capturedGroups));
  const target = path.join(__dirname, 'n-body-values-comparison.html');
  fs.writeFileSync(target, html);
  const browser = await puppeteer.launch({ headless: true,
    executablePath: process.env.EVALENS_CHROME_PATH
      || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.setViewport({ width: 1960, height: 1200, deviceScaleFactor: 2 });
    await page.goto('file://' + target);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.drawGuides());
    const png = path.join(__dirname, 'n-body-values-comparison.png');
    await page.screenshot({ path: png, fullPage: true });
    console.log('First comparison image: ' + png);
    const checks = await page.evaluate(() => window.checkConcepts());
    for (const check of checks) {
      assert.equal(check.columnPairs, 1);
      assert.deepEqual(check.expanded, [false, true]);
      assert.deepEqual(check.output, ['base: 10', '1 0', '1 1', '1 2']);
      assert.equal(check.overflow, false);
      assert.match(check.final, /x = 1, y = 2, base = 10, v = 12/);
      assert.ok(check.bracketEnds.every(end => end.endY === end.lastBottom + 5));
    }
    assert.deepEqual(checks[0].visibleBaseRows, []);
    assert.deepEqual(checks[0].summaries, ['x = 0, base = 0', 'x = 1, base = 10']);
    assert.deepEqual(checks[1].visibleBaseRows, ['10']);
    assert.deepEqual(checks[1].summaries, ['x = 0, base = 0', 'x = 1']);
    assert.deepEqual(checks[1].timingCues, ['at iteration end']);
    assert.deepEqual(checks[1].bracketEnds, []);
    assert.equal(checks[1].innerGuideEnds.length, 1);
    assert.ok(checks[1].innerGuideEnds.every(end => end.endY === end.targetY));
    const interactions = await page.evaluate(() => window.checkFolding());
    for (const check of interactions) {
      assert.deepEqual(check.allOpen.output, ['base: 0', '0 0', '0 1', '0 2', 'base: 10', '1 0', '1 1', '1 2']);
      assert.deepEqual(check.allClosed.output, []);
      assert.deepEqual(check.allClosed.baseRows, []);
      assert.deepEqual(check.allClosed.summaries, ['x = 0, base = 0', 'x = 1, base = 10']);
      assert.deepEqual(check.restored.output, ['base: 10', '1 0', '1 1', '1 2']);
      assert.deepEqual(check.allOpen.baseRows, check.variant === 'revised' ? ['0', '10'] : []);
      assert.deepEqual(check.restored.baseRows, check.variant === 'revised' ? ['10'] : []);
    }
    const viewportChecks = [];
    for (const width of [1960, 1300, 980]) {
      await page.setViewport({ width, height: 1100, deviceScaleFactor: 1 });
      const check = await page.evaluate(() => {
        window.drawGuides();
        const textLeft = node => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().left; };
        const card = document.querySelector('[data-variant="revised"]');
        const headers = card.querySelectorAll('.loop-columns > span');
        const base = [...card.querySelectorAll('.body-reading')].find(visible);
        const output = [...card.querySelectorAll('.loop-output')].find(visible);
        const svg = card.querySelector('.tree-guide');
        const guide = svg.querySelector('[data-target="inner-header"]');
        const guideX = Number(guide.getAttribute('d').split(' ')[1]) + svg.getBoundingClientRect().left;
        const inner = [...card.querySelectorAll('[data-loop-depth="1"] > .loop-source')].find(visible);
        const innerValue = [...card.querySelectorAll('[data-loop-depth="1"] .loop-target button')].find(visible);
        const innerBox = inner.getBoundingClientRect();
        const maxGuideY = Math.max(...[...svg.querySelectorAll('path')].map(node => {
          const box = node.getBBox(); return box.y + box.height;
        })) + svg.getBoundingClientRect().top;
        return { width: innerWidth, states: window.checkConcepts(),
          lefts: [...document.querySelectorAll('.option')].map(node => node.getBoundingClientRect().left),
          baseHeadingDifference: textLeft(base) - textLeft(headers[0]),
          outputHeadingDifference: textLeft(output) - textLeft(headers[1]),
          guideToBaseGap: textLeft(base) - guideX,
          innerValueIndent: textLeft(innerValue) - textLeft(inner),
          baseOutdentFromInner: textLeft(innerValue) - textLeft(base),
          guideStopsAtInnerHeading: Math.abs(maxGuideY - (innerBox.top + innerBox.height / 2)) < .1,
          pageOverflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.equal(check.pageOverflow, false);
      assert.ok(check.states.every(state => !state.overflow));
      assert.ok(Math.abs(check.baseHeadingDifference) < 1);
      assert.ok(Math.abs(check.outputHeadingDifference) < 1);
      assert.ok(check.guideToBaseGap >= 14);
      assert.ok(check.innerValueIndent >= 14 && check.innerValueIndent <= 20);
      assert.ok(check.baseOutdentFromInner >= 30);
      assert.equal(check.guideStopsAtInnerHeading, true);
      if (width < 1500) assert.equal(new Set(check.lefts).size, 1);
      viewportChecks.push(check);
    }
    assert.deepEqual(errors, []);
    for (const [file, digest] of Object.entries(originals)) {
      assert.equal(hash(fs.readFileSync(path.join(__dirname, file))), digest, 'earlier artifact changed: ' + file);
    }
    const bytes = fs.readFileSync(png);
    const report = {
      kind: 'draft original-versus-revised N; no implementation approval',
      recordingSource: 'before-inner-checks.json',
      fixtureSha256: recorded.fixtureSha256, kernelRequests: 0,
      screenshot: { file: 'n-body-values-comparison.png', sha256: hash(bytes),
        width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), deviceScaleFactor: 2 },
      checks, interactions, viewportChecks, browserErrors: errors,
      unchangedEarlierArtifacts: originals,
      limitations: 'Local foldable concept HTML only. Existing real fixture recording reused; no native VS Code connection, runtime changes, or new per-statement captures.',
    };
    fs.writeFileSync(path.join(__dirname, 'n-body-values-checks.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('Original and revised N checked: ' + report.screenshot.width + ' × ' + report.screenshot.height);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
