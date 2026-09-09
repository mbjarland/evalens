'use strict';
// Uses #205's real-kernel/compiled-renderer approach and approved fixture.
// No layout rules are injected into the rendered page.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const puppeteer = require(path.join(root, 'node_modules/puppeteer-core'));
const { KernelClient } = require(path.join(root, 'out/kernel/client'));
const { present } = require(path.join(root, 'out/render/present'));
const { rowsFor, valuesHtml } = require(path.join(root, 'out/panel/html'));
const { newLoopViewState } = require(path.join(root, 'out/panel/loopExplorer'));
const before = process.argv.includes('--expect-overlap');
const phase = before ? 'before' : 'after';
const fixtures = {
  base: fs.readFileSync(path.join(__dirname, '../205-aligned-loop-guides/base.py'), 'utf8'),
  missing: 'for x in [1]:\n    base = 10\n    print("base:", base)\n'
    + '    for y in range(2):\n        print(x, y)\n    continue\n',
  deep: 'for x in [1]:\n    base = 10\n    print("base:", base)\n'
    + '    for y in range(2):\n        middle = base + y\n        print("middle:", middle)\n'
    + '        for z in range(2):\n            v = middle + z\n            print(x, y, z)\n',
  gaps: 'for x in [1]:\n    print("outer:", x)\n'
    + '    for y in [2]:\n        print("middle:", y)\n'
    + '        for z in [3]:\n            print(x, y, z)\n',
};
const pause = () => new Promise(resolve => setTimeout(resolve, 100));

async function main() {
  const captures = {};
  for (const [name, source] of Object.entries(fixtures)) {
    const kernel = new KernelClient({ resolvePython: async () => 'python3',
      kernelPath: path.join(root, 'kernel/evalens_kernel.py') });
    try {
      const response = await kernel.request({ op: 'eval', source, line: 0,
        character: 0, filename: `/private/tmp/evalens-207-${name}.py`, allow_stdin: false });
      assert.equal(response.ok, true);
      const lines = source.split('\n');
      const rows = rowsFor({ lineCount: lines.length,
        lineAt: line => ({ text: lines[line] }) }, [present(response)], 'printed');
      captures[name] = { rows, model: rows[0].loopExplorer };
    } finally { kernel.dispose(); }
  }
  const browser = await puppeteer.launch({ headless: true,
    executablePath: process.env.EVALENS_CHROME_PATH
      || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const results = [];
  try {
    for (const [name, { rows, model }] of Object.entries(captures)) {
      const state = newLoopViewState(207);
      if (name === 'base') {
        const [first, second] = model.children.get(model.roots[0].id);
        state.expanded.set(first.id, false);
        state.expanded.set(second.id, true);
      }
      for (const [width, font] of [[480, 28], [560, 28], [480, 16], [1400, 20]]) {
        await page.setViewport({ width, height: 1200 });
        await page.goto('about:blank');
        await page.evaluate(() => {
          window.acquireVsCodeApi = () => ({ getState: () => undefined,
            setState: () => {}, postMessage: () => {} });
        });
        let html = valuesHtml({ fileName: `${name}.py`, rows }, 0, 'review', undefined,
          { loopStates: new Map([[model.wire, state]]) }, true, 1, true, false,
          { introDismissed: true, resetOnLoad: true });
        html = html.replace('<style nonce="review">', `<style nonce="review">:root {
          --vscode-editor-font-family: Menlo, monospace; --vscode-editor-font-size: ${font}px;
          --vscode-font-size: 13px; --vscode-panel-background: #181818;
          --vscode-editor-foreground: #cccccc; --vscode-foreground: #cccccc;
          --vscode-descriptionForeground: #aaaaaa; --vscode-panel-border: #333333;
          --vscode-evalens-resultForeground: #d1a35c;
          --vscode-evalens-outputLabelForeground: #5c7fa6;
          --vscode-textLink-foreground: #64a9de; --vscode-focusBorder: #007fd4;
        }`).replace('<body>', '<body class="vscode-dark">');
        await page.setContent(html, { waitUntil: 'load' });
        await pause();
        const measured = await page.evaluate(() => {
          const columns = document.querySelector('.loop-columns');
          const stacked = getComputedStyle(columns).display === 'none';
          const svg = document.querySelector('.loop-guides');
          const origin = svg.getBoundingClientRect();
          const guides = [...svg.querySelectorAll('path')].filter(node =>
            node.dataset.loopGuide === 'child' || node.dataset.loopGuide === 'iterations').map(node => {
            const box = node.getBBox();
            return { kind: node.dataset.loopGuide, x: origin.left + box.x,
              top: origin.top + box.y, bottom: origin.top + box.y + box.height };
          });
          function boxes(node) {
            const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
            const rects = [];
            let text;
            while ((text = walker.nextNode())) {
              if (!text.textContent.trim()) continue;
              const range = document.createRange(); range.selectNodeContents(text);
              for (const box of range.getClientRects()) if (box.width && box.height)
                rects.push({ left: box.left, right: box.right, top: box.top, bottom: box.bottom });
            }
            return rects;
          }
          const cells = [...document.querySelectorAll('.loop-data > :nth-child(2)')];
          const readings = [];
          for (const cell of cells) {
            const row = cell.parentElement, first = row.firstElementChild;
            const variable = first.querySelector('button');
            const variableBox = variable && boxes(variable)[0];
            for (const node of cell.querySelectorAll('.loop-stream-label, .loop-output')) {
              const rects = boxes(node);
              if (!rects.length) continue;
              readings.push({ rowClass: row.className,
                depth: Number(row.closest('.loop-invocation').dataset.loopDepth),
                role: node.classList.contains('loop-output') ? 'text' : 'label',
                text: node.textContent, rects,
                variableLeft: variableBox?.left,
                clearance: rects.flatMap(rect => guides.filter(guide =>
                  rect.bottom > guide.top && rect.top < guide.bottom)
                  .map(guide => rect.left - guide.x)) });
            }
          }
          return { stacked, guides, readings,
            widePrintedLeft: stacked ? undefined : boxes(columns.children[1])[0].left,
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
            parentText: document.querySelector('.loop-parent-reading')?.innerText,
            output: [...document.querySelectorAll('.loop-output')].map(node => node.textContent),
          };
        });
        const result = { name, width, font, ...measured };
        results.push(result);
        if (width === 480 && font === 28)
          await page.screenshot({ path: path.join(__dirname, `${phase}-${name}-480-28.png`), fullPage: true });
      }
    }
    fs.writeFileSync(path.join(__dirname, `${phase}-geometry.json`), JSON.stringify({
      kernelRequests: Object.keys(fixtures).length, browserErrors: errors, results,
    }, null, 2) + '\n');
    assert.deepEqual(errors, []);
    const failures = results.flatMap(result => result.stacked ? result.readings.filter(reading =>
      reading.clearance.some(gap => gap < 7)).map(reading => ({ name: result.name,
      width: result.width, font: result.font, ...reading })) : []);
    if (before) {
      assert.ok(failures.length > 0, 'the regression must reproduce before the fix');
      console.log(`${failures.length} stacked labels/text readings cross or intrude into the guide gutter before the fix`);
      return;
    }
    assert.deepEqual(failures, []);
    const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'before-geometry.json'), 'utf8')).results;
    for (const result of results) {
      assert.equal(result.overflow, false);
      if (!result.stacked) assert.deepEqual(result, baseline.find(previous =>
        previous.name === result.name && previous.width === result.width && previous.font === result.font),
      'wide text and guide geometry must remain exactly unchanged');
      for (const reading of result.readings) {
        if (result.stacked && reading.variableLeft !== undefined)
          assert.ok(Math.abs(reading.rects[0].left - reading.variableLeft) < 1);
        if (!result.stacked && reading.role === 'text')
          assert.ok(Math.abs(reading.rects[0].left - result.widePrintedLeft) < 1);
      }
      if (result.name === 'base') {
        assert.match(result.parentText, /base = 10/);
        assert.deepEqual(result.output, ['base: 10', '1 0', '1 1', '1 2']);
      }
      if (result.name === 'missing') assert.match(result.parentText, /base: not recorded/);
      if (result.name === 'gaps') {
        assert.deepEqual(result.output, ['outer: 1', 'middle: 2', '1 2 3']);
        assert.ok(result.readings.some(reading => reading.rowClass.includes('loop-direct') && reading.depth === 1));
      }
    }
    console.log('Stacked labels/text clear guides; body, gap, missing and deeper rows remain readable; wide output edge unchanged');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
