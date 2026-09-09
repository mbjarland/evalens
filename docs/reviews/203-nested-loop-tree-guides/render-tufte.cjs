'use strict';

// Unimplemented design concepts: recorded fixture data, code-native layouts.
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
const fixture = 'docs/reviews/196-marketplace-page-refresh/fixtures/nested-loops.py';
const source = fs.readFileSync(path.join(root, fixture), 'utf8');
const e = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const variants = [
  ['H', 'Follow the visible branch', 'The guide lands on the folded caption, then on the open inner loop. Familiar, with no hidden destination.'],
  ['I', 'Put context beside the source', 'Join x and its inner loop on one line. Close labels replace the extra heading and most of the linework.'],
  ['J', 'Show the source tree once', 'Explain the nesting once; let the results follow. Less repetition when you open several iterations.'],
  ['K', 'Move context into the margin', 'Keep x beside the rows it belongs to. The values begin immediately, without a separate expanded heading.'],
  ['L', 'Let the values form a ledger', 'Name each variable once, then align its numbers. Compact to compare; less sentence-like for a first encounter.'],
  ['M', 'Emphasize the branch you inspect', 'Keep the connection quiet; strengthen the branch you inspect. Click or tab into an iteration to move the emphasis.'],
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
  } finally { kernel.dispose(); }
  const lines = source.split('\n');
  const rows = rowsFor({ lineCount: lines.length,
    lineAt: line => ({ text: lines[line] }) }, [present(response)], 'printed');
  const model = rows[0].loopExplorer;
  const invocation = model.roots[0];
  const outerSite = model.sites.get(invocation.site);
  const iterations = model.children.get(invocation.id).filter(x => x.kind === 'iteration');
  const groups = iterations.map(outer => {
    const inner = model.children.get(outer.id).find(x => x.kind === 'invocation');
    const site = model.sites.get(inner.site);
    const readings = model.children.get(inner.id).filter(x => x.kind === 'iteration').map(entry => ({
      y: entry.value,
      v: entry.body.values.find(value => value.name === 'v').value,
      output: loopSlice(model, entry.start, entry.end, 0).trimEnd(),
    }));
    return { id: outer.id, ordinal: outer.ordinal, x: outer.value,
      source: site.source.replace(/:\s*$/, ''), count: inner.count, readings,
      outputLines: loopSlice(model, outer.start, outer.end, 0).trimEnd().split('\n').length };
  });
  assert.deepEqual(groups.map(group => group.readings), [
    [{ y: '0', v: '0', output: '0 0' }, { y: '1', v: '1', output: '0 1' }, { y: '2', v: '2', output: '0 2' }],
    [{ y: '0', v: '1', output: '1 0' }, { y: '1', v: '2', output: '1 1' }, { y: '2', v: '3', output: '1 2' }],
  ]);
  assert.equal(model.sites.get([...model.sites.values()].find(site => site.parent !== null).id).parent, outerSite.id);
  assert.deepEqual(groups.map(group => group.count), [3, 3]);
  const state = newLoopViewState();
  for (const item of iterations) state.expanded.set(item.id, true);
  const production = loopExplorerHtml(model, 0, state);
  const help = production.match(/<details class="loop-recording-details"[\s\S]*?<\/details>/)[0];
  const foot = '<div class="loop-final">Final values after this loop: '
    + model.wire.final_values.map(value => e(value.name) + ' = ' + e(value.value)).join(', ')
    + '</div><div class="loop-export"><span>Open statement printed output</span></div>';
  const rootHeading = '<div class="concept-root-source">' + e(outerSite.source.replace(/:\s*$/, ''))
    + ' <span class="loop-note">· ' + invocation.count + ' iterations</span></div>';
  const overview = '<div class="concept-overview">' + rootHeading + help + '</div>';
  const sourceMap = '<div class="source-map"><span class="source-elbow" aria-hidden="true"></span>'
    + '<span>' + e(groups[0].source) + ' <span class="loop-note">· 3 iterations each</span></span></div>';
  const columns = '<div class="concept-columns"><span>Variables</span><span>Printed output</span></div>';
  const ordinaryRows = group => group.readings.map(reading =>
    '<div class="concept-reading" data-reading data-y="' + e(reading.y) + '" data-v="' + e(reading.v) + '">'
    + '<span class="reading-values">y = ' + e(reading.y) + ', v = ' + e(reading.v) + '</span>'
    + '<span class="reading-output">' + e(reading.output) + '</span></div>').join('');
  const toggle = (group, contents, klass = '') =>
    '<button class="concept-toggle ' + klass + '" data-toggle-group aria-expanded="'
    + (group.ordinal === 2 ? 'true' : 'false') + '"><span class="fold" aria-hidden="true">'
    + (group.ordinal === 2 ? '▾' : '▸') + '</span>' + contents + '</button>';
  const openGroup = group => '<section class="concept-group" data-outer="' + group.ordinal
    + '" data-expanded="' + (group.ordinal === 2) + '">';
  function custom(id) {
    let content = overview;
    if (['J', 'K', 'L'].includes(id)) content += sourceMap;
    content += id === 'L'
      ? '<div class="ledger-head"><span>Variables</span><span>Printed output</span></div>'
        + '<div class="ledger-subhead"><span>x</span><span>y</span><span>v</span><span></span></div>'
      : columns;
    for (const group of groups) {
      content += openGroup(group);
      const hidden = group.ordinal === 1 ? ' hidden' : '';
      if (id === 'I') {
        content += toggle(group, '<span class="gold">x = ' + e(group.x) + '</span>'
          + '<span class="loop-note"> · </span><span class="fused-source">' + e(group.source) + '</span>'
          + '<span class="loop-note"> · ' + group.count + ' iterations · printed ' + group.outputLines + ' lines</span>');
        content += '<div class="group-detail"' + hidden + '>' + ordinaryRows(group) + '</div>';
      } else if (id === 'J') {
        content += toggle(group, '<span class="gold">Iteration ' + group.ordinal + ' · x = ' + e(group.x)
          + '</span><span class="loop-note"> · printed ' + group.outputLines + ' lines</span>');
        content += '<div class="group-detail"' + hidden + '>' + ordinaryRows(group) + '</div>';
      } else if (id === 'K') {
        content += toggle(group, '<span class="gold">x = ' + e(group.x) + '</span>', 'margin-context');
        content += '<div class="closed-summary"' + (group.ordinal === 2 ? ' hidden' : '') + '><span>'
          + group.count + ' iterations</span><span>' + group.outputLines + ' lines</span></div>';
        content += '<div class="group-detail"' + hidden + '>' + ordinaryRows(group) + '</div>';
      } else if (id === 'L') {
        content += toggle(group, '<span class="gold">' + e(group.x) + '</span>', 'ledger-context');
        content += '<div class="closed-summary"' + (group.ordinal === 2 ? ' hidden' : '') + '><span>'
          + group.count + ' iterations</span><span>' + group.outputLines + ' lines</span></div>';
        content += '<div class="group-detail"' + hidden + '>' + group.readings.map(reading =>
          '<div class="ledger-reading" data-reading data-y="' + e(reading.y) + '" data-v="' + e(reading.v) + '">'
          + '<span class="reading-y">' + e(reading.y) + '</span>'
          + '<span class="reading-v">' + e(reading.v) + '</span>'
          + '<span class="reading-output">' + e(reading.output) + '</span></div>').join('') + '</div>';
      }
      content += '</section>';
    }
    return '<div class="concept-explorer">' + content + foot + '</div>';
  }
  const cards = variants.map(([id, title, caption]) =>
    '<article class="option" data-option="' + id + '">'
    + '<header class="option-heading"><span class="letter">' + id + '</span><h2>' + title + '</h2></header>'
    + '<div class="sample ' + (id === 'H' || id === 'M' ? 'production-sample' : 'custom-sample') + '">'
    + (id === 'H' || id === 'M'
      ? '<span class="outer-fold" aria-hidden="true">▾</span>' + production
        + '<svg class="tree-guide" aria-hidden="true"></svg>'
      : '<span class="source-root-dot" aria-hidden="true">▾</span>' + custom(id))
    + '</div><p class="caption">' + caption + '</p></article>').join('\n');
  const references = [
    ['CURRENT', 'Current layout', 'The production renderer, with no tree guides. First iteration folded; second open.'],
    ['F', 'Previous F · connect loop headers', 'The earlier proposal, with both iterations open. Branches lead directly to each inner for header.'],
  ].map(([id, title, caption]) => '<article class="option reference" data-option="' + id + '">'
    + '<header class="option-heading"><span class="letter">' + (id === 'CURRENT' ? 'NOW' : id) + '</span><h2>' + title + '</h2></header>'
    + '<div class="sample production-sample"><span class="outer-fold" aria-hidden="true">▾</span>'
    + production + (id === 'F' ? '<svg class="tree-guide" aria-hidden="true"></svg>' : '')
    + '</div><p class="caption">' + caption + '</p></article>').join('');
  const html = fs.readFileSync(path.join(__dirname, 'tufte-template.html'), 'utf8')
    .replace('__PRODUCTION_STYLE__', LOOP_EXPLORER_STYLE)
    .replace('__SOURCE__', e(source.trimEnd())).replace('__OPTIONS__', cards).replace('__REFERENCES__', references);
  const target = path.join(__dirname, 'tufte-loop-explorations.html');
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
    await page.setViewport({ width: 1960, height: 1800, deviceScaleFactor: 2 });
    await page.goto('file://' + target);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.drawGuides());
    const png = path.join(__dirname, 'tufte-loop-explorations.png');
    await page.screenshot({ path: png, fullPage: true });
    console.log('First image ready: ' + png);
    const checks = await page.evaluate(() => window.checkConcepts());
    assert.equal(checks.length, 6);
    for (const check of checks) {
      assert.equal(check.columnPairs, 1, check.option + ' headings');
      assert.deepEqual(check.expanded, [false, true], check.option + ' folds');
      assert.deepEqual(check.output, ['1 0', '1 1', '1 2'], check.option + ' output');
      assert.deepEqual(check.values, ['y = 0, v = 1', 'y = 1, v = 2', 'y = 2, v = 3'], check.option + ' values');
      assert.equal(check.helpControls, 1);
      assert.equal(check.overflow, false, check.option + ' overflow');
      assert.match(check.final, /x = 1, y = 2, v = 3/);
    }
    // Exercise every fold: mixed -> all open -> all closed -> mixed again.
    const interactions = await page.evaluate(() => window.checkFolding());
    for (const result of interactions) {
      assert.deepEqual(result.allOpen, ['0 0', '0 1', '0 2', '1 0', '1 1', '1 2']);
      assert.deepEqual(result.allClosed, []);
      assert.deepEqual(result.restored, ['1 0', '1 1', '1 2']);
    }
    const referenceChecks = await page.evaluate(() =>
      [...document.querySelectorAll('.references > .option')].map(card => ({
        option: card.dataset.option, output: groupOutput(card),
        expanded: productionGroups(card).map(group =>
          group.querySelector('button[aria-expanded]').getAttribute('aria-expanded')),
        sharedHeadings: card.querySelectorAll('.loop-columns').length,
        guides: card.querySelectorAll('.tree-guide').length,
      })));
    assert.deepEqual(referenceChecks[0].output, ['1 0', '1 1', '1 2']);
    assert.deepEqual(referenceChecks[0].expanded, ['false', 'true']);
    assert.equal(referenceChecks[0].guides, 0);
    assert.deepEqual(referenceChecks[1].output, ['0 0', '0 1', '0 2', '1 0', '1 1', '1 2']);
    assert.deepEqual(referenceChecks[1].expanded, ['true', 'true']);
    assert.equal(referenceChecks[1].guides, 1);
    for (const check of referenceChecks) assert.equal(check.sharedHeadings, 1);
    const focusChecks = await page.evaluate(() => {
      const card = document.querySelector('[data-option="M"]');
      const groups = productionGroups(card);
      groups[0].querySelector('button').focus();
      const first = card.querySelector('.tree-guide .active').dataset.target;
      groups[1].querySelector('button').focus();
      const second = card.querySelector('.tree-guide .active').dataset.target;
      return { first, second };
    });
    assert.deepEqual(focusChecks, { first: 'folded-caption', second: 'inner-source' });
    await page.setViewport({ width: 900, height: 1000, deviceScaleFactor: 1 });
    const narrow = await page.evaluate(() => {
      window.drawGuides();
      const cards = [...document.querySelectorAll('.options > .option')];
      return {
        width: innerWidth,
        lefts: cards.map(card => card.getBoundingClientRect().left),
        sourceFontSizes: cards.map(card => getComputedStyle(card.querySelector('.loop-root-source, .concept-root-source')).fontSize),
        pageOverflow: document.documentElement.scrollWidth > innerWidth,
        checks: window.checkConcepts(),
      };
    });
    assert.equal(new Set(narrow.lefts).size, 1);
    assert.equal(narrow.pageOverflow, false);
    assert.ok(narrow.sourceFontSizes.every(size => size === '20px'));
    assert.ok(narrow.checks.every(check => !check.overflow));
    assert.deepEqual(errors, []);
    const bytes = fs.readFileSync(png);
    const report = {
      kind: 'unimplemented interactive design concepts',
      fixture, fixtureSha256: hash(source), kernelRequests: 1,
      rendererSource: 'H/M use compiled production markup; I/J/K/L use standalone concept layouts with the same recorded model.',
      screenshot: { file: 'tufte-loop-explorations.png', sha256: hash(bytes),
        width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), deviceScaleFactor: 2 },
      capturedGroups: groups, referenceChecks, checks, interactions, focusChecks, narrow, browserErrors: errors,
      limitations: 'Concept HTML only. Folding is local, with no evaluation or VS Code connection. No runtime changes or selected implementation.',
    };
    fs.writeFileSync(path.join(__dirname, 'tufte-checks.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('Six concepts and local folding verified: ' + report.screenshot.width + ' × ' + report.screenshot.height);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
