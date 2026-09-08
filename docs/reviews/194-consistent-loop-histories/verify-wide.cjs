const assert=require('node:assert/strict');const fs=require('node:fs');
const {api,sleep,connect,until}=require('/private/tmp/evalens-learning-live/client.cjs');
(async()=>{
 await until(async()=>{try{return await api({op:'state'});}catch{return false;}},'reloaded Host');
 const {browser,page}=await connect();try{
  await page.setViewport({width:3000,height:900,deviceScaleFactor:1});
  for(const [key,value] of [['fontSize',14],['lineHeight',24]])await api({op:'setting',section:'editor',key,value});
  await api({op:'open',path:'/private/tmp/evalens-194/workspace/wide.py'});
  await api({op:'command',command:'evalens.clearResults'});await api({op:'command',command:'evalens.restartKernel'});
  for(const line of [0,1,2]){await api({op:'cursor',line});await api({op:'command',command:'evalens.evaluateAtCursor'});}
  await sleep(300);
  const rows=await page.$eval('.monaco-editor[data-uri="file:///private/tmp/evalens-194/workspace/wide.py"]',e=>[...e.querySelectorAll('.view-line')].map(row=>({source:row.textContent,pieces:[...row.querySelectorAll('span')].map(span=>{const s=getComputedStyle(span,'::after');return{text:s.content.slice(1,-1).replace(/\u00a0/g,' '),color:s.color,content:s.content};}).filter(p=>!['none','normal','""'].includes(p.content))})));
  const line=rows[2],text=line.pieces.map(p=>p.text).join('');
  for(const fragment of ['total: 1, 2, 3, 4, 5','b1: 1, 2, 3, 4, 5','b2: 2, 4, 6, 8, 10','b3: 3, 6, 9, 12, 15','printed:','stderr:','more','partial:'])assert(text.includes(fragment),fragment+' in '+text);
  assert.equal(line.pieces.length,48,'48 decorated slots including separators');
  assert(new Set(line.pieces.map(p=>p.color)).size>=3,'semantic colors are preserved');
  await page.screenshot({path:'/private/tmp/evalens-194/wide.png'});
  fs.writeFileSync('/private/tmp/evalens-194/wide.json',JSON.stringify({rows,slots:line.pieces.length},null,2)+'\n');
  console.log(JSON.stringify(line,null,2));
 }finally{await browser.disconnect();}
})().catch(e=>{console.error(e);process.exit(1)});
