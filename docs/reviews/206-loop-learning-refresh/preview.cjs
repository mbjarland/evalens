const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const repo=process.argv[2]||'/Users/mbjarland/projects/evalens-worktrees/206-loop-learning-refresh';
const mediaRepo=process.env.EVALENS_PREVIEW_MEDIA_REPO||repo;
const revision=require('node:child_process').execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const out=process.env.EVALENS_PREVIEW_OUT||'/private/tmp/evalens-206/preview';
fs.mkdirSync(out,{recursive:true});
(async()=>{
 const p=await import('/Users/mbjarland/projects/evalens/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js');
 const browser=await p.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try{
  const page=await browser.newPage();await page.setViewport({width:1360,height:1000,deviceScaleFactor:1});
  await page.goto('https://marketplace.visualstudio.com/items?itemName=mbjarland.evalens',{waitUntil:'networkidle2',timeout:60000});
  const md=require('/Users/mbjarland/projects/evalens/node_modules/markdown-it')({html:true});
  let html=md.render(fs.readFileSync(repo+'/README.md','utf8'))
   .replace(/src="(media\/[^\"]+)"/g,(_,src)=>`src="data:image/png;base64,${fs.readFileSync(mediaRepo+'/'+src).toString('base64')}"`)
   .replace(/href="(?!https?:|#|mailto:)([^\"]+)"/g,(_,href)=>`href="https://github.com/mbjarland/evalens/blob/${revision}/${href}"`);
  html=html.replace('<h2>A loop tells you what happened</h2>', '<h2 id="a-loop-tells-you-what-happened">A loop tells you what happened</h2>');
  await page.$eval('.itemDetails .markdown',(e,html)=>e.innerHTML=html,html);
  await page.waitForFunction(()=>[...document.querySelectorAll('.markdown img')].every(e=>e.complete&&e.naturalWidth>0));
  const fixture=fs.readFileSync(repo+'/docs/reviews/196-marketplace-page-refresh/fixtures/nested-loops-base.py','utf8').trim();
  const example=await page.$eval('.itemDetails .markdown',e=>{
   const heading=[...e.querySelectorAll('h2')].find(h=>h.textContent==='A loop tells you what happened');
   const nodes=[];for(let n=heading.nextElementSibling;n&&n.tagName!=='H2';n=n.nextElementSibling)nodes.push(n);
   const code=nodes.flatMap(n=>[...n.querySelectorAll('pre code')]).find(Boolean);
   const image=nodes.flatMap(n=>n.tagName==='IMG'?[n]:[...n.querySelectorAll('img')]).find(i=>i.alt.startsWith('Nested loop explorer'));
   const sourceImage=nodes.flatMap(n=>n.tagName==='IMG'?[n]:[...n.querySelectorAll('img')]).find(i=>i!==image);
   return {source:code?.textContent.trim(),sourceImageBeforeResult:!!(sourceImage&&image&&(sourceImage.compareDocumentPosition(image)&Node.DOCUMENT_POSITION_FOLLOWING)),codeInDisclosure:!!code?.closest('details'),codeBeforeImage:!!(code&&image&&(code.compareDocumentPosition(image)&Node.DOCUMENT_POSITION_FOLLOWING))};
  });
  assert.equal(example.source,fixture);assert(example.codeBeforeImage);assert(example.sourceImageBeforeResult);assert(example.codeInDisclosure);
  const styles=await page.evaluate(()=>({links:[...document.querySelectorAll('link[rel="stylesheet"]')].map(e=>e.href),inline:[...document.querySelectorAll('style')].map(e=>e.innerHTML)}));
  const typeMetrics=()=>{const root=document.querySelector('.itemDetails .markdown');return Object.fromEntries(['p','h1','h2','pre code'].map(selector=>{const style=getComputedStyle(root.querySelector(selector));return [selector,{fontSize:style.fontSize,fontFamily:style.fontFamily,lineHeight:style.lineHeight}]}));};
  const liveTypography=await page.evaluate(typeMetrics);
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
    const heading=[...e.querySelectorAll('h2')].find(h=>h.textContent==='A loop tells you what happened');
    heading.scrollIntoView({block:'start',behavior:'instant'});
    const next=[...e.querySelectorAll('h2')].find(h=>h.textContent==='Room to grow');
    const box=e.getBoundingClientRect(),top=heading.getBoundingClientRect().top;
    return {x:box.x,y:top+window.scrollY,width:box.width,height:next.getBoundingClientRect().top-top};
   });
   await page.screenshot({path:out+`/loop-code-before-values-${viewport}.png`,clip:sectionClip});
   reports.push({viewport,...metrics});
  }
  const report={method:'Unpublished README rendered locally inside the public Marketplace page, using its actual CSS and real locally captured extension images. No Marketplace content was uploaded or changed.',example,readmeSha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(repo+'/README.md')).digest('hex'),reports,liveTypography};
  const styleTags=styles.links.map(url=>`<link rel="stylesheet" href="${url}">`).join('\n')+styles.inline.map(s=>`<style>${s}</style>`).join('\n');
  // A standalone local preview, with the actual Marketplace styles and image bytes.
  fs.writeFileSync(out+'/index.html',`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>eval·lens — Marketplace preview</title>${styleTags}<style>body{margin:0;background:#fff}main.itemDetails{box-sizing:border-box;max-width:759px;margin:0 auto;padding:24px}.preview-note{font:13px system-ui;color:#666;text-align:center;margin:0 0 24px}.itemDetails .markdown{width:100%;box-sizing:border-box}</style></head><body class="platform gallery gallery-page-item-details"><main class="ms-Fabric itemDetails"><p class="preview-note">Marketplace preview · actual Marketplace type size</p><div class="markdown">${html}</div></main></body></html>`);
  // Preserve the live page's ms-Fabric typography ancestor in the reduced shell.
  await page.goto('file://'+out+'/index.html',{waitUntil:'networkidle2'});
  await page.evaluate(()=>document.fonts.ready);
  const standaloneTypography=await page.evaluate(typeMetrics);
  assert.deepEqual(standaloneTypography,liveTypography,'standalone preview must match Marketplace typography');
  report.standaloneTypography=standaloneTypography;
  report.typographyMatches=true;
  await page.setViewport({width:900,height:1000,deviceScaleFactor:1});
  await page.$eval('#a-loop-tells-you-what-happened',e=>e.scrollIntoView({block:'start',behavior:'instant'}));
  await page.screenshot({path:out+'/standalone-loop-section.png'});
  const guideSource=fs.readFileSync(repo+'/docs/user-guide.md','utf8');
  let guideHtml=md.render(guideSource)
   .replace(/src="(\.\.\/media\/[^\"]+)"/g,(_,src)=>`src="data:image/png;base64,${fs.readFileSync(path.resolve(mediaRepo,'docs',src)).toString('base64')}"`)
   .replace(/href="(?!https?:|#|mailto:)([^\"]+)"/g,(_,href)=>`href="https://github.com/mbjarland/evalens/blob/${revision}/${path.posix.normalize('docs/'+href)}"`);
  guideHtml=guideHtml.replace('<h3>Loops keep values beside the output they produced</h3>','<h3 id="loops-keep-values-beside-the-output-they-produced">Loops keep values beside the output they produced</h3>');
  fs.writeFileSync(out+'/user-guide.html',`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Evalens user guide preview</title>${styleTags}<style>body{margin:0;background:#fff}main.itemDetails{box-sizing:border-box;max-width:759px;margin:0 auto;padding:24px}.itemDetails .markdown{width:100%;box-sizing:border-box}</style></head><body class="platform gallery gallery-page-item-details"><main class="ms-Fabric itemDetails"><div class="markdown">${guideHtml}</div></main></body></html>`);
  await page.goto('file://'+out+'/user-guide.html',{waitUntil:'networkidle2'});
  await page.waitForFunction(()=>[...document.querySelectorAll('.markdown img')].every(e=>e.complete&&e.naturalWidth>0));
  report.guide=[];
  for(const viewport of [759,536]){
   await page.setViewport({width:viewport,height:1000,deviceScaleFactor:1});
   const section=await page.$eval('.itemDetails .markdown',e=>{
    const heading=e.querySelector('#loops-keep-values-beside-the-output-they-produced');
    const nodes=[];for(let n=heading.nextElementSibling;n&&n.tagName!=='H3';n=n.nextElementSibling)nodes.push(n);
    const code=nodes.flatMap(n=>[...n.querySelectorAll('pre code')]).find(Boolean);
    const images=nodes.flatMap(n=>n.tagName==='IMG'?[n]:[...n.querySelectorAll('img')]);
    heading.scrollIntoView({block:'start',behavior:'instant'});
    const next=[...e.querySelectorAll('h3')].find(h=>h.textContent==='A comprehension stops hiding its loop');
    const box=e.getBoundingClientRect(),top=heading.getBoundingClientRect().top;
    return {source:code?.textContent.trim(),codeInDisclosure:!!code?.closest('details'),
     sourceBeforeResult:images.length===2&&!!(images[0].compareDocumentPosition(images[1])&Node.DOCUMENT_POSITION_FOLLOWING),
     codeBeforeResult:!!(code&&images[1]&&(code.compareDocumentPosition(images[1])&Node.DOCUMENT_POSITION_FOLLOWING)),
     images:images.map(i=>({width:i.width,height:i.height,naturalWidth:i.naturalWidth})),
     clip:{x:box.x,y:top+window.scrollY,width:box.width,height:next.getBoundingClientRect().top-top}};
   });
   assert.equal(section.source,fixture);assert(section.codeInDisclosure);assert(section.sourceBeforeResult);assert(section.codeBeforeResult);
   assert(section.images.every(image=>image.width<=section.clip.width));
   await page.screenshot({path:out+`/user-guide-loops-${viewport}.png`,clip:section.clip});
   report.guide.push({viewport,...section});
  }
  report.guideSha256=require('node:crypto').createHash('sha256').update(guideSource).digest('hex');
  fs.writeFileSync(out+'/marketplace-preview.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({reports,liveTypography,standaloneTypography},null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
