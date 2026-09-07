const http = require('node:http');
const vscode = require('vscode');
exports.run = async function () {
 const server=http.createServer(async(req,res)=>{
  try{
   let raw='';for await(const part of req)raw+=part;
   const d=raw?JSON.parse(raw):{};let result;
   if(d.op==='open'){
    const doc=await vscode.workspace.openTextDocument(d.path);
    await vscode.window.showTextDocument(doc,{preview:false});
   }else if(d.op==='cursor'){
    const editor=vscode.window.activeTextEditor;
    const p=new vscode.Position(d.line,d.character||0);
    editor.selection=new vscode.Selection(p,p);
    editor.revealRange(new vscode.Range(p,p),vscode.TextEditorRevealType.InCenterIfOutsideViewport);
   }else if(d.op==='command'){
    result=await vscode.commands.executeCommand(d.command,...(d.args||[]));
   }else if(d.op==='edit'){
    const editor=vscode.window.activeTextEditor;
    result=await editor.edit(builder=>builder.replace(new vscode.Range(d.startLine,d.startChar||0,d.endLine,d.endChar||0),d.text));
   }else if(d.op==='hover'){
    const editor=vscode.window.activeTextEditor;
    const hovers=await vscode.commands.executeCommand('vscode.executeHoverProvider',editor.document.uri,new vscode.Position(d.line,d.character||0));
    result=hovers.map(h=>({contents:h.contents.map(c=>typeof c==='string'?c:{value:c.value,language:c.language}),range:h.range}));
   }else if(d.op==='setting'){
    await vscode.workspace.getConfiguration(d.section).update(d.key,d.value,vscode.ConfigurationTarget.Global);
   }else if(d.op==='state'){
    const e=vscode.window.activeTextEditor;
    result={active:e&&{uri:e.document.uri.toString(),path:e.document.uri.fsPath,line:e.selection.active.line,text:e.document.getText(),untitled:e.document.isUntitled,language:e.document.languageId},documents:vscode.workspace.textDocuments.map(doc=>({uri:doc.uri.toString(),language:doc.languageId,untitled:doc.isUntitled})),extensions:vscode.extensions.all.filter(e=>e.id.includes('evalens')).map(e=>({id:e.id,path:e.extensionPath,active:e.isActive}))};
   }
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,result}));
  }catch(error){res.writeHead(500);res.end(JSON.stringify({error:String(error)}));}
 });
 await new Promise(r=>server.listen(9355,'127.0.0.1',r));
 await new Promise(()=>{});
};
