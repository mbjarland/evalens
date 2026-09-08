const assert = require('node:assert/strict');
const fs = require('node:fs');
const { api, sleep, connect, until } = require('/private/tmp/evalens-learning-live/client.cjs');
const output = process.env.EVALENS_193_REPORT || '/private/tmp/evalens-193/source';
const expectedRoot = process.env.EVALENS_193_ROOT || '/Users/mbjarland/projects/evalens-worktrees/193-nested-loop-values-first';
const cases = [
  {name: 'uniform', lines: [
    /x ×100: 0, 1, 2, 3, 4, … \(\+94 more\) … 99/,
    /y: 0, 1, 2, 3, 4, …, 99 · 100 runs · 10,000 iterations total/,
  ], hover: /10,000 iterations total across 100 loop runs|10000 iterations total across 100 loop runs/},
  {name: 'uneven', lines: [/x ×4: 1, 3, 0, 2/, /y: 0, 0, 1, 0, 1 · 4 runs · 5 iterations total/], hover: /5 iterations total across 4 loop runs/},
  {name: 'empty', lines: [/x ×2: 0, 1/, /y: \(no iterations\) · 2 runs · 0 iterations total/], hover: /0 iterations total across 2 loop runs/},
  {name: 'unreached', lines: [/x: \(no iterations\)/, /y: \(not reached\)/], hover: /Loop not reached/},
  {name: 'single', lines: [/x ×1: 0/, /y ×3: 0, 1, 2/], hover: /3 iterations/},
  {name: 'shadowed', lines: [/x ×2: 1, 2/, /x: 7, 8, 7, 8 · 2 runs · 4 iterations total/, /x: 9, 9, 9, 9 · 4 runs · 4 iterations total/], hover: /4 iterations total across 2 loop runs/},
];
(async () => {
  await until(async () => { try { return !!await api({op: 'state'}); } catch { return false; } }, 'Host');
  const {browser, page} = await connect();
  try {
    await page.setViewport({width: 1900, height: 850, deviceScaleFactor: 1});
    const state = await api({op: 'state'});
    assert.equal(state.extensions.find(e => e.id === 'mbjarland.evalens').path, expectedRoot);
    for (const command of ['workbench.action.closeSidebar', 'workbench.action.closeAuxiliaryBar', 'workbench.action.closePanel', 'workbench.action.joinAllGroups']) await api({op:'command', command});
    for (const [key, value] of [['wordWrap', 'off'], ['fontSize', 18], ['lineHeight', 28]]) await api({op:'setting', section:'editor', key, value});
    const report = {extension: expectedRoot, fixtures: []};
    for (const test of cases) {
      const file = '/private/tmp/evalens-193/workspace/' + test.name + '.py';
      await api({op:'open', path: file});
      await api({op:'cursor', line:0});
      await api({op:'command', command:'evalens.evaluateAtCursor'});
      const editor = '.monaco-editor[data-uri="file://' + file + '"]';
      const read = () => page.$eval(editor, e => [...e.querySelectorAll('.view-line')].map(row => {
        const pieces = [...row.querySelectorAll('span')].map(s => {
          const style = getComputedStyle(s, '::after');
          const content = style.content;
          if (content === 'none' || content === 'normal' || content === '""') return null;
          const text = content.slice(1, -1).replace(/\u00a0/g, ' ');
          return {text, color:style.color};
        }).filter(Boolean);
        return {source:row.textContent, text:pieces.map(p => p.text).join(''), pieces};
      }));
      await until(async () => (await read()).some(r => r.text), 'paint ' + test.name);
      const rows = await read();
      test.lines.forEach((pattern, i) => assert.match(rows[i].text, pattern, test.name + ' line ' + (i + 1)));
      const hover = await api({op:'hover', line:1, character:8});
      const hoverText = hover.flatMap(h => h.contents.map(c => typeof c === 'string' ? c : c.value)).join('\n');
      assert.match(hoverText, test.hover);
      if (['uniform', 'uneven', 'empty', 'shadowed'].includes(test.name)) {
        const pieces = rows[1].pieces;
        const meta = pieces.find(p => p.text.includes(' runs · '));
        assert(meta, 'metadata segment exists');
        const values = pieces.find(p => p.text.includes(test.name === 'empty' ? '(no iterations)' : test.name === 'shadowed' ? '7, 8' : '0,'));
        assert(values, 'value segment exists');
        assert.notEqual(meta.color, values.color, 'counts use label color');
      }
      await api({op:'cursor', line:1, character:8});
      await sleep(200);
      await page.screenshot({path:output + '-' + test.name + '.png'});
      report.fixtures.push({name:test.name, rows, hover:hoverText});
    }
    fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({extension:expectedRoot, cases:report.fixtures.length, report:output + '.json'}, null, 2));
  } finally { await browser.disconnect(); }
})().catch(e => { console.error(e); process.exit(1); });
