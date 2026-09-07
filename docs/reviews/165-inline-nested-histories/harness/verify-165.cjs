const assert=require('node:assert/strict');const fs=require('node:fs');
const{api,connect,sleep,until}=require('./client.cjs');
(async()=>{
 await until(async()=>{try{return !!await api({op:'state'});}catch{return false;}},'Host ready');
 const{page,browser}=await connect();const report=[];
 async function annotations(){return page.$$eval('.monaco-editor[data-uri^="file:"] .view-line',es=>es.map(e=>({code:e.innerText.replaceAll('\u00a0',' '),annotation:[...e.querySelectorAll('span')].map(s=>getComputedStyle(s,'::after').content).filter(s=>s!=='none'&&s!=='normal').map(s=>s.startsWith('"')?JSON.parse(s):s).join('').replaceAll('\u00a0',' ').replaceAll('\u200b','')})).filter(e=>e.annotation));}
 async function evaluate(name,line=0){await api({op:'open',path:`/private/tmp/evalens-learning-live/workspace/${name}.py`});await api({op:'cursor',line});await api({op:'command',command:'evalens.evaluateAtCursor'});await sleep(150);return annotations();}
 async function hover(line){return JSON.stringify(await api({op:'hover',line,character:10}));}
 const cases={
  'x5-100x100':[/^x ×100:.*99printed:/,/^y ×10,000 total:.*9,994 more.*99$/],
  'inline-uniform':[/^x ×3:/,/^y ×12 total:/],
  'inline-varying':[/^x ×4:/,/^y ×6 total: 0, 0, 1, 0, 1, 2$/],
  'inline-empty':[/^x ×3:/,/^y: \(no iterations\)$/],
  'inline-unreached':[/^x: \(no iterations\)$/,/^y: \(not reached\)$/],
  'inline-break':[/^x ×3:/,/^y ×6 total: 0, 0, 1, 0, 1, 2$/],
  'inline-same-name':[/^x ×2: 0, 1$/,/^x ×6 total: 0, 1, 2, 0, 1, 2$/],
  'inline-three':[/^x ×2:/,/^y ×6 total:/,/^z ×24 total:/],
 };
 for(const[name,patterns]of Object.entries(cases)){
  const rows=await evaluate(name);assert.equal(rows.length,patterns.length,name);
  rows.forEach((row,i)=>assert.match(row.annotation,patterns[i],name));
  assert.doesNotMatch(rows[0].annotation,/y:/);
  if(name==='x5-100x100')assert.match(await hover(1),/10000 iterations total across 100 loop runs/);
  report.push({case:name,status:'pass',rows});
 }
 await evaluate('inline-reanchor',1);
 await api({op:'edit',startLine:0,endLine:0,text:'# added\n# second\n'});await sleep(150);
 let rows=await annotations();assert.equal(rows.length,2);assert.match(rows[1].annotation,/y ×12 total/);assert.match(await hover(4),/12 iterations total across 3 loop runs/);
 await api({op:'edit',startLine:4,endLine:4,endChar:'    for y in range(4):'.length,text:'    for y in range(2):'});await sleep(150);
 rows=await annotations();assert.equal(rows.length,1,'edited child headers must not carry uncertain history');
 assert.match(await hover(3),/stale|changed|edited/i);
 await api({op:'command',command:'workbench.action.focusActiveEditorGroup'});await api({op:'command',command:'undo'});await sleep(150);
 assert.equal((await annotations()).length,1,'undo preserves the existing stale-until-evaluation policy');
 await api({op:'command',command:'workbench.action.focusActiveEditorGroup'});await api({op:'command',command:'undo'});await sleep(150);
 assert.match(await hover(1),/Stale: this line/);
 assert.equal((await annotations()).length,1);
 await api({op:'command',command:'evalens.clearResults'});await sleep(150);assert.equal((await annotations()).length,0);
 await api({op:'cursor',line:1});await api({op:'command',command:'evalens.evaluateAtCursor'});await sleep(150);assert.equal((await annotations()).length,2);
 // A fresh enclosing evaluation replaces both histories with the new run.
 await api({op:'edit',startLine:2,endLine:2,endChar:'    for y in range(4):'.length,text:'    for y in range(2):'});await sleep(150);
 await api({op:'cursor',line:1});await api({op:'command',command:'evalens.evaluateAtCursor'});await sleep(150);
 rows=await annotations();assert.equal(rows.length,2);assert.match(rows[1].annotation,/^y ×6 total: 0, 1, 0, 1, 0, 1$/);
 await api({op:'command',command:'workbench.action.focusActiveEditorGroup'});await api({op:'command',command:'workbench.action.files.revert'});await sleep(150);
 report.push({case:'source edits, stale undo, clear and fresh evaluation',status:'pass'});
 await api({op:'open',path:'/private/tmp/evalens-learning-live/workspace/inline-following-print.py'});await api({op:'command',command:'evalens.evaluateFile'});await sleep(200);
 rows=await annotations();assert.equal(rows.length,3);assert.match(rows[0].annotation,/^x ×2:/);assert.doesNotMatch(rows[0].annotation,/y:/);assert.match(rows[1].annotation,/^y ×6 total:/);assert.match(rows[2].annotation,/^y: 2printed: 2$/);
 report.push({case:'EvaluateFile preserves later print(y) value label',status:'pass',rows});
 console.log(JSON.stringify(report,null,2));fs.writeFileSync('/private/tmp/evalens-165-host-results.json',JSON.stringify(report,null,2)+'\n');await browser.disconnect();
})().catch(e=>{console.error(e);process.exit(1)});
