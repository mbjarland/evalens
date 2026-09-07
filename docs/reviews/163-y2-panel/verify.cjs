// Run after npm run compile. Only literal fixtures below are evaluated.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const { KernelClient } = require(path.join(root, 'out/kernel/client'));
const { present } = require(path.join(root, 'out/render/present'));
const { rowsFor, valuesHtml, fullTextFor } = require(path.join(root, 'out/panel/html'));
const manifest = require(path.join(root, 'package.json'));

async function main() {
  const client = new KernelClient({ resolvePython: async () => 'python3',
    kernelPath: path.join(root, 'kernel/evalens_kernel.py') });
  const source = [
    'x = [1, 2, 3]', 'x.append(4)', 'print("x after mutating y:", x)',
    'print("output only")',
    'for n in range(25):', '    print("captured line", n)',
    'import sys', `exec("print('ready'); print('a warning', file=sys.stderr)")`,
    '1 / 0', 'pass',
  ].join('\n');
  const document = { lineAt: line => ({ text: source.split('\n')[line] }) };
  let rows;
  try {
    const result = await client.request({ op: 'eval_file', source,
      filename: '/tmp/evalens-y2-fixture.py', allow_stdin: false });
    const annotations = result.results.map(item => {
      const response = item.result ?? item;
      const shown = present(response, response.range?.start.line ?? 0);
      return shown.kind === 'error' ? { ...shown, error: {
        type: shown.type, message: shown.message,
      } } : shown;
    }).filter(item => item.kind !== 'nothing');
    rows = rowsFor(document, annotations, 'printed');
  } finally { client.dispose(); }
  assert.equal(rows.find(row => row.line === 3).streams[0].text, 'output only');
  rows = rows.map(row => row.line === 1 ? { ...row, state: 'stale',
    staleReason: 'edited' } : row);
  // A recorded multiline repr exercises the same fold UI as stream text.
  rows.push({ line: 10, startLine: 10, endLine: 10, state: 'evaluated',
    codeLines: ['grid = captured_grid'], groups: [[
      { role: 'nameLabel', text: 'grid: ' },
      { role: 'value', text: Array.from({ length: 25 }, (_, i) => `[${i}, ${i + 1}]`).join('\n') },
    ]] });
  const { launch } = await import(path.join(root,
    'node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js'));
  const browser = await launch({ executablePath:
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1220, height: 850, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(() => {
      window.sent = [];
      window.acquireVsCodeApi = () => ({ postMessage: message => window.sent.push(message) });
    });
    const palettes = {
      dark: { className: 'vscode-dark', background: '#1e1e1e', foreground: '#cccccc', border: '#454545' },
      light: { className: 'vscode-light', background: '#ffffff', foreground: '#333333', border: '#e5e5e5' },
      highContrast: { className: 'vscode-high-contrast', background: '#000000', foreground: '#ffffff', border: '#6fc3df' },
      highContrastLight: { className: 'vscode-high-contrast-light', background: '#ffffff', foreground: '#000000', border: '#0f4a85' },
    };
    async function render(name, expanded = false) {
      const theme = palettes[name];
      const variables = { 'panel-background': theme.background,
        foreground: theme.foreground, 'descriptionForeground': theme.foreground,
        'panel-border': theme.border, 'editor-font-family': 'Menlo, monospace',
        'editor-font-size': '15px', 'font-size': '13px', 'focusBorder': theme.border,
        'textLink-foreground': name.includes('Light') || name === 'light' ? '#005fb8' : '#75beff' };
      for (const color of manifest.contributes.colors) {
        variables[color.id.replaceAll('.', '-')] = color.defaults[name];
      }
      const themeCss = Object.entries(variables)
        .map(([key, value]) => `--vscode-${key}:${value};`).join('');
      const html = valuesHtml({ fileName: 'layout.py', rows }, undefined, 'y2',
        undefined, { outputLines: 5, expandedLines: new Set(expanded ? [4, 10] : []) });
      const themed = html.replace('<body>', `<body class="${theme.className}">`)
        .replace('<style nonce="y2">', `<style nonce="y2">:root{${themeCss}}`)
        .replace('<script nonce="y2">', '<script nonce="y2">window.sent=[];'
          + 'window.acquireVsCodeApi=()=>({postMessage:m=>window.sent.push(m)});');
      await page.setContent(themed);
    }
    const measurements = {};
    for (const name of Object.keys(palettes)) {
      await render(name);
      const result = await page.evaluate(() => {
        const only = document.querySelector('tr[data-goto="3"] .result-surface');
        const label = only.querySelector('.seg-streamLabel');
        const mixed = document.querySelector('tr[data-goto="2"] .result-surface');
        const variable = mixed.querySelector('.seg-nameLabel');
        const output = mixed.querySelector('.seg-streamLabel');
        const divider = getComputedStyle(mixed.querySelector('.result-streams'), '::before');
        return { outputInset: label.getBoundingClientRect().top - only.getBoundingClientRect().top,
          labelAlignment: variable.getBoundingClientRect().left - output.getBoundingClientRect().left,
          valueGap: variable.nextElementSibling.getBoundingClientRect().left
            - variable.getBoundingClientRect().right,
          inlineValueOffset: output.nextElementSibling.getBoundingClientRect().left
            - variable.nextElementSibling.getBoundingClientRect().left,
          dividerWidth: parseFloat(divider.width),
          usableWidth: mixed.getBoundingClientRect().width
            - parseFloat(getComputedStyle(mixed).borderLeftWidth)
            - parseFloat(getComputedStyle(mixed).paddingLeft)
            - parseFloat(getComputedStyle(mixed).paddingRight),
          resultBorder: getComputedStyle(mixed).borderLeftWidth,
          dividerOpacity: divider.opacity,
          rowSeparator: getComputedStyle(document.querySelector('td')).borderBottomWidth,
          emptyResult: !!document.querySelector('tr[data-goto="9"] .result-surface'),
          duplicateBars: document.querySelectorAll('.bar').length };
      });
      assert.ok(result.outputInset >= 0 && result.outputInset < 8,
        `output-only label must begin on the first result line: ${JSON.stringify(result)}`);
      assert.equal(result.labelAlignment, 0, 'variable and printed labels must align');
      assert.equal(result.valueGap, 0, 'value follows the label and its one space immediately');
      assert.ok(result.inlineValueOffset > 0, 'different label lengths must not form value columns');
      assert.equal(result.dividerWidth, result.usableWidth, 'divider spans the usable result width');
      assert.equal(result.resultBorder, '3px');
      assert.equal(result.dividerOpacity, '0.6');
      assert.equal(result.emptyResult, false);
      assert.equal(result.duplicateBars, 0);
      measurements[name] = result;
      await page.screenshot({ path: path.join(__dirname, `${name}.png`), fullPage: true });
    }
    await render('dark');
    await page.click('tr[data-goto="4"] [data-fold-action="expand"]');
    assert.deepEqual(await page.evaluate(() => window.sent), [{ expand: 4 }]);
    await page.click('tr[data-goto="4"] [data-fold-action="open"]');
    assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { open: 4, stream: 'printed' });
    assert.equal(fullTextFor(rows.find(row => row.line === 4), 'printed').split('\n').length, 25);
    assert.ok(!await page.evaluate(() => document.body.innerText.includes('captured line 24')));
    await render('dark', true);
    assert.ok(await page.evaluate(() => document.body.innerText.includes('captured line 24')));
    await page.click('tr[data-goto="4"] [data-fold-action="expand"]');
    assert.deepEqual(await page.evaluate(() => window.sent), [{ expand: 4 }]);
    await page.screenshot({ path: path.join(__dirname, 'expanded.png'), fullPage: true });
    fs.writeFileSync(path.join(__dirname, 'geometry.json'), JSON.stringify(measurements, null, 2) + '\n');
    console.log('Four theme geometry checks and folded/expanded controls passed.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
