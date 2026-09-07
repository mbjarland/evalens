const assert=require('node:assert/strict');const fs=require('node:fs');
const {api,sleep,connect,until}=require('./client.cjs');
const root='/private/tmp/evalens-learning-live/workspace';
const report=[];
(async()=>{
 await until(async()=>{try{return !!await api({op:'state'});}catch{return false;}},'Host ready');
 const {browser,page,frame}=await connect();
 const inspect=()=>page.$eval('.monaco-editor[data-uri="file:///private/tmp/evalens-learning-live/workspace/x5-small.py"]',editor=>({
  tokens:[...editor.querySelectorAll('.view-line')].map(row=>[...row.querySelectorAll('span')].filter(s=>s.firstChild?.nodeType===3).map(s=>({text:s.textContent,color:getComputedStyle(s).color}))),
  lineTops:[...editor.querySelectorAll('.view-line')].map(e=>e.getBoundingClientRect().top),
  overlays:[...editor.querySelectorAll('.view-overlays .cdr[class*="TextEditorDecorationType"]')].map(e=>({class:e.className,top:e.getBoundingClientRect().top,bg:getComputedStyle(e).backgroundColor,bt:getComputedStyle(e).borderTopWidth,bl:getComputedStyle(e).borderLeftWidth})),
  glyphs:[...editor.querySelectorAll('.glyph-margin-widgets *')].map(e=>({top:e.getBoundingClientRect().top,bg:getComputedStyle(e).backgroundImage})),
 }));
 const checkLine=async(line,alpha='rgba(255, 255, 255, 0.05)')=>{
  await sleep(120);const d=await inspect();
  const washes=d.overlays.filter(e=>e.bg!=='rgba(0, 0, 0, 0)');
  assert.equal(washes.length,line===null?0:1,JSON.stringify(d.overlays));
  for(const e of d.overlays){assert.equal(e.bt,'0px');assert.equal(e.bl,'0px');}
  if(line!==null){assert.equal(washes[0].bg,alpha);assert.equal(washes[0].top,d.lineTops[line]);}
  assert.equal(d.glyphs.filter(g=>g.bg.includes('/current-')).length,line===null?0:1);
  return d;
 };
 await api({op:'open',path:root+'/x5-small.py'});await api({op:'cursor',line:0});
 await api({op:'command',command:'evalens.evaluateAtCursor'});await api({op:'command',command:'evalens.showValuesPanel'});
 await api({op:'command',command:'workbench.action.focusActiveEditorGroup'});await api({op:'cursor',line:2});await sleep(500);
 let d=await checkLine(2);
 assert.deepEqual(d.tokens,JSON.parse(fs.readFileSync('/private/tmp/evalens-source-baseline.json','utf8')).tokens);
 assert(d.glyphs.some(g=>g.bg.includes('current-plain-dark.svg')));
 report.push({case:'inner-header exact neutral wash, plain tick; syntax colors unchanged',overlays:d.overlays,glyphs:d.glyphs});
 await api({op:'cursor',line:5});await checkLine(5);
 await api({op:'cursor',line:0});d=await checkLine(0);
 assert(d.glyphs.some(g=>g.bg.includes('current-evaluated-dark.svg')));report.push({case:'body and root lines, combined evaluated glyph'});
 let f=await frame('.loop-explorer');await f.click('[data-loop-action="select"][data-loop-id="5"]');await sleep(180);
 assert.equal((await api({op:'state'})).active.line,2);await checkLine(2);
 report.push({case:'inner iteration activation marks actual inner header'});
 await api({op:'cursor',line:6});await checkLine(null);
 await api({op:'cursor',line:2});await api({op:'command',command:'workbench.action.closePanel'});await checkLine(null);
 await api({op:'command',command:'evalens.showValuesPanel'});await checkLine(2);
 report.push({case:'unmatched cursor clears, hiding clears, reopening restores'});
 const themes=[['Dark Modern','dark','rgba(255, 255, 255, 0.05)'],['Light Modern','light','rgba(0, 0, 0, 0.04)'],['Default High Contrast','hc','rgba(255, 255, 255, 0.1)'],['Default High Contrast Light','hc-light','rgba(0, 0, 0, 0.08)']];
 for(const [theme,name,alpha] of themes){await api({op:'setting',section:'workbench',key:'colorTheme',value:theme});await sleep(650);d=await checkLine(2,alpha);await page.screenshot({path:'/private/tmp/evalens-172-'+name+'.png'});report.push({case:theme,wash:d.overlays.find(e=>e.bg!=='rgba(0, 0, 0, 0)')?.bg});}
 await api({op:'setting',section:'workbench',key:'colorTheme',value:'Dark Modern'});await sleep(400);
 await api({op:'command',command:'evalens.clearResults'});await checkLine(null);report.push({case:'clear removes source wash and tick'});
 await api({op:'cursor',line:0});await api({op:'command',command:'evalens.evaluateAtCursor'});await api({op:'cursor',line:2});await sleep(400);
 await page.screenshot({path:'/private/tmp/evalens-172-current-line.png'});
 fs.writeFileSync('/private/tmp/evalens-172-host-results.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.disconnect();
})().catch(e=>{console.error(e);process.exit(1)});
