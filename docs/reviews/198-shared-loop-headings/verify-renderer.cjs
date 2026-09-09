'use strict';

// Real kernel responses, compiled panel CSS/script, and Chromium layout.
// This is a renderer check, not an Extension Host or screen-reader review.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const puppeteer = require(path.join(root, 'node_modules/puppeteer-core'));
const { KernelClient } = require(path.join(root, 'out/kernel/client'));
const { present } = require(path.join(root, 'out/render/present'));
const { rowsFor, valuesHtml } = require(path.join(root, 'out/panel/html'));
const { newLoopViewState } = require(path.join(root, 'out/panel/loopExplorer'));
const destination = process.argv[2] || __dirname;
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
const fixtures = {
  nested: 'for x in range(2):\n    for y in range(3):\n        v = x + y\n        print(x, y)\n',
  large: 'for x in range(100):\n    for y in range(100):\n        print(x, y)\n',
  deep: 'for x in [0, 1]:\n    for y in [2, 3]:\n        for z in [4, 5]:\n            print(x, y, z)\n    for sibling in [6, 7]:\n        print(x, sibling)\n',
  timing: 'for v in [1]:\n    u = 4\n    print(u)\n    u = 99\n',
  missing: 'for v in [1]:\n    u = 4\n    print(u)\n    continue\n',
};

async function main() {
  const kernel = new KernelClient({ resolvePython: async () => 'python3',
    kernelPath: path.join(root, 'kernel/evalens_kernel.py') });
  const captures = {};
  let requests = 0;
  try {
    for (const [name, source] of Object.entries(fixtures)) {
      const response = await kernel.request({ op: 'eval', source, line: 0,
        character: 0, filename: `/private/tmp/evalens-198-${name}.py`, allow_stdin: false });
      requests++;
      assert.equal(response.ok, true);
      const lines = source.split('\n');
      const rows = rowsFor({ lineCount: lines.length,
        lineAt: line => ({ text: lines[line] }) }, [present(response)], 'printed');
      assert.ok(rows[0].loopExplorer);
      captures[name] = { rows, model: rows[0].loopExplorer, response };
    }
  } finally { kernel.dispose(); }
  const browser = await puppeteer.launch({ headless: true,
    executablePath: process.env.EVALENS_CHROME_PATH
      || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const measurements = [];
  async function render(name, width, fontSize, theme = 'dark', state = newLoopViewState()) {
    await page.setViewport({ width, height: 600 });
    await page.goto('about:blank');
    await page.evaluate(() => {
      window.messages = [];
      window.acquireVsCodeApi = () => ({ getState: () => undefined,
        setState: () => {}, postMessage: message => window.messages.push(message) });
    });
    const { rows, model } = captures[name];
    const light = theme.includes('light');
    let html = valuesHtml({ fileName: `${name}.py`, rows }, 0, 'review', undefined,
      { loopStates: new Map([[model.wire, state]]) }, true, 1, true, false,
      { introDismissed: true, resetOnLoad: true });
    html = html.replace('<style nonce="review">', `<style nonce="review">:root {
      --vscode-editor-font-family: Menlo, monospace;
      --vscode-editor-font-size: ${fontSize}px;
      --vscode-font-size: 13px;
      --vscode-panel-background: ${light ? '#ffffff' : '#181818'};
      --vscode-editor-foreground: ${light ? '#333333' : '#cccccc'};
      --vscode-foreground: ${light ? '#333333' : '#cccccc'};
      --vscode-descriptionForeground: ${light ? '#666666' : '#aaaaaa'};
      --vscode-panel-border: ${light ? '#dddddd' : '#333333'};
      --vscode-textLink-foreground: ${light ? '#006ab1' : '#64a9de'};
      --vscode-focusBorder: #007fd4;
    }`).replace('<body>', `<body class="vscode-${theme}">`);
    await page.setContent(html, { waitUntil: 'load' });
    await pause();
  }
  async function geometry() {
    return page.evaluate(() => {
      const header = document.querySelector('.loop-columns');
      const columns = getComputedStyle(header).display !== 'none';
      const lefts = node => [...node.children].map(child => child.getBoundingClientRect().left);
      const overview = document.querySelector('.loop-overview').getBoundingClientRect();
      const title = document.querySelector('.loop-title').getBoundingClientRect();
      const source = document.querySelector('.loop-root-source');
      const sourceRect = source.getBoundingClientRect();
      const help = document.querySelector('.loop-recording-details').getBoundingClientRect();
      // Compare the actual title with its natural wrapping at the full
      // result width. No-overflow alone misses a title crushed to 5ch.
      const reference = source.cloneNode(true);
      reference.style.cssText = `position: fixed; visibility: hidden; width: ${overview.width}px; font: ${getComputedStyle(source).font}`;
      document.body.append(reference);
      const fullWidthHeight = reference.getBoundingClientRect().height;
      reference.remove();
      return {
        width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        headings: document.querySelectorAll('.loop-columns').length,
        help: document.querySelectorAll('.loop-recording-details').length,
        timingRows: document.querySelectorAll('.loop-value-timing, .loop-owner').length,
        columns, headerLefts: lefts(header),
        title: { width: title.width, availableWidth: overview.width,
          height: sourceRect.height, fullWidthHeight, helpBelow: help.top >= sourceRect.bottom - 1 },
        rows: [...document.querySelectorAll('.loop-data')].map(row => ({
          lefts: lefts(row), output: row.children[1].innerText,
          variableLabel: row.querySelector('.loop-stack-label')?.getClientRects().length > 0,
          outputLabel: row.querySelector('.loop-stream-label.loop-stack-label')?.getClientRects().length > 0,
        })),
        controls: [...document.querySelectorAll('.loop-explorer button, .loop-explorer summary')]
          .filter(node => node.getClientRects().length).map(node => {
            const box = node.getBoundingClientRect();
            return { label: node.textContent, left: box.left, right: box.right };
          }),
      };
    });
  }
  try {
    for (const name of ['nested', 'deep']) {
      for (const width of [300, 560, 900, 1400]) {
        for (const fontSize of [14, 28]) {
          for (const theme of ['dark', 'light', 'high-contrast', 'high-contrast-light']) {
            await render(name, width, fontSize, theme);
            const result = await geometry();
            assert.equal(result.headings, 1);
            assert.equal(result.help, 1);
            assert.equal(result.timingRows, 0);
            assert.ok(result.scrollWidth <= width + 1, JSON.stringify(result));
            assert.ok(result.title.width >= Math.min(result.title.availableWidth, fontSize * .55 * 24) - 1,
              JSON.stringify({ name, width, fontSize, title: result.title }));
            if (width <= 560 && fontSize === 28) {
              assert.ok(result.title.helpBelow, 'help should wrap below a narrow, large-font title');
              assert.ok(Math.abs(result.title.width - result.title.availableWidth) < 1);
              assert.ok(Math.abs(result.title.height - result.title.fullWidthHeight) < 1,
                'help must not force the title onto extra lines');
            }
            for (const row of result.rows) {
              if (result.columns) {
                for (let i = 0; i < 2; i++) assert.ok(Math.abs(row.lefts[i] - result.headerLefts[i]) < 1,
                  JSON.stringify({ width, fontSize, name, row, header: result.headerLefts }));
              } else {
                assert.ok(row.variableLabel);
                assert.ok(row.outputLabel);
              }
            }
            for (const control of result.controls) assert.ok(control.left >= 0 && control.right <= width + 1,
              JSON.stringify({ width, fontSize, control }));
            measurements.push({ name, width, fontSize, theme, columns: result.columns,
              rows: result.rows.length, headings: result.headings, help: result.help, title: result.title });
            if (name === 'nested' && width === 560 && fontSize === 28 && theme === 'dark'
              && process.env.EVALENS_198_SCREENSHOT) {
              await page.$eval('.loop-overview', node => node.scrollIntoView({ block: 'start' }));
              await pause();
              await page.screenshot({ path: process.env.EVALENS_198_SCREENSHOT });
            }
          }
        }
      }
    }
    await render('timing', 1400, 16);
    assert.match(await page.$eval('.loop-data', node => node.textContent), /v = 1, u = 99/);
    assert.equal(await page.$eval('.loop-output', node => node.textContent), '4');
    await page.focus('.loop-recording-details > summary');
    await page.keyboard.press('Enter');
    await pause();
    assert.equal(await page.$eval('.loop-recording-details', node => node.open), true);
    assert.match(await page.$eval('.loop-explanation', node => node.innerText), /u = 99 beside printed 4/);
    assert.equal(await page.evaluate(() => window.messages.length), 0);
    await render('missing', 1400, 16);
    await page.focus('.loop-missing-why > summary');
    await page.keyboard.press('Space');
    await pause();
    assert.equal(await page.$eval('.loop-missing-why', node => node.open), true);
    assert.match(await page.$eval('.loop-missing-why', node => node.innerText), /does not tell us whether the assignment ran/);
    assert.equal(await page.evaluate(() => window.messages.length), 0);

    const state = newLoopViewState();
    const large = captures.large.model;
    const first = large.children.get(large.roots[0].id)[0];
    state.expanded.set(first.id, true);
    await render('large', 1400, 16, 'dark', state);
    assert.equal(await page.$eval('.loop-scroll-owner', node => node.hidden), true);
    const inner = large.children.get(first.id)[0];
    const tenth = large.children.get(inner.id)[9];
    await page.$eval(`[data-loop-entry="${tenth.id}"]`, node => node.scrollIntoView({ block: 'start' }));
    await pause();
    const sticky = await page.$eval('.loop-context', node => ({
      top: node.getBoundingClientRect().top,
      toolbarBottom: document.getElementById('navigation-control').getBoundingClientRect().bottom,
      owner: node.querySelector('.loop-scroll-owner').textContent,
      hidden: node.querySelector('.loop-scroll-owner').hidden,
      bodySize: document.body.scrollHeight,
    }));
    assert.ok(Math.abs(sticky.top - sticky.toolbarBottom) < 1);
    assert.equal(sticky.hidden, false);
    assert.match(sticky.owner, /Iteration 1 · x = 0/);
    assert.match(sticky.owner, /for y in range\(100\)/);
    await page.evaluate(() => window.scrollTo(0, 0));
    await pause();
    assert.equal(await page.$eval('.loop-scroll-owner', node => node.hidden), true);
    assert.equal(await page.evaluate(() => document.body.scrollHeight), sticky.bodySize,
      'showing owner context must not change document height');
    await page.click('.result-disclosure');
    assert.equal(await page.$eval('.result-detail', node => node.hidden), true);
    const folded = await page.$eval('tr.row', node => ({
      code: node.querySelector('.source-content').getBoundingClientRect().height,
      summary: node.querySelector('.result-summary').getBoundingClientRect().height,
    }));
    assert.ok(Math.abs(folded.code - folded.summary) < 1);
    assert.equal(requests, 5);
    assert.deepEqual(errors, []);
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'renderer-results.json'), JSON.stringify({
      kernelRequests: requests, browserErrors: errors, measurements, sticky, folded,
      limitations: 'Chromium renderer checks only. Native Extension Host review is separate; no human screen-reader session.'
    }, null, 2) + '\n');
    console.log(`${measurements.length} layout cases, keyboard help, scroll ownership and R2 fold passed`);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
