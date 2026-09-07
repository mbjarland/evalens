const assert=require('node:assert/strict');const fs=require('node:fs');
const {api,sleep,connect,until}=require('./client.cjs');const root='/private/tmp/evalens-learning-live';
(async()=>{
 await until(async()=>{try{return !!await api({op:'state'});}catch{return false;}},'Host ready');
 const {browser,page,frame}=await connect();
 await api({op:'open',path:`${root}/workspace/x5-small.py`});await api({op:'cursor',line:0});await api({op:'command',command:'evalens.evaluateAtCursor'});await api({op:'command',command:'evalens.showValuesPanel'});await sleep(200);
 let f=await frame('.loop-explorer');await f.click('[data-loop-action="select"][data-loop-id="5"]');await sleep(200);
 f=await frame('.loop-selected');const colors=await f.$eval('.loop-explorer',e=>({row:getComputedStyle(e.closest('tr')).backgroundColor,surface:getComputedStyle(e.closest('.result-surface')).backgroundColor,bar:getComputedStyle(e.closest('.result-surface')).borderLeftColor,selection:getComputedStyle(e.querySelector('.loop-selected')).backgroundColor,outline:getComputedStyle(e.querySelector('.loop-selected')).outlineWidth}));
 assert.equal(colors.row,'rgba(0, 0, 0, 0)');assert.equal(colors.surface,'rgba(0, 0, 0, 0)');assert.equal(colors.bar,'rgb(230, 173, 69)');assert.equal(colors.outline,'1px');
 await page.screenshot({path:`${root}/x5-neutral-background-host.png`});
 fs.writeFileSync(`${root}/background-results.json`,JSON.stringify(colors,null,2)+'\n');console.log(colors);await browser.disconnect();
})().catch(e=>{console.error(e);process.exit(1)});
