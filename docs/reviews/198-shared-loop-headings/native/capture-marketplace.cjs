const assert = require('node:assert/strict'), fs = require('node:fs'), crypto = require('node:crypto');
const { api, connect, sleep } = require('./client.cjs');
const repo = '/Users/mbjarland/projects/evalens-worktrees/198-shared-loop-headings';
const source = fs.readFileSync(repo + '/docs/reviews/196-marketplace-page-refresh/fixtures/nested-loops.py', 'utf8');
fs.writeFileSync('/private/tmp/evalens-198/workspace/nested-loops.py', source);
(async () => {
  const { browser, page, frame } = await connect();
  try {
    const state = await api({ op: 'state' });
    assert.equal(state.extensions.find(e => e.id === 'mbjarland.evalens').path, repo);
    assert.deepEqual(state.workspace, ['/private/tmp/evalens-198/workspace']);
    await api({ op: 'setting', section: 'editor', key: 'fontSize', value: 16 });
    await api({ op: 'setting', section: 'workbench', key: 'colorTheme', value: 'Default Dark Modern' });
    await api({ op: 'open', path: '/private/tmp/evalens-198/workspace/nested-loops.py' });
    await api({ op: 'cursor', line: 0 });
    await api({ op: 'command', command: 'evalens.evaluateFile' });
    await api({ op: 'command', command: 'evalens.showValuesPanel' });
    if (await page.$eval('.part.panel', e => e.getBoundingClientRect().height < innerHeight / 2))
      await api({ op: 'command', command: 'workbench.action.toggleMaximizedPanel' });
    await page.setViewport({ width: 1150, height: 1000, deviceScaleFactor: 2 });
    await sleep(400);
    let f = await frame('.loop-explorer');
    const toggles = await f.$$eval('.loop-group > .loop-iteration-header [data-loop-action="toggle"]', es => es.map(e => ({ id: e.dataset.loopId, expanded: e.getAttribute('aria-expanded') })));
    assert.equal(toggles.length, 2);
    for (const [index, toggle] of toggles.entries()) {
      if ((toggle.expanded === 'true') !== (index === 0)) {
        await f.focus(`[data-loop-action="toggle"][data-loop-id="${toggle.id}"]`);
        await page.keyboard.press('Enter'); await sleep(180); f = await frame('.loop-explorer');
      }
    }
    await api({ op: 'cursor', line: 0 }); await sleep(200); f = await frame('.loop-explorer');
    await f.focus('#follow-cursor'); await page.mouse.move(20, 20);
    await f.evaluate(() => window.scrollTo(0, 0)); await sleep(160);
    assert.equal(await f.$$eval('.loop-columns', es => es.length), 1);
    const text = await f.$eval('body', e => e.innerText);
    assert(!/Recording details|within Iteration|at iteration start/.test(text));
    const element = await f.$('.whole-result'), clip = await element.boundingBox();
    const image = 'media/demo/nested-loops.png';
    await element.screenshot({ path: repo + '/' + image });
    await page.screenshot({ path: '/private/tmp/evalens-198/native-marketplace-full.png' });
    const png = fs.readFileSync(repo + '/' + image);
    const metadata = {
      image, sha256: crypto.createHash('sha256').update(png).digest('hex'),
      width: png.readUInt32BE(16), height: png.readUInt32BE(20),
      fixture: 'fixtures/nested-loops.py',
      description: 'Actual nested loop explorer with one shared Variables / Printed output heading, compact inner rows, and optional About these values help.',
      text, clip, deviceScaleFactor: 2,
      extensionPath: repo, captureRevision: require('node:child_process').execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      theme: 'Default Dark Modern', editorFontSize: 16
    };
    const manifestPath = repo + '/docs/reviews/196-marketplace-page-refresh/captures.json';
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    manifest.captures[manifest.captures.findIndex(e => e.image === image)] = metadata;
    if (!manifest.captureNotes.includes('refreshed for #198')) manifest.captureNotes += ' The nested-loops image was refreshed for #198 from its dedicated native Extension Development Host; other captures retain their original provenance.';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    fs.writeFileSync('/private/tmp/evalens-198/marketplace-capture.json', JSON.stringify(metadata, null, 2) + '\n');
    console.log(JSON.stringify(metadata, null, 2));
  } finally { await browser.disconnect(); }
})().catch(e => { console.error(e); process.exit(1); });
