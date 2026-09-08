// Root grants exclusive ownership of the isolated Host before running this.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { api, sleep, connect } = require('/private/tmp/evalens-learning-live/client.cjs');
(async () => {
  const fixture = '/private/tmp/evalens-learning-live/workspace/review-final-paging.py';
  fs.writeFileSync(fixture,
    'for x in range(25):\n    for y in range(25):\n        print(x, y)\n');
  const { browser, page, frame } = await connect();
  const command = command => api({ op: 'command', command });
  const report = { kind: 'Agent-operated final keyboard loop integration',
    extension: (await api({ op: 'state' })).extensions };
  try {
    await api({ op: 'open', path: fixture });
    await command('workbench.action.focusActiveEditorGroup');
    await command('evalens.clearResults');
    await command('evalens.evaluateFile');
    await command('evalens.showValuesPanel');
    if (await page.$eval('.part.panel', e => e.getBoundingClientRect().height) < 600)
      await command('workbench.action.toggleMaximizedPanel');
    let f = await frame('[data-loop-navigation="1"]');
    if (!await f.$eval('#learning-help', e => e.hidden))
      await f.click('[data-learning-toggle]');
    async function activate(selector) {
      await f.focus(selector); await sleep(80);
      await page.keyboard.press('Enter'); await sleep(200);
      f = await frame('[data-loop-navigation="1"]');
    }
    async function focusEvidence() {
      return f.evaluate(() => {
        const e = document.activeElement;
        const r = e.getBoundingClientRect();
        const toolbarBottom = document.getElementById('navigation-control')
          .getBoundingClientRect().bottom;
        const pinned = [...document.querySelectorAll('.loop-context')]
          .filter(c => !c.contains(e) && getComputedStyle(c).visibility !== 'hidden'
            && getComputedStyle(c).position === 'sticky'
            && c.getBoundingClientRect().top <= toolbarBottom + 1);
        const top = Math.max(toolbarBottom,
          ...pinned.map(c => c.getBoundingClientRect().bottom));
        return { text: e.textContent, disabled: e.disabled, id: e.dataset.loopId,
          control: e.dataset.loopControl, top: r.top, bottom: r.bottom,
          visibleTop: top, viewport: innerHeight, pinnedContexts: pinned.length };
      });
    }
    function visible(e) {
      assert(!e.disabled);
      assert(e.top >= e.visibleTop - 1, JSON.stringify(e));
      assert(e.bottom <= e.viewport + 1, JSON.stringify(e));
    }
    await activate('[data-loop-navigation="1"] [data-loop-control="next"]');
    report.outerPage = await f.$eval('[data-loop-navigation="1"]', e => e.innerText);
    assert.match(report.outerPage, /21–25 of 25/);
    report.outerFocus = await focusEvidence();
    assert.equal(report.outerFocus.control, 'previous');
    visible(report.outerFocus);
    const outerId = await f.$eval(
      '[data-loop-invocation="1"] > .loop-entries > .loop-iteration',
      e => e.dataset.loopEntry);
    await activate(`[data-loop-action="toggle"][data-loop-id="${outerId}"]`);
    const innerId = await f.$eval(`[data-loop-entry="${outerId}"] .loop-invocation`,
      e => e.dataset.loopInvocation);
    await activate(`[data-loop-navigation="${innerId}"] [data-loop-control="next"]`);
    report.innerPage = await f.$eval(`[data-loop-navigation="${innerId}"]`,
      e => e.innerText);
    assert.match(report.innerPage, /21–25 of 25/);
    report.innerFocus = await focusEvidence();
    assert.equal(report.innerFocus.id, innerId);
    assert.equal(report.innerFocus.control, 'previous');
    visible(report.innerFocus);
    await page.keyboard.press('Tab'); await sleep(100);
    report.nextTab = await focusEvidence(); visible(report.nextTab);
    await activate('.result-disclosure');
    assert.equal(await f.$eval('.result-disclosure', e => e.ariaExpanded), 'false');
    await activate('.result-disclosure');
    assert.equal(await f.$eval(`[data-loop-navigation="${innerId}"]`,
      e => e.innerText), report.innerPage);
    report.wholeFoldPreservedInnerPage = true;
    await f.focus(`[data-loop-navigation="${innerId}"] [data-loop-control="previous"]`);
    await sleep(100); report.restoredFocus = await focusEvidence();
    visible(report.restoredFocus);
    await api({ op: 'setting', section: 'editor', key: 'fontSize', value: 28 });
    await sleep(200); f = await frame('[data-loop-navigation="1"]');
    await activate(`[data-loop-navigation="${innerId}"] [data-loop-control="previous"]`);
    report.largeFontFocus = await focusEvidence();
    assert.equal(report.largeFontFocus.control, 'next');
    visible(report.largeFontFocus);
    assert(report.largeFontFocus.pinnedContexts > 0);
    const out = path.join(__dirname, 'evidence');
    await page.screenshot({ path: path.join(out, 'final-loop-keyboard.png') });
    await api({ op: 'setting', section: 'editor', key: 'fontSize', value: 14 });
    fs.writeFileSync(path.join(out, 'final-loop-keyboard.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.disconnect(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
