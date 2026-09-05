import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

interface Setting {
  readonly type: string;
  readonly default: unknown;
  readonly scope?: string;
  readonly markdownDescription?: string;
  readonly minimum?: number;
  readonly maximum?: number;
}

const properties: Record<string, Setting> =
  manifest.contributes?.configuration?.properties ?? {};
const settings = Object.entries(properties);

const configSource = fs.readFileSync(
  path.join(root, 'src', 'config.ts'), 'utf8');

test('there are settings to check', () => {
  assert.ok(settings.length > 0, 'no configuration contributed');
});

test('every setting id is the same shape', () => {
  // `pythonPath`, `alignColumn` and `progressDelay` were three instincts:
  // two noun phrases and one imperative. The shape settled on is a camelCase
  // noun phrase naming the thing configured, subject first -- so the settings
  // UI, which sorts alphabetically, files everything about loops together and
  // everything about names together. `alignColumn` became `resultColumn` for
  // exactly that reason.
  for (const [id] of settings) {
    assert.match(id, /^evalens\.[a-z][a-zA-Z]+$/,
      `${id} is not evalens.<lowerCamelCase>`);
  }
});

test('every setting declares a scope, and never resource', () => {
  // A scope has to be chosen rather than defaulted into, and `resource` would
  // be a lie here: every read in config.ts is getConfiguration('evalens')
  // with no resource, which resolves at window level. Contributing at
  // `resource` scope would let a value be set per folder and then have no
  // effect there, silently, which is worse than not offering it.
  for (const [id, setting] of settings) {
    assert.ok(setting.scope, `${id} declares no scope`);
    assert.ok(['application', 'window'].includes(setting.scope!),
      `${id} has scope ${setting.scope}; nothing here is read per resource`);
  }
});

test('every description says what the option costs', () => {
  // "Names annotated per line" tells a reader what the field is called, which
  // they can already see. What they cannot see is what they give up by
  // raising it. A description that does that does not fit in a label, so
  // length is a crude but honest proxy for having written one.
  for (const [id, setting] of settings) {
    assert.ok(setting.markdownDescription,
      `${id} has no markdownDescription`);
    assert.ok(setting.markdownDescription!.length > 120,
      `${id} reads as a label rather than a description of what it costs`);
  }
});

test('every number setting is bounded at both ends', () => {
  // Unbounded, the settings UI is a text box that accepts anything, and the
  // out-of-range values are the ones with consequences: a loop asked to keep
  // ten thousand iterations keeps ten thousand strings and puts them all on
  // one wire line.
  for (const [id, setting] of settings) {
    if (setting.type !== 'number') {
      continue;
    }
    assert.equal(typeof setting.minimum, 'number', `${id} has no minimum`);
    assert.equal(typeof setting.maximum, 'number', `${id} has no maximum`);
  }
});

test('no setting re-implements something VS Code already does', () => {
  // Keybindings are natively rebindable and Evalens hands out the JSON to do
  // it. An `evalens.keybinding` would be a worse version of an editor
  // feature, and worse in the specific way that matters: it could not win the
  // load-order tie that a user keybinding wins.
  for (const [id] of settings) {
    assert.doesNotMatch(id, /key(binding|board)|shortcut/i,
      `${id} duplicates a feature the editor already has`);
  }
});

test('config.ts is the only module that reads a setting', () => {
  // Two defaults for one setting is the drift this test exists to stop, and
  // it had already happened: package.json said alignColumn was 0 while
  // decorations.ts asked for it with a fallback of 80.
  const others = fs.readdirSync(path.join(root, 'src'), { recursive: true })
    .filter((f): f is string => typeof f === 'string' && f.endsWith('.ts'))
    .filter((f) => f !== 'config.ts' && !f.startsWith('test'));

  for (const file of others) {
    const source = fs.readFileSync(path.join(root, 'src', file), 'utf8');
    assert.doesNotMatch(source, /getConfiguration\('evalens'\)/,
      `${file} reads a setting directly; go through config.ts`);
  }
});

/** The fallback each `config.get` call site passes, by setting name. */
function fallbacks(): Map<string, unknown> {
  const found = new Map<string, unknown>();
  const pattern = /\.get<\w+>\(\s*'([A-Za-z]+)',\s*([^)]+?)\s*\)/g;
  for (const match of configSource.matchAll(pattern)) {
    const [, name, literal] = match;
    let value: unknown;
    if (literal === 'true' || literal === 'false') {
      value = literal === 'true';
    } else if (/^'.*'$/.test(literal!)) {
      value = literal!.slice(1, -1);
    } else {
      value = Number(literal);
    }
    found.set(name!, value);
  }
  return found;
}

test('the fallback in the code is the default in the manifest', () => {
  const found = fallbacks();
  assert.equal(found.size, settings.length,
    'config.ts reads a different number of settings than the manifest declares');

  for (const [id, setting] of settings) {
    const name = id.slice('evalens.'.length);
    assert.ok(found.has(name), `${id} is contributed but never read`);
    assert.deepEqual(found.get(name), setting.default,
      `${id} defaults to ${JSON.stringify(setting.default)} in the manifest ` +
      `and ${JSON.stringify(found.get(name))} in config.ts`);
  }
});

test('the kernel defaults to what the manifest says the defaults are', () => {
  // The limits ride on the request, so the kernel's constants only apply to a
  // caller that sends none -- which makes them exactly the kind of duplicate
  // that drifts unnoticed. They are the same numbers on purpose: a request
  // that says nothing has to behave like a request that says the defaults.
  const constants: ReadonlyArray<readonly [string, string, string]> = [
    ['evalens.readNamesPerLine', 'evalens_kernel.py', 'NAME_LIMIT'],
    ['evalens.loopIterations', 'loops.py', 'HEAD_LIMIT'],
  ];

  for (const [id, file, constant] of constants) {
    const source = fs.readFileSync(path.join(root, 'kernel', file), 'utf8');
    const match = new RegExp(`^${constant} = (\\d+)$`, 'm').exec(source);
    assert.ok(match, `${constant} not found in kernel/${file}`);
    assert.equal(Number(match![1]), properties[id]!.default,
      `${constant} and ${id} disagree about the default`);
  }
});

test('the formatter defaults to what the manifest says the default is', () => {
  // `PRINTED_LABEL` is what `format.ts` uses when nobody supplied a label --
  // every caller that is not the editor. Same duplicate-that-drifts shape as
  // the kernel constants above: a caller that says nothing has to render what
  // a caller reading the settings would.
  const source = fs.readFileSync(
    path.join(root, 'src', 'render', 'format.ts'), 'utf8');
  const match = /^export const PRINTED_LABEL = '(\w+)';$/m.exec(source);
  assert.ok(match, 'PRINTED_LABEL not found in src/render/format.ts');
  assert.equal(match![1], properties['evalens.printedLabel']!.default,
    'PRINTED_LABEL and evalens.printedLabel disagree about the default');
});
