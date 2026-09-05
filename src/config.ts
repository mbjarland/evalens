import * as vscode from 'vscode';

/**
 * Which Python to run.
 *
 * Getting this wrong is the most common way an extension like this appears
 * broken: a machine with a system Python, a Homebrew Python and three venvs
 * will happily run the kernel under one that has none of the user's packages,
 * and every evaluation then fails with ImportError on code that works in
 * their terminal.
 *
 * So the order is: what the user configured, then whatever the Microsoft
 * Python extension has selected for this workspace -- which is the
 * interpreter their status bar already claims -- and only then `python3`.
 */
export async function resolvePythonPath(): Promise<string> {
  const configured = vscode.workspace
    .getConfiguration('evalens')
    .get<string>('pythonPath');
  if (configured && configured.trim() !== '') {
    return configured.trim();
  }
  return (await interpreterFromPythonExtension()) ?? 'python3';
}

async function interpreterFromPythonExtension(): Promise<string | undefined> {
  try {
    const extension = vscode.extensions.getExtension('ms-python.python');
    if (!extension) {
      return undefined;
    }
    if (!extension.isActive) {
      await extension.activate();
    }
    // Read defensively: this is another extension's API surface, and a shape
    // change there must degrade to `python3` rather than break evaluation.
    const environments = (extension.exports as {
      environments?: { getActiveEnvironmentPath?(): { path?: string } };
    })?.environments;
    const path = environments?.getActiveEnvironmentPath?.()?.path;
    return typeof path === 'string' && path !== '' ? path : undefined;
  } catch {
    return undefined;
  }
}
