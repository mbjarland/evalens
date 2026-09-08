'use strict';

// Real kernel -> compiled panel renderer -> Chromium layout. This does not
// simulate VS Code's source navigation; the Host review checks that separately.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const { KernelClient } = require(path.join(root, 'out/kernel/client.js'));
const { present } = require(path.join(root, 'out/render/present.js'));
const { rowsFor, valuesHtml } = require(path.join(root, 'out/panel/html.js'));
const puppeteer = require('puppeteer-core');
const destination = process.argv[2] || __dirname;

async function main() {
  const lines = Array(137).fill('');
  lines[0] = 'for n in range(3):';
  lines[1] = '    print(n * n)';
  lines[4] = '42';
  lines[136] = '"A deliberately long source line keeps its own ellipsis"';
  const source = lines.join('\n');
  const kernel = new KernelClient({
    resolvePython: async () => 'python3',
    kernelPath: path.join(root, 'kernel/evalens_kernel.py'),
  });
  const annotations = [];
  try {
    for (const line of [0, 4, 136]) {
      const response = await kernel.request({
        op: 'eval', source, line, character: 0,
        filename: '/private/tmp/evalens-gutter-fixture.py', allow_stdin: false,
      });
      const annotation = present(response, line);
      assert.equal(annotation.kind, 'value');
      annotations.push(annotation);
    }
  } finally {
    kernel.dispose();
  }
  const rows = rowsFor({ lineAt: (line) => ({ text: lines[line] }) },
    annotations, 'printed');
  assert.deepEqual(rows.map((row) => row.line), [0, 4, 136]);
  const browser = await puppeteer.launch({ headless: true,
    executablePath: process.env.EVALENS_CHROME_PATH
      || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });
  fs.mkdirSync(destination, { recursive: true });
  const measurements = [];
  try {
    for (const font of ['Menlo', 'Courier New']) {
      for (const fontSize of [14, 28]) {
        for (const theme of ['dark', 'light', 'high-contrast']) {
          const page = await browser.newPage();
          try {
            await page.setViewport({ width: 1500, height: 700 });
            const light = theme === 'light';
            let html = valuesHtml({ fileName: 'gutter-fixture.py', rows,
              latestResultLine: 4 }, 0, 'gutter-review');
            html = html.replace('<style nonce="gutter-review">',
              `<style nonce="gutter-review">:root {
                --vscode-editor-font-family: '${font}', monospace;
                --vscode-editor-font-size: ${fontSize}px;
                --vscode-panel-background: ${light ? '#ffffff' : '#181818'};
                --vscode-foreground: ${light ? '#333333' : '#cccccc'};
                --vscode-descriptionForeground: ${light ? '#666666' : '#aaaaaa'};
                --vscode-panel-border: ${light ? '#dddddd' : '#333333'};
                --vscode-focusBorder: ${theme === 'high-contrast' ? '#f38518' : '#007fd4'};
              }`);
            html = html.replace('<body>', `<body>
              <script nonce="gutter-review">window.messages = [];
              window.acquireVsCodeApi = () => ({
                getState: () => undefined, setState: () => {},
                postMessage: message => window.messages.push(message)
              });</script>`);
            await page.setContent(html, { waitUntil: 'load' });
            const geometry = await page.evaluate(() => {
              const result = [];
              const bounds = (node) => {
                const range = document.createRange();
                range.selectNodeContents(node);
                const rect = range.getBoundingClientRect();
                return { left: rect.left, right: rect.right };
              };
              // Exercise the bold cursor gutter at every line-number width.
              for (const active of document.querySelectorAll('tr.row')) {
                document.querySelectorAll('tr.row').forEach((row) =>
                  row.classList.toggle('cursor', row === active));
                const gutter = active.querySelector('.line-cell');
                const number = active.querySelector('.line-num');
                const arrow = active.querySelector('.navigation-arrow');
                const code = active.querySelector('.code-line');
                result.push({
                  line: number.textContent,
                  gutterLeft: gutter.getBoundingClientRect().left,
                  gutterRight: gutter.getBoundingClientRect().right,
                  arrowLeft: bounds(arrow).left,
                  numberRight: bounds(number).right,
                  codeLeft: bounds(code).left,
                  gap: bounds(code).left - bounds(number).right,
                  codeWidth: code.getBoundingClientRect().width,
                  codeOverflow: getComputedStyle(code).textOverflow,
                  valueLeft: active.querySelector('.value-cell')
                    .getBoundingClientRect().left,
                });
              }
              return result;
            });
            for (const row of geometry) {
              assert.ok(row.gap >= 9, JSON.stringify(row));
              assert.ok(row.arrowLeft > row.gutterLeft, JSON.stringify(row));
              assert.ok(row.numberRight <= row.gutterRight, JSON.stringify(row));
              assert.equal(row.codeOverflow, 'ellipsis');
            }
            assert.equal(new Set(geometry.map((row) => row.codeLeft)).size, 1);
            assert.equal(new Set(geometry.map((row) => row.valueLeft)).size, 1);
            // Clicking the displayed three-digit line still posts its source
            // coordinate, never a digit-width-dependent target.
            await page.click('tr[data-goto="136"] .line-num');
            const message = await page.evaluate(() => window.messages.at(-1));
            assert.equal(message.goto, 136);
            measurements.push({ font, fontSize, theme, geometry, message });
            if (font === 'Menlo' && theme !== 'high-contrast') {
              await page.screenshot({
                path: path.join(destination, `${theme}-${fontSize}.png`),
                fullPage: true,
              });
            }
          } finally {
            await page.close();
          }
        }
      }
    }
    // A file need not be allocated to verify its later displayed line IDs.
    // Preserve the real computed result and render it at a six-digit row.
    const later = { ...rows[1], line: 999998, startLine: 999998, endLine: 999998 };
    const html = valuesHtml({ fileName: 'later.py', rows: [later] }, 999998, 'n');
    assert.match(html, /--line-number-width: 6ch/);
    assert.match(html, /data-goto="999998"/);
    fs.writeFileSync(path.join(destination, 'renderer-results.json'),
      JSON.stringify({ measurements, sixDigitWidth: true }, null, 2) + '\n');
  } finally {
    await browser.close();
  }
  console.log(`${measurements.length} renderer layout cases passed`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
