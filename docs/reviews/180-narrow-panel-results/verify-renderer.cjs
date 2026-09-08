'use strict';

// Real Python responses rendered by the compiled panel and measured in
// Chromium. Source messages and folding run the real embedded page script;
// the Extension Development Host review separately checks editor routing.
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
  const fixtures = [
    'answer = 42',
    'print("a long output line " * 10 + "\\n" * 40 + "last output")',
    'for v in [1, 2, 3]:\n    u = 4 * v\n    print("value is", u)',
    'for x in range(2):\n    for y in range(2):\n        print(x, y)',
    'import sys\nfor n in range(2):\n    print("ordinary", n)\n    print("warning", n, file=sys.stderr)',
    'raise ValueError("an intentionally long error message " * 5)',
  ];
  const source = fixtures.join('\n\n');
  const sourceLines = source.split('\n');
  const starts = [];
  let start = 0;
  for (const fixture of fixtures) {
    starts.push(start); start += fixture.split('\n').length + 1;
  }
  const kernel = new KernelClient({ resolvePython: async () => 'python3',
    kernelPath: path.join(root, 'kernel/evalens_kernel.py') });
  const annotations = [];
  try {
    for (const line of starts) {
      if (sourceLines[line] === 'import sys') {
        await kernel.request({ op: 'eval', source, line, character: 0,
          filename: '/private/tmp/evalens-narrow-fixture.py', allow_stdin: false });
      }
      const actualLine = sourceLines[line] === 'import sys' ? line + 1 : line;
      const response = await kernel.request({ op: 'eval', source, line: actualLine,
        character: 0, filename: '/private/tmp/evalens-narrow-fixture.py', allow_stdin: false });
      const shown = present(response, actualLine);
      assert.notEqual(shown.kind, 'nothing');
      annotations.push(shown.kind === 'error'
        ? { ...shown, error: { type: shown.type, message: shown.message } } : shown);
    }
  } finally { kernel.dispose(); }
  const rows = rowsFor({ lineAt: (line) => ({ text: sourceLines[line] }) }, annotations, 'printed');
  assert.equal(rows.length, 6);
  assert.equal(rows.filter((row) => row.loopExplorer).length, 3);
  assert.match(rows.at(-1).errorText, /^ValueError: an intentionally long/);
  const browser = await puppeteer.launch({ headless: true,
    executablePath: process.env.EVALENS_CHROME_PATH
      || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  fs.mkdirSync(destination, { recursive: true });
  const measurements = [];
  try {
    for (const width of [300, 450, 900]) {
      for (const fontSize of [14, 28]) {
        for (const theme of ['dark', 'light', 'high-contrast', 'high-contrast-light']) {
          const page = await browser.newPage();
          try {
            await page.setViewport({ width, height: 1200 });
            const light = theme.includes('light');
            const contrast = theme.includes('contrast');
            let html = valuesHtml({ fileName: 'narrow-fixture.py', rows,
              latestResultLine: starts[2] }, starts[2], 'narrow-review');
            html = html.replace('<style nonce="narrow-review">',
              `<style nonce="narrow-review">:root {
                --vscode-editor-font-family: Menlo, monospace;
                --vscode-editor-font-size: ${fontSize}px;
                --vscode-font-size: 13px;
                --vscode-panel-background: ${light ? '#ffffff' : '#181818'};
                --vscode-editor-foreground: ${light ? '#333333' : '#cccccc'};
                --vscode-foreground: ${light ? '#333333' : '#cccccc'};
                --vscode-descriptionForeground: ${light ? '#666666' : '#aaaaaa'};
                --vscode-panel-border: ${light ? '#dddddd' : '#333333'};
                --vscode-evalens-resultForeground: #d8af62;
                --vscode-evalens-outputLabelForeground: #779abe;
                --vscode-textLink-foreground: ${light ? '#006ab1' : '#64a9de'};
                --vscode-focusBorder: ${contrast ? '#f38518' : '#007fd4'};
              }`);
            html = html.replace('<body>', `<body class="vscode-${theme}">
              <script nonce="narrow-review">window.messages = [];
              window.acquireVsCodeApi = () => ({
                getState: () => undefined, setState: () => {},
                postMessage: message => window.messages.push(message)
              });</script>`);
            await page.setContent(html, { waitUntil: 'load' });
            await new Promise((resolve) => setTimeout(resolve, 100));
            const result = await page.evaluate(() => {
              const rect = (node) => {
                const r = node.getBoundingClientRect();
                return { left: r.left, right: r.right, top: r.top,
                  bottom: r.bottom, width: r.width, height: r.height };
              };
              return {
                scrollWidth: document.documentElement.scrollWidth,
                viewport: innerWidth,
                rows: [...document.querySelectorAll('tr.row')].map((row) => ({
                  source: rect(row.querySelector('.code-cell')),
                  gutter: rect(row.querySelector('.line-cell')),
                  values: rect(row.querySelector('.value-cell')),
                })),
                controls: [...document.querySelectorAll('button, input')]
                  .filter((node) => node.getClientRects().length)
                  .map((node) => ({ text: node.textContent, ...rect(node) })),
                timingVisible: [...document.querySelectorAll('.loop-value-timing')]
                  .every((node) => node.getClientRects().length > 0),
                loops: [...document.querySelectorAll('.loop-explorer')].map((loop) => {
                  const data = loop.querySelector('.loop-data');
                  return { width: loop.getBoundingClientRect().width,
                    columns: data && getComputedStyle(data).gridTemplateColumns,
                    labels: [...loop.querySelectorAll('.loop-stack-label')]
                      .filter((node) => node.getClientRects().length)
                      .map((node) => node.textContent) };
                }),
              };
            });
            assert.ok(result.scrollWidth <= width + 1, JSON.stringify(result));
            assert.ok(result.timingVisible, 'capture timing remains visible');
            if (width === 300 && fontSize === 28) {
              assert.ok(result.loops.every((loop) => loop.labels.includes('Variables')
                && loop.labels.includes('Printed output: ')));
            }
            for (const row of result.rows) {
              assert.ok(row.values.width > width / 3, JSON.stringify(row));
              assert.ok(row.values.right <= width + 1, JSON.stringify(row));
              assert.ok(row.source.left >= row.gutter.right, JSON.stringify(row));
              if (width <= 450) assert.ok(row.values.top >= row.source.bottom - 1);
              else assert.ok(Math.abs(row.values.top - row.source.top) < 1);
            }
            for (const control of result.controls) {
              assert.ok(control.width > 0 && control.left >= 0
                && control.right <= width + 1, JSON.stringify(control));
            }
            const loopRow = `tr[data-goto="${starts[2]}"]`;
            const toggle = `${loopRow} .result-disclosure`;
            await page.click(toggle);
            const folded = await page.$eval(loopRow, (row) => ({
              hidden: row.querySelector('.result-detail').hidden,
              sourceHeight: row.querySelector('.source-content').getBoundingClientRect().height,
              summaryHeight: row.querySelector('.result-summary').getBoundingClientRect().height,
              radius: getComputedStyle(row.querySelector('.result-summary')).borderRadius,
            }));
            assert.equal(folded.hidden, true);
            assert.ok(Math.abs(folded.sourceHeight - folded.summaryHeight) < 1);
            assert.equal(folded.radius, '0px');
            await page.click(toggle);
            await page.click(`${loopRow} .line-num`);
            const message = await page.evaluate(() => window.messages.at(-1));
            assert.equal(message.goto, starts[2]);
            // The same open result survives width changes without rebuilding
            // or issuing an evaluation request; observer remeasures its fold.
            await page.setViewport({ width: width === 300 ? 900 : 300, height: 1200 });
            await new Promise((resolve) => setTimeout(resolve, 100));
            assert.equal(await page.$eval(`${loopRow} .result-detail`, (node) => node.hidden), false);
            await page.setViewport({ width, height: 1200 });
            await page.$eval(loopRow, (node) => node.scrollIntoView());
            if (theme === 'dark') await page.screenshot({
              path: path.join(destination, `dark-${width}-${fontSize}.png`) });
            // UI-font scaling is independent of the editor font. A large
            // toolbar must wrap its text without shrinking the checkbox.
            const toolbar = width === 300 && fontSize === 28
              ? await page.evaluate(() => {
                document.documentElement.style.setProperty('--vscode-font-size', '28px');
                return { scrollWidth: document.documentElement.scrollWidth,
                  labels: [...document.querySelectorAll('.navigation-control label')]
                    .map((node) => ({ width: node.getBoundingClientRect().width,
                      height: node.getBoundingClientRect().height,
                      checkboxWidth: node.querySelector('input').getBoundingClientRect().width })) };
              }) : undefined;
            if (toolbar) {
              assert.ok(toolbar.scrollWidth <= width + 1);
              assert.ok(toolbar.labels.every((label) => label.width <= width - 20
                && label.checkboxWidth >= 12));
              assert.ok(toolbar.labels.at(-1).height > 56);
            }
            measurements.push({ width, fontSize, theme, ...result, folded, message, toolbar });
          } finally { await page.close(); }
        }
      }
    }
    fs.writeFileSync(path.join(destination, 'renderer-results.json'),
      JSON.stringify({ measurements }, null, 2) + '\n');
  } finally { await browser.close(); }
  console.log(`${measurements.length} responsive layout cases passed`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
