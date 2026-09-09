const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '../../../..');
const scratch = '/private/tmp/evalens-206';
for (const dir of ['workspace', 'bridge', 'native-user-data/User', 'extensions']) {
  fs.mkdirSync(path.join(scratch, dir), { recursive: true });
}
fs.copyFileSync(path.join(repo,
  'docs/reviews/196-marketplace-page-refresh/fixtures/nested-loops-base.py'),
path.join(scratch, 'workspace/nested-loops.py'));
fs.copyFileSync(path.join(__dirname, 'bridge.cjs'), path.join(scratch, 'bridge/bridge.cjs'));
fs.writeFileSync(path.join(scratch, 'bridge/package.json'), JSON.stringify({
  name: 'evalens-learning-review-bridge', publisher: 'local', version: '0.0.1',
  engines: { vscode: '^1.90.0' }, main: './bridge.cjs',
  activationEvents: ['onStartupFinished'],
}, null, 2) + '\n');
fs.writeFileSync(path.join(scratch, 'native-user-data/User/settings.json'), JSON.stringify({
  'security.workspace.trust.enabled': false,
  'workbench.startupEditor': 'none',
  'workbench.colorTheme': 'Default Dark Modern',
  'extensions.autoCheckUpdates': false,
  'extensions.autoUpdate': 'off',
  'editor.fontFamily': 'Menlo',
  'editor.fontSize': 18,
  'editor.lineHeight': 28,
  'editor.minimap.enabled': false,
  'editor.renderLineHighlight': 'none',
  'editor.selectionHighlight': false,
  'editor.occurrencesHighlight': 'off',
  'editor.padding.top': 20,
  'editor.guides.indentation': true,
  'editor.wordWrap': 'off',
  'evalens.resetOnLoad': true,
}, null, 2) + '\n');
console.log(scratch);
