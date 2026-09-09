// Use only the disposable profile named here; never a personal VS Code profile.
const fs=require('node:fs'),path=require('node:path');
const root='/private/tmp/evalens-196';
for(const d of ['workspace','user-data/User','extensions','bridge'])fs.mkdirSync(path.join(root,d),{recursive:true});
for(const name of fs.readdirSync(path.join(__dirname,'../fixtures')))fs.copyFileSync(path.join(__dirname,'../fixtures',name),path.join(root,'workspace',name));
fs.writeFileSync(path.join(root,'user-data/User/settings.json'),JSON.stringify({'workbench.startupEditor':'none','workbench.colorTheme':'Default Dark Modern','extensions.autoCheckUpdates':false,'extensions.autoUpdate':false,'evalens.valuesPanel.followCursor':true,'evalens.valuesPanel.follow':true},null,2));
fs.writeFileSync(path.join(root,'bridge/package.json'),JSON.stringify({name:'evalens-review-bridge',publisher:'local',version:'0.0.1',engines:{vscode:'^1.90.0'},main:'./bridge.cjs',activationEvents:['onStartupFinished']}));
fs.copyFileSync(path.join(__dirname,'bridge.cjs'),path.join(root,'bridge/bridge.cjs'));
console.log('Prepared disposable fixtures, profile, and loopback review bridge in '+root);
