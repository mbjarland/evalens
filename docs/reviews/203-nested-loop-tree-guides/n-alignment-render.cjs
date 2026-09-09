'use strict';

// Alignment-only draft using the existing recording and concept markup.
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
  .filter(file => !file.startsWith('n-alignment-') && fs.statSync(path.join(__dirname, file)).isFile())
  .map(file => [file, hash(fs.readFileSync(path.join(__dirname, file)))]));
async function main() {
  const previous = fs.readFileSync(path.join(__dirname, 'n-base-position-comparison.html'), 'utf8');
  const record = JSON.parse(fs.readFileSync(path.join(__dirname, 'before-inner-checks.json'), 'utf8'));
  const fixture = fs.readFileSync(path.join(__dirname, 'before-inner-fixture.py'), 'utf8');
  assert.equal(hash(fixture), record.fixtureSha256);
  const latestN = previous.match(/<article class="option" data-option="N" data-variant="revised" data-placement="before">[\s\S]*?<\/article>/)[0];
  const variants = [
    ['previous', 'Previous N', 'The iteration captions and inner for start at different positions from the Variables header and base.'],
    ['aligned', 'Aligned N', 'Iteration text, base, and for y share one edge. Blue arrows and short connectors stay in the gutter; y/v sit one level farther in.'],
  ];
  const cards = variants.map(([alignment, title, caption]) => latestN
    .replace('data-placement="before"', 'data-placement="before" data-alignment="' + alignment + '"')
    .replace('<h2>New revised N · base above for y</h2>', '<h2>' + e(title) + '</h2>')
    .replace(/<p class="caption">[\s\S]*?<\/p>/, '<p class="caption">' + e(caption) + '</p>')).join('');
  const numbered = fixture.trimEnd().split('\n').map((line, index) =>
    '<div class="source-line"><span class="line-number">' + (index + 1)
    + '</span><code>' + e(line) + '</code></div>').join('');
  const html = fs.readFileSync(path.join(__dirname, 'n-alignment-template.html'), 'utf8')
    .replace('__SOURCE__', numbered).replace('__OPTIONS__', cards)
    .replace('__GROUPS__', JSON.stringify(record.capturedGroups));
  const target = path.join(__dirname, 'n-alignment-comparison.html');
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
    const png = path.join(__dirname, 'n-alignment-comparison.png');
    await page.screenshot({ path: png, fullPage: true });
    console.log('First alignment image: ' + png);
    const checks = await page.evaluate(() => window.checkConcepts());
    for (const check of checks) {
      assert.equal(check.columnPairs, 1);
      assert.deepEqual(check.expanded, [false, true]);
      assert.deepEqual(check.summaries, ['x = 0, base = 0', 'x = 1']);
      assert.deepEqual(check.visibleBaseRows, ['10']);
      assert.deepEqual(check.output, ['base: 10', '1 0', '1 1', '1 2']);
      assert.deepEqual(check.timingCues, []);
      assert.equal(check.overflow, false);
    }
    const interactions = await page.evaluate(() => window.checkFolding());
    for (const check of interactions) {
      assert.deepEqual(check.allOpen.output, ['base: 0', '0 0', '0 1', '0 2', 'base: 10', '1 0', '1 1', '1 2']);
      assert.deepEqual(check.allOpen.baseRows, ['0', '10']);
      assert.deepEqual(check.allClosed.output, []);
      assert.deepEqual(check.allClosed.baseRows, []);
      assert.deepEqual(check.allClosed.summaries, ['x = 0, base = 0', 'x = 1, base = 10']);
      assert.deepEqual(check.restored.output, ['base: 10', '1 0', '1 1', '1 2']);
    }
    const geometry = [];
    for (const width of [1960, 1300, 980]) {
      await page.setViewport({ width, height: 1100, deviceScaleFactor: 1 });
      const measurement = await page.evaluate(() => {
        window.drawGuides();
        function textBox(node, token) {
          const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
          let text;
          while ((text = walker.nextNode())) {
            const start = text.textContent.indexOf(token);
            if (start < 0) continue;
            const range = document.createRange();
            range.setStart(text, start);
            range.setEnd(text, start + token.length);
            const rect = [...range.getClientRects()].find(rect => rect.width);
            if (rect) return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
          }
          throw new Error('Visible text not found: ' + token);
        }
        return {
          width: innerWidth,
          cards: [...document.querySelectorAll('.option')].map(card => {
            const heading = textBox(card.querySelector('.loop-columns'), 'Variables');
            const printed = textBox(card.querySelector('.loop-columns'), 'Printed output');
            const iterationLabels = groupsFor(card).map((group, index) =>
              textBox(group.querySelector('.loop-iteration-header'), 'Iteration ' + (index + 1)));
            const base = textBox([...card.querySelectorAll('.body-reading')].find(visible), 'base = 10');
            const innerNode = [...card.querySelectorAll('[data-loop-depth="1"] > .loop-source')].find(visible);
            const inner = textBox(innerNode, 'for y');
            const values = [...card.querySelectorAll('[data-loop-depth="1"] .loop-target button')].filter(visible)
              .map(node => textBox(node, 'y ='));
            const stdout = [...card.querySelectorAll('.loop-output')].filter(visible).map(node => textBox(node, node.innerText.trim()));
            const arrows = [...card.querySelectorAll('.loop-iteration-header .loop-disclosure')].map(node => textBox(node, node.innerText));
            const svg = card.querySelector('.tree-guide'), svgRect = svg.getBoundingClientRect();
            const guideBounds = [...svg.querySelectorAll('path')].map(node => {
              const box = node.getBBox();
              return { right: box.x + box.width + svgRect.left, bottom: box.y + box.height + svgRect.top };
            });
            const innerRect = innerNode.getBoundingClientRect();
            return {
              alignment: card.dataset.alignment,
              left: card.getBoundingClientRect().left,
              iterationDifferences: iterationLabels.map(box => box.left - heading.left),
              baseDifference: base.left - heading.left,
              innerSourceDifference: inner.left - heading.left,
              innerValueIndents: values.map(box => box.left - heading.left),
              outputDifferences: stdout.map(box => box.left - printed.left),
              arrowTextGaps: arrows.map((box, index) => iterationLabels[index].left - box.right),
              guideTextGaps: guideBounds.map(box => heading.left - box.right),
              guidesStopAtInnerHeading: Math.abs(Math.max(...guideBounds.map(box => box.bottom)) - (innerRect.top + innerRect.height / 2)) < .1,
              overflow: card.querySelector('.sample').scrollWidth > card.querySelector('.sample').clientWidth + 1,
            };
          }),
          pageOverflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      const aligned = measurement.cards.find(card => card.alignment === 'aligned');
      assert.ok(aligned.iterationDifferences.every(value => Math.abs(value) < 1));
      assert.ok(Math.abs(aligned.baseDifference) < 1);
      assert.ok(Math.abs(aligned.innerSourceDifference) < 1);
      assert.ok(aligned.innerValueIndents.every(value => value >= 18 && value <= 20));
      assert.ok(aligned.outputDifferences.every(value => Math.abs(value) < 1));
      assert.ok(aligned.arrowTextGaps.every(value => value >= 8));
      assert.ok(aligned.guideTextGaps.every(value => value >= 7));
      assert.equal(aligned.guidesStopAtInnerHeading, true);
      assert.equal(measurement.pageOverflow, false);
      assert.ok(measurement.cards.every(card => !card.overflow));
      if (width < 1500) assert.equal(new Set(measurement.cards.map(card => card.left)).size, 1);
      geometry.push(measurement);
    }
    const stackedPair = await page.evaluate(() => {
      const card = document.querySelector('[data-alignment="aligned"]');
      card.querySelector('.sample').style.width = '380px';
      window.drawGuides();
      const row = [...card.querySelectorAll('.loop-parent-reading')].find(visible);
      const base = row.querySelector('.body-reading'), output = row.querySelector('.loop-output');
      return {
        headerHidden: getComputedStyle(card.querySelector('.loop-columns')).display === 'none',
        baseVisible: visible(base), baseText: base.innerText, outputText: output.innerText,
        outputBelowBase: output.getBoundingClientRect().top > base.getBoundingClientRect().bottom,
      };
    });
    assert.deepEqual(stackedPair, { headerHidden: true, baseVisible: true,
      baseText: 'base = 10', outputText: 'base: 10', outputBelowBase: true });
    assert.deepEqual(errors, []);
    for (const [file, digest] of Object.entries(originals)) {
      assert.equal(hash(fs.readFileSync(path.join(__dirname, file))), digest, 'earlier artifact changed: ' + file);
    }
    const bytes = fs.readFileSync(png);
    const report = {
      kind: 'draft text-edge alignment comparison; no implementation selected',
      recordingSource: 'before-inner-checks.json', kernelRequests: 0,
      fixtureSha256: record.fixtureSha256,
      screenshot: { file: 'n-alignment-comparison.png', sha256: hash(bytes),
        width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), deviceScaleFactor: 2 },
      checks, interactions, geometry, stackedPair, browserErrors: errors,
      unchangedEarlierArtifacts: originals,
      limitations: 'Presentation-only HTML using existing recording and markup. Text geometry measured with Range/getClientRects. No runtime changes or native VS Code connection.',
    };
    fs.writeFileSync(path.join(__dirname, 'n-alignment-checks.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('Text edges and local folds checked: ' + report.screenshot.width + ' × ' + report.screenshot.height);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
