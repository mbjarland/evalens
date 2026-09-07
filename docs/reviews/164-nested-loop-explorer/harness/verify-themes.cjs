const assert=require('node:assert/strict');const fs=require('node:fs');
const {api,sleep,connect,until}=require('./client.cjs');
const root='/private/tmp/evalens-learning-live';
(async()=>{
 const {browser,page,frame}=await connect();
 await api({op:'open',path:`${root}/workspace/x5-small.py`});await api({op:'cursor',line:0});await api({op:'command',command:'evalens.evaluateAtCursor'});await api({op:'command',command:'evalens.showValuesPanel'});await sleep(250);
 const themes=[['Dark Modern','dark','rgb(230, 173, 69)'],['Light Modern','light','rgb(143, 88, 10)'],['Default High Contrast','high-contrast','rgb(255, 209, 102)'],['Default High Contrast Light','high-contrast-light','rgb(89, 52, 0)']];
 const report=[];
 for(const [theme,name,expected] of themes){
  await api({op:'setting',section:'workbench',key:'colorTheme',value:theme});await sleep(500);
  await until(async()=>{const f=await frame('.result-surface');return await f.$eval('.result-surface',e=>getComputedStyle(e).borderLeftColor)===expected;},theme);
  const f=await frame('.loop-explorer');const colors=await f.$eval('.loop-explorer',e=>({bodyClasses:document.body.className,text:getComputedStyle(e).color,bar:getComputedStyle(e.closest('.result-surface')).borderLeftColor,header:getComputedStyle(e.querySelector('.loop-iteration-header')).color,disclosure:getComputedStyle(e.querySelector('.loop-disclosure')).color}));
  assert.equal(colors.bar,expected);assert.match(await f.$eval('.loop-explorer',e=>e.innerText),/Values after loop: x = 1, y = 3/);
  await page.screenshot({path:`${root}/x5-installed-${name}.png`});report.push({theme,...colors});
 }
 await api({op:'setting',section:'workbench',key:'colorTheme',value:'Dark Modern'});
 fs.writeFileSync(`${root}/theme-results.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));await browser.disconnect();
})().catch(e=>{console.error(e);process.exit(1)});
