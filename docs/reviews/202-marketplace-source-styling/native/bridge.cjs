const http = require('node:http');
const vscode = require('vscode');
const workspace = '/private/tmp/evalens-202/workspace';

exports.activate = () => {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST') throw Error('POST required');
      let raw = '';
      for await (const part of req) raw += part;
      const request = JSON.parse(raw);
      let result;
      if (request.op !== 'state') {
        const folders = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath);
        if (folders?.length !== 1 || folders[0] !== workspace) {
          throw Error('Disposable workspace required');
        }
      }
      if (request.op === 'open') {
        if (request.path !== workspace + '/nested-loops.py') {
          throw Error('Only the source-review fixture may be opened');
        }
        const document = await vscode.workspace.openTextDocument(request.path);
        await vscode.window.showTextDocument(document, { preview: false });
      } else if (request.op === 'cursor') {
        const editor = vscode.window.activeTextEditor;
        if (editor?.document.uri.fsPath !== workspace + '/nested-loops.py') {
          throw Error('Source-review fixture required');
        }
        const position = new vscode.Position(request.line, 0);
        editor.selection = new vscode.Selection(position, position);
      } else if (request.op === 'command') {
        const allowed = new Set([
          'workbench.action.closeSidebar',
          'workbench.action.closeAuxiliaryBar',
          'workbench.action.closePanel',
          'workbench.action.joinAllGroups',
          'workbench.action.focusStatusBar',
        ]);
        if (!allowed.has(request.command)) throw Error('Command not allowed');
        result = await vscode.commands.executeCommand(request.command);
      } else if (request.op === 'state') {
        const editor = vscode.window.activeTextEditor;
        result = {
          workspace: vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath),
          active: editor && {
            path: editor.document.uri.fsPath,
            uri: editor.document.uri.toString(),
            text: editor.document.getText(),
            language: editor.document.languageId,
          },
          extensions: vscode.extensions.all.filter(e => e.id.includes('evalens'))
            .map(e => ({ id: e.id, path: e.extensionPath, active: e.isActive })),
        };
      } else {
        throw Error('Operation not allowed');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(error) }));
    }
  });
  server.listen(9425, '127.0.0.1');
};
