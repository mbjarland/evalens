// Temporary native VS Code capture helper. Not packaged or used by Evalens.
const http=require('node:http'),vscode=require('vscode');
exports.activate=context=>{
 const server=http.createServer(async(req,res)=>{try{
  let raw='';for await(const part of req)raw+=part;const d=JSON.parse(raw);let result;
  if(d.op==='open'){
   if(!d.path.startsWith('/private/tmp/evalens-196/workspace/')||d.path.includes('..'))throw Error('Disposable fixtures only');
   const doc=await vscode.workspace.openTextDocument(d.path);await vscode.window.showTextDocument(doc,{preview:false});
  }else if(d.op==='cursor'){
   const editor=vscode.window.activeTextEditor,p=new vscode.Position(d.line,d.character||0);editor.selection=new vscode.Selection(p,p);editor.revealRange(new vscode.Range(p,p),vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }else if(d.op==='command'){
   if(!/^(evalens\.|workbench\.action\.)/.test(d.command))throw Error('Unexpected capture command');
   result=await vscode.commands.executeCommand(d.command,...(d.args||[]));
  }else if(d.op==='setting'){
   if(d.section!=='editor')throw Error('Editor settings only');
   await vscode.workspace.getConfiguration(d.section).update(d.key,d.value,vscode.ConfigurationTarget.Global);
  }else if(d.op==='state'){
   const e=vscode.window.activeTextEditor;result={active:e&&{uri:e.document.uri.toString(),path:e.document.uri.fsPath,line:e.selection.active.line,text:e.document.getText()},extensions:vscode.extensions.all.filter(e=>e.id.includes('evalens')).map(e=>({id:e.id,path:e.extensionPath,active:e.isActive}))};
  }else throw Error('Unexpected capture operation');
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,result}));
 }catch(error){res.writeHead(500);res.end(JSON.stringify({error:String(error)}));}});
 server.listen(9355,'127.0.0.1');context.subscriptions.push({dispose:()=>server.close()});
};
