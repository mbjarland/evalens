const fs=require('fs'),assert=require('node:assert/strict'),crypto=require('crypto');
const{api,connect,sleep,until}=require('./client.cjs');
const repo=require('node:path').resolve(__dirname,'../../../..'),review=repo+'/docs/reviews/196-marketplace-page-refresh';
(async()=>{const{browser,page,frame}=await connect();try{
 await page.setViewport({width:800,height:1000,deviceScaleFactor:2});
 const manifest=JSON.parse(fs.readFileSync(review+'/captures.json'));manifest.captures=manifest.captures.filter(c=>!['panel','nested-loops'].some(n=>c.image===`media/demo/${n}.png`));
 for(const name of ['panel','nested-loops']){
  await page.setViewport({width:name==='nested-loops'?1150:800,height:1000,deviceScaleFactor:2});
  await api({op:'open',path:`/private/tmp/evalens-196/workspace/${name}.py`});await api({op:'command',command:'evalens.clearResults'});await api({op:'command',command:'evalens.restartKernel'});await api({op:'command',command:'evalens.evaluateFile'});await api({op:'cursor',line:name==='panel'?1:4});await api({op:'command',command:'evalens.showValuesPanel'});await sleep(250);
  if(await page.$eval('iframe',e=>e.getBoundingClientRect().height)<750){await api({op:'command',command:'workbench.action.toggleMaximizedPanel'});await sleep(200);}
  let f=await frame('.result-surface');
  // Selecting a blank part of the genuine panel removes a row's keyboard-focus ring.
  await f.click('.summary');
  if(name==='nested-loops'){
   console.log('controls',await f.$$eval('[data-loop-action]',es=>es.map(e=>({text:e.innerText,action:e.dataset.loopAction,expanded:e.getAttribute('aria-expanded')}))));
   const controls=await f.$$('[data-loop-action="toggle"]');
   for(let i=1;i<controls.length;i++)if(await controls[i].evaluate(e=>e.getAttribute('aria-expanded')==='true'))await controls[i].click();
  }
  await sleep(200); f=await frame('.result-surface');
  if(name==='nested-loops')await f.focus('#follow-cursor');
  await f.evaluate(()=>window.scrollTo(0,0));await page.mouse.move(10,10);await sleep(200);
  const text=await f.$eval('body',e=>e.innerText);
  if(name==='panel'){assert.match(text,/x: \[1, 2, 3\]/);assert.match(text,/printed: Now: \[1, 2, 3\]/);assert.match(text,/Latest result/);}
  else{assert.match(text,/Variables/);assert.match(text,/Printed output/);assert.match(text,/v = 2/);}
  const fr=await page.$eval('iframe',e=>e.getBoundingClientRect().toJSON());
  const height=await f.$eval('body',e=>e.getBoundingClientRect().height);
  let clip={x:Math.floor(fr.x),y:Math.floor(fr.y-36),width:Math.floor(fr.width),height:Math.ceil(height+36+8)};
  if(name==='nested-loops'){const box=await f.$eval('.result-detail > .result-surface',e=>e.getBoundingClientRect().toJSON());clip={x:Math.floor(fr.x+box.x),y:Math.floor(fr.y+box.y),width:Math.ceil(box.width),height:Math.ceil(box.height)};}
  assert(clip.y+clip.height<=1000,'content too tall');const image=`media/demo/${name}.png`;await page.screenshot({path:repo+'/'+image,clip});const png=fs.readFileSync(repo+'/'+image);
  manifest.captures.push({image,sha256:crypto.createHash('sha256').update(png).digest('hex'),width:png.readUInt32BE(16),height:png.readUInt32BE(20),fixture:`fixtures/${name}.py`,description:name==='panel'?'Recorded list values and printed output in the actual Values panel, including cursor and latest-result markers.':'The actual nested loop explorer distinguishes loop and body variables from printed output.',text,clip,deviceScaleFactor:2});
  fs.writeFileSync(review+'/captures.json',JSON.stringify(manifest,null,2)+'\n');console.log(name,clip,text);
 }
}finally{await browser.disconnect();}})().catch(e=>{console.error(e);process.exit(1)});
