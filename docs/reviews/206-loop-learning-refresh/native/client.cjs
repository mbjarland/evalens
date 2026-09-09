const assert = require('node:assert/strict');
const path = require('node:path');
const repo = path.resolve(__dirname, '../../../..');
exports.sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
exports.api = async request => {
  const response = await fetch('http://127.0.0.1:9435', {
    method: 'POST', body: JSON.stringify(request),
  });
  const body = await response.json();
  assert(body.ok, JSON.stringify(body));
  return body.result;
};
exports.until = async (check, label) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await exports.sleep(100);
  }
  throw Error('Timed out: ' + label);
};
exports.connect = async () => {
  const { connect } = require(path.join(repo, 'node_modules/puppeteer-core'));
  const browser = await connect({ browserURL: 'http://127.0.0.1:9434', defaultViewport: null });
  const pages = await browser.pages();
  assert.equal(pages.length, 1, 'Dedicated native browser must have one window');
  const page = pages[0];
  const session = await page.createCDPSession();
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.bringToFront();
  const frame = async selector => {
    let result;
    await exports.until(async () => {
      for (const candidate of page.frames()) {
        try { if (await candidate.$(selector)) result = candidate; } catch {}
      }
      return !!result;
    }, selector);
    return result;
  };
  return { browser, page, frame };
};
