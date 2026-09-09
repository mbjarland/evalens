const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const repo=process.argv[2]||'/Users/mbjarland/projects/evalens-worktrees/199-restore-marketplace-branding';
const mediaRepo=process.env.EVALENS_PREVIEW_MEDIA_REPO||repo;
const revision=require('node:child_process').execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const out='/private/tmp/evalens-199';
(async()=>{
 const p=await import('/Users/mbjarland/projects/evalens/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js');
 const browser=await p.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try{
  const page=await browser.newPage();await page.setViewport({width:1360,height:1000,deviceScaleFactor:1});
  await page.goto('https://marketplace.visualstudio.com/items?itemName=mbjarland.evalens',{waitUntil:'networkidle2',timeout:60000});
  const md=require('/Users/mbjarland/projects/evalens/node_modules/markdown-it')({html:true});
  const html=md.render(fs.readFileSync(repo+'/README.md','utf8'))
   .replace(/src="(media\/[^\"]+)"/g,(_,src)=>`src="data:image/png;base64,${fs.readFileSync(mediaRepo+'/'+src).toString('base64')}"`)
   .replace(/href="(?!https?:|#|mailto:)([^\"]+)"/g,(_,href)=>`href="https://github.com/mbjarland/evalens/blob/${revision}/${href}"`);
  await page.$eval('.itemDetails .markdown',(e,html)=>e.innerHTML=html,html);
  await page.waitForFunction(()=>[...document.querySelectorAll('.markdown img')].every(e=>e.complete&&e.naturalWidth>0));
  const styles=await page.evaluate(()=>({links:[...document.querySelectorAll('link[rel="stylesheet"]')].map(e=>e.href),inline:[...document.querySelectorAll('style')].map(e=>e.innerHTML)}));
  const reports=[];
  for(const viewport of [1360,900]){
   await page.setViewport({width:viewport,height:1000,deviceScaleFactor:1});
   const metrics=await page.$eval('.itemDetails .markdown',e=>({width:e.getBoundingClientRect().width,scrollWidth:e.scrollWidth,heading:e.querySelector('h1')?.textContent,headingAlign:getComputedStyle(e.querySelector('h1')).textAlign,images:[...e.querySelectorAll('img')].map(i=>({alt:i.alt,width:i.width,height:i.height,naturalWidth:i.naturalWidth,complete:i.complete}))}));
   assert.equal(metrics.heading,'eval·lens');assert.equal(metrics.headingAlign,'center');assert(metrics.scrollWidth<=Math.ceil(metrics.width));assert(metrics.images.every(i=>i.complete&&i.naturalWidth));
   const element=await page.$('.itemDetails .markdown');await element.screenshot({path:out+`/marketplace-preview-${viewport}.png`});
   await element.evaluate(e=>e.scrollIntoView({block:'start',behavior:'instant'}));
   await new Promise(r=>setTimeout(r,250));
   const box=await element.boundingBox();await page.screenshot({path:out+`/opening-${viewport}.png`,clip:{x:box.x,y:box.y+await page.evaluate(()=>window.scrollY),width:box.width,height:Math.min(850,box.height)}});
   const sectionClip=await page.$eval('.itemDetails .markdown',e=>{
    const heading=[...e.querySelectorAll('h2')].find(h=>h.textContent==='A total that keeps starting over');
    heading.scrollIntoView({block:'start',behavior:'instant'});
    const next=[...e.querySelectorAll('h2')].find(h=>h.textContent==='Your first evaluation');
    const box=e.getBoundingClientRect(),top=heading.getBoundingClientRect().top;
    return {x:box.x,y:top+window.scrollY,width:box.width,height:next.getBoundingClientRect().top-top};
   });
   await page.screenshot({path:out+`/running-total-${viewport}.png`,clip:sectionClip});
   reports.push({viewport,...metrics});
  }
  fs.writeFileSync(out+'/marketplace-preview.json',JSON.stringify({method:'Unpublished README rendered locally inside the public Marketplace page, using its actual CSS and real locally captured extension images. No Marketplace content was uploaded or changed.',readmeSha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(repo+'/README.md')).digest('hex'),reports},null,2)+'\n');
  const styleTags=styles.links.map(url=>`<link rel="stylesheet" href="${url}">`).join('\n')+styles.inline.map(s=>`<style>${s}</style>`).join('\n');
  // A standalone local preview, with the actual Marketplace styles and image bytes.
  fs.writeFileSync(out+'/index.html',`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>eval·lens — Marketplace preview</title>${styleTags}<style>body{margin:0;background:#fff}main.itemDetails{box-sizing:border-box;max-width:759px;margin:0 auto;padding:24px}.preview-note{font:13px system-ui;color:#666;text-align:center;margin:0 0 24px}.itemDetails .markdown{width:100%;box-sizing:border-box}</style></head><body class="platform gallery gallery-page-item-details"><main class="itemDetails"><p class="preview-note">Marketplace preview · prepared locally</p><div class="markdown">${html}</div></main></body></html>`);
  console.log(JSON.stringify(reports,null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
