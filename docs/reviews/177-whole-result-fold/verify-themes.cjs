const assert=require('node:assert/strict');const fs=require('node:fs');const{api,connect,sleep}=require('./client.cjs');
(async()=>{const{browser,page,frame}=await connect();const report=[];
await api({op:'open',path:'/private/tmp/evalens-learning-live/workspace/r2-root.py'});await api({op:'cursor',line:0});await api({op:'command',command:'evalens.evaluateAtCursor'});let f=await frame('.result-disclosure');await sleep(100);
if(await f.$eval('.result-disclosure',e=>e.getAttribute('aria-expanded')==='true'))await f.click('.result-disclosure');
for(const [name,theme]of[['dark','Default Dark Modern'],['light','Default Light Modern'],['hc','Default High Contrast'],['hc-light','Default High Contrast Light']]){
 await api({op:'setting',section:'workbench',key:'colorTheme',value:theme});await api({op:'setting',section:'editor',key:'fontSize',value:28});await sleep(500);f=await frame('.result-disclosure');
 const data=await f.$eval('.whole-result',e=>{const b=e.querySelector('.result-disclosure');const s=e.querySelector('.result-summary');return{closed:e.classList.contains('result-collapsed'),height:e.getBoundingClientRect().height,source:e.closest('tr').querySelector('.source-content').getBoundingClientRect().height,buttonRight:b.getBoundingClientRect().right,textLeft:e.querySelector('.result-summary-text').getBoundingClientRect().left,bg:getComputedStyle(s).backgroundColor,radius:getComputedStyle(s).borderRadius,border:getComputedStyle(s).borderLeftColor}});
 assert(data.closed);assert(data.height<=data.source+1);assert(data.buttonRight<data.textLeft);assert.equal(data.radius,'0px');assert.equal(data.bg,'rgba(0, 0, 0, 0)');report.push({name,...data});
 await page.screenshot({path:'/private/tmp/evalens-177-font-'+name+'.png'});
}
await api({op:'setting',section:'editor',key:'fontSize',value:14});await api({op:'setting',section:'workbench',key:'colorTheme',value:'Default Dark Modern'});
fs.writeFileSync('/private/tmp/evalens-177-root-themes.json',JSON.stringify(report,null,2));console.log(report);await browser.disconnect();})().catch(e=>{console.error(e);process.exit(1)});
