const assert=require('node:assert/strict');
const fs=require('node:fs');
const {api,sleep,connect,until}=require('./client.cjs');
const root='/private/tmp/evalens-learning-live';
const report=[];
async function main(){
 await until(async()=>{try{return !!(await api({op:'state'}));}catch{return false;}},'Host ready');
 const {browser,page,frame}=await connect();
 async function evaluate(name,line=0){
  await api({op:'open',path:`${root}/workspace/${name}.py`});
  await api({op:'cursor',line});
  await api({op:'command',command:'evalens.evaluateAtCursor'});
  await api({op:'command',command:'evalens.showValuesPanel'});await sleep(300);
 }
 async function text(){return(await frame('tr.row')).$eval('body',e=>e.innerText);}
 async function click(selector){await(await frame(selector)).click(selector);await sleep(180);}
 async function metrics(){return(await frame('.loop-explorer')).$eval('.loop-explorer',e=>({elements:e.querySelectorAll('*').length,characters:e.innerText.length,entries:e.querySelectorAll('[data-loop-entry],[data-loop-invocation]').length}));}
 async function lastClick(selector){const f=await frame(selector);const es=await f.$$(selector);await es.at(-1).click();await sleep(180);}
 await api({op:'command',command:'workbench.action.closeSidebar'});
 await api({op:'command',command:'workbench.action.closeAuxiliaryBar'});
 await evaluate('x5-small');
 assert.match(await text(),/Iteration 1 · x = 0 · printed 4 lines/);
 assert.match(await text(),/Iteration 2 · x = 1 · printed 4 lines/);
 assert.match(await text(),/Values after loop: x = 1, y = 3/);
 await click('[data-loop-action="select"][data-loop-id="5"]');
 assert.equal((await api({op:'state'})).active.line,2);
 await click('[data-loop-action="toggle"][data-loop-id="2"]');
 assert.equal((await api({op:'state'})).active.line,2);
 assert.equal(await(await frame('[data-loop-id="2"]')).$eval('[data-loop-action="toggle"][data-loop-id="2"]',e=>e.getAttribute('aria-expanded')),'false');
 await(await frame('[data-loop-id="2"]')).focus('[data-loop-action="toggle"][data-loop-id="2"]');
 await page.keyboard.press('Enter');await sleep(200);
 assert.equal(await(await frame('[data-loop-id="2"]')).$eval('[data-loop-action="toggle"][data-loop-id="2"]',e=>e.getAttribute('aria-expanded')),'true');
 assert.equal((await api({op:'state'})).active.line,2);
 const bar=await(await frame('.result-surface')).$eval('.result-surface',e=>getComputedStyle(e).borderLeftColor);
 assert.equal(bar,'rgb(230, 173, 69)');
 const sash=await page.$('.monaco-sash.horizontal:not(.disabled)');
 if(sash){const r=await sash.boundingBox();await page.mouse.move(r.x+r.width/2,r.y+r.height/2);await page.mouse.down();await page.mouse.move(r.x+r.width/2,280,{steps:12});await page.mouse.up();await sleep(200);}
 await page.screenshot({path:`root/x5-small-host.png`.replace('root',root)});
 await click('[data-loop-action="open"][data-loop-id="0"]');
 assert.equal((await api({op:'state'})).active.text,'x is 0\n0 1\n0 2\n0 3\nx is 1\n1 1\n1 2\n1 3\n');
 report.push({case:'small',status:'pass',checks:'Exact stdout; iteration/source selection; keyboard fold preserving cursor; amber shared bar',bar});
 await evaluate('x5-unicode');
 assert.match(await text(),/😀 outer 0/);assert.match(await text(),/😀 inner 0 1/);assert.match(await text(),/🎈 sibling 1 1/);
 await click('[data-loop-action="open"][data-loop-id="0"]');
 assert.equal((await api({op:'state'})).active.text,'😀 outer 0\n😀 inner 0 1\n🎈 sibling 0 1\n🎈 sibling 0 1\n😀 outer 1\n😀 inner 1 1\n🎈 sibling 1 1\n🎈 sibling 1 1\n');
 report.push({case:'Unicode and repeated sibling values',status:'pass'});
 await evaluate('x5-large');assert.match(await text(),/not retained|not fully retained/);
  const large=await metrics();assert(large.entries<=120);assert(large.characters<10000);
  if(!await(await frame('.loop-explorer')).$('[data-loop-action^="text:"]')) await click('[data-loop-action="toggle"][aria-expanded="false"]');
  await click('[data-loop-action^="text:"]');assert.match(await text(),/Previous output/);assert.match(await text(),/Output part 2 of/);
 await page.screenshot({path:`${root}/x5-large-host.png`});
 await click('[data-loop-action="open"][data-loop-id="0"]');const out=(await api({op:'state'})).active.text;
 assert.match(out,/truncated|omitted/);assert(out.length<70000);
 report.push({case:'100-page output per iteration',status:'pass',initial:large,capturedCharacters:out.length});
 await evaluate('x5-million');assert.match(await text(),/not individually retained/);const million=await metrics();assert(million.elements<1500);assert(million.entries<=120);
 await click('[data-loop-action="toggle"]');await click('[data-loop-action="toggle-invocation"]');await click('[data-loop-action="page"]');
 assert.match(await text(),/Iterations 21–40/);assert((await metrics()).entries<=120);
 await page.screenshot({path:`${root}/x5-million-host.png`});report.push({case:'one million nested iterations',status:'pass',initial:million});
 await evaluate('x5-siblings');await click('[data-loop-action="toggle"]');await lastClick('[data-loop-action="toggle-invocation"]');assert.match(await text(),/sibling 7 19/);
 report.push({case:'last of eight sibling groups reachable',status:'pass'});
 await evaluate('x5-repeated-invocations');await click('[data-loop-action="toggle"]');
 for(let i=1;i<=7;i++) await click(`[data-loop-action="page"][data-loop-id="2"][data-loop-value="${i}"]`);
 assert.match(await text(),/Nested loops 141–150 of 150/);await lastClick('[data-loop-action="toggle-invocation"]');assert.match(await text(),/149 0/);assert((await metrics()).entries<=120);
 report.push({case:'150 repeated inner invocations, last page reachable',status:'pass'});
 await evaluate('x5-else');const elseText=await text();for(const s of ['😀 outer 0','🦉 else 0','🦉 else 1'])assert.equal(elseText.split(s).length-1,1);
 report.push({case:'loop else output belongs to enclosing invocation',status:'pass'});
 await evaluate('x5-stderr');assert.match(await text(),/stderr 2 lines/);assert.doesNotMatch(await text(),/No printed output/);
 await click('[data-loop-action="open"][data-loop-id="0"][data-loop-value="1"]');assert.equal((await api({op:'state'})).active.text,'warning 0 0\nwarning 0 1\nwarning 1 0\nwarning 1 1\n');
 report.push({case:'stderr counts and export separate from stdout',status:'pass'});
 await evaluate('x5-silent-after-limit');const silent=await(await frame('.loop-explorer')).$$eval('.loop-data.loop-iteration',es=>es.map(e=>e.innerText).find(t=>t.startsWith('y = 1')));assert.match(silent,/No output/);assert.doesNotMatch(silent,/not retained/);
 report.push({case:'known silent iteration after output limit',status:'pass'});
 await evaluate('x5-reanchor');await click('[data-loop-action="toggle"][data-loop-id="2"]');
 await api({op:'edit',startLine:0,endLine:0,text:'# preface\n# another\n'});await sleep(250);
 assert.equal(await(await frame('[data-loop-id="2"]')).$eval('[data-loop-action="toggle"][data-loop-id="2"]',e=>e.getAttribute('aria-expanded')),'false');
 await click('[data-loop-action="toggle"][data-loop-id="2"]');assert.match(await text(),/line 5/);
 await click('[data-loop-action="select"][data-loop-id="5"]');assert.equal((await api({op:'state'})).active.line,4);
 await api({op:'command',command:'undo'});await sleep(150);
 report.push({case:'prefix edit reanchors labels/navigation and preserves folds',status:'pass'});
 fs.writeFileSync(`${root}/x5-host-results.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));await browser.disconnect();
}
main().catch(error=>{console.error(error);fs.writeFileSync(`${root}/x5-host-results.json`,JSON.stringify({report,error:String(error)},null,2)+'\n');process.exit(1);});
