import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EVALUATE_AND_ADVANCE, EVALUATE_AT_CURSOR, EVALUATE_WHEN, KNOWN_CONFLICTS,
  KnownConflict, TOP_LEVEL_KEY, advanceEntries, advanceKey, conflictMessage,
  describeConflicts, detectConflicts, evaluateKey, evaluateKeys,
  keybindingEntries, keybindingSnippet, keybindingsQuery, platformOf,
} from '../keybindings';

const AREPL = 'almenon.arepl';
const JUPYTER = 'ms-toolsai.jupyter';

const conflictsIn = (id: string) =>
  KNOWN_CONFLICTS.filter((c) => c.extensionId === id);
const conflictOn = (id: string, command: string) =>
  KNOWN_CONFLICTS.find((c) => c.extensionId === id && c.command === command);

const only = (...ids: string[]) => (id: string) => ids.includes(id);
const nothing = () => false;

/** The snippet is JSON with comments; strip them and it must still parse. */
function parseSnippet(snippet: string): unknown {
  const withoutComments = snippet
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  return JSON.parse(`[${withoutComments}]`);
}

test('the platform is decided by process.platform, not by guessing', () => {
  assert.equal(platformOf('darwin'), 'mac');
  assert.equal(platformOf('win32'), 'other');
  assert.equal(platformOf('linux'), 'other');
  assert.equal(platformOf('freebsd'), 'other');
});

test('the key is cmd+enter on macOS and ctrl+enter everywhere else', () => {
  assert.equal(evaluateKey('mac'), 'cmd+enter');
  assert.equal(evaluateKey('other'), 'ctrl+enter');
});

test('alt+enter is the second key, and the same one on every platform', () => {
  // `evaluateAtCursor` resolves the enclosing top-level statement, and Calva
  // puts the top-level form on alt+enter. `alt` needs no platform branch.
  assert.equal(TOP_LEVEL_KEY, 'alt+enter');
  assert.deepEqual(evaluateKeys('mac'), ['cmd+enter', 'alt+enter']);
  assert.deepEqual(evaluateKeys('other'), ['ctrl+enter', 'alt+enter']);
});

test('AREPL is detected on both platforms when it is installed', () => {
  for (const platform of ['mac', 'other'] as const) {
    const found = detectConflicts(only(AREPL), platform);
    assert.equal(found.length, 2, `expected both AREPL bindings on ${platform}`);
    assert.ok(found.every((c) => c.extensionId === AREPL));
  }
});

test('AREPL takes both of our keys, not just the first one', () => {
  // The belief that it took only ctrl/cmd+enter is what made alt+enter look
  // uncontested. Its manifest binds `extension.printDir` on alt+enter under a
  // `when` clause identical to the other binding's, on every platform.
  const printDir = conflictOn(AREPL, 'extension.printDir');
  assert.ok(printDir, 'AREPL\'s alt+enter binding must stay in the table');
  assert.equal(printDir.key.mac, TOP_LEVEL_KEY);
  assert.equal(printDir.key.other, TOP_LEVEL_KEY);
  assert.deepEqual(printDir.platforms, ['mac', 'other']);

  const block = conflictOn(AREPL, 'extension.executeAREPLBlock');
  assert.equal(printDir.when, block?.when,
    'both AREPL bindings ship the same when clause');
});

test('nothing is reported on a machine without the conflicting extension', () => {
  assert.deepEqual(detectConflicts(nothing, 'mac'), []);
  assert.deepEqual(detectConflicts(nothing, 'other'), []);
});

test('Jupyter is documented but never notified about', () => {
  // Its overlap is real, and the README says so. It bites only inside a file
  // with `# %%` cells, though, and Jupyter is installed on a large share of
  // Python setups -- a notification most of them cannot act on is how users
  // learn to dismiss the one that matters.
  const jupyter = conflictsIn(JUPYTER);
  assert.ok(jupyter.length > 0, 'Jupyter must stay in the table for the README');
  assert.ok(jupyter.every((c) => c.notify === false));
  assert.deepEqual(detectConflicts(only(JUPYTER), 'other'), []);
  assert.deepEqual(detectConflicts(only(JUPYTER), 'mac'), []);
  assert.equal(detectConflicts(only(JUPYTER, AREPL), 'other').length, 2);
});

test('Jupyter\'s ctrl+enter binding overlaps only off macOS', () => {
  // That one ships no `mac` override, and `ctrl` stays `ctrl` on macOS -- so
  // there it sits on ctrl+enter while we sit on cmd+enter, and the two never
  // meet.
  const runCell = conflictOn(JUPYTER, 'jupyter.runcurrentcell');
  assert.deepEqual(runCell?.platforms, ['other']);
  assert.equal(runCell?.key.other, 'ctrl+enter');
});

test('Jupyter\'s alt+enter binding overlaps on macOS as well', () => {
  // The same missing `mac` override reads the opposite way here: `key` is the
  // cross-platform default, so a binding with no override applies on macOS
  // rather than being absent there. Reading that absence as "does not apply on
  // macOS" is how alt+enter came to look free.
  const addBelow = conflictOn(JUPYTER, 'jupyter.runcurrentcellandaddbelow');
  assert.ok(addBelow, 'Jupyter\'s alt+enter binding must be in the table');
  assert.deepEqual(addBelow.platforms, ['mac', 'other']);
  assert.equal(addBelow.key.mac, TOP_LEVEL_KEY);
  assert.ok(addBelow.when, 'this one does ship a when clause');
  assert.match(addBelow.when, /jupyter\.hascodecells/);
});

test('the fix binds our command on both keys, in the manifest context', () => {
  // Both keys are contested, so binding only the first leaves the second as a
  // dead key of exactly the kind this file exists to stop.
  assert.deepEqual(keybindingEntries('mac'), [
    { key: 'cmd+enter', command: EVALUATE_AT_CURSOR, when: EVALUATE_WHEN },
    { key: 'alt+enter', command: EVALUATE_AT_CURSOR, when: EVALUATE_WHEN },
  ]);
  assert.deepEqual(keybindingEntries('other').map((e) => e.key),
    ['ctrl+enter', 'alt+enter']);
});

test('each conflict also gets a removal entry, on that binding\'s own when', () => {
  // Ours only wins where its `when` holds, so without the removal AREPL still
  // answers with the find widget open -- a dead key in a different disguise.
  const conflicts = detectConflicts(only(AREPL), 'mac');
  const entries = keybindingEntries('mac', conflicts);
  const removals = entries.slice(evaluateKeys('mac').length);

  assert.equal(entries.length, 4);
  assert.deepEqual(removals, [
    {
      key: 'cmd+enter',
      command: '-extension.executeAREPLBlock',
      when: 'editorTextFocus && editorLangId == python',
    },
    {
      key: 'alt+enter',
      command: '-extension.printDir',
      when: 'editorTextFocus && editorLangId == python',
    },
  ]);
  assert.ok(removals.every((e) => e.when !== EVALUATE_WHEN));
});

test('a removal sits on its own key, not on whatever ours is', () => {
  // The removal key used to be inherited from `evaluateKey`, which silently
  // put a `-extension.printDir` entry on cmd+enter -- removing nothing, and
  // leaving alt+enter answering AREPL.
  const printDir = conflictOn(AREPL, 'extension.printDir');
  assert.ok(printDir);
  for (const platform of ['mac', 'other'] as const) {
    const [removal] = keybindingEntries(platform, [printDir])
      .slice(evaluateKeys(platform).length);
    assert.equal(removal.key, TOP_LEVEL_KEY);
    assert.notEqual(removal.key, evaluateKey(platform));
  }
});

test('the snippet is what those entries say, once its comments are stripped', () => {
  const conflicts = detectConflicts(only(AREPL), 'other');
  const snippet = keybindingSnippet('other', conflicts);

  assert.deepEqual(parseSnippet(snippet), keybindingEntries('other', conflicts));
});

test('the snippet parses with no conflicts detected at all', () => {
  // The palette command hands it out on any machine, including one whose key
  // was taken by an extension nobody here has heard of.
  assert.deepEqual(parseSnippet(keybindingSnippet('mac')), keybindingEntries('mac'));
});

test('the snippet names what each removal removes', () => {
  // A user is about to paste this into their own file. A line saying which
  // extension loses which key, and that deleting the line undoes it, is the
  // difference between explicit and merely reversible. With one extension on
  // both keys, "the same key" repeats word for word and names neither.
  const snippet = keybindingSnippet('mac', detectConflicts(only(AREPL), 'mac'));
  const prose = snippet.replace(/\n\s*\/\/ /g, ' ');
  assert.match(prose, /AREPL's extension\.executeAREPLBlock from cmd\+enter/);
  assert.match(prose, /AREPL's extension\.printDir from alt\+enter/);
  assert.match(prose, /Delete this entry to keep it/);
});

test('the advance key is shift+enter with a modifier, never shift+enter', () => {
  // shift+enter is the convention -- Jupyter, Spyder, MATLAB and the
  // Interactive Window all put run-and-advance there -- and it is claimed four
  // times over in a Python file, so it would be a dead key decided by load
  // order. cmd+shift+enter is claimed by no extension of the sixty-one
  // measured, and VS Code's own default on it is a core binding, which an
  // extension binding outranks.
  assert.equal(advanceKey('mac'), 'cmd+shift+enter');
  assert.equal(advanceKey('other'), 'ctrl+shift+enter');
  assert.notEqual(advanceKey('mac'), 'shift+enter');
  assert.notEqual(advanceKey('other'), 'shift+enter');
});

test('Jupyter contests the advance key off macOS, with no when clause', () => {
  // The reason this row is here at all. Its two siblings bite only in a file
  // with `# %%` cells; this one ships no `when` whatsoever, so on Windows and
  // Linux it matches in every editor and every file.
  const runAndDebug = conflictOn(JUPYTER, 'jupyter.runAndDebugCell');
  assert.ok(runAndDebug, 'the ctrl+shift+enter conflict must be in the table');
  assert.equal(runAndDebug.when, undefined,
    'an empty when is not the same as none, and this binding has none');
  assert.deepEqual(runAndDebug.platforms, ['other']);
  assert.equal(runAndDebug.key.other, advanceKey('other'));
  // On macOS ours is cmd+shift+enter and this stays ctrl+shift+enter, so the
  // two never meet -- the same reading as jupyter.runcurrentcell.
  assert.notEqual(runAndDebug.key.mac, advanceKey('mac'));
});

test('the advance fix binds our command, and removes what contests it', () => {
  assert.deepEqual(advanceEntries('other'), [
    {
      key: 'ctrl+shift+enter',
      command: EVALUATE_AND_ADVANCE,
      when: EVALUATE_WHEN,
    },
    // No `when`, because the binding it cancels has none: a removal only
    // cancels a binding it matches exactly, and inventing a context here would
    // leave the real one answering.
    { key: 'ctrl+shift+enter', command: '-jupyter.runAndDebugCell' },
  ]);
});

test('on macOS the advance fix is one entry, because nothing contests it', () => {
  assert.deepEqual(advanceEntries('mac'), [
    {
      key: 'cmd+shift+enter',
      command: EVALUATE_AND_ADVANCE,
      when: EVALUATE_WHEN,
    },
  ]);
});

test('the keybindings query filters that editor to our key', () => {
  // `@keybinding:` is a filter the keybindings editor implements, so this
  // opens on the conflict rather than on a search box.
  assert.equal(keybindingsQuery('mac'), '@keybinding:cmd+enter');
  assert.equal(keybindingsQuery('other'), '@keybinding:ctrl+enter');
});

test('the notification names the extension, both keys, and the command', () => {
  const message = conflictMessage(detectConflicts(only(AREPL), 'mac'), 'mac');
  assert.match(message, /AREPL/);
  assert.match(message, /cmd\+enter/);
  assert.match(message, /alt\+enter/);
  assert.match(message, /Evaluate at Cursor/);
});

test('one extension taking both keys is named once, not twice', () => {
  // "AREPL and AREPL binds" is how a user learns a warning is generated and
  // stops reading it.
  const message = conflictMessage(detectConflicts(only(AREPL), 'mac'), 'mac');
  assert.equal(message.match(/AREPL/g)?.length, 1);
});

test('two conflicts are named together rather than in two notifications', () => {
  const both: KnownConflict[] = [
    { ...conflictOn(AREPL, 'extension.executeAREPLBlock')! },
    { ...conflictOn(JUPYTER, 'jupyter.runcurrentcell')!, notify: true },
  ];
  assert.match(conflictMessage(both, 'other'), /AREPL and Jupyter/);
});

test('the log line carries the identity, the reason, and the whole fix', () => {
  // The notification shows once ever; this is the way back for a user who
  // dismissed it, and the log line whose absence made the bug take three
  // rounds of diagnosis to find.
  const conflicts = detectConflicts(only(AREPL), 'mac');
  const log = describeConflicts(conflicts, 'mac');

  assert.match(log, /almenon\.arepl/);
  assert.match(log, /extension\.executeAREPLBlock on cmd\+enter/);
  assert.match(log, /extension\.printDir on alt\+enter/);
  assert.match(log, /load order/);
  assert.ok(log.includes(keybindingSnippet('mac', conflicts)),
    'the log must contain the fix, not a pointer to it');
});
