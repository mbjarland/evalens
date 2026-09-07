const assert=require('node:assert/strict');const fs=require('node:fs');
const{api,sleep,until,connect}=require('./client.cjs');
const base='/private/tmp/evalens-learning-live/workspace/';
(async()=>{
 const fixtures={
  'u-values.py':'x = [1, 2, 3]\nfor v in x:\n    u = 4 * v\n    print("value is " + str(u))\n',
  'u-continue.py':'for v in [1, 2, 3]:\n    if v == 2:\n        continue\n    u = 4 * v\n    print(u)\n',
  'u-conditional.py':'u = 999\nfor v in range(3):\n    if v == 1:\n        u = 10\n    print(v)\n',
  'u-nested.py':'for x in range(2):\n    w = x + 100\n    for y in range(2):\n        u = x * 10 + y\n        print(x, y, u)\n',
  'u-limits.py':'for v in range(3):\n    a = v + 1\n    b = v + 2\n    c = v + 3\n    d = v + 4\n    print(a, b, c, d)\n'
 };
 for(const[name,source]of Object.entries(fixtures))fs.writeFileSync(base+name,source);
 await until(async()=>{try{return !!await api({op:'state'});}catch{return false;}},'Host ready');
 const{browser,page,frame}=await connect();
 await api({op:'command',command:'workbench.action.closeSidebar'});await api({op:'command',command:'workbench.action.closeAuxiliaryBar'});
 const report={extension:(await api({op:'state'})).extensions};
 async function evaluate(name,lines){await api({op:'open',path:base+name});await api({op:'command',command:'evalens.clearResults'});for(const line of lines){await api({op:'cursor',line});await api({op:'command',command:'evalens.evaluateAtCursor'});}await api({op:'command',command:'evalens.showValuesPanel'});await sleep(250);return frame('.loop-explorer');}
 async function entries(f,root='1'){return f.$$eval('[data-loop-invocation="'+root+'"] > .loop-entries > .loop-iteration',es=>es.map(e=>e.innerText));}
 let f=await evaluate('u-values.py',[0,1]);const simple=await entries(f);
 assert.equal(simple.length,3);for(let i=0;i<3;i++){assert.match(simple[i],new RegExp('v = '+(i+1)));assert.match(simple[i],new RegExp('u = '+((i+1)*4)));assert.match(simple[i],new RegExp('value is '+((i+1)*4)));}
 report.simple=simple;assert.match(await f.$eval('.loop-explorer',e=>e.innerText),/Loop variable at start.*body values at end/s);
 await page.screenshot({path:'/private/tmp/evalens-171-simple.png'});
 // Whole fold and inner capture remain independent, with the existing result marker.
 await f.click('.latest-result .result-disclosure');await sleep(100);assert.equal(await f.$eval('.latest-result .result-disclosure',e=>e.getAttribute('aria-expanded')),'false');await f.click('.latest-result .result-disclosure');assert.deepEqual(await entries(f),simple);report.r2PreservesValues=true;
 f=await evaluate('u-continue.py',[0]);const continued=await entries(f);assert.match(continued[0],/u = 4/);assert.match(continued[1],/u: not recorded/);assert.doesNotMatch(continued[1],/u = (4|8|12)/);assert.match(continued[2],/u = 12/);report.continue=continued;
 f=await evaluate('u-conditional.py',[0,1]);const conditional=await entries(f);assert.match(conditional[0],/u: not recorded/);assert.match(conditional[1],/u = 10/);assert.match(conditional[2],/u = 10/);report.conditional=conditional;
 f=await evaluate('u-nested.py',[0]);const nested=await entries(f);assert.equal(nested.length,2);
 for(let x=0;x<2;x++)assert.match(nested[x],new RegExp('w = '+(100+x)));
 for(let x=0;x<2;x++){
  const selector='[data-loop-invocation="1"] > .loop-entries > .loop-iteration';const id=await f.$$eval(selector,(es,x)=>es[x].dataset.loopEntry,x);const toggle='[data-loop-action="toggle"][data-loop-id="'+id+'"]';
  if(await f.$eval(toggle,e=>e.getAttribute('aria-expanded')==='false')){await f.click(toggle);await sleep(180);f=await frame('.loop-explorer');}
  const group='[data-loop-entry="'+id+'"]';const innerId=await f.$eval(group+' [data-loop-invocation]',e=>e.dataset.loopInvocation);const rows=await entries(f,innerId);for(let y=0;y<2;y++)assert.match(rows[y],new RegExp('u = '+(x*10+y)));nested[x]=await f.$eval(group,e=>e.innerText);
 }
 report.nested=nested;
 f=await evaluate('u-limits.py',[0]);const limited=await entries(f);assert.match(limited[0],/a = 1/);assert.match(limited[0],/b = 2/);assert.match(limited[0],/c = 3/);assert.doesNotMatch(limited[0],/d = 4/);report.limits=await f.$eval('.loop-explorer',e=>e.innerText);
 fs.writeFileSync('/private/tmp/evalens-171-host-results.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.disconnect();
})().catch(e=>{console.error(e);process.exit(1)});
