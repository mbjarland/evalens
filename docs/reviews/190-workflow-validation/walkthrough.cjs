// Developer-operated real-Host walkthrough, never simulated user research.
// Run only after root grants this agent the isolated Host at 9354/9355.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { api, sleep, until, connect } = require(
  '/private/tmp/evalens-learning-live/client.cjs');
const workspace = '/private/tmp/evalens-learning-live/workspace';
const evidence = path.join(__dirname, 'evidence');
const fixtures = {
  'review-timing.py': 'for v in [1, 2, 3]:\n    u = 4 * v\n    print(u)\n    u = 99\n',
  'review-continue.py': 'for v in [1, 2, 3]:\n    u = 4 * v\n    if v == 2:\n        continue\n    print(u)\n',
  'review-carry.py': 'for v in [1, 2, 3]:\n    if v == 1:\n        u = 4\n    print(u)\n',
  'review-stale.py': 'scale = 4\nanswer = scale * 3\nprint(answer)\n',
  'review-paging.py': 'for x in range(25):\n    for y in range(25):\n        print(x, y)\n',
  'review-limits.py': 'for x in range(100):\n    for y in range(100):\n        print(x, y)\n',
  'review-text.py': "print(''.join(f'{i:03d}: café 🚀\\n' for i in range(150)), end='')\n",
  'review-keyboard.py': 'counter = 0\ncounter += 1\ncounter\n',
  'review-state-a.py': 'remembered = 7\nremembered\n',
  'review-state-b.py': 'remembered\n',
};
const report = { kind: 'Developer-led, agent-operated real VS Code Host walkthrough',
  participants: 0, observations: {},
  extensionCommit: execFileSync('git', ['rev-parse', 'master'],
    { cwd: '/Users/mbjarland/projects/evalens', encoding: 'utf8' }).trim() };
(async () => {
  fs.mkdirSync(evidence, { recursive: true });
  for (const [file, content] of Object.entries(fixtures))
    fs.writeFileSync(path.join(workspace, file), content);
  await until(async () => { try { return !!await api({ op: 'state' }); }
    catch { return false; } }, 'isolated Host');
  const { browser, page, frame } = await connect();
  report.extension = (await api({ op: 'state' })).extensions;
  const command = command => api({ op: 'command', command });
  async function editor(file, line = 0) {
    await api({ op: 'open', path: path.join(workspace, file) });
    await command('workbench.action.focusActiveEditorGroup');
    await api({ op: 'cursor', line });
    await sleep(100);
  }
  async function show(file, wholeFile = true) {
    await editor(file);
    const currentText = (await api({ op: 'state' })).active.text;
    if (currentText !== fixtures[file]) {
      const lines = currentText.split('\n');
      await api({ op: 'edit', startLine: 0, endLine: lines.length - 1,
        endChar: lines.at(-1).length, text: fixtures[file] });
      await api({ op: 'cursor', line: 0 });
    }
    await command('evalens.restartKernel');
    await command('evalens.clearResults');
    await command(wholeFile ? 'evalens.evaluateFile' : 'evalens.evaluateAtCursor');
    await command('evalens.showValuesPanel');
    await sleep(180);
    return frame('tr.row');
  }
  async function current() { await sleep(120); return frame('tr.row'); }
  async function keyControl(f, selector, key = 'Enter') {
    await f.focus(selector); await page.keyboard.press(key); await sleep(120);
  }
  function record(id, value) {
    report.observations[id] = value;
    fs.writeFileSync(path.join(evidence, 'walkthrough.json'),
      JSON.stringify(report, null, 2));
  }
  async function shot(name) {
    if (await page.$eval('.part.panel', e => e.getBoundingClientRect().height) < 600) {
      await command('workbench.action.toggleMaximizedPanel'); await sleep(150);
    }
    await page.screenshot({ path: path.join(evidence, name + '.png') });
  }
  try {
    for (const name of ['workbench.action.closeSidebar',
      'workbench.action.closeAuxiliaryBar']) await command(name);
    await page.setViewport({ width: 1400, height: 1000 });
    await api({ op: 'setting', section: 'workbench', key: 'colorTheme',
      value: 'Default Dark Modern' });
    await api({ op: 'setting', section: 'editor', key: 'fontSize', value: 14 });
    await api({ op: 'setting', section: 'evalens', key: 'resetOnLoad', value: true });
    await editor('review-timing.py');
    await command('evalens.clearResults');
    await command('evalens.showValuesPanel');
    let f = await frame('[data-learning-toggle]');
    const empty = await f.$eval('.empty', e => e.innerText);
    assert.match(empty, /Try a guided example/);
    assert.match(empty, /Cmd\+Enter/);
    if (await f.$eval('#learning-help', e => e.hidden))
      await keyControl(f, '[data-learning-toggle]');
    if (await f.$eval('#learning-intro', e => e.hidden))
      await keyControl(f, '[data-learning-action="show-intro"]');
    await keyControl(f, '[data-learning-action="dismiss-intro"]');
    assert(await f.$eval('#learning-intro', e => e.hidden));
    const exerciseTopic = '[data-learning-topic="exercises"]';
    if (!await f.$eval(exerciseTopic, e => e.open))
      await keyControl(f, exerciseTopic + ' summary');
    await keyControl(f, '[data-learning-action="exercise"]');
    await until(async () => await page.$('.quick-input-widget'), 'exercise chooser');
    await page.keyboard.press('Enter'); await sleep(200);
    const exercise = (await api({ op: 'state' })).active;
    assert.equal(exercise.language, 'python'); assert(exercise.untitled);
    record('1-guidance', { empty, exercise: { uri: exercise.uri,
      language: exercise.language, untitled: exercise.untitled },
      introDismissed: true, comprehensionTested: false });

    f = await show('review-timing.py');
    assert(await f.$eval('#learning-intro', e => e.hidden));
    if (!await f.$eval('#learning-help', e => e.hidden))
      await keyControl(f, '[data-learning-toggle]');
    const timing = await f.$eval('.loop-explorer', e => e.innerText);
    assert.match(timing, /v at iteration start; u at iteration end/);
    assert.match(timing, /v = 1, u = 99/);
    const timingRows = await f.$$eval('.loop-data.loop-iteration',
      es => es.map(e => [...e.children].map(c => c.innerText)));
    assert(timingRows[0][1].includes('4'));
    await keyControl(f, '.loop-recording-details summary');
    const timingWhy = await f.$eval('.loop-recording-details', e => e.innerText);
    await shot('timing');
    await keyControl(f, '.loop-recording-details summary');
    record('2-timing', { timing, timingRows, timingWhy });

    f = await show('review-stale.py');
    await editor('review-stale.py');
    await api({ op: 'edit', startLine: 0, startChar: 8,
      endLine: 0, endChar: 9, text: '5' });
    await command('evalens.evaluateAtCursor');
    await command('evalens.showValuesPanel'); f = await current();
    const stale = await f.$eval('tr[data-goto="1"]', e => e.innerText);
    assert.match(stale, /12/); assert.match(stale, /scale/);
    record('3-stale', { answer: stale,
      interpretation: 'Historical 12 preserved after only scale reevaluated.' });

    f = await show('review-continue.py');
    await keyControl(f, '.loop-missing-why summary');
    const missing = await f.$eval('.loop-missing-why', e => e.innerText);
    assert.match(missing, /does not tell us whether the assignment ran/);
    assert.match(missing, /None or zero/);
    await shot('missing');
    f = await show('review-carry.py');
    const carry = await f.$$eval('.loop-data.loop-iteration',
      es => es.map(e => e.innerText));
    assert.equal(carry.length, 3);
    assert(carry.every(s => s.includes('u = 4')));
    record('4-missing', { assignedBeforeContinue: missing, carry });

    f = await show('review-paging.py');
    const outerNav = '[data-loop-navigation="1"]';
    await keyControl(f, outerNav + ' [data-loop-control="next"]');
    f = await current();
    const outerPage = await f.$eval(outerNav, e => e.innerText);
    assert.match(outerPage, /21–25 of 25/);
    const entryId = await f.$eval(
      '[data-loop-invocation="1"] > .loop-entries > .loop-iteration',
      e => e.dataset.loopEntry);
    await keyControl(f, `[data-loop-action="toggle"][data-loop-id="${entryId}"]`);
    f = await current();
    const innerId = await f.$eval(`[data-loop-entry="${entryId}"] .loop-invocation`,
      e => e.dataset.loopInvocation);
    const innerNav = `[data-loop-navigation="${innerId}"]`;
    await keyControl(f, innerNav + ' [data-loop-control="next"]');
    f = await current();
    const innerPage = await f.$eval(innerNav, e => e.innerText);
    assert.match(innerPage, /21–25 of 25/);
    await keyControl(f, '.result-disclosure');
    assert.equal(await f.$eval('.result-disclosure', e => e.ariaExpanded), 'false');
    await keyControl(f, '.result-disclosure');
    assert.equal(await f.$eval(innerNav, e => e.innerText), innerPage);
    f = await show('review-limits.py');
    const outerLimit = await f.$eval('[data-loop-context="1"]', e => e.innerText);
    assert.match(outerLimit, /details saved for the first 20/);
    assert(await f.$eval(outerNav + ' [data-loop-control="next"]', e => e.disabled));
    const overflow = await f.$eval('[data-loop-overflow="1"]', e => e.innerText);
    assert.match(overflow, /Remaining printed output/);
    assert.equal(await f.$eval('[data-loop-overflow="1"] button',
      e => e.ariaExpanded), 'false');
    await shot('limits');
    record('5-paging-and-limits', { outerPage, innerPage, innerPageSurvivedFold: true,
      outerLimit, overflow });

    // Final tasks 6 and 7 use the coordinating agent's actual Host reports
    // and final-loop-keys.cjs. This early walkthrough keeps its original scope.

    f = await show('review-state-a.py');
    await command('evalens.clearResults');
    await editor('review-state-b.py');
    await command('evalens.evaluateAtCursor');
    await command('evalens.showValuesPanel'); f = await current();
    const retained = await f.$eval('.value-cell', e => e.innerText);
    assert.match(retained, /7/);
    await command('evalens.restartKernel');
    await editor('review-state-b.py');
    await command('evalens.evaluateAtCursor');
    await command('evalens.showValuesPanel'); f = await current();
    const restarted = await f.$eval('.value-cell', e => e.innerText);
    assert.match(restarted, /NameError/);
    if (await f.$eval('#learning-help', e => e.hidden))
      await keyControl(f, '[data-learning-toggle]');
    const session = '[data-learning-topic="session"]';
    if (!await f.$eval(session, e => e.open)) await keyControl(f, session + ' summary');
    const sessionHelp = await f.$eval(session, e => e.innerText);
    assert.match(sessionHelp, /Existing recorded results remain visible/);
    record('8-session', { clearThenOtherFile: retained, afterRestart: restarted,
      sessionHelp, replayEvidence: 'Reuse #188 real-pipe lifecycle report; not rerun here.' });
    const debuggerTopic = '[data-learning-topic="debugger"]';
    if (!await f.$eval(debuggerTopic, e => e.open))
      await keyControl(f, debuggerTopic + ' summary');
    const debuggerHelp = await f.$eval(debuggerTopic, e => e.innerText);
    assert.match(debuggerHelp, /call stack/);
    assert.match(debuggerHelp, /does not resume an Evalens recording/);
    await f.$eval(debuggerTopic, e => e.scrollIntoView({ block: 'start' }));
    await shot('debugger-guidance');
    record('9-debugger-choice', { debuggerHelp,
      humanChoiceObserved: false, debuggerStartedByThisTask: false });
    record('complete', { scope: 'Early tasks 1–5 and 8–9',
      finalEvidence: 'See findings.md for native inspection and keyboard checks.' });
  } finally { await browser.disconnect(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
