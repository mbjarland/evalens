import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  KNOWN_CONFLICTS, advanceEntries, detectConflicts, keybindingSnippet,
} from '../keybindings';

const root = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

/** The text under one `## ` heading, up to the next one. */
function section(heading: string): string {
  const start = readme.indexOf(`## ${heading}\n`);
  assert.notEqual(start, -1, `README has no "## ${heading}" section`);
  const rest = readme.slice(start + heading.length + 4);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}

test('every contributed command is in the README', () => {
  // A command nobody can find is a command that does not exist, and the
  // palette is the fallback for a user whose keybinding was stolen.
  const titles: string[] =
    (manifest.contributes?.commands ?? []).map((c: { title: string }) => c.title);
  assert.ok(titles.length > 0, 'no commands contributed');

  for (const title of titles) {
    assert.ok(readme.includes(title), `${title} is not in the README`);
  }
});

test('the README says every command is in the Command Palette', () => {
  assert.match(readme, /Command Palette/);
});

test('no bare Cmd+ chord above Keybindings: every one names Ctrl too', () => {
  // #117: the README used to teach Cmd+Enter as though every reader had a
  // Mac, with a "read Ctrl for Cmd" footnote a beginner never reaches. A
  // Windows or Linux reader must see the chord that exists on their own
  // keyboard, Windows/Linux first, everywhere above the reference table.
  // Table rows pair by column instead of by wording, so they are excluded.
  const idx = readme.indexOf('## Keybindings');
  assert.notEqual(idx, -1, 'README has no "## Keybindings" heading');
  const prose = readme
    .slice(0, idx)
    .split('\n')
    .filter((line) => !line.trim().startsWith('|'))
    .join('\n')
    // Bold markers and line-wrap whitespace are layout, not content: a key
    // bolded for emphasis or a phrase reflowed onto two lines is still
    // paired, so both are normalised away before the check below.
    .replace(/\*\*/g, '');

  const everyMac = prose.match(/`Cmd\+[A-Za-z+]+`/g) ?? [];
  const paired = prose.match(
    /`Ctrl\+([A-Za-z+]+)`\s*\(`Cmd\+\1`\s+on\s+a\s+Mac\)/g) ?? [];
  assert.equal(everyMac.length, paired.length,
    'expected every `Cmd+...` above Keybindings to read `Ctrl+X` ' +
    `(\`Cmd+X\` on a Mac); found ${everyMac.length} Cmd+ chord(s) but only ` +
    `${paired.length} paired that way`);
});

test('the four-key table teaches Windows/Linux keys first', () => {
  // The larger audience reads first, and a macOS reader is already used to
  // translating a chord; a Windows or Linux reader is not. This table is
  // the one a screenshot of the README lands on, so the column order and
  // the Windows/Linux-only Alt+Enter alternative must not regress silently.
  const fourKeys = section('Learn it in four keys');
  assert.ok(
    fourKeys.indexOf('Windows / Linux') < fourKeys.indexOf('macOS'),
    'the four-key table should list Windows / Linux before macOS');
  assert.match(fourKeys, /`Ctrl\+Enter` or `Alt\+Enter`/);
});

test('the keybinding conflict is stated next to the table, not footnoted', () => {
  // The whole failure mode is a silently dead key. A user who reads the
  // keybinding table and stops reading has to have been told there already;
  // a troubleshooting section at the bottom is read after the damage.
  const keybindings = section('Keybindings');

  for (const conflict of KNOWN_CONFLICTS) {
    assert.ok(keybindings.includes(conflict.extensionId),
      `${conflict.extensionId} is not named in the keybindings section`);
    assert.ok(keybindings.includes(conflict.command),
      `${conflict.command} is not named in the keybindings section`);
  }
  assert.match(keybindings, /load order/);
});

test('the README shows the fix the extension hands out, verbatim', () => {
  // Two copies of a JSON snippet drift, and the one in the README is the copy
  // people paste. This fails the build instead.
  const snippet = keybindingSnippet(
    'mac', detectConflicts((id) => id === 'almenon.arepl', 'mac'));
  assert.ok(readme.includes(snippet),
    'the README keybinding block is not what keybindingSnippet produces');
});

test('the README documents the key the manifest actually binds', () => {
  const keybindings = section('Keybindings');
  assert.match(keybindings, /Cmd\+Enter/);
  assert.match(keybindings, /Ctrl\+Enter/);
  assert.match(keybindings, /Cmd\+Shift\+Enter/);
  assert.match(keybindings, /Ctrl\+Shift\+Enter/);
});

test('the README says why the advance key is not shift+enter', () => {
  // The convention says shift+enter, so a reader who knows the neighbourhood
  // will assume we simply got it wrong. The four commands already sitting
  // there are the answer, and they belong beside the table rather than in a
  // commit message nobody reads.
  const keybindings = section('Keybindings');
  assert.match(keybindings, /Shift\+Enter/);
  for (const command of [
    'python.execSelectionInTerminal', 'python.execInREPL',
    'jupyter.execSelectionInteractive', 'jupyter.runcurrentcelladvance',
  ]) {
    assert.ok(keybindings.includes(command),
      `${command} is not named as a claimant of shift+enter`);
  }
});

test('the README shows the user binding that settles the advance key', () => {
  // Windows and Linux get what #45 gave AREPL: the fix stated where the
  // conflict is, in a form that can be pasted. Built from the same constants
  // the manifest is checked against, so the block cannot drift from the key,
  // the command or the context.
  for (const entry of advanceEntries('other')) {
    const json = JSON.stringify(entry, null, 2)
      .split('\n').map((line) => `  ${line}`).join('\n');
    assert.ok(readme.includes(json),
      `the README does not show this entry verbatim:\n${json}`);
  }
});

test('the keybinding section says an install revokes an isDevelopment scope', () => {
  // A user keybinding scoped to the Extension Development Host was the right
  // fix while that was the only window Evalens existed in. Installing the
  // .vsix silently inverts it: `isDevelopment` is false in an ordinary
  // window, so the scope now excludes every window the extension runs in and
  // AREPL takes the key back. The symptom is the same dead key as before,
  // which is why it has to be said next to the conflict rather than found.
  const keybindings = section('Keybindings');
  assert.match(keybindings, /isDevelopment/);
  assert.match(keybindings, /not to install AREPL/);
});

test('the requirement is one interpreter, said before the install steps', () => {
  // "Python and nothing else" is the advantage over every alternative here,
  // and it is only an advantage if an installer reads it. Buried under the
  // settings table it is a footnote.
  const requirements = section('Requirements');
  assert.match(requirements, /Python 3\.9 or later/);
  assert.ok(readme.indexOf('## Requirements') < readme.indexOf('## Install'),
    'the requirement is stated after the install steps it governs');
});

test('the install section hands over a command that installs', () => {
  const install = section('Install');
  assert.match(install, /npm run package/);
  assert.match(install, /code --install-extension/);
});

test('every setting is in the README with its default', () => {
  // The settings UI is the primary place to read these and the README is the
  // one someone browsing the repository finds first. A setting in one and not
  // the other is a setting half the audience does not know exists.
  const settings = section('Settings');
  const properties = manifest.contributes?.configuration?.properties ?? {};
  assert.ok(Object.keys(properties).length > 0, 'no settings contributed');

  for (const [id, setting] of Object.entries(properties)) {
    assert.ok(settings.includes(`\`${id}\``),
      `${id} is not in the README settings table`);
    const shown = JSON.stringify((setting as { default: unknown }).default);
    assert.ok(settings.includes(`\`${shown}\``),
      `${id}'s default (${shown}) is not shown in the README`);
  }
});

test('every theme colour is documented as overridable', () => {
  // Contributing a colour makes it overridable through
  // `workbench.colorCustomizations` -- and a user who dislikes the gold has
  // no way to discover a one-line fix nobody wrote down. Naming every id in a
  // block they can paste is the difference between "themeable" as a fact and
  // as something anyone acts on.
  const settings = section('Settings');
  assert.match(settings, /workbench\.colorCustomizations/);

  for (const color of manifest.contributes?.colors ?? []) {
    assert.ok(settings.includes(color.id),
      `${color.id} is contributed but not documented as overridable`);
  }
});

test('the README says the keybindings are not a setting', () => {
  // The audit's first deliberate omission, recorded where a reader looking for
  // it will be -- otherwise its absence reads as an oversight and the next
  // person adds it.
  assert.match(section('Settings'), /no setting for the keybindings/i);
});

test('the README says what else was considered and declined', () => {
  // An audit is only worth as much as its declines, and those rot fastest:
  // this one was written before printed output, Evaluate and Advance and the
  // partial-parse fallback landed, and each of them added something a reader
  // could reasonably expect a switch for. The section is what stops the next
  // feature arriving with no opinion attached.
  const settings = section('Settings');
  assert.match(settings, /### What is deliberately not a setting/);

  for (const [subject, pattern] of [
    ['printed output', /printed output/i],
    ['the partial-parse caveat', /partial: line/],
    ['where Evaluate and Advance stops', /Evaluate and Advance\*\* stops/],
  ] as ReadonlyArray<readonly [string, RegExp]>) {
    assert.match(settings, pattern,
      `the settings section has no opinion about ${subject}`);
  }
});
