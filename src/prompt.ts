import * as vscode from 'vscode';

import { ESCAPE_HINT, SKIP_HINT, SKIP_LABEL, promptLabel } from './input';
import { InputRequest } from './kernel/protocol';

/**
 * What the user did with the box.
 *
 * Three outcomes rather than a string-or-null, because "skip the rest" is not
 * expressible as an answer: any text at all is something someone could type,
 * and so is the empty string. It is a decision about every prompt still to
 * come, and the caller has to be able to act on it rather than guess.
 */
export type Answer =
  | { readonly kind: 'value'; readonly value: string }
  /** Cancelled: send end-of-file, raise `EOFError` there, carry on. */
  | { readonly kind: 'eof' }
  /** Cancel this one and every one after it, for the rest of the load. */
  | { readonly kind: 'skip' };

/**
 * Ask the user what the running code asked for.
 *
 * The kernel is blocked while this box is open, which is correct and is what a
 * REPL does -- and is why interrupting had to land alongside prompting. A
 * prompt the user walked away from and a hung kernel look identical from the
 * outside; `Evalens: Interrupt Evaluation` is the difference.
 *
 * Cancelling sends end-of-file, which raises `EOFError` in the code that
 * asked. That is the behaviour the kernel had before it could ask anything,
 * kept on purpose as the way out.
 *
 * The box stays at the top of the window, and is deliberately not an inline
 * editable field on the line that asked. The only stable API for that is the
 * Comments API, whose zone widget pushes every line below it down -- reflowing
 * the column of values the reader is in the middle of, which is the annotation
 * stability a whole ticket went into fixing. What the inline version would
 * have given is context, and that comes from marking and revealing the line
 * instead: the box is where you type, the annotation is what says which line
 * is asking and what for.
 *
 * `title` is `locatedTitle`'s output when the kernel said where the statement
 * is -- `line 13 · x = input("give me a value: ")` -- and falls back to the
 * bare extension name when it did not, which is the only way an older kernel
 * or a request with no `range` can reach this.
 */
export async function askForInput(
  request: InputRequest, offerSkip = false, title?: string
): Promise<Answer> {
  if (!offerSkip) {
    // `showInputBox` for the ordinary case: the same widget with none of the
    // lifecycle to get wrong, and most prompts never see the other path.
    const answer = await vscode.window.showInputBox(settings(request, title));
    return answer === undefined
      ? { kind: 'eof' }
      : { kind: 'value', value: answer };
  }
  return withSkipButton(request, title);
}

/** Everything both boxes share, so the two cannot drift in what they say. */
function settings(
  request: InputRequest, title?: string
): vscode.InputBoxOptions {
  return {
    title: title ?? 'Evalens',
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
  };
}

/**
 * The same box, with a button that answers every prompt still to come.
 *
 * `createInputBox` rather than `showInputBox` because only the former takes
 * buttons, and the button has to be on the box: a file with twenty prompts
 * must not mean twenty boxes with no way out, and the way out belongs where
 * the reader is already looking. The cost is the lifecycle this function
 * exists to contain -- every path resolves exactly once and disposes exactly
 * once, or the kernel is left blocked on an answer nobody will send.
 */
function withSkipButton(
  request: InputRequest, title?: string
): Promise<Answer> {
  const box = vscode.window.createInputBox();
  const shared = settings(request, title);
  box.title = shared.title;
  box.prompt = shared.prompt;
  box.placeholder = shared.placeHolder;
  box.password = shared.password ?? false;
  box.ignoreFocusOut = true;
  box.buttons = [{
    // "Continue" is the honest word: the load keeps going, it stops asking.
    iconPath: new vscode.ThemeIcon('debug-continue'),
    tooltip: `${SKIP_LABEL} — ${SKIP_HINT}`,
  }];

  return new Promise<Answer>((resolve) => {
    // Cancelling is the default because it is what every way of leaving a box
    // without answering means -- Escape, the close button, a command palette
    // opening over it.
    let answer: Answer = { kind: 'eof' };
    const settle = (chosen: Answer): void => {
      answer = chosen;
      // Hiding fires onDidHide, which is the one place the promise resolves.
      // A single exit is what keeps the box from being disposed twice or the
      // kernel from being answered twice, however the user left it.
      box.hide();
    };
    box.onDidAccept(() => settle({ kind: 'value', value: box.value }));
    box.onDidTriggerButton(() => settle({ kind: 'skip' }));
    box.onDidHide(() => {
      box.dispose();
      resolve(answer);
    });
    box.show();
  });
}
