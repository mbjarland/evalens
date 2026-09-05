import * as vscode from 'vscode';

import { ESCAPE_HINT, promptLabel } from './input';
import { InputRequest } from './kernel/protocol';

/**
 * Ask the user what the running code asked for.
 *
 * The kernel is blocked while this box is open, which is correct and is what
 * a REPL does -- and is why interrupting had to land alongside prompting. A
 * prompt the user walked away from and a hung kernel look identical from the
 * outside; `Evalens: Interrupt Evaluation` is the difference.
 *
 * Returning null sends end-of-file, which raises `EOFError` in the code that
 * asked. That is the behaviour the kernel had before it could ask anything,
 * kept on purpose as the way out.
 */
export async function askForInput(
  request: InputRequest
): Promise<string | null> {
  const answer = await vscode.window.showInputBox({
    title: 'Evalens',
    prompt: promptLabel(request.prompt),
    placeHolder: ESCAPE_HINT,
    // The read came from inside getpass. Echoing it into a visible box would
    // leak the one thing that function exists to hide.
    password: request.password,
    // Not optional. Without it the box closes the moment the user clicks the
    // editor -- which is exactly what someone does to re-read the line that
    // asked -- leaving the kernel blocked with no visible prompt and no way
    // to answer the question it is still waiting on.
    ignoreFocusOut: true,
  });
  return answer ?? null;
}
