const assert=require('node:assert/strict'),fs=require('node:fs');
const {api,sleep,connect,until}=require('/private/tmp/evalens-learning-live/client.cjs');
(async()=>{
 await until(async()=>{try{return await api({op:'state'});}catch{return false;}},'Host');
 const {browser,page,frame}=await connect();try{
  await page.setViewport({width:1600,height:950,deviceScaleFactor:1});
  await api({op:'setting',section:'editor',key:'fontSize',value:18});
  await api({op:'setting',section:'editor',key:'lineHeight',value:28});
  await api({op:'open',path:'/private/tmp/evalens-194/workspace/comprehension.py'});await api({op:'cursor',line:0});await api({op:'command',command:'evalens.evaluateAtCursor'});await api({op:'command',command:'evalens.showValuesPanel'});
  const panel=await frame('.result-surface');const text=await panel.$$eval('.result-surface',es=>es.filter(e=>e.getClientRects().length).map(e=>e.innerText).join('\n'));assert.match(text,/n: 0, 1, 2, 3, 4, 5 · 6 iterations/);assert.match(text,/squares: \[0, 1, 4, 9, 16, 25\]/);
  await page.screenshot({path:'/private/tmp/evalens-194/panel.png'});
  await api({op:'command',command:'workbench.action.closePanel'});await api({op:'command',command:'workbench.action.joinAllGroups'});await api({op:'command',command:'evalens.openLearningWalkthrough'});await sleep(500);
  await page.click('[data-step-id="mbjarland.evalens#evalens.learning#accumulator"]');
  let guide;await until(async()=>{for(const f of page.frames())try{if(await f.$eval('h1',e=>e.textContent).catch(()=>null)==='Fix an accumulator'){guide=f;return true;}}catch{}return false;},'accumulator guide');
  await until(async()=>guide.$$eval('img',es=>es.length===2&&es.every(e=>e.complete&&e.naturalWidth>0)), 'guide images');
  const images=await guide.$$eval('img',es=>es.map(e=>({src:e.src,width:e.naturalWidth,height:e.naturalHeight})));
  assert.deepEqual(images.map(e=>[e.width,e.height]),[[2240,300],[2264,300]]);
  await guide.$eval('img',e=>e.scrollIntoView({block:'center'}));await sleep(200);await page.screenshot({path:'/private/tmp/evalens-194/guide.png'});
  fs.writeFileSync('/private/tmp/evalens-194/panel-guide.json',JSON.stringify({panel:text,images,extensions:(await api({op:'state'})).extensions},null,2)+'\n');console.log({panel:text,images});
 }finally{await browser.disconnect();}
})().catch(e=>{console.error(e);process.exit(1)});
