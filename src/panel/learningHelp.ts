/** Optional teaching copy is separate from the result evidence it explains.
 * These controls read no annotations or namespace and cannot run Python. */
export const INTRO_DISMISSED_KEY = 'evalens.valuesPanel.introDismissed';
export const PYTHON_DEBUGGING_GUIDE = 'https://code.visualstudio.com/docs/python/debugging';

export const LEARNING_TOPICS = ['help', 'evaluate', 'results', 'session', 'exercises', 'debugger'] as const;
export type LearningTopic = typeof LEARNING_TOPICS[number];
export interface LearningHelpState {
  readonly introDismissed?: boolean;
  readonly openTopics?: ReadonlySet<LearningTopic>;
  readonly platform?: string;
  /** Configuration only, not a claim about bindings currently in Python. */
  readonly resetOnLoad?: boolean;
}

export function isLearningTopic(value: unknown): value is LearningTopic {
  return LEARNING_TOPICS.some(topic => topic === value);
}

export function evaluationShortcuts(platform: string): { evaluate: string; advance: string } {
  const modifier = platform === 'darwin' ? 'Cmd' : 'Ctrl';
  return { evaluate: `${modifier}+Enter`, advance: `${modifier}+Shift+Enter` };
}

function shortcutInstructions(platform: string): string {
  const keys = evaluationShortcuts(platform);
  return `<p>In the Python editor, <kbd>${keys.evaluate}</kbd> evaluates the current statement. `
    + `<kbd>${keys.advance}</kbd> evaluates it and moves to the next statement.</p>`
    + '<p class="learning-note">These are the default shortcuts; the same Evalens commands '
    + 'are available in the Command Palette.</p>';
}

export function learningEmptyHtml(hasEditor: boolean, platform: string): string {
  return '<div class="empty">'
    + (hasEditor ? '' : '<p>Open a Python file.</p>')
    + shortcutInstructions(platform)
    + '<button type="button" class="learning-action" data-learning-action="walkthrough">'
    + 'Try a guided example</button></div>';
}

export function learningToggleHtml(state: LearningHelpState): string {
  return '<button type="button" class="learning-action" data-learning-toggle '
    + `aria-controls="learning-help" aria-expanded="${state.openTopics?.has('help') ?? false}">`
    + 'Help and learning</button>';
}

export function learningHelpHtml(state: LearningHelpState): string {
  const open = (topic: LearningTopic) => state.openTopics?.has(topic) ? ' open' : '';
  const topic = (id: LearningTopic, title: string, content: string) =>
    `<details data-learning-topic="${id}"${open(id)}><summary>${title}</summary>${content}</details>`;
  return (state.resetOnLoad === false
    ? '<p class="session-notice">Evaluate File is set to keep existing variables. '
      + '<button type="button" class="learning-action" data-learning-session>Session details</button></p>'
    : '')
    + `<div id="learning-intro" class="learning-intro"${state.introDismissed ? ' hidden' : ''}>`
    + '<span>Results are recorded when you run code. Browsing this panel does not run Python.</span> '
    + '<button type="button" class="learning-action" data-learning-action="dismiss-intro" '
    + 'aria-label="Dismiss introduction">Dismiss</button></div>'
    + '<section id="learning-help" class="learning-help" aria-label="Help and learning"'
    + `${state.openTopics?.has('help') ? '' : ' hidden'}>`
    + topic('evaluate', 'Evaluate code', shortcutInstructions(state.platform ?? process.platform)
      + '<p>Evaluate and Advance runs the entire statement before moving the cursor. '
      + 'It does not pause inside a loop or step into a function.</p>')
    + topic('results', 'Understand recorded results',
      '<dl><dt>Variables and printed output</dt><dd>Variables are recorded readings. '
      + 'Printed output is the text your code wrote, for example with <code>print()</code>.</dd>'
      + '<dt>Old results</dt><dd>An edit or a later evaluation can make a recorded result '
      + 'out of date. Its marker explains the known reason; reading it does not refresh it.</dd>'
      + '<dt>Loop values</dt><dd>The loop variable is read at iteration start; body values '
      + 'are read at normal iteration end. Printed output may come from an earlier moment '
      + 'in the iteration.</dd><dt>Not recorded</dt><dd>Evalens did not save that reading. '
      + 'This does not mean the variable had no value in Python. The result explains '
      + 'the known reason.</dd><dt>Long results</dt><dd>Folding and paging reveal saved '
      + 'content. A capture-limit notice means some detail was never saved; expanding '
      + 'cannot recover it.</dd></dl>')
    + topic('session', 'Session and reset actions', sessionHelpHtml(state.resetOnLoad ?? true))
    + topic('exercises', 'Practice with guided examples',
      '<p>Five editable examples cover prediction, advancing, shared lists, accumulators, '
      + 'and old results. Opening an example does not run it or reset your session.</p>'
      + '<p><button type="button" class="learning-action" data-learning-action="walkthrough">'
      + 'Open learning walkthrough</button> · '
      + '<button type="button" class="learning-action" data-learning-action="exercise">'
      + 'Choose an exercise</button></p>')
    + topic('debugger', 'When to use the Python debugger',
      '<p>Use Evalens to evaluate a chosen statement and inspect its recorded result. '
      + 'Use the Python debugger to follow execution order, stop at breakpoints, step '
      + 'into function calls, inspect the call stack, or read variables at a paused point.</p>'
      + '<p>Starting a normal Python debugging session runs your program separately. '
      + 'It does not resume an Evalens recording or carry over its variables.</p>'
      + `<p><a href="${PYTHON_DEBUGGING_GUIDE}">Python debugging in VS Code</a> `
      + '(official guide)</p>')
    + `<button type="button" class="learning-action" data-learning-action="show-intro"`
    + `${state.introDismissed ? '' : ' hidden'}>Show introduction</button></section>`;
}

function sessionHelpHtml(resetOnLoad: boolean): string {
  return '<p>Evalens keeps one Python session for statement evaluations in this VS Code '
    + 'window. Files share its variables. Switching files or editing code does not reset it.</p>'
    + '<p>Recorded results describe earlier evaluations; they are not a list of variables '
    + 'currently in Python. Moving the cursor or selecting an iteration does not move '
    + 'Python execution to that point. A normal Python debugging session is separate.</p>'
    + '<dl><dt>Clear Inline Results</dt><dd>Removes recorded results from the editor and '
    + 'Values panel for all files. Variables and saved input answers stay in Python. '
    + 'It does not stop running code.</dd>'
    + '<dt>Restart Kernel</dt><dd>Stops Evalens\u2019s Python process and discards its variables '
    + 'and saved input answers. The next evaluation starts a fresh process. Existing '
    + 'recorded results remain visible; they do not describe the new session.</dd>'
    + '<dt>Evaluate at Cursor / Evaluate and Advance</dt><dd>Runs the statement at the '
    + 'cursor using the existing variables, without resetting. Repeating an evaluation '
    + 'runs it again, including any side effects.</dd>'
    + '<dt>Evaluate File</dt><dd>'
    + (resetOnLoad
      ? 'Currently set to clear variables and saved input answers before a whole-file run '
        + '(<code>evalens.resetOnLoad</code> is on, the default).'
      : 'Currently set to keep existing variables and saved input answers before a '
        + 'whole-file run (<code>evalens.resetOnLoad</code> is off).')
    + ' With a selection, it runs the selected whole statements and never resets, '
    + 'regardless of that setting. When a non-resetting whole-file run reports names '
    + 'left over from an earlier session, the status bar lists them after the run.</dd>'
    + '<dt>Run File as Script</dt><dd>Always clears variables and saved input answers, '
    + 'then runs the whole file with <code>__name__ = "__main__"</code>. It ignores '
    + 'the selection and <code>evalens.resetOnLoad</code>.</dd>'
    + '<dt>Evaluate Above Cursor</dt><dd>Clears variables and saved input answers, then '
    + 'runs complete top-level statements above the cursor, stopping at the first error. '
    + 'The statement containing the cursor stays unrun. This reset cannot be turned off.</dd>'
    + '<dt>Clear Input Answers</dt><dd>Forgets saved answers for <code>input()</code> '
    + 'without clearing variables. Otherwise a repeated prompting statement can reuse '
    + 'its saved answers until the statement changes or the session resets. Answers '
    + 'supplied by a <code># evalens:</code> comment remain part of the source.</dd></dl>'
    + '<p class="learning-note">Find these Evalens commands in the Command Palette. '
    + 'Reading this help does not run code, clear results, or reset Python.</p>';
}

export const LEARNING_STYLE = `
.learning-action {
  border: 0; padding: 0; background: transparent;
  color: var(--vscode-textLink-foreground, #3794ff);
  font: inherit; text-align: left; cursor: pointer;
}
.learning-action:hover, .learning-help a:hover { text-decoration: underline; }
.learning-action:focus-visible, .learning-help summary:focus-visible,
.learning-help a:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, currentColor); outline-offset: 2px;
}
.learning-intro, .learning-help { padding: 6px 2px; line-height: 1.5; }
.session-notice { margin: 6px 2px; line-height: 1.5; }
.learning-intro, .learning-note { color: var(--vscode-descriptionForeground, #9d9d9d); }
.learning-help { max-width: 80ch; overflow-wrap: anywhere; }
.learning-help summary { cursor: pointer; }
.learning-help details { margin-bottom: 6px; }
.learning-help p, .empty p { margin: 0 0 8px; }
.learning-help dt { font-weight: 600; }
.learning-help dd { margin: 0 0 8px 1em; }
.learning-help a { color: var(--vscode-textLink-foreground, #3794ff); }
.learning-help kbd, .empty kbd { font-family: var(--vscode-editor-font-family, monospace); }
`;

/** Runs inside the existing nonce-guarded webview closure. State changes are
 * immediate DOM updates, so dismissing prose never rebuilds result folds. */
export const LEARNING_SCRIPT = `
  function revealLearning(element) {
    var toolbar = document.getElementById('navigation-control').getBoundingClientRect();
    window.scrollTo({ top: Math.max(0, window.scrollY
      + element.getBoundingClientRect().top - toolbar.height - 8) });
  }
  document.querySelectorAll('[data-learning-toggle]').forEach(function (button) {
    button.addEventListener('click', function () {
      var help = document.getElementById('learning-help');
      help.hidden = !help.hidden;
      button.setAttribute('aria-expanded', String(!help.hidden));
      if (!help.hidden) revealLearning(help);
      vscode.postMessage({ learningTopic: 'help', learningOpen: !help.hidden, revision: revision });
    });
  });
  document.querySelectorAll('[data-learning-topic]').forEach(function (topic) {
    topic.addEventListener('toggle', function () {
      vscode.postMessage({ learningTopic: topic.dataset.learningTopic,
        learningOpen: topic.open, revision: revision });
    });
  });
  document.querySelectorAll('[data-learning-session]').forEach(function (button) {
    button.addEventListener('click', function () {
      var help = document.getElementById('learning-help');
      var topic = document.querySelector('[data-learning-topic="session"]');
      help.hidden = false;
      topic.open = true;
      document.querySelector('[data-learning-toggle]').setAttribute('aria-expanded', 'true');
      topic.querySelector('summary').focus({ preventScroll: true });
      revealLearning(topic);
      vscode.postMessage({ learningTopic: 'help', learningOpen: true, revision: revision });
      vscode.postMessage({ learningTopic: 'session', learningOpen: true, revision: revision });
    });
  });
  document.querySelectorAll('[data-learning-action]').forEach(function (button) {
    button.addEventListener('click', function () {
      var action = button.dataset.learningAction;
      if (action === 'dismiss-intro' || action === 'show-intro') {
        var dismissed = action === 'dismiss-intro';
        document.getElementById('learning-intro').hidden = dismissed;
        document.querySelector('[data-learning-action="show-intro"]').hidden = !dismissed;
        document.querySelector('[data-learning-toggle]').focus({ preventScroll: true });
        if (!dismissed) revealLearning(document.getElementById('learning-intro'));
      }
      vscode.postMessage({ learningAction: action, revision: revision });
    });
  });
`;
