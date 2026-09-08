const assert = require('node:assert/strict');
const fs = require('node:fs');
const {api, sleep, until, connect} = require('/private/tmp/evalens-learning-live/client.cjs');
const repo = '/Users/mbjarland/projects/evalens-worktrees/194-consistent-loop-histories';
const base = '/private/tmp/evalens-194/workspace/';
(async () => {
 const {browser,page} = await connect();
 const report = process.argv.includes('--comprehension-only') ? JSON.parse(fs.readFileSync('/private/tmp/evalens-194/current-images.json','utf8')) : {extension:repo, capture:'Actual VS Code screenshot clips; no recreated decorations or edited pixels', screenshots:[]};
 try {
  await page.setViewport({width:2100,height:1100,deviceScaleFactor:2});
  for (const [key,value] of [['fontFamily','Menlo'],['fontSize',20],['lineHeight',30],['wordWrap','off']]) await api({op:'setting',section:'editor',key,value});
  for (const command of ['workbench.action.closeSidebar','workbench.action.closeAuxiliaryBar','workbench.action.closePanel','workbench.action.joinAllGroups']) await api({op:'command',command});
  async function open(name) {
   await api({op:'open',path:base+name+'.py'});
   await api({op:'command',command:'evalens.clearResults'});
   await api({op:'command',command:'evalens.restartKernel'});
   await api({op:'cursor',line:0});
  }
  async function evaluate(line, command='evalens.evaluateAtCursor') {
   await api({op:'cursor',line});await api({op:'command',command});await sleep(200);
  }
  async function shoot(name,first,last,expected) {
   await sleep(500);
   const state=await api({op:'state'}), selector='.monaco-editor[data-uri="'+state.active.uri+'"]';
   const capture=await page.$eval(selector,(editor,{first,last})=>{
    const bounds=editor.getBoundingClientRect();
    const numbers=[...editor.querySelectorAll('.line-numbers')].map(e=>({n:Number(e.textContent),y:e.getBoundingClientRect().y}));
    const top=numbers.find(e=>e.n===first+1)?.y,bottom=numbers.find(e=>e.n===last+1)?.y;
    if(top===undefined||bottom===undefined)throw Error('Requested source lines are not visible');
    const lines=[...editor.querySelectorAll('.view-line')].filter(e=>{const y=e.getBoundingClientRect().y;return y>=top-2&&y<=bottom+2;});
    let right=bounds.x;const pieces=[];
    for(const line of lines)for(const span of line.querySelectorAll('span')) {
     right=Math.max(right,span.getBoundingClientRect().right);
     const text=getComputedStyle(span,'::after').content;
     if(text!=='none'&&text!=='normal'&&text!=='""')pieces.push(text.slice(1,-1).replace(/\u00a0/g,' '));
    }
    return {source:lines.map(e=>e.textContent),pieces,clip:{x:Math.floor(bounds.x),y:Math.floor(top),width:Math.ceil(Math.min(bounds.width,right-bounds.x+28)),height:Math.ceil(bottom-top+30)}};
   },{first,last});
   const text=capture.pieces.join('');for(const value of expected)assert(text.includes(value),name+' missing '+value+' in '+text);
   const file=repo+'/'+name+'.png';await page.screenshot({path:file,clip:capture.clip});
   report.screenshots.push({file:name+'.png',source:state.active.text,lines:[first+1,last+1],...capture});
   fs.writeFileSync('/private/tmp/evalens-194/current-images.json',JSON.stringify(report,null,2)+'\n');console.log(name,capture.clip);
  }
  if(!process.argv.includes('--comprehension-only')) {
  await open('accumulator');await evaluate(0,'evalens.evaluateFile');
  await shoot('media/learning/screenshots/accumulator-before',8,12,['score: ','total: 2, 4, 6','3 iterations']);
  await api({op:'edit',startLine:11,startChar:10,endLine:11,endChar:11,text:'+='});
  await evaluate(0,'evalens.evaluateFile');
  await shoot('media/learning/screenshots/accumulator-after',8,12,['total: 2, 6, 12','3 iterations']);
  // Only this temporary fixture was edited; avoid leaving an unsaved buffer.
  await api({op:'command',command:'workbench.action.files.revert'});
  await open('loop');await evaluate(0);
  await shoot('media/demo/loop',0,2,['n: 0, 1, 2, 3, 4','squared: 0, 1, 4, 9, 16','5 iterations']);
  for(const name of ['spot-the-bug','hero']) {
   await open(name);await evaluate(0,'evalens.evaluateFile');
   await shoot('media/demo/'+name,0,6,['s: 72, 85, 91, 64','4 iterations',name==='hero'?'total: 72, 157, 248, 312':'total: 72, 85, 91, 64']);
  }
  await open('watch');await evaluate(0);await api({op:'cursor',line:1,character:4});
  const watch=api({op:'command',command:'evalens.addInlineWatch'});
  await until(async()=>page.$('.quick-input-widget input.input'), 'Watch input');
  const input=await page.$('.quick-input-widget input.input');await input.focus();await page.keyboard.down('Meta');await page.keyboard.press('KeyA');await page.keyboard.up('Meta');await page.keyboard.press('Backspace');await page.keyboard.type('total > 5');assert.equal(await input.evaluate(e=>e.value),'total > 5');await page.keyboard.press('Enter');await watch;
  await shoot('media/demo/watch',1,2,['total > 5','False, False, True, True','4 iterations']);
  }
  await open('comprehension');await evaluate(0);await shoot('media/demo/comprehension',0,0,['squares: [0, 1, 4, 9, 16, 25]','n: 0, 1, 2, 3, 4, 5','6 iterations']);
  report.extensions=(await api({op:'state'})).extensions;
  fs.writeFileSync('/private/tmp/evalens-194/current-images.json',JSON.stringify(report,null,2)+'\n');
 } finally {await browser.disconnect();}
})().catch(e=>{console.error(e);process.exit(1)});
