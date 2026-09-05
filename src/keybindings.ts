/**
 * Keybinding collisions with other extensions, and the one fix that holds.
 *
 * VS Code resolves two *extension* keybindings on the same key and the same
 * `when` clause by load order -- the last one registered wins -- and nothing
 * makes load order deterministic. `almenon.arepl` binds our key under exactly
 * our context, so on a machine with both installed the primary interaction
 * works or does not depending on which extension loaded second, and can flip
 * between reloads. It presents as a completely dead key: no error, no log
 * line, no indication that another extension answered instead. Three rounds
 * of diagnosis went past it, including a headless harness that proved the
 * command was fine -- because the command was never the problem.
 *
 * A *user* keybinding is not subject to that tie: user bindings are resolved
 * after every extension's, so the last match on a key is always the user's.
 * Writing one is the only deterministic fix available, since the manifest
 * cannot win a tie it is itself a party to.
 *
 * Changing the default away from ctrl/cmd+enter is deliberately not the
 * answer. It is what Calva uses, what AREPL uses, and what this audience's
 * fingers already know; ceding it would trade a solvable collision for a
 * permanently worse default.
 *
 * No `vscode` import: which key applies on which platform, and the JSON that
 * says so, are decidable without an editor.
 */

export type Platform = 'mac' | 'other';

/** The command the collision costs us, and the reason this file exists. */
export const EVALUATE_AT_CURSOR = 'evalens.evaluateAtCursor';

/**
 * The context the manifest binds it under. The fix repeats it verbatim so a
 * user keybinding behaves exactly like the default it is replacing --
 * `manifest.test.ts` fails if the two ever drift apart.
 */
export const EVALUATE_WHEN =
  'editorTextFocus && editorLangId == python && !findWidgetVisible';

/** `process.platform` is the only input; the rest of this module is pure. */
export function platformOf(nodePlatform: string): Platform {
  return nodePlatform === 'darwin' ? 'mac' : 'other';
}

/** The key `evalens.evaluateAtCursor` answers on, as the manifest binds it. */
export function evaluateKey(platform: Platform): string {
  return platform === 'mac' ? 'cmd+enter' : 'ctrl+enter';
}

export interface KnownConflict {
  readonly extensionId: string;
  readonly extensionName: string;
  /** The command that answers instead of ours when the other side wins. */
  readonly command: string;
  /** That binding's `when` clause, as the other extension ships it. */
  readonly when: string;
  /** Platforms where it lands on the same key as ours. */
  readonly platforms: readonly Platform[];
  /** Whether finding it installed justifies interrupting the user. */
  readonly notify: boolean;
  /** One sentence, for the README and the output channel. */
  readonly summary: string;
}

/**
 * Read off the shipped manifests of the extensions in question, not guessed.
 *
 * Jupyter is listed and documented but not notified about. Its overlap is
 * real, and it is the reason the README says so, but it bites only inside a
 * file with `# %%` cells and only where our key is `ctrl+enter`; Jupyter is
 * installed on a large share of Python setups, and a notification most of
 * those users cannot act on is how an extension teaches people to dismiss the
 * one that matters.
 */
export const KNOWN_CONFLICTS: readonly KnownConflict[] = [
  {
    extensionId: 'almenon.arepl',
    extensionName: 'AREPL',
    command: 'extension.executeAREPLBlock',
    when: 'editorTextFocus && editorLangId == python',
    platforms: ['mac', 'other'],
    notify: true,
    summary:
      'sits on the same key under the same condition, on every platform',
  },
  {
    extensionId: 'ms-toolsai.jupyter',
    extensionName: 'Jupyter',
    command: 'jupyter.runcurrentcell',
    when:
      'editorTextFocus && !editorHasSelection && jupyter.hascodecells && ' +
      '!notebookEditorFocused && !isCompositeNotebook',
    platforms: ['other'],
    notify: false,
    summary:
      'binds ctrl+enter to Run Current Cell, so it overlaps on Windows and ' +
      'Linux, and only in a file that has `# %%` cells',
  },
];

/**
 * The conflicts worth interrupting the user over: installed here, live on
 * this platform, and unconditional enough to be worth saying out loud.
 *
 * `isInstalled` is injected so the decision stays testable -- the caller is
 * the only part that needs an editor to answer it.
 */
export function detectConflicts(
  isInstalled: (extensionId: string) => boolean,
  platform: Platform
): readonly KnownConflict[] {
  return KNOWN_CONFLICTS.filter(
    (conflict) =>
      conflict.notify &&
      conflict.platforms.includes(platform) &&
      isInstalled(conflict.extensionId));
}

export interface KeybindingEntry {
  readonly key: string;
  readonly command: string;
  readonly when: string;
}

/**
 * The user keybindings that settle a set of conflicts.
 *
 * The first entry is the fix. The removals after it are not redundant: ours
 * only wins where its `when` holds, so AREPL would still answer with the find
 * widget open -- a dead key in a different disguise.
 */
export function keybindingEntries(
  platform: Platform,
  conflicts: readonly KnownConflict[] = []
): readonly KeybindingEntry[] {
  const key = evaluateKey(platform);
  return [
    { key, command: EVALUATE_AT_CURSOR, when: EVALUATE_WHEN },
    ...conflicts.map((conflict) => ({
      key,
      command: `-${conflict.command}`,
      when: conflict.when,
    })),
  ];
}

function indent(text: string): string {
  return text.split('\n').map((line) => `  ${line}`).join('\n');
}

/**
 * Those entries as text to paste inside the outer `[ ]` of keybindings.json.
 *
 * Comments ship with it because the user is the one applying it. A line
 * somebody can read before pasting and delete afterwards is reversible in a
 * way that an edit made silently on their behalf is not, and keybindings.json
 * is JSON with comments, so they survive the paste.
 */
export function keybindingSnippet(
  platform: Platform,
  conflicts: readonly KnownConflict[] = []
): string {
  const [ours, ...removals] = keybindingEntries(platform, conflicts);
  const blocks = [
    indent([
      '// Evalens: a user keybinding is resolved after every extension\'s, so',
      '// this one wins the key whichever extension happened to load last.',
      JSON.stringify(ours, null, 2),
    ].join('\n')),
    ...removals.map((entry, index) =>
      indent([
        `// Removes ${conflicts[index].extensionName}'s binding on the ` +
        'same key. Delete this entry to',
        '// keep it -- the one above already wins wherever both apply.',
        JSON.stringify(entry, null, 2),
      ].join('\n'))),
  ];
  return blocks.join(',\n');
}

/**
 * A keybindings-editor query listing every binding on our key, ours and the
 * other extension's side by side. `@keybinding:` is a real filter in that
 * editor, so this lands on the conflict rather than on a search box.
 */
export function keybindingsQuery(platform: Platform): string {
  return `@keybinding:${evaluateKey(platform)}`;
}

/** The notification: what is wrong, and that it is fixable. */
export function conflictMessage(
  conflicts: readonly KnownConflict[],
  platform: Platform
): string {
  const names = conflicts.map((each) => each.extensionName).join(' and ');
  return `${names} also binds ${evaluateKey(platform)} for Python, and VS ` +
    'Code decides which extension answers by load order, so Evalens: ' +
    'Evaluate at Cursor may do nothing. A user keybinding settles it.';
}

/**
 * What goes in the output channel: what was found, why it matters, and the
 * whole fix. The notification appears once ever, so this is the way back for
 * a user who dismissed it -- and the log line whose absence made the original
 * bug take three rounds to find.
 */
export function describeConflicts(
  conflicts: readonly KnownConflict[],
  platform: Platform
): string {
  return [
    `keybinding conflict on ${evaluateKey(platform)}:`,
    ...conflicts.map(
      (conflict) =>
        `  ${conflict.extensionName} (${conflict.extensionId}) binds ` +
        `${conflict.command} -- it ${conflict.summary}`),
    'VS Code breaks that tie by extension load order, which is not stable',
    'between reloads. A user keybinding beats every extension binding; paste',
    'this inside the outer [ ] of keybindings.json, or run the command',
    'Evalens: Fix Keybinding Conflict to be handed it:',
    keybindingSnippet(platform, conflicts),
  ].join('\n');
}
