const assert=require('node:assert/strict');
const fs=require('node:fs');
const {api,sleep,connect}=require('./client.cjs');
const root='/private/tmp/evalens-learning-live';
const report=[];
async function main(){
 const {browser,page,frame}=await connect();
 async function evalAt(name,line=0){await api({op:'open',path:`${root}/workspace/${name}.py`});await api({op:'cursor',line});await api({op:'command',command:'evalens.evaluateAtCursor'});await api({op:'command',command:'evalens.showValuesPanel'});await sleep(250);}
 async function click(selector){await(await frame(selector)).click(selector);await sleep(180);}
 for(const name of ['x5-long-line','x5-long-multiline']){
  await evalAt(name);
  let f=await frame('.fold-footer');
  assert.match(await f.$eval('.fold-footer',e=>e.innerText),/Show more/);
  assert.doesNotMatch(await f.$eval('.fold-footer',e=>e.innerText),/Show all/);
  assert((await f.$eval('.seg-value',e=>e.textContent.length))<=2000);
  await click('[data-fold-action="expand"]');
  f=await frame('.fold-scroll');
  const scroll=await f.$eval('.fold-scroll',e=>({height:e.getBoundingClientRect().height,maxHeight:getComputedStyle(e).maxHeight,chars:e.textContent.length,overflow:getComputedStyle(e).overflowY}));
  assert(scroll.chars<=16000);assert(scroll.height<=300);assert.equal(scroll.overflow,'auto');
  await click('[data-fold-action="open"]');const full=(await api({op:'state'})).active.text;
  assert(full.length>=50000);assert(full.length<=60001);
  report.push({case:name,status:'pass',scroll,openedCharacters:full.length});
 }
 fs.writeFileSync(`${root}/workspace/output-only.py`,'print("hello from output-only")\n');
 await evalAt('output-only',0);
 const f=await frame('.result-surface');
 const outputOnly=await f.$eval('tr[data-goto="0"] .result-surface',e=>{const label=e.querySelector('.seg-streamLabel');return{height:e.getBoundingClientRect().height,firstTextOffset:label.getBoundingClientRect().top-e.getBoundingClientRect().top,bar:getComputedStyle(e).borderLeftColor,text:e.innerText};});
 assert(outputOnly.firstTextOffset<8);assert.equal(outputOnly.bar,'rgb(230, 173, 69)');assert.match(outputOnly.text,/printed: hello from output-only/);
 await page.screenshot({path:`${root}/y2-output-only-host.png`});report.push({case:'Y2 output-only row has no blank first line and retains amber bar',status:'pass',outputOnly});
 await api({op:'open',path:`root/workspace/navigation.py`.replace('root',root)});await api({op:'command',command:'evalens.evaluateFile'});await api({op:'command',command:'evalens.showValuesPanel'});await sleep(300);
 await api({op:'cursor',line:0});await sleep(150);await api({op:'cursor',line:59});await sleep(250);
 const bottom=await(await frame('tr[data-goto="59"]')).$eval('tr[data-goto="59"]',e=>({top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom,viewport:innerHeight}));
 assert(bottom.top>=0&&bottom.bottom<=bottom.viewport);
 await api({op:'cursor',line:0});await sleep(250);const top=await(await frame('tr[data-goto="0"]')).$eval('tr[data-goto="0"]',e=>({top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom,viewport:innerHeight}));
 assert(top.top>=0&&top.bottom<=top.viewport);
 report.push({case:'Editor cursor scrolls offscreen Values rows into view both directions',status:'pass',top,bottom});
 fs.writeFileSync(`${root}/panel-regression-results.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));await browser.disconnect();
}
main().catch(error=>{console.error(error);fs.writeFileSync(`${root}/panel-regression-results.json`,JSON.stringify({report,error:String(error)},null,2)+'\n');process.exit(1);});
