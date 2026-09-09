const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { api, connect, sleep } = require('./client.cjs');

const repo = path.resolve(__dirname, '../../../..');
const runtime = process.argv[2]
  || '/Users/mbjarland/projects/evalens-worktrees/205-aligned-loop-guides';
const scratch = '/private/tmp/evalens-206';
const draft = process.env.EVALENS_CAPTURE_DRAFT === '1';
const captureDir = path.join(scratch, draft ? 'draft' : 'capture');
fs.mkdirSync(captureDir, { recursive: true });
const imagePath = image => path.join(captureDir, path.basename(image));
const fixture = 'fixtures/nested-loops-base.py';
const source = fs.readFileSync(path.join(repo,
  'docs/reviews/196-marketplace-page-refresh', fixture), 'utf8');
const captureRevision = execFileSync('git', ['-C', runtime, 'rev-parse', 'HEAD'],
  { encoding: 'utf8' }).trim();
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

(async () => {
  const state = await api({ op: 'state' });
  assert.deepEqual(state.workspace, [scratch + '/workspace']);
  assert.equal(state.extensions.find(e => e.id === 'mbjarland.evalens').path, runtime);
  assert.equal(state.extensions.find(e => e.id === 'local.evalens-learning-review-bridge').path,
    scratch + '/bridge');
  const { browser, page, frame } = await connect();
  const captures = [];
  const metadata = (image, details) => {
    const png = fs.readFileSync(imagePath(image));
    return {
      image, sha256: sha256(png), width: png.readUInt32BE(16),
      height: png.readUInt32BE(20), fixture, ...details,
      deviceScaleFactor: 2, extensionPath: runtime, captureRevision,
      theme: 'Default Dark Modern',
    };
  };
  try {
    await page.setViewport({ width: 1150, height: 1000, deviceScaleFactor: 2 });
    for (const command of ['workbench.action.closeSidebar',
      'workbench.action.closeAuxiliaryBar', 'workbench.action.closePanel',
      'workbench.action.joinAllGroups']) await api({ op: 'command', command });
    await api({ op: 'setting', section: 'editor', key: 'fontSize', value: 18 });
    await api({ op: 'open', path: scratch + '/workspace/nested-loops.py' });
    await api({ op: 'command', command: 'evalens.clearResults' });
    await api({ op: 'cursor', line: 6 });
    await api({ op: 'command', command: 'workbench.action.focusStatusBar' });
    await page.mouse.move(20, 20);
    await sleep(600);
    const openState = await api({ op: 'state' });
    assert.equal(openState.active.text, source);
    assert.equal(openState.active.language, 'python');
    const editorSelector = '.monaco-editor[data-uri="' + openState.active.uri + '"]';
    const rendered = await page.$eval(editorSelector, editor => {
      const lines = [...editor.querySelectorAll('.view-line')].slice(0, 6);
      const bounds = editor.querySelector('.view-lines').getBoundingClientRect();
      const first = lines[0].getBoundingClientRect();
      const last = lines[5].getBoundingClientRect();
      return {
        source: lines.map(line => line.textContent.replace(/\u00a0/g, ' ')),
        fontSize: getComputedStyle(editor.querySelector('.view-lines')).fontSize,
        fontFamily: getComputedStyle(editor.querySelector('.view-lines')).fontFamily,
        backgroundColor: getComputedStyle(editor).backgroundColor,
        syntaxColors: [...new Set(lines.flatMap(line => [...line.querySelectorAll('span')]
          .map(span => getComputedStyle(span).color)))],
        clip: {
          x: Math.floor(bounds.x - 16), y: Math.floor(first.y - 12),
          width: 711, height: Math.ceil(last.bottom - first.y + 24),
        },
      };
    });
    assert.equal(rendered.source.join('\n') + '\n', source);
    assert.equal(rendered.fontSize, '18px');
    assert(rendered.syntaxColors.length >= 4);
    const sourceImage = 'media/demo/nested-loop-code.png';
    await page.screenshot({ path: imagePath(sourceImage), clip: rendered.clip });
    await page.screenshot({ path: path.join(captureDir, 'native-source-full.png') });
    captures.push(metadata(sourceImage, {
      description: 'Actual native Python source for the nested-loop example: set and print base before the inner loop, compute v = base + y, and print x, y. Copyable source precedes the result in README and the user guide.',
      ...rendered, evaluated: false,
    }));

    await api({ op: 'setting', section: 'editor', key: 'fontSize', value: 16 });
    await api({ op: 'cursor', line: 0 });
    await api({ op: 'command', command: 'evalens.evaluateFile' });
    await api({ op: 'command', command: 'evalens.showValuesPanel' });
    if (await page.$eval('.part.panel', element =>
      element.getBoundingClientRect().height < innerHeight / 2)) {
      await api({ op: 'command', command: 'workbench.action.toggleMaximizedPanel' });
    }
    await page.setViewport({ width: 1150, height: 1000, deviceScaleFactor: 2 });
    await sleep(450);
    let f = await frame('.loop-tree');
    const toggles = await f.$$eval(
      '.loop-group > .loop-iteration-header [data-loop-action="toggle"]',
      elements => elements.map(element => ({
        id: element.dataset.loopId, expanded: element.getAttribute('aria-expanded'),
      })));
    assert.equal(toggles.length, 2);
    for (const [index, toggle] of toggles.entries()) {
      if ((toggle.expanded === 'true') !== (index === 1)) {
        await f.focus(`[data-loop-action="toggle"][data-loop-id="${toggle.id}"]`);
        await page.keyboard.press('Enter');
        await sleep(160);
        f = await frame('.loop-tree');
      }
    }
    await api({ op: 'cursor', line: 0 });
    await sleep(200);
    f = await frame('.loop-tree');
    await f.focus('#follow-cursor');
    await page.mouse.move(20, 20);
    await f.evaluate(() => window.scrollTo(0, 0));
    await sleep(180);
    const observed = await f.$eval('.loop-tree', explorer => {
      const rect = element => {
        const bounds = element.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      };
      return {
        text: explorer.innerText,
        columnHeadingCount: explorer.querySelectorAll('.loop-columns').length,
        aboutCount: explorer.querySelectorAll('.loop-recording-details').length,
        parentReadings: [...explorer.querySelectorAll('.loop-parent-reading')]
          .map(element => ({ text: element.innerText, ...rect(element) })),
        guideCount: explorer.querySelectorAll('.loop-guides').length,
        guideMarkup: [...explorer.querySelectorAll('.loop-guides')].map(element => element.outerHTML),
        groups: [...explorer.querySelectorAll('.loop-group > .loop-iteration-header')]
          .map(element => ({ text: element.innerText,
            expanded: element.querySelector('[data-loop-action="toggle"]')?.getAttribute('aria-expanded') })),
        captions: [...explorer.querySelectorAll('.loop-group > .loop-iteration-header [data-loop-action="toggle"]')]
          .map(button => {
            const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
              const start = node.textContent.indexOf('Iteration');
              if (start < 0) continue;
              const range = document.createRange();
              range.setStart(node, start);
              range.setEnd(node, node.textContent.length);
              return { text: node.textContent.slice(start), ...rect(range) };
            }
            throw Error('Iteration caption text missing');
          }),
        geometry: [...explorer.querySelectorAll(
          '.loop-columns > span, .loop-parent-reading, .loop-source, .loop-target')]
          .map(element => ({ className: element.className,
            text: element.innerText, ...rect(element) })),
        fontSize: getComputedStyle(explorer).fontSize,
        backgroundColor: getComputedStyle(explorer).backgroundColor,
      };
    });
    assert.equal(observed.columnHeadingCount, 1);
    assert.equal(observed.aboutCount, 1);
    assert.deepEqual(observed.groups.map(group => group.expanded), ['false', 'true']);
    assert.equal(observed.parentReadings.length, 1);
    assert.match(observed.parentReadings[0].text, /base = 10/);
    assert(observed.guideCount > 0);
    assert.match(observed.text, /base = 0/);
    for (const expected of ['base: 10', 'y = 0, v = 10', 'y = 1, v = 11',
      'y = 2, v = 12', '1 0', '1 1', '1 2', 'line 4']) {
      assert(observed.text.includes(expected), 'Missing captured content: ' + expected);
    }
    assert(!/Recording details|within Iteration|at iteration start/.test(observed.text));
    const element = await f.$('.whole-result');
    const clip = await element.boundingBox();
    const resultImage = 'media/demo/nested-loops.png';
    await element.screenshot({ path: imagePath(resultImage) });
    await page.screenshot({ path: path.join(captureDir, 'native-result-full.png') });
    captures.push(metadata(resultImage, {
      description: 'Actual aligned nested-loop explorer: Iteration 1 is folded with base = 0; Iteration 2 is expanded with a separate base = 10 reading and base: 10 output, a short guide to its inner loop, and indented y/v readings under one pair of headings.',
      ...observed, clip, evaluated: true,
    }));
    if (draft) {
      fs.writeFileSync(path.join(captureDir, 'captures.json'), JSON.stringify({
        draft: true, method: 'native-vscode', workspace: state.workspace,
        ports: { cdp: 9434, bridge: 9435 }, captures,
      }, null, 2) + '\n');
      console.log('Draft native review images: ' + captureDir);
      return;
    }
    for (const capture of captures) fs.copyFileSync(imagePath(capture.image), path.join(repo, capture.image));
    for (const name of ['native-source-full.png', 'native-result-full.png']) {
      fs.copyFileSync(path.join(captureDir, name), path.join(__dirname, name));
    }
    const manifestPath = path.join(repo, 'docs/reviews/196-marketplace-page-refresh/captures.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const priorCaptures = manifest.captures.filter(capture =>
      captures.some(next => next.image === capture.image));
    const priorFile = path.join(__dirname, 'previous-captures.json');
    if (!fs.existsSync(priorFile)) {
      fs.writeFileSync(priorFile, JSON.stringify(priorCaptures, null, 2) + '\n');
    }
    for (const capture of captures) {
      manifest.captures[manifest.captures.findIndex(old => old.image === capture.image)] = capture;
    }
    const note = ' The nested source and result images were refreshed for #206 using the six-line nested-loops-base fixture and the aligned-guide runtime; previous metadata is retained in docs/reviews/206-loop-learning-refresh/native/previous-captures.json.';
    if (!manifest.captureNotes.includes('refreshed for #206')) manifest.captureNotes += note;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    fs.writeFileSync(path.join(__dirname, 'captures.json'), JSON.stringify({
      method: 'native-vscode', workspace: state.workspace,
      ports: { cdp: 9434, bridge: 9435 }, captures,
    }, null, 2) + '\n');
    console.log(JSON.stringify(captures.map(capture => ({
      image: capture.image, sha256: capture.sha256,
      width: capture.width, height: capture.height, captureRevision,
    })), null, 2));
  } finally { await browser.disconnect(); }
})().catch(error => { console.error(error); process.exit(1); });
