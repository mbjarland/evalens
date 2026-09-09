'use strict';
// Actual kernel readings and compiled renderer; native VS Code is reviewed
// separately. The renderer is not restyled to imitate the approved drawing.
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
  base: fs.readFileSync(path.join(__dirname, 'base.py'), 'utf8'),
  siblings: 'for x in [1]:\n    base = 10\n    print("base:", base)\n    for y in range(2):\n        print(x, y)\n    for z in range(2):\n        print(x, z)\n',
  deep: 'for x in [1]:\n    base = 10\n    for y in range(2):\n        middle = base + y\n        for z in range(2):\n            v = middle + z\n            print(x, y, z)\n',
  changed: 'for x in [1]:\n    base = 4\n    print(base)\n    for y in [0]:\n        print(y)\n    base = 99\n',
  missing: 'for x in [1]:\n    base = 4\n    print(base)\n    for y in [0]:\n        print(y)\n    continue\n',
};

async function main() {
  const captures = {};
  for (const [name, source] of Object.entries(fixtures)) {
    const kernel = new KernelClient({ resolvePython: async () => 'python3',
      kernelPath: path.join(root, 'kernel/evalens_kernel.py') });
    try {
      const response = await kernel.request({ op: 'eval', source, line: 0,
        character: 0, filename: `/private/tmp/evalens-205-${name}.py`, allow_stdin: false });
      assert.equal(response.ok, true);
      const lines = source.split('\n');
      const rows = rowsFor({ lineCount: lines.length,
        lineAt: line => ({ text: lines[line] }) }, [present(response)], 'printed');
      captures[name] = { rows, model: rows[0].loopExplorer, response };
    } finally { kernel.dispose(); }
  }
  fs.mkdirSync(destination, { recursive: true });
  const browser = await puppeteer.launch({ headless: true,
    executablePath: process.env.EVALENS_CHROME_PATH
      || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const states = Object.fromEntries(Object.keys(captures).map(name => [name, newLoopViewState(205)]));
  const outer = captures.base.model.children.get(captures.base.model.roots[0].id);
  states.base.expanded.set(outer[0].id, false);
  states.base.expanded.set(outer[1].id, true);
  async function render(name, width = 1400, font = 20, theme = 'dark') {
    await page.setViewport({ width, height: 1000 });
    await page.goto('about:blank');
    await page.evaluate(() => {
      window.messages = [];
      window.acquireVsCodeApi = () => ({ getState: () => undefined,
        setState: () => {}, postMessage: message => window.messages.push(message) });
    });
    const { rows, model } = captures[name];
    const light = theme.includes('light');
    let html = valuesHtml({ fileName: `${name}.py`, rows }, 0, 'review', undefined,
      { loopStates: new Map([[model.wire, states[name]]]) }, true, 1, true, false,
      { introDismissed: true, resetOnLoad: true });
    html = html.replace('<style nonce="review">', `<style nonce="review">:root {
      --vscode-editor-font-family: Menlo, monospace; --vscode-editor-font-size: ${font}px;
      --vscode-font-size: 13px; --vscode-panel-background: ${light ? '#ffffff' : '#181818'};
      --vscode-editor-foreground: ${light ? '#333333' : '#cccccc'};
      --vscode-foreground: ${light ? '#333333' : '#cccccc'};
      --vscode-descriptionForeground: ${light ? '#666666' : '#aaaaaa'};
      --vscode-evalens-resultForeground: ${light ? '#8a6a2b' : '#d1a35c'};
      --vscode-evalens-outputLabelForeground: ${light ? '#728da6' : '#5c7fa6'};
      --vscode-panel-border: ${light ? '#dddddd' : '#333333'};
      --vscode-textLink-foreground: ${light ? '#006ab1' : '#64a9de'};
      --vscode-focusBorder: #007fd4;
    }`).replace('<body>', `<body class="vscode-${theme}">`);
    await page.setContent(html, { waitUntil: 'load' });
    await pause();
    assert.deepEqual(errors, []);
  }
  async function measure() {
    return page.evaluate(() => {
      function textBox(node, token) {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        let text;
        while ((text = walker.nextNode())) {
          const start = token ? text.textContent.indexOf(token) : text.textContent.search(/\S/);
          if (start < 0 || text.parentElement.closest('.loop-disclosure')) continue;
          const range = document.createRange(); range.setStart(text, start);
          range.setEnd(text, token ? start + token.length : text.textContent.length);
          const rect = [...range.getClientRects()].find(rect => rect.width);
          if (rect) return { left: rect.left, right: rect.right, cy: rect.top + rect.height / 2,
            top: rect.top, bottom: rect.bottom };
        }
        throw new Error('Missing visible text: ' + token);
      }
      const visible = node => node.getClientRects().length > 0;
      const svg = document.querySelector('.loop-guides'), origin = svg.getBoundingClientRect();
      const columns = document.querySelector('.loop-columns');
      const columnPairs = document.querySelectorAll('.loop-columns').length;
      const wide = getComputedStyle(columns).display !== 'none';
      const variable = wide ? textBox(columns, 'Variables').left : undefined;
      const printed = wide ? textBox(columns, 'Printed output').left : undefined;
      const captions = [...document.querySelectorAll('[data-loop-depth="0"] > .loop-entries > .loop-group > .loop-iteration-header')];
      const parent = document.querySelector('.loop-parent-reading');
      const base = parent && textBox(parent.querySelector('[data-loop-control="body"]'));
      const inner = document.querySelector('[data-loop-depth="1"] > .loop-source');
      const source = inner && textBox(inner);
      const leaves = [...document.querySelectorAll('[data-loop-depth="1"] > .loop-entries > .loop-data .loop-target > button')];
      const output = [...document.querySelectorAll('.loop-output')].filter(visible);
      return { wide, columnPairs, help: document.querySelectorAll('.loop-recording-details').length,
        variable, printed, captions: captions.map(node => textBox(node, 'Iteration')),
        summaries: captions.map(node => node.querySelector('[data-loop-action="select"]').textContent),
        base, source, innerValues: leaves.map(node => textBox(node)),
        output: output.map(node => ({ text: node.textContent, ...textBox(node) })),
        final: document.querySelector('.loop-final').textContent,
        parentClass: parent?.className, parentText: parent?.innerText,
        parentOutputTop: parent?.children[1].getBoundingClientRect().top,
        parentValueBottom: parent?.children[0].getBoundingClientRect().bottom,
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        guides: [...svg.querySelectorAll('path')].map(node => {
          const box = node.getBBox();
          const target = document.querySelector('[data-loop-invocation="' + node.dataset.guideTarget + '"] > .loop-source');
          return { kind: node.dataset.loopGuide, target: node.dataset.guideTarget,
            left: box.x + origin.left, right: box.x + box.width + origin.left,
            top: box.y + origin.top, bottom: box.y + box.height + origin.top,
            targetText: target && textBox(target) };
        }) };
    });
  }
  try {
    const geometry = [];
    for (const width of [980, 1400]) for (const font of [16, 20, 28]) {
      await render('base', width, font);
      const result = await measure();
      assert.equal(result.columnPairs, 1);
      assert.equal(result.help, 1);
      assert.deepEqual(result.summaries, ['x = 0, base = 0', 'x = 1']);
      assert.deepEqual(result.output.map(row => row.text), ['base: 10', '1 0', '1 1', '1 2']);
      assert.match(result.final, /x = 1, y = 2, base = 10, v = 12/);
      assert.equal(result.overflow, false);
      assert.ok(result.base && result.source);
      assert.ok(result.base.top < result.source.top);
      assert.equal(result.parentClass, 'loop-data loop-parent-reading');
      if (result.wide) {
        for (const cell of [...result.captions, result.base, result.source])
          assert.ok(Math.abs(cell.left - result.variable) < 1, JSON.stringify({ width, font, cell, result }));
        for (const value of result.innerValues) assert.ok(Math.abs(value.left - result.variable - font * .95) < 1);
        for (const text of result.output) assert.ok(Math.abs(text.left - result.printed) < 1);
      }
      const child = result.guides.filter(guide => guide.kind === 'child');
      assert.equal(child.length, 1);
      assert.ok(Math.abs(child[0].bottom - result.source.cy) < 1);
      assert.ok(Math.abs(result.source.left - child[0].right - 7) < 1);
      assert.ok(result.guides.every(guide => guide.bottom <= result.source.cy + 1));
      geometry.push({ width, font, ...result });
      if (width === 1400 && font === 20) {
        await (await page.$('.whole-result')).screenshot({ path: path.join(destination, 'renderer-base.png') });
        fs.writeFileSync(path.join(destination, 'renderer-base.html'), await page.content());
      }
    }
    const variants = [];
    for (const name of ['siblings', 'deep', 'changed', 'missing']) {
      await render(name);
      const result = await measure();
      assert.equal(result.overflow, false);
      for (const guide of result.guides.filter(guide => guide.kind === 'child')) {
        assert.ok(Math.abs(guide.bottom - guide.targetText.cy) < 1);
        assert.ok(Math.abs(guide.targetText.left - guide.right - 7) < 1);
      }
      if (name === 'changed') {
        assert.match(result.parentText, /base = 99/);
        assert.equal(result.output[0].text, '4');
      }
      if (name === 'missing') assert.match(result.parentText, /base: not recorded/);
      if (name === 'siblings' || name === 'deep') assert.match(result.parentText, /base = 10/);
      if (name === 'siblings') {
        const children = result.guides.filter(guide => guide.kind === 'child');
        assert.equal(children.length, 2);
        assert.ok(children[1].top > children[0].bottom,
          'the later sibling gets a local elbow, not a trunk through earlier readings');
        assert.ok(children[1].top >= children[1].targetText.top - 6.1);
      }
      await (await page.$('.whole-result')).screenshot({ path: path.join(destination, `renderer-${name}.png`) });
      variants.push({ name, ...result });
    }
    const narrow = [];
    for (const width of [300, 560]) for (const font of [16, 28]) {
      await render('base', width, font);
      const result = await measure();
      assert.equal(result.overflow, false);
      assert.match(result.parentText, /base = 10/);
      if (!result.wide) assert.ok(result.parentOutputTop >= result.parentValueBottom);
      narrow.push({ width, font, ...result });
    }
    await render('base');
    await page.focus('.loop-parent-reading [data-loop-control="body"]');
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.messages.at(-1)),
      { loop: 0, action: 'select', node: outer[1].id, value: 0, revision: 1 });
    const bodyKey = await page.$eval('.loop-parent-reading button', node => node.dataset.focusKey);
    const targetKey = await page.$eval(`[data-loop-entry="${outer[1].id}"] > .loop-iteration-header [data-loop-action="select"]`, node => node.dataset.focusKey);
    assert.notEqual(bodyKey, targetKey);
    const openGuides = (await measure()).guides.length;
    await page.focus('.result-disclosure');
    await page.keyboard.press('Enter');
    await pause();
    assert.equal(await page.$$eval('.loop-guides path', paths => paths.length), 0);
    assert.equal(await page.$eval('.result-disclosure', button => button.getAttribute('aria-expanded')), 'false');
    await page.keyboard.press('Enter');
    await pause();
    assert.equal((await measure()).guides.length, openGuides);
    states.base.expanded.set(outer[0].id, true);
    await render('base');
    assert.deepEqual((await measure()).output.map(row => row.text),
      ['base: 0', '0 0', '0 1', '0 2', 'base: 10', '1 0', '1 1', '1 2']);
    states.base.expanded.set(outer[0].id, false);
    states.base.expanded.set(outer[1].id, false);
    await render('base');
    assert.deepEqual((await measure()).output, []);
    assert.deepEqual((await measure()).summaries, ['x = 0, base = 0', 'x = 1, base = 10']);
    assert.equal((await measure()).guides.filter(guide => guide.kind === 'child').length, 0);
    fs.writeFileSync(path.join(destination, 'renderer-results.json'), JSON.stringify({
      kernelRequests: Object.keys(fixtures).length, geometry, variants, narrow,
      bodyKey, targetKey, wholeResultFoldRestoresGuides: true, browserErrors: errors,
      limitation: 'Actual kernel and compiled Chromium renderer; native VS Code review is separate.'
    }, null, 2) + '\n');
    console.log('Aligned guides, snapshots, text geometry, narrow layout and saved-result controls passed');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
