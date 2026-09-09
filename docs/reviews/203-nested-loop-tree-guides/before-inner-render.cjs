'use strict';

// Draft comparison only: the fixture runs once when generating the page.
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
const { loopExplorerHtml, newLoopViewState, LOOP_EXPLORER_STYLE, loopSlice } =
  require(path.join(runtime, 'out/panel/loopExplorer'));
const fixture = 'docs/reviews/203-nested-loop-tree-guides/before-inner-fixture.py';
const source = fs.readFileSync(path.join(root, fixture), 'utf8');
const e = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const hash = value => createHash('sha256').update(value).digest('hex');
const originals = Object.fromEntries(fs.readdirSync(__dirname)
  .filter(file => !file.startsWith('before-inner-') && fs.statSync(path.join(__dirname, file)).isFile())
  .map(file => [file, hash(fs.readFileSync(path.join(__dirname, file)))]));

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
  } finally { kernel.dispose(); }
  const lines = source.trimEnd().split('\n');
  const rows = rowsFor({ lineCount: lines.length,
    lineAt: line => ({ text: lines[line] }) }, [present(response)], 'printed');
  const model = rows[0].loopExplorer;
  const rootInvocation = model.roots[0];
  const outerSite = model.sites.get(rootInvocation.site);
  const iterations = model.children.get(rootInvocation.id).filter(entry => entry.kind === 'iteration');
  const groups = iterations.map(outer => {
    const inner = model.children.get(outer.id).find(entry => entry.kind === 'invocation');
    const site = model.sites.get(inner.site);
    return {
      id: outer.id, ordinal: outer.ordinal, x: outer.value,
      base: outer.body.values.find(value => value.name === 'base').value,
      innerSource: site.source, innerLine: site.line + 1, count: inner.count,
      prefix: loopSlice(model, outer.start, inner.start, 0).trimEnd(),
      outputLines: loopSlice(model, outer.start, outer.end, 0).trimEnd().split('\n').length,
      readings: model.children.get(inner.id).filter(entry => entry.kind === 'iteration').map(entry => ({
        y: entry.value, v: entry.body.values.find(value => value.name === 'v').value,
        output: loopSlice(model, entry.start, entry.end, 0).trimEnd(),
      })),
    };
  });
  assert.deepEqual(groups.map(group => group.base), ['0', '10']);
  assert.deepEqual(groups.map(group => group.prefix), ['base: 0', 'base: 10']);
  assert.deepEqual(groups.map(group => group.outputLines), [4, 4]);
  assert.deepEqual(groups.map(group => group.count), [3, 3]);
  assert.deepEqual(groups[1].readings, [
    { y: '0', v: '10', output: '1 0' },
    { y: '1', v: '11', output: '1 1' },
    { y: '2', v: '12', output: '1 2' },
  ]);
  const state = newLoopViewState();
  iterations.forEach(entry => state.expanded.set(entry.id, true));
  const production = loopExplorerHtml(model, 0, state);
  const help = production.match(/<details class="loop-recording-details"[\s\S]*?<\/details>/)[0];
  const footer = '<div class="loop-final">Final values after this loop: '
    + model.wire.final_values.map(value => e(value.name) + ' = ' + e(value.value)).join(', ')
    + '</div><div class="loop-export"><span>Open statement printed output</span></div>';
  const overview = '<div class="concept-overview"><div class="concept-root-source">'
    + e(outerSite.source) + ' <span class="loop-note">· 2 iterations</span></div>' + help + '</div>';
  const columns = '<div class="concept-columns"><span>Variables</span><span>Printed output</span></div>';
  const sourceOutline = '<div class="source-outline" aria-label="Static source outline">'
    + lines.slice(1).map((line, index) => '<div class="source-outline-row depth-'
      + (index > 2 ? '2' : '1') + '"><span class="outline-line">' + (index + 2) + '</span>'
      + '<span class="outline-branch" aria-hidden="true">' + (index < 2 ? '├─' : index === 2 ? '└─' : index === 3 ? '├─' : '└─') + '</span>'
      + '<code>' + e(line.trim()) + '</code></div>').join('') + '</div>';
  const readingRows = group => group.readings.map(reading =>
    '<div class="concept-reading" data-reading><span class="reading-values">y = '
    + e(reading.y) + ', v = ' + e(reading.v) + '</span><span class="reading-output">'
    + e(reading.output) + '</span></div>').join('');
  function custom(id) {
    let result = '<div class="concept-explorer">' + overview;
    if (id === 'O') result += sourceOutline;
    result += columns;
    for (const group of groups) {
      const open = group.ordinal === 2;
      result += '<section class="concept-group" data-outer="' + group.ordinal + '" data-expanded="' + open + '">'
        + '<button class="concept-toggle" data-toggle-group aria-expanded="' + open + '"'
        + ' title="x at iteration start; base at iteration end">'
        + '<span class="fold" aria-hidden="true">' + (open ? '▾' : '▸') + '</span>';
      if (id === 'P') {
        result += '<span class="margin-summary"><span>x = ' + e(group.x)
          + '</span><span class="base-snapshot">base = ' + e(group.base) + '</span></span>';
      } else {
        result += '<span class="gold">Iteration ' + group.ordinal + ' · x = ' + e(group.x)
          + ', base = ' + e(group.base) + '</span><span class="loop-note"> · printed 4 lines</span>';
      }
      result += '</button>';
      if (id === 'P') {
        result += '<div class="closed-summary"' + (open ? ' hidden' : '') + '>'
          + '<span>3 inner iterations</span><span>4 lines</span></div>';
      }
      result += '<div class="group-detail"' + (!open ? ' hidden' : '') + '>'
        + '<div class="concept-direct"><span class="source-cue">Before inner loop</span>'
        + '<span class="reading-output">' + e(group.prefix) + '</span></div>'
        + '<div class="inner-source">'
        + (id === 'O' ? '<span class="source-cue">Lines 4–6</span> <span class="loop-note">· 3 inner iterations</span>'
          : e(group.innerSource) + ' <span class="loop-note">· 3 iterations · line 4</span>')
        + '</div>' + readingRows(group) + '</div></section>';
    }
    return result + footer + '</div>';
  }
  const variants = [
    ['CURRENT', 'Current layout', 'The production renderer already keeps the outer output before the inner loop. The grouping relies on headings and position.'],
    ['N', 'Anchor the whole iteration', 'The tree always lands on an iteration. A second branch encloses its own output and the inner loop, so folding never changes the owner.'],
    ['O', 'Show all the source once', 'A static outline includes the work before the inner loop. Results preserve that order, with small source cues instead of repeated code.'],
    ['P', 'Keep the owner in the margin', 'x and base stay beside their whole iteration. Parent output has its own row; the inner readings begin under their source.'],
  ];
  const cards = variants.map(([id, title, caption]) =>
    '<article class="option" data-option="' + id + '"><header class="option-heading">'
    + '<span class="letter">' + (id === 'CURRENT' ? 'NOW' : id) + '</span><h2>' + title + '</h2></header>'
    + '<div class="sample ' + (id === 'CURRENT' || id === 'N' ? 'production-sample' : 'custom-sample') + '">'
    + '<span class="root-fold" aria-hidden="true">▾</span>'
    + (id === 'CURRENT' || id === 'N' ? production : custom(id))
    + (id === 'N' ? '<svg class="tree-guide" aria-hidden="true"></svg>' : '')
    + '</div><p class="caption">' + caption + '</p></article>').join('');
  const numberedSource = lines.map((line, index) =>
    '<div class="source-line"><span class="line-number">' + (index + 1)
    + '</span><code>' + e(line) + '</code></div>').join('');
  const html = fs.readFileSync(path.join(__dirname, 'before-inner-template.html'), 'utf8')
    .replace('__PRODUCTION_STYLE__', LOOP_EXPLORER_STYLE)
    .replace('__SOURCE__', numberedSource).replace('__OPTIONS__', cards);
  const htmlPath = path.join(__dirname, 'before-inner-comparison.html');
  fs.writeFileSync(htmlPath, html);
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.EVALENS_CHROME_PATH
      || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.setViewport({ width: 1960, height: 1800, deviceScaleFactor: 2 });
    await page.goto('file://' + htmlPath);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.drawGuides());
    const png = path.join(__dirname, 'before-inner-comparison.png');
    await page.screenshot({ path: png, fullPage: true });
    console.log('First draft image ready: ' + png);
    const checks = await page.evaluate(() => window.checkConcepts());
    for (const check of checks) {
      assert.equal(check.columnPairs, 1, check.option + ' headings');
      assert.equal(check.helpControls, 1);
      assert.deepEqual(check.expanded, [false, true]);
      assert.deepEqual(check.output, ['base: 10', '1 0', '1 1', '1 2']);
      assert.deepEqual(check.values, ['y = 0, v = 10', 'y = 1, v = 11', 'y = 2, v = 12']);
      assert.equal(check.overflow, false, check.option + ' overflow');
      assert.match(check.final, /x = 1, y = 2, base = 10, v = 12/);
    }
    assert.equal(checks.length, 4);
    const interactions = await page.evaluate(() => window.checkFolding());
    for (const result of interactions) {
      assert.deepEqual(result.allOpen, ['base: 0', '0 0', '0 1', '0 2', 'base: 10', '1 0', '1 1', '1 2']);
      assert.deepEqual(result.allClosed, []);
      assert.deepEqual(result.restored, ['base: 10', '1 0', '1 1', '1 2']);
    }
    const viewportChecks = [];
    for (const width of [1960, 1300, 980]) {
      await page.setViewport({ width, height: 1100, deviceScaleFactor: 1 });
      const measured = await page.evaluate(() => {
        window.drawGuides();
        const textLeft = node => {
          const range = document.createRange();
          range.selectNodeContents(node);
          return range.getBoundingClientRect().left;
        };
        const n = document.querySelector('[data-option="N"]');
        const nHeaders = n.querySelectorAll('.loop-columns > span');
        const nValueLeft = textLeft([...n.querySelectorAll('.loop-target button')].find(visible));
        const nOutputLeft = textLeft([...n.querySelectorAll('.loop-output')].find(visible));
        const svg = n.querySelector('.tree-guide');
        const scopeX = Number(svg.querySelector('.scope').getAttribute('d').split(' ')[1])
          + svg.getBoundingClientRect().left;
        const p = document.querySelector('[data-option="P"]');
        const pHeader = p.querySelector('.concept-columns > span:last-child');
        const pOutput = [...p.querySelectorAll('.reading-output')].filter(visible);
        return {
          width: innerWidth, checks: window.checkConcepts(),
          lefts: [...document.querySelectorAll('.option')].map(card => card.getBoundingClientRect().left),
          pageOverflow: document.documentElement.scrollWidth > innerWidth,
          nValueHeadingDifference: nValueLeft - textLeft(nHeaders[0]),
          nOutputHeadingDifference: nOutputLeft - textLeft(nHeaders[1]),
          nGuideToValueGap: nValueLeft - scopeX,
          pOutputHeadingDifferences: pOutput.map(node => textLeft(node) - textLeft(pHeader)),
        };
      });
      assert.equal(measured.pageOverflow, false);
      assert.ok(measured.checks.every(check => !check.overflow));
      assert.ok(Math.abs(measured.nValueHeadingDifference) < 1);
      assert.ok(Math.abs(measured.nOutputHeadingDifference) < 1);
      assert.ok(measured.nGuideToValueGap >= 14);
      assert.ok(measured.pOutputHeadingDifferences.every(value => Math.abs(value) < 1));
      if (width < 1500) assert.equal(new Set(measured.lefts).size, 1);
      viewportChecks.push(measured);
    }
    assert.deepEqual(errors, []);
    for (const [file, digest] of Object.entries(originals)) {
      assert.equal(hash(fs.readFileSync(path.join(__dirname, file))), digest, 'earlier artifact changed: ' + file);
    }
    const bytes = fs.readFileSync(png);
    const report = {
      kind: 'draft visual comparison; no implementation selected',
      fixture, fixtureSha256: hash(source), kernelRequests: 1,
      screenshot: { file: 'before-inner-comparison.png', sha256: hash(bytes),
        width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), deviceScaleFactor: 2 },
      capturedGroups: groups, checks, interactions, viewportChecks, browserErrors: errors,
      unchangedEarlierArtifacts: originals,
      limitations: 'Code-native concept HTML. Current/N use production markup. O/P use the same recorded model in custom layouts. No native VS Code connection, product changes, or per-statement variable capture.',
    };
    fs.writeFileSync(path.join(__dirname, 'before-inner-checks.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('Four mixed-state layouts and local folds verified: ' + report.screenshot.width + ' × ' + report.screenshot.height);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
