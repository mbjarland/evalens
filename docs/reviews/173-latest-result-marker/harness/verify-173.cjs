const fs=require('node:fs');const assert=require('node:assert/strict');
const {api,sleep,connect,until}=require('./client.cjs');
const root='/private/tmp/evalens-learning-live/workspace';const report=[];
(async()=>{
 await until(async()=>{try{return !!await api({op:'state'});}catch{return false;}},'Host ready');
 const {browser,page,frame}=await connect();
 const rows=async()=>{const f=await frame('tr.row');return f.$$eval('tr.row',es=>es.map(e=>({line:Number(e.dataset.goto),latest:e.classList.contains('latest-result'),cursor:e.classList.contains('cursor'),aria:e.getAttribute('aria-current'),text:e.textContent,label:e.querySelector('.latest-result-label')?.textContent,bar:getComputedStyle(e.querySelector('.line-cell')).borderLeftColor})));};
 const check=async(line,sourceLine)=>{await until(async()=>{try{return (await rows()).filter(r=>r.latest).length===1&&(await rows()).some(r=>r.latest&&r.line===line);}catch{return false;}},'latest row '+line);await sleep(100);const rs=await rows();assert.equal((await api({op:'state'})).active.line,sourceLine);assert.equal(rs.filter(r=>r.latest).length,1);assert.equal(rs.find(r=>r.latest).label,'Latest result');return rs;};
 const press=async(advance)=>{await api({op:'command',command:'workbench.action.focusActiveEditorGroup'});await page.keyboard.down('Meta');if(advance)await page.keyboard.down('Shift');await page.keyboard.press('Enter');if(advance)await page.keyboard.up('Shift');await page.keyboard.up('Meta');};
 await api({op:'open',path:root+'/key-dispatch.py'});await api({op:'command',command:'evalens.clearResults'});await api({op:'cursor',line:0});await api({op:'command',command:'evalens.showValuesPanel'});
 await press(true);let rs=await check(0,1);assert.equal(rs[0].cursor,false);assert.match(rs[0].text,/42/);report.push({case:'actual Shift-Cmd-Enter marks42 after advance',rows:rs});
 await press(true);rs=await check(1,2);assert.match(rs.find(r=>r.latest).text,/43/);report.push({case:'second actual Shift-Cmd-Enter moves latest cue',rows:rs});
 await press(false);rs=await check(2,2);assert(rs.find(r=>r.latest).cursor);assert.match(rs.find(r=>r.latest).text,/44/);report.push({case:'actual Cmd-Enter stays and combines current/latest',rows:rs});
 await api({op:'cursor',line:0});await press(true);rs=await check(0,1);assert(rs.find(r=>r.line===1).cursor);assert.equal(rs.find(r=>r.line===0).aria,'false');report.push({case:'previously evaluated next line keeps current separate',rows:rs});
 await api({op:'cursor',line:3});rs=await check(0,3);assert(!rs.some(r=>r.cursor));report.push({case:'unmatched cursor retains latest cue'});
 await api({op:'setting',section:'evalens.valuesPanel',key:'follow',value:false});await api({op:'setting',section:'evalens.valuesPanel',key:'followCursor',value:false});await api({op:'cursor',line:1});await press(true);await check(1,2);report.push({case:'latest cue independent of follow settings'});
 await api({op:'setting',section:'evalens.valuesPanel',key:'follow',value:true});await api({op:'setting',section:'evalens.valuesPanel',key:'followCursor',value:true});
 await api({op:'open',path:root+'/single-square.py'});await api({op:'cursor',line:0});await press(false);await check(0,0);
 await api({op:'open',path:root+'/key-dispatch.py'});await check(1,2);report.push({case:'per-file latest restored on editor switch'});
 await api({op:'command',command:'workbench.action.closePanel'});await api({op:'command',command:'evalens.showValuesPanel'});await check(1,2);report.push({case:'view hide/reopen preserves cue'});
 for(const [theme,name,bar] of [['Dark Modern','dark','rgb(230, 173, 69)'],['Light Modern','light','rgb(143, 88, 10)'],['Default High Contrast','hc','rgb(255, 209, 102)'],['Default High Contrast Light','hc-light','rgb(89, 52, 0)']]){await api({op:'setting',section:'workbench',key:'colorTheme',value:theme});await sleep(550);rs=await check(1,2);assert.equal(rs.find(r=>r.latest).bar,bar);await page.screenshot({path:'/private/tmp/evalens-173-'+name+'.png'});report.push({case:theme,bar});}
 await api({op:'setting',section:'workbench',key:'colorTheme',value:'Dark Modern'});await sleep(300);
 await api({op:'open',path:root+'/x5-large.py'});await api({op:'cursor',line:0});await press(false);await check(0,0);let f=await frame('.loop-explorer');const toggle=await f.$('[data-loop-action="toggle"]');if(toggle){await toggle.click();await sleep(100);await check(0,0);}
 f=await frame('.loop-explorer');const style=await f.$eval('.loop-explorer',e=>({bg:getComputedStyle(e.closest('.result-surface')).backgroundColor,radius:getComputedStyle(e.closest('.result-surface')).borderRadius}));assert.equal(style.bg,'rgba(0, 0, 0, 0)');assert.equal(style.radius,'0px');report.push({case:'loop fold rebuild preserves latest and transparent square surface',style});
 await api({op:'command',command:'evalens.clearResults'});await sleep(200);f=await frame('#navigation-control');assert.equal((await f.$$('.latest-result-label')).length,0);report.push({case:'clear removes latest cue'});
 await api({op:'open',path:root+'/key-dispatch.py'});await api({op:'cursor',line:0});await press(true);await check(0,1);
 await page.screenshot({path:'/private/tmp/evalens-173-advance.png'});
 fs.writeFileSync('/private/tmp/evalens-173-host-results.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.disconnect();
})().catch(e=>{console.error(e);process.exit(1)});
