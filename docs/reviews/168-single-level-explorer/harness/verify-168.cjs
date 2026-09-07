const assert=require('node:assert/strict');const fs=require('node:fs');
const{api,connect,sleep,until}=require('./client.cjs');
(async()=>{
 await until(async()=>{try{return !!await api({op:'state'});}catch{return false;}},'Host ready');
 const{page,browser,frame}=await connect();const report=[];
 async function evaluate(name,line=0){await api({op:'open',path:`/private/tmp/evalens-learning-live/workspace/${name}.py`});await api({op:'cursor',line});await api({op:'command',command:'evalens.evaluateAtCursor'});await api({op:'command',command:'evalens.showValuesPanel'});await sleep(150);}
 async function text(){return(await frame('.loop-explorer')).$eval('.loop-explorer',e=>e.innerText);}
 async function count(s){return(await frame('.loop-explorer')).$$eval(s,es=>es.length);}
 async function rows(){return(await frame('.loop-explorer')).$$eval('.loop-data.loop-iteration',es=>es.map(e=>e.innerText));}
 async function click(s){await(await frame(s)).click(s);await sleep(150);}
 async function inline(){return page.$$eval('.monaco-editor[data-uri^="file:"] .view-line',es=>es.map(e=>[...e.querySelectorAll('span')].map(s=>getComputedStyle(s,'::after').content).filter(s=>s!=='none'&&s!=='normal').map(s=>s.startsWith('"')?JSON.parse(s):s).join('').replaceAll('\u00a0',' ').replaceAll('\u200b','')).filter(Boolean));}
 await evaluate('single-square');assert.deepEqual(await rows(),['n = 0\n0','n = 1\n1','n = 2\n4']);assert.equal(await count('[data-loop-action="toggle"]'),0);
 const style=await(await frame('.result-surface')).$eval('.result-surface',e=>{const s=getComputedStyle(e);return{radius:s.borderRadius,bar:s.borderLeftColor,background:s.backgroundColor};});assert.deepEqual(style,{radius:'0px',bar:'rgb(230, 173, 69)',background:'rgba(0, 0, 0, 0)'});
 await click('[data-loop-action="select"][data-loop-id="3"]');assert.equal((await api({op:'state'})).active.line,0);
 await click('[data-loop-action="open"][data-loop-id="0"][data-loop-value="0"]');assert.equal((await api({op:'state'})).active.text,'0\n1\n4\n');
 report.push({case:'three compact square-print rows, source selection, exact export and square orange bar',status:'pass',style});
 await evaluate('single-body');const chip=(await inline()).join(' ');assert.match(chip,/n: 0, 1, 2/);assert.match(chip,/squared: 0, 1, 4/);const hover=JSON.stringify(await api({op:'hover',line:0,character:5}));assert.match(hover,/squared = 0, 1, 4/);assert.match(await text(),/Values after loop: n = 2, squared = 4/);
 report.push({case:'existing inline body history and saved hover preserved',status:'pass',chip});
 await evaluate('single-skipped');assert.deepEqual(await rows(),['n = 0\nNo output','n = 1\n1','n = 2\nNo output','n = 3\n3','n = 4\nNo output']);
 await evaluate('single-break');assert.deepEqual(await rows(),['n = 0\n0','n = 1\n1','n = 2\n2','n = 3\nNo output']);
 report.push({case:'continue and break retain entered silent iterations',status:'pass'});
 await evaluate('single-empty-else');assert.equal((await rows()).length,0);assert.match(await text(),/0 iterations/);assert.match(await text(),/No iterations/);assert.equal((await text()).split('no work').length-1,1);
 await evaluate('single-silent');assert.deepEqual(await rows(),['n = 0\nNo output','n = 1\nNo output','n = 2\nNo output']);
 report.push({case:'empty-loop else output is separate; known silent passes show No output',status:'pass'});
 await evaluate('single-two-lines');assert.equal(await count('[data-loop-action="toggle"]'),0);assert.deepEqual(await rows(),['n = 0\nnumber 0\nsquare 0','n = 1\nnumber 1\nsquare 1','n = 2\nnumber 2\nsquare 4']);
 report.push({case:'two short printed lines stay visible within compact rows',status:'pass'});
 await evaluate('single-unicode');assert.equal(await count('[data-loop-action="toggle"]'),0);assert.match((await rows())[0],/😀 0/);assert.match((await rows())[0],/stderr:\s+🦉 0/);assert.doesNotMatch(await text(),/\uFFFD/);
 await click('[data-loop-action="open"][data-loop-id="0"][data-loop-value="1"]');assert.equal((await api({op:'state'})).active.text,'🦉 0\n🦉 1\n🦉 2\n');
 report.push({case:'Unicode stdout/stderr remain separate and export exactly',status:'pass'});
 await evaluate('single-many');assert.equal((await rows()).length,20);await click('[data-loop-action="page"][data-loop-id="1"][data-loop-value="1"]');assert.equal((await rows())[0],'n = 20\n20');assert.equal((await rows()).length,20);
 report.push({case:'100 iterations replace a bounded 20-row page',status:'pass'});
 await evaluate('single-million');assert.equal((await rows()).length,20);assert.match(await text(),/1,000,000 iterations/);assert.match(await text(),/998,001 iterations not individually retained/);assert(await count('[data-loop-entry],[data-loop-invocation]')<=120);assert(await count('.loop-explorer *')<1500);await click('[data-loop-action="page"][data-loop-id="1"][data-loop-value="1"]');assert.equal((await rows())[0],'n = 20\nNo output');
 report.push({case:'million-pass loop retains bounded detail, truthful totals and working pages',status:'pass'});
 await evaluate('single-long');assert.equal(await count('.loop-output'),0);assert.equal(await count('[data-loop-action="toggle"][aria-expanded="false"]'),3);await click('[data-loop-action="toggle"][data-loop-id="2"]');assert.match(await text(),/page line/);await click('[data-loop-action="text:0:0"][data-loop-id="2"][data-loop-value="1"]');assert.match(await text(),/Output part 2 of/);await click('[data-loop-action="toggle"][data-loop-id="2"]');assert.equal(await count('.loop-output'),0);await click('[data-loop-action="toggle"][data-loop-id="2"]');assert.match(await text(),/Output part 2 of/);await click('[data-loop-action="open"][data-loop-id="0"][data-loop-value="0"]');const exported=(await api({op:'state'})).active.text;assert.match(exported,/truncated|omitted/);assert(exported.length<70000);
 report.push({case:'long output starts folded, pages retained text and preserves page on reopen',status:'pass',exportedCharacters:exported.length});
 await evaluate('single-reanchor',1);await click('[data-loop-action="select"][data-loop-id="3"]');assert.equal((await api({op:'state'})).active.line,1);await api({op:'edit',startLine:0,endLine:0,text:'# added\n# another\n'});await sleep(150);await click('[data-loop-action="select"][data-loop-id="3"]');assert.equal((await api({op:'state'})).active.line,3);await api({op:'command',command:'workbench.action.focusActiveEditorGroup'});await api({op:'command',command:'workbench.action.files.revert'});await sleep(150);
 report.push({case:'iteration source selection reanchors with edits above loop',status:'pass'});
 fs.writeFileSync('/private/tmp/evalens-168-host-results.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));await browser.disconnect();
})().catch(e=>{console.error(e);process.exit(1)});
