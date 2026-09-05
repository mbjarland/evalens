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
 * `evaluateAtCursor` answers on two keys, and the second is not a fallback.
 * The command resolves the enclosing *top-level* statement, and alt+enter is
 * the key Calva puts the top-level form on -- `betterthantomorrow.calva`
 * ships `alt+enter` for `calva.evaluateCurrentTopLevelForm` in its own
 * manifest. So the binding is what the semantics already said it was. It also
 * leaves ctrl+enter free for the inner-form command when that lands, which is
 * the other half of the same split.
 *
 * What it is not is an escape from the collision. A scan of the shipped
 * manifests found AREPL on alt+enter as well, under the same `when` clause,
 * so the second key is tied exactly like the first. Two defaults are still
 * two defaults; only a user keybinding decides either of them.
 *
 * No `vscode` import: which key applies on which platform, and the JSON that
 * says so, are decidable without an editor.
 */

export type Platform = 'mac' | 'other';

/** The command the collision costs us, and the reason this file exists. */
export const EVALUATE_AT_CURSOR = 'evalens.evaluateAtCursor';

/** Evaluate, then step to the next top-level statement. */
export const EVALUATE_AND_ADVANCE = 'evalens.evaluateAndAdvance';

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

/**
 * The other key it answers on: Calva's key for the top-level form, which is
 * what `evaluateAtCursor` resolves. Platform-neutral -- `alt` is `alt` on
 * every platform, so unlike the key above there is nothing to branch on.
 */
export const TOP_LEVEL_KEY = 'alt+enter';

/**
 * Both keys, in the order the manifest and the offered fix list them: the one
 * whose loss started this, then the one the semantics always implied.
 */
export function evaluateKeys(platform: Platform): readonly string[] {
  return [evaluateKey(platform), TOP_LEVEL_KEY];
}

/**
 * The key `evalens.evaluateAndAdvance` answers on.
 *
 * `shift+enter` is what the convention wants -- it is run-and-advance in
 * Jupyter, Spyder, MATLAB and VS Code's own Interactive Window -- and it is
 * unusable. In a Python file it is claimed four times over:
 * `python.execSelectionInTerminal`, `python.execInREPL`,
 * `jupyter.execSelectionInteractive` and `jupyter.runcurrentcelladvance`.
 * Taking it would reproduce the AREPL defect exactly: a tie between extension
 * bindings, broken by load order, dead or alive depending on nothing the user
 * can see.
 *
 * `cmd+shift+enter` is claimed by no extension of the sixty-one measured. VS
 * Code's own `editor.action.insertLineBefore` holds it as a core default,
 * which an extension binding outranks -- a core default is not a tie.
 * `ctrl+shift+enter` is a different matter, and the table below says so.
 */
export function advanceKey(platform: Platform): string {
  return platform === 'mac' ? 'cmd+shift+enter' : 'ctrl+shift+enter';
}

export interface KnownConflict {
  readonly extensionId: string;
  readonly extensionName: string;
  /** The command that answers instead of ours when the other side wins. */
  readonly command: string;
  /**
   * The key that binding takes, as each platform resolves it. Stored rather
   * than derived from `evaluateKey`, because a conflict is a fact about
   * somebody else's manifest: AREPL's second binding sits on alt+enter on
   * every platform, and deriving the key from ours would have hidden it.
   */
  readonly key: Readonly<Record<Platform, string>>;
  /**
   * That binding's `when` clause, as the other extension ships it -- absent
   * when it ships none.
   *
   * Absent is not the same as empty, and modelling it as a string would have
   * lost the distinction: a binding with no `when` matches unconditionally,
   * everywhere, and the removal that cancels it must carry no `when` either.
   * `jupyter.runAndDebugCell` is that shape.
   */
  readonly when?: string;
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
 * Guessing is what made this table wrong once already: it recorded AREPL on
 * ctrl/cmd+enter and stopped there, and a later scan of the same manifest
 * found a second binding, `extension.printDir` on alt+enter, under a `when`
 * clause identical to the first. That omission is why alt+enter was believed
 * uncontested. Both of AREPL's bindings are listed here now, and a conflict
 * carries the key it takes rather than inheriting ours.
 *
 * Jupyter is listed and documented but not notified about, on three rows now.
 * `runcurrentcell` on ctrl+enter and `runcurrentcellandaddbelow` on alt+enter
 * bite only inside a file with `# %%` cells -- the second with no `mac`
 * override, which means the `key` field applies on macOS too rather than being
 * absent there -- and a notification most users cannot act on is how an
 * extension teaches people to dismiss the one that matters. `runAndDebugCell`
 * on ctrl+shift+enter is a stronger conflict than either: no `when` clause at
 * all, so it is live in any file on Windows and Linux. It stays silent anyway,
 * for a different reason. It costs the *second* command rather than the
 * primary interaction, Jupyter is installed on a large share of Python setups,
 * and the notification's own wording is about Evaluate at Cursor. The README
 * carries its fix instead, beside the keybinding table where it is read before
 * the damage rather than after it.
 */
export const KNOWN_CONFLICTS: readonly KnownConflict[] = [
  {
    extensionId: 'almenon.arepl',
    extensionName: 'AREPL',
    command: 'extension.executeAREPLBlock',
    key: { mac: 'cmd+enter', other: 'ctrl+enter' },
    when: 'editorTextFocus && editorLangId == python',
    platforms: ['mac', 'other'],
    notify: true,
    summary:
      'sits on the same key under the same condition, on every platform',
  },
  {
    extensionId: 'almenon.arepl',
    extensionName: 'AREPL',
    command: 'extension.printDir',
    key: { mac: 'alt+enter', other: 'alt+enter' },
    when: 'editorTextFocus && editorLangId == python',
    platforms: ['mac', 'other'],
    notify: true,
    summary:
      'takes alt+enter under that same condition too, so the top-level key ' +
      'is tied exactly like the other one',
  },
  {
    extensionId: 'ms-toolsai.jupyter',
    extensionName: 'Jupyter',
    command: 'jupyter.runcurrentcell',
    key: { mac: 'ctrl+enter', other: 'ctrl+enter' },
    when:
      'editorTextFocus && !editorHasSelection && jupyter.hascodecells && ' +
      '!notebookEditorFocused && !isCompositeNotebook',
    platforms: ['other'],
    notify: false,
    summary:
      'binds ctrl+enter to Run Current Cell, so it overlaps on Windows and ' +
      'Linux, and only in a file that has `# %%` cells',
  },
  {
    extensionId: 'ms-toolsai.jupyter',
    extensionName: 'Jupyter',
    command: 'jupyter.runcurrentcellandaddbelow',
    key: { mac: 'alt+enter', other: 'alt+enter' },
    when:
      'editorTextFocus && !editorHasSelection && jupyter.hascodecells && ' +
      '!notebookEditorFocused',
    platforms: ['mac', 'other'],
    notify: false,
    summary:
      'binds alt+enter with no `mac` override, so it overlaps on every ' +
      'platform, and only in a file that has `# %%` cells',
  },
  {
    extensionId: 'ms-toolsai.jupyter',
    extensionName: 'Jupyter',
    command: 'jupyter.runAndDebugCell',
    key: { mac: 'ctrl+shift+enter', other: 'ctrl+shift+enter' },
    // No `when` at all, which is the whole point of this row: unlike the two
    // above it is not gated on `# %%` cells, so it is live in an ordinary
    // Python file -- and in every other editor in the window.
    platforms: ['other'],
    notify: false,
    summary:
      'takes ctrl+shift+enter with no `when` clause at all, so on Windows ' +
      'and Linux it matches unconditionally rather than only in a file with ' +
      '`# %%` cells',
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
  /** Absent when the binding being cancelled carries no `when` of its own. */
  readonly when?: string;
}

/**
 * The entry that cancels one other extension's binding.
 *
 * On that binding's own key and its own `when`, not ours: a removal is aimed
 * at somebody else's manifest, and a removal written against our context
 * removes nothing.
 */
function removal(
  conflict: KnownConflict, platform: Platform
): KeybindingEntry {
  return {
    key: conflict.key[platform],
    command: `-${conflict.command}`,
    ...(conflict.when === undefined ? {} : { when: conflict.when }),
  };
}

/** The known conflicts that land on `key` on this platform. */
function conflictsOn(
  key: string, platform: Platform
): readonly KnownConflict[] {
  return KNOWN_CONFLICTS.filter(
    (conflict) => conflict.platforms.includes(platform)
      && conflict.key[platform] === key);
}

/**
 * The user keybindings that settle a set of conflicts.
 *
 * Both of our keys are claimed, so both are bound. The removals after them
 * are not redundant: ours only wins where its `when` holds, so AREPL would
 * still answer with the find widget open -- a dead key in a different
 * disguise. Each removal names the key its own binding sits on, which is what
 * lets one call cover a conflict on cmd+enter and a conflict on alt+enter.
 */
export function keybindingEntries(
  platform: Platform,
  conflicts: readonly KnownConflict[] = []
): readonly KeybindingEntry[] {
  return [
    ...evaluateKeys(platform).map((key) => ({
      key,
      command: EVALUATE_AT_CURSOR,
      when: EVALUATE_WHEN,
    })),
    ...conflicts.map((conflict) => removal(conflict, platform)),
  ];
}

/**
 * The user keybinding that settles the advance key, where anything contests it.
 *
 * Separate from the pair above because the conflict is: nothing claims
 * `cmd+shift+enter` on macOS, so there it is one entry restating the default,
 * while on Windows and Linux `jupyter.runAndDebugCell` sits on
 * `ctrl+shift+enter` with no `when` clause and the removal is the half that
 * matters. This is the same answer #45 arrived at for AREPL -- a user
 * keybinding is resolved after every extension's, so it is the only thing that
 * settles a tie deterministically.
 */
export function advanceEntries(platform: Platform): readonly KeybindingEntry[] {
  return [
    {
      key: advanceKey(platform),
      command: EVALUATE_AND_ADVANCE,
      when: EVALUATE_WHEN,
    },
    ...conflictsOn(advanceKey(platform), platform)
      .map((conflict) => removal(conflict, platform)),
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
  const entries = keybindingEntries(platform, conflicts);
  const mine = evaluateKeys(platform).length;
  const blocks = entries.map((entry, index) => {
    const comment = index === 0
      ? [
        '// Evalens: a user keybinding is resolved after every extension\'s,',
        '// so this one wins the key whichever extension loaded last.',
      ]
      : index < mine
        ? [
          '// The same command on the top-level-form key, which is where',
          '// Calva puts it. Uncontested by VS Code itself; not by AREPL.',
        ]
        : (() => {
          // Named per removal rather than "the same key": with one extension
          // on both keys the generic wording repeats verbatim, and a user
          // deciding which line to delete cannot tell them apart.
          const conflict = conflicts[index - mine];
          return [
            `// Removes ${conflict.extensionName}'s ${conflict.command} from ` +
            `${entry.key}. Delete this`,
            '// entry to keep it -- the one above already wins where both apply.',
          ];
        })();
    return indent([...comment, JSON.stringify(entry, null, 2)].join('\n'));
  });
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

/** A list joined for prose, with each name said once. */
function names(values: readonly string[]): string {
  return [...new Set(values)].join(' and ');
}

/**
 * The notification: what is wrong, and that it is fixable.
 *
 * One extension taking both keys is one problem, not two, so the names are
 * deduplicated -- "AREPL and AREPL binds" is how a user learns the warning is
 * machine-generated and stops reading it. The keys are listed instead,
 * because which of them is dead is the thing they are about to check.
 */
export function conflictMessage(
  conflicts: readonly KnownConflict[],
  platform: Platform
): string {
  const who = names(conflicts.map((each) => each.extensionName));
  const keys = names(conflicts.map((each) => each.key[platform]));
  return `${who} also binds ${keys} for Python, and VS ` +
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
    `keybinding conflict on ${names(conflicts.map((c) => c.key[platform]))}:`,
    ...conflicts.map(
      (conflict) =>
        `  ${conflict.extensionName} (${conflict.extensionId}) binds ` +
        `${conflict.command} on ${conflict.key[platform]} -- it ` +
        `${conflict.summary}`),
    'VS Code breaks that tie by extension load order, which is not stable',
    'between reloads. A user keybinding beats every extension binding; paste',
    'this inside the outer [ ] of keybindings.json, or run the command',
    'Evalens: Fix Keybinding Conflict to be handed it:',
    keybindingSnippet(platform, conflicts),
  ].join('\n');
}
