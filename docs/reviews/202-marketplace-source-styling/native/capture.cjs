const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repo = path.resolve(__dirname, '../../../..');
const scratch = '/private/tmp/evalens-202';
const expectedExtension = '/private/tmp/evalens-198/extensions/mbjarland.evalens-0.2.0';
const fixture = 'fixtures/nested-loops.py';
const source = fs.readFileSync(path.join(repo,
  'docs/reviews/196-marketplace-page-refresh', fixture), 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const api = async request => {
  const response = await fetch('http://127.0.0.1:9425', {
    method: 'POST', body: JSON.stringify(request),
  });
  const body = await response.json();
  assert(body.ok, JSON.stringify(body));
  return body.result;
};

(async () => {
  const state = await api({ op: 'state' });
  assert.deepEqual(state.workspace, [scratch + '/workspace']);
  assert.equal(state.extensions.find(e => e.id === 'mbjarland.evalens').path,
    expectedExtension);
  assert.equal(state.extensions.find(e => e.id === 'local.evalens-source-review-bridge').path,
    scratch + '/bridge');
  const { connect } = require(path.join(repo, 'node_modules/puppeteer-core'));
  const browser = await connect({ browserURL: 'http://127.0.0.1:9424', defaultViewport: null });
  try {
    const pages = await browser.pages();
    assert.equal(pages.length, 1, 'Dedicated capture browser must have one window');
    const page = pages[0];
    const session = await page.createCDPSession();
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await page.bringToFront();
    await page.setViewport({ width: 1150, height: 800, deviceScaleFactor: 2 });
    for (const command of ['workbench.action.closeSidebar',
      'workbench.action.closeAuxiliaryBar', 'workbench.action.closePanel',
      'workbench.action.joinAllGroups']) {
      await api({ op: 'command', command });
    }
    await api({ op: 'open', path: scratch + '/workspace/nested-loops.py' });
    await api({ op: 'cursor', line: 4 });
    await api({ op: 'command', command: 'workbench.action.focusStatusBar' });
    await page.mouse.move(20, 20);
    await sleep(600);
    const finalState = await api({ op: 'state' });
    assert.equal(finalState.active.text, source);
    assert.equal(finalState.active.language, 'python');
    const selector = '.monaco-editor[data-uri="' + finalState.active.uri + '"]';
    const rendered = await page.$eval(selector, editor => {
      const lines = [...editor.querySelectorAll('.view-line')].slice(0, 4);
      const bounds = editor.querySelector('.view-lines').getBoundingClientRect();
      const first = lines[0].getBoundingClientRect();
      const last = lines[3].getBoundingClientRect();
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
    assert(rendered.syntaxColors.length >= 4, 'Native Python syntax colors must be visible');
    const image = 'media/demo/nested-loop-code.png';
    await page.screenshot({ path: path.join(repo, image), clip: rendered.clip });
    await page.screenshot({ path: path.join(__dirname, 'native-source-full.png') });
    const png = fs.readFileSync(path.join(repo, image));
    const metadata = {
      image,
      sha256: crypto.createHash('sha256').update(png).digest('hex'),
      width: png.readUInt32BE(16), height: png.readUInt32BE(20), fixture,
      description: 'Actual unevaluated Python source for the nested-loop example, with native syntax colors and dark editor background. The README keeps the exact source copyable below this capture.',
      ...rendered,
      deviceScaleFactor: 2,
      extensionPath: expectedExtension,
      captureRevision: execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      theme: 'Default Dark Modern',
      evaluated: false,
    };
    const manifestPath = path.join(repo, 'docs/reviews/196-marketplace-page-refresh/captures.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const index = manifest.captures.findIndex(capture => capture.image === image);
    if (index === -1) manifest.captures.push(metadata);
    else manifest.captures[index] = metadata;
    const note = ' The source-only nested-loop-code image was added for #202 from a dedicated native VS Code window; it was not evaluated and existing result captures were unchanged.';
    if (!manifest.captureNotes.includes('source-only nested-loop-code')) manifest.captureNotes += note;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    fs.writeFileSync(path.join(__dirname, 'capture.json'), JSON.stringify({
      ...metadata, workspace: finalState.workspace, ports: { cdp: 9424, bridge: 9425 },
    }, null, 2) + '\n');
    console.log(JSON.stringify(metadata, null, 2));
  } finally {
    await browser.disconnect();
  }
})().catch(error => { console.error(error); process.exit(1); });
