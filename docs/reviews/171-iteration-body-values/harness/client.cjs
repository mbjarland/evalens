const assert=require('node:assert/strict');
exports.sleep=ms=>new Promise(r=>setTimeout(r,ms));
exports.api=async d=>{const x=await(await fetch('http://127.0.0.1:9355',{method:'POST',body:JSON.stringify(d)})).json();assert(x.ok,JSON.stringify(x));return x.result;};
exports.until=async(fn,label)=>{for(let i=0;i<100;i++){if(await fn())return;await exports.sleep(100);}throw Error('Timed out: '+label);};
exports.connect=async()=>{
 const {connect}=await import('/Users/mbjarland/projects/evalens/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js');
 const browser=await connect({browserURL:'http://127.0.0.1:9354',defaultViewport:null});
 const [page]=await browser.pages();const session=await page.createCDPSession();
 await session.send('Emulation.setFocusEmulationEnabled',{enabled:true});await page.bringToFront();
 const frame=async(selector)=>{let found;await exports.until(async()=>{for(const f of page.frames())try{if(await f.$(selector))found=f;}catch{}return !!found;},selector);return found;};
 return {browser,page,frame};
};
