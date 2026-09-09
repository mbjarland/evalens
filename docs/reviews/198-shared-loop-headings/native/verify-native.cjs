const assert = require('node:assert/strict');
const fs = require('node:fs');
const { api, connect, until, sleep } = require('./client.cjs');
const base = '/private/tmp/evalens-198';
const report = { method: 'Actual VS Code Extension Development Host, dedicated profile and fixtures', cases: [] };
(async () => {
  const { browser, page, frame } = await connect();
  try {
    const state = await api({ op: 'state' });
    assert.deepEqual(state.workspace, [base + '/workspace']);
    assert.equal(state.extensions.find(e => e.id === 'mbjarland.evalens').path,
      process.env.EVALENS_REVIEW_PATH || '/Users/mbjarland/projects/evalens-worktrees/198-shared-loop-headings');
    report.extension = state.extensions.find(e => e.id === 'mbjarland.evalens');
    report.implementationRevision = require('node:child_process').execFileSync('git', ['-C', '/Users/mbjarland/projects/evalens-worktrees/198-shared-loop-headings', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await api({ op: 'setting', section: 'editor', key: 'fontSize', value: 16 });
    await page.setViewport({ width: 1150, height: 1000, deviceScaleFactor: 2 });
    async function load(name) {
      await api({ op: 'open', path: `${base}/workspace/${name}.py` });
      await api({ op: 'cursor', line: 0 });
      await api({ op: 'command', command: 'evalens.evaluateFile' });
      await api({ op: 'command', command: 'evalens.showValuesPanel' });
      if (await page.$eval('.part.panel', e => e.getBoundingClientRect().height < innerHeight / 2)) {
        await api({ op: 'command', command: 'workbench.action.toggleMaximizedPanel' });
      }
      let f;
      await until(async () => {
        try { f = await frame('.loop-explorer'); return (await f.$eval('body', e => e.innerText)).includes(name + '.py'); }
        catch { return false; }
      }, name);
      await sleep(250); f = await frame('.loop-explorer');
      await f.evaluate(() => window.scrollTo(0, 0));
      await sleep(160);
      return f;
    }
    const tokens = async f => f.$$eval('[data-result-token]', es => es.map(e => e.dataset.resultToken));
    const press = async (f, selector, key = 'Enter') => { await f.focus(selector); await page.keyboard.press(key); await sleep(160); };
    const measurements = async f => f.evaluate(() => {
      const header = document.querySelector('.loop-columns');
      const rect = e => e.getBoundingClientRect();
      const hx = [...header.children].map(e => rect(e).x);
      return {
        headers: document.querySelectorAll('.loop-columns').length,
        helps: document.querySelectorAll('.loop-recording-details').length,
        visible: document.body.innerText,
        aligned: [...document.querySelectorAll('.loop-data')].filter(e => rect(e).height > 0).every(e =>
          [...e.children].slice(0, 2).every((c, i) => Math.abs(rect(c).x - hx[i]) < 1)),
        overflow: document.documentElement.scrollWidth > innerWidth,
        title: document.querySelector('.loop-scroll-owner').textContent,
        helpOpen: document.querySelector('.loop-recording-details').open
      };
    });
    let f = await load('nested-small');
    const small = await measurements(f);
    assert.equal(small.headers, 1); assert.equal(small.helps, 1); assert(small.aligned); assert(!small.overflow);
    assert(!/within Iteration|at iteration start|Recording details/.test(small.visible));
    const identity = await tokens(f), cursor = (await api({ op: 'state' })).active.line;
    await press(f, '.loop-recording-details > summary');
    assert(await f.$eval('.loop-recording-details', e => e.open));
    assert.match(await f.$eval('.loop-recording-details', e => e.innerText), /iteration.*start|start.*iteration/s);
    assert(await f.$eval('.loop-context', e => e.classList.contains('loop-context-unpinned')));
    await press(f, '.loop-recording-details > summary', 'Space');
    assert(!await f.$eval('.loop-recording-details', e => e.open));
    assert.deepEqual(await tokens(f), identity); assert.equal((await api({ op: 'state' })).active.line, cursor);
    await page.screenshot({ path: base + '/native-small.png' });
    report.cases.push({ name: 'shared headings and native keyboard help', ...small, sameRecordingAndSourceCursor: true });

    f = await load('missing');
    assert.match(await f.$eval('.loop-explorer', e => e.innerText), /not recorded/i);
    const missingIdentity = await tokens(f);
    await press(f, '.loop-missing-why > summary', 'Space');
    assert(await f.$eval('.loop-missing-why', e => e.open));
    const why = await f.$eval('.loop-missing-why', e => e.innerText);
    assert.match(why, /does not tell us/); assert.deepEqual(await tokens(f), missingIdentity);
    report.cases.push({ name: 'missing readings retain native keyboard Why', explanation: why });

    f = await load('nested-large');
    const root = await f.$eval('.loop-invocation', e => e.dataset.loopInvocation);
    const first = await f.$eval(`[data-loop-invocation="${root}"] > .loop-entries > .loop-group`, e => e.dataset.loopEntry);
    const toggle = `[data-loop-action="toggle"][data-loop-id="${first}"]`;
    if (await f.$eval(toggle, e => e.getAttribute('aria-expanded')) === 'false') await press(f, toggle);
    f = await frame('.loop-explorer');
    const inner = await f.$eval(`[data-loop-entry="${first}"] [data-loop-invocation]`, e => e.dataset.loopInvocation);
    const navigation = id => `[data-loop-navigation="${id}"]`;
    const rootNav = await f.$eval(navigation(root), e => e.innerText);
    const innerBefore = await f.$eval(navigation(inner), e => e.innerText);
    assert.match(rootNav, /More iterations/); assert.match(innerBefore, /More iterations/);
    const identityLarge = await tokens(f);
    await f.evaluate(() => window.scrollTo(0, 0)); await sleep(100);
    assert.equal(await f.$eval('.loop-scroll-owner', e => e.hidden), true);
    const heightBefore = await f.evaluate(() => document.documentElement.scrollHeight);
    await f.$eval('.loop-data', e => e.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await until(async () => !(await f.$eval('.loop-scroll-owner', e => e.hidden)), 'scroll owner');
    const owner = await f.$eval('.loop-scroll-owner', e => e.textContent);
    assert.match(owner, /Iteration 1/); assert.match(owner, /for y/);
    assert.equal(await f.evaluate(() => document.documentElement.scrollHeight), heightBefore);
    await page.screenshot({ path: base + '/native-scrolled.png' });
    await f.evaluate(() => window.scrollTo(0, 0)); await sleep(120);
    assert(await f.$eval('.loop-scroll-owner', e => e.hidden));
    const next = navigation(inner) + ' [data-loop-control="next"]';
    assert(!await f.$eval(next, e => e.disabled));
    await press(f, next);
    f = await frame('.loop-explorer');
    await until(async () => (await f.$eval(navigation(inner), e => e.innerText)) !== innerBefore, 'inner next page');
    const innerAfter = await f.$eval(navigation(inner), e => e.innerText);
    const overflowFolds = await f.$$eval('.loop-overflow button[aria-expanded]', es => es.map(e => e.getAttribute('aria-expanded')));
    assert(overflowFolds.every(v => v === 'false'));
    await press(f, '.result-disclosure');
    const folded = await f.$eval('.whole-result', e => ({ closed: e.classList.contains('result-collapsed'), height: e.getBoundingClientRect().height, sourceHeight: e.closest('tr').querySelector('.source-content').getBoundingClientRect().height }));
    assert(folded.closed); assert(folded.height <= folded.sourceHeight + 1);
    await page.screenshot({ path: base + '/native-folded.png' });
    await press(f, '.result-disclosure'); f = await frame('.loop-explorer');
    assert.equal(await f.$eval(navigation(inner), e => e.innerText), innerAfter);
    assert.deepEqual(await tokens(f), identityLarge);
    report.cases.push({ name: 'large nested loops, ownership, paging and whole-result fold', rootNav, innerBefore, innerAfter, owner, folded, overflowFolds, recordingUnchanged: true });

    for (const name of ['nested-deep', 'siblings']) {
      f = await load(name); const result = await measurements(f);
      assert.equal(result.headers, 1); assert.equal(result.helps, 1); assert(result.aligned); assert(!result.overflow);
      report.cases.push({ name, ...result });
    }
    f = await load('nested-small');
    for (const theme of ['Default Light Modern', 'Default High Contrast', 'Default Dark Modern']) {
      await api({ op: 'setting', section: 'workbench', key: 'colorTheme', value: theme });
      await sleep(300); f = await frame('.loop-explorer');
      const result = await measurements(f); assert(result.aligned); assert(!result.overflow);
      report.cases.push({ name: theme, themeClass: await f.$eval('body', e => e.className), ...result });
      await page.screenshot({ path: base + '/native-' + theme.toLowerCase().replaceAll(' ', '-') + '.png' });
    }
    await api({ op: 'setting', section: 'editor', key: 'fontSize', value: 28 }); await sleep(300);
    await page.setViewport({ width: 560, height: 650, deviceScaleFactor: 2 }); await sleep(200);
    f = await frame('.loop-explorer');
    const narrow = await f.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, explorerWidth: document.querySelector('.loop-explorer').getBoundingClientRect().width, titleWidth: document.querySelector('.loop-title').getBoundingClientRect().width, titleHeight: document.querySelector('.loop-title').getBoundingClientRect().height, columns: getComputedStyle(document.querySelector('.loop-columns')).display, labels: [...document.querySelectorAll('.loop-stack-label')].map(e => ({ text: e.textContent, display: getComputedStyle(e).display })), unpinned: document.querySelector('.loop-context').classList.contains('loop-context-unpinned') }));
    assert(!narrow.overflow); assert.equal(narrow.columns, 'none'); assert(narrow.labels.some(e => e.text.startsWith('Printed output') && e.display !== 'none'));
    assert(narrow.titleWidth >= narrow.explorerWidth * .8, 'source heading must not be squeezed beside help');
    await f.$eval('.loop-explorer', e => e.scrollIntoView({ block: 'start', behavior: 'instant' })); await sleep(120);
    await page.screenshot({ path: base + '/native-narrow-large-font.png' });
    report.cases.push({ name: 'narrow at 28px font', ...narrow });
    await api({ op: 'setting', section: 'editor', key: 'fontSize', value: 16 });
    await page.setViewport({ width: 1150, height: 1000, deviceScaleFactor: 2 });
    fs.writeFileSync(base + '/native-results.json', JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ passed: report.cases.map(c => c.name), extension: report.extension }, null, 2));
  } finally { await browser.disconnect(); }
})().catch(e => { fs.writeFileSync(base + '/native-partial-results.json', JSON.stringify(report, null, 2) + '\n'); console.error(e); process.exit(1); });
