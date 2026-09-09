const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const {api,sleep,until,connect}=require('./client.cjs');
const repo=require('node:path').resolve(__dirname,'../../../..');
const review=repo+'/docs/reviews/196-marketplace-page-refresh';
const specs=[
 ['hero',4,['price: 8','quantity: 3','total: 24','printed: 24'],'Four explicit evaluations show a computed total and its printed output.'],
 ['aliasing',4,['a: [1, 2]','b: [1, 2, 3]','a: [1, 2, 3]'],'Recorded earlier list values remain beside code after a mutation through an alias.'],
 ['print',2,['total: 6','printed: total: 6'],'A print-only result appears directly beside the print statement.'],
 ['error',1,['ValueError','invalid literal'],'A Python ValueError appears beside the failing expression.'],
 ['loop',2,['n: 0, 1, 2','square: 0, 1, 4','3 iterations'],'The loop records its target and the square computed in each complete iteration.'],
 ['comprehension',1,['nums: [0, 2, 4]','n: 0, 1, 2','3 iterations'],'A comprehension shows its result and its loop variable observations.'],
 ['spot-the-bug',4,['total: 2, 4, 6','total: 6'],'A mistaken accumulator replaces total with each number instead of adding.'],
 ['watch',2,['n: 0, 1, 2','n * 2: 0, 2, 4','3 iterations'],'An explicit inline watch records n * 2 without adding the expression to source.'],
];
(async()=>{
 await until(async()=>{try{return await api({op:'state'});}catch{return false;}},'Host');
 const {browser,page}=await connect();
 try{
  assert.equal((await api({op:'state'})).extensions.find(e=>e.id==='mbjarland.evalens').path,repo);
  await page.setViewport({width:1400,height:900,deviceScaleFactor:2});
  for(const command of ['workbench.action.closeSidebar','workbench.action.closeAuxiliaryBar','workbench.action.closePanel','workbench.action.joinAllGroups'])await api({op:'command',command});
  for(const[key,value]of[['fontFamily','Menlo'],['fontSize',16],['lineHeight',26],['wordWrap','off'],['minimap.enabled',false]])await api({op:'setting',section:'editor',key,value});
  const manifest={captureMethod:'native-vscode',extensionVersion:'0.2.0',extensionPath:repo,captureNotes:'Actual VS Code Extension Development Host screenshots. Source and result pixels were captured together; no recreated chrome or edited pixels.',captures:[]};
  for(const[name,count,expected,description]of specs){
   await api({op:'open',path:'/private/tmp/evalens-196/workspace/'+name+'.py'});
   await api({op:'command',command:'evalens.clearResults'});await api({op:'command',command:'evalens.restartKernel'});
   await api({op:'cursor',line:0});await api({op:'command',command:'evalens.evaluateFile'});
   if(name==='watch'){
    await api({op:'cursor',line:0,character:4});const pending=api({op:'command',command:'evalens.addInlineWatch'});
    await until(async()=>page.$('.quick-input-widget input.input'),'Watch');const input=await page.$('.quick-input-widget input.input');await input.focus();await page.keyboard.down('Meta');await page.keyboard.press('KeyA');await page.keyboard.up('Meta');await page.keyboard.press('Backspace');await page.keyboard.type('n * 2');assert.equal(await input.evaluate(e=>e.value),'n * 2');await page.keyboard.press('Enter');await pending;
   }
   await api({op:'cursor',line:count});await sleep(400);
   const state=await api({op:'state'});const selector='.monaco-editor[data-uri="'+state.active.uri+'"]';
   const result=await page.$eval(selector,(editor,count)=>{
    const bounds=editor.getBoundingClientRect();const numbers=[...editor.querySelectorAll('.line-numbers')].map(e=>({n:Number(e.textContent),y:e.getBoundingClientRect().y}));const top=numbers.find(n=>n.n===1).y,bottom=numbers.find(n=>n.n===count).y;
    const rows=[...editor.querySelectorAll('.view-line')].filter(e=>{const y=e.getBoundingClientRect().y;return y>=top-1&&y<=bottom+1;});let right=bounds.x;const pieces=[];
    for(const row of rows)for(const span of row.querySelectorAll('span')){right=Math.max(right,span.getBoundingClientRect().right);const c=getComputedStyle(span,'::after').content;if(c!=='none'&&c!=='normal'&&c!=='""')pieces.push(c.slice(1,-1).replace(/\u00a0/g,' '));}
    return{source:rows.map(r=>r.textContent),pieces,fontSize:getComputedStyle(editor.querySelector('.view-lines')).fontSize,clip:{x:Math.floor(bounds.x),y:Math.floor(top),width:Math.ceil(Math.max(620,Math.min(bounds.width,right-bounds.x+16))),height:Math.ceil(bottom-top+26)}};
   },count);
   for(const text of expected)assert(result.pieces.join('').includes(text),name+' missing '+text+' in '+result.pieces.join(''));
   assert(result.clip.width<=860,name+' too wide: '+result.clip.width);
   const image='media/demo/'+name+'.png';await page.screenshot({path:repo+'/'+image,clip:result.clip});const png=fs.readFileSync(repo+'/'+image);
   manifest.captures.push({image,sha256:crypto.createHash('sha256').update(png).digest('hex'),width:png.readUInt32BE(16),height:png.readUInt32BE(20),fixture:'fixtures/'+name+'.py',description,...result,deviceScaleFactor:2});
   fs.writeFileSync(review+'/captures.json',JSON.stringify(manifest,null,2)+'\n');console.log(name,result.clip,result.pieces.join(''));
  }
 }finally{await browser.disconnect();}
})().catch(e=>{console.error(e);process.exit(1);});
