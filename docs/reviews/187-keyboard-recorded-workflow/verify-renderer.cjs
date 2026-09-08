// Actual Chromium keyboard behavior against the compiled panel and a real
// kernel capture. Separate from Extension Host verification and human study.
// Run after compile: node docs/reviews/187-keyboard-recorded-workflow/verify-renderer.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '../../..');
const puppeteer = require(path.join(root, 'node_modules/puppeteer-core'));
const { KernelClient } = require(path.join(root, 'out/kernel/client'));
const { present } = require(path.join(root, 'out/render/present'));
const { rowsFor, valuesHtml } = require(path.join(root, 'out/panel/html'));
const { newLoopViewState, loopExpanded } = require(path.join(root, 'out/panel/loopExplorer'));
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
(async () => {
  const source = 'for x in range(25):\n    for y in range(25):\n        u = x + y\n        if y == 0: continue\n        print(x, y)\n';
  const client = new KernelClient({ resolvePython: async () => 'python3',
    kernelPath: path.join(root, 'kernel/evalens_kernel.py') });
  let result;
  try {
    result = await client.request({ op: 'eval', source, line: 0, character: 0,
      filename: '/private/tmp/evalens-187-keyboard.py', allow_stdin: false });
    assert.equal(result.ok, true);
  } finally { client.dispose(); }
  const sourceLines = source.split('\n');
  const presentation = present(result);
  const rows = rowsFor({ lineCount: sourceLines.length, lineAt: line => ({ text: sourceLines[line] }) },
    [presentation], 'printed');
  const model = rows[0].loopExplorer;
  assert.ok(model);
  const state = newLoopViewState(33);
  const resultState = { identity: 700, collapsed: false, expanded: false };
  const flat = { line: 20, startLine: 20, endLine: 20, state: 'evaluated',
    codeLines: ['print(long_text)'], streams: [{ label: 'printed', text: Array.from({ length: 80 }, (_, i) => `entry ${i}: åäö 🐍`).join('\n') }] };
  let sourceUri = 'file:///private/tmp/evalens-187-keyboard.py';
  let revision = 1;
  let saved = {};
  let expanded = new Set();
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.EVALENS_CHROME_PATH
    || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 700 });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  async function render() {
    await page.goto('about:blank');
    await page.evaluate(initial => {
      window.saved = initial; window.messages = [];
      window.acquireVsCodeApi = () => ({ getState: () => window.saved,
        setState: value => { window.saved = JSON.parse(JSON.stringify(value)); },
        postMessage: message => window.messages.push(message) });
    }, saved);
    await page.setContent(valuesHtml({ fileName: 'keyboard.py', sourceUri, rows: [...rows, flat], latestResultLine: 20 },
      0, 'keyboard', undefined, { loopStates: new Map([[model.wire, state]]),
        resultFolds: new Map([[0, resultState]]), expandedLines: expanded }, true, revision++, true, false,
      { introDismissed: true, resetOnLoad: false }).replace('<script nonce=',
        '<button type="button" class="keyboard-probe">Unkeyed fixture control</button><script nonce='));
    await pause();
  }
  const focused = () => page.evaluate(() => document.activeElement.dataset.focusKey);
  async function key(selector, key = 'Enter') {
    await page.focus(selector); await page.keyboard.press(key); await pause();
    const message = await page.evaluate(() => window.messages.at(-1));
    saved = await page.evaluate(() => window.saved);
    return message;
  }
  try {
    await render();
    // Turning a label into a native button must preserve its existing ink.
    assert.equal(await page.$eval('.fold-label.seg-streamLabel', el => getComputedStyle(el).color), 'rgb(92, 127, 166)');
    let opened = await key('[data-fold-action="open"][data-fold-line="20"]');
    assert.equal(opened.revision, revision - 1);
    assert.equal(opened.stream, 'printed');
    // Every flat control participates in native Tab and Enter semantics.
    const flatExpand = '[data-fold-line="20"].fold-action[data-fold-action="expand"]';
    let message = await key(flatExpand);
    assert.equal(message.expand, 20);
    const flatFocus = await focused();
    assert.ok(flatFocus.startsWith('flat/'));
    expanded.add(20); await render();
    assert.equal(await focused(), flatFocus, 'Show all -> Show less keeps the same control');
    assert.equal(await page.$eval(flatExpand, el => el.tagName), 'BUTTON');
    // Session details has its own stable key even outside the optional Help.
    await page.focus('[data-learning-session]');
    saved = await page.evaluate(() => window.saved);
    assert.equal(saved.key, 'learning/session-details');
    await render();
    assert.equal(await focused(), 'learning/session-details');
    await key('[data-learning-session]');
    assert.equal(await focused(), 'topic/session');
    // Help Escape closes the topic, then help, without producing source messages.
    await page.keyboard.press('Escape'); await pause();
    assert.equal(await page.$eval('[data-learning-topic="session"]', el => el.open), false);
    await page.keyboard.press('Escape'); await pause();
    assert.equal(await page.$eval('#learning-help', el => el.hidden), true);
    assert.equal(await focused(), 'learning/help');
    assert.equal(await page.evaluate(() => window.messages.some(m => m.goto !== undefined)), false);
    // Unknown future controls remain native focus targets without fake keys.
    assert.equal(await page.$eval('.keyboard-probe', el => el.hasAttribute('data-focus-key')), false);
    await page.focus('.keyboard-probe');
    assert.equal(await page.evaluate(() => window.saved.key), undefined);
    // The final page disables Next: focus falls back to Previous for this loop.
    message = await key('[data-loop-action="page"][data-loop-id="1"][data-loop-control="next"]');
    state.pages.set(message.node, message.value); await render();
    assert.match(await focused(), /loop\/33\/1\/page\/previous$/);
    // Expanding an outer iteration keeps its own disclosure focused.
    const toggle = '[data-loop-action="toggle"]';
    message = await key(toggle);
    const toggleFocus = await focused();
    const entry = model.entries.get(message.node);
    state.expanded.set(entry.id, !loopExpanded(model, entry, state));
    await render(); assert.equal(await focused(), toggleFocus);
    // Local Why uses native disclosure and Escape; no goto/select is posted.
    message = await key('.loop-missing-why summary');
    await page.keyboard.press('Escape'); await pause();
    assert.equal(await page.$eval('.loop-missing-why', el => el.open), false);
    assert.match(await focused(), /^details\//);
    // Native focus scrolling leaves a target below the currently sticky header.
    const leaf = '.loop-data [data-loop-action="select"]';
    await page.evaluate(selector => {
      const target = document.querySelectorAll(selector)[12];
      window.scrollTo({ top: window.scrollY + target.getBoundingClientRect().top - 5 });
      target.focus({ preventScroll: true });
    }, leaf);
    await pause();
    const geometry = await page.evaluate(() => {
      const target = document.activeElement;
      const toolbar = document.getElementById('navigation-control').getBoundingClientRect();
      const contexts = [...document.querySelectorAll('.loop-context')].filter(context =>
        !context.classList.contains('loop-context-covered')
        && !context.classList.contains('loop-context-unpinned')
        && context.getBoundingClientRect().top <= toolbar.bottom + 1);
      return { target: target.getBoundingClientRect().top,
        bottom: Math.max(toolbar.bottom, ...contexts.map(context => context.getBoundingClientRect().bottom)) };
    });
    assert.ok(geometry.target >= geometry.bottom, JSON.stringify(geometry));
    // Whole-result fold keeps one mounted button and preserves nested page.
    await key('[data-result-line="0"] .result-disclosure');
    assert.equal(await page.$eval('[data-result-line="0"]', el => el.classList.contains('result-collapsed')), true);
    await page.keyboard.press('Enter'); await pause();
    assert.equal(state.pages.get(1), 1);
    // A replaced capture cannot recover an old inner control by matching IDs.
    saved = await page.evaluate(() => window.saved);
    resultState.identity = 701; state.identity = 34;
    await render();
    assert.equal(await focused(), 'result/701');
    // A different source file never inherits focused controls from this one.
    saved = await page.evaluate(() => window.saved);
    sourceUri = 'file:///private/tmp/other/keyboard.py';
    await render();
    assert.equal(await page.evaluate(() => document.activeElement.tagName), 'BODY');
    assert.deepEqual(errors, []);
    const screenshot = process.env.EVALENS_SCREENSHOT || '/private/tmp/evalens-187-renderer.png';
    await page.screenshot({ path: screenshot });
    const report = { passed: ['native flat open dispatch revision and label color', 'native flat buttons and rebuild focus', 'Session details focus/rebuild and Help Escape; unkeyed-control safety',
      'disabled paging fallback', 'iteration disclosure focus', 'Why Escape', 'focus below sticky loop context',
      'whole-result fold', 'replacement fallback', 'cross-file focus isolation'],
      sourceUri, kernelRequests: 1, browserErrors: errors, screenshot };
    fs.writeFileSync('/private/tmp/evalens-187-renderer.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
