import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  PANEL_PALETTE, PanelAnnotation, rowsFor, valuesHtml,
} from '../panel/html';
import {
  FakePosition, FakeRange, FakeSelection, FakeWebviewView, createEditor,
  createExtensionContext, createFakeVscode, loadCompiledExtension,
} from './harness/fakeVscode';

const root = path.resolve(__dirname, '..', '..');
const outRoot = path.resolve(__dirname, '..');
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// -- rowsFor / valuesHtml: pure, no webview and no vscode at all -------------

/** The minimum `rowsFor` needs from a document, built from plain lines. */
function lineSource(lines: readonly string[]): { lineAt(line: number): { text: string } } {
  return { lineAt: (line: number) => ({ text: lines[line] ?? '' }) };
}

function range(startLine: number, endLine: number): PanelAnnotation['range'] {
  return { start: { line: startLine }, end: { line: endLine } };
}

/** The summary line's own text, apart from the rest of the document --
 * the static stylesheet mentions "stale" and "error" in every render
 * (`.chip.tone-stale`, `.error-text`, …), so a check for either word has to
 * be scoped to content that actually varies with the rows. */
function summaryOf(html: string): string | undefined {
  return /<div class="summary">([^<]*)<\/div>/.exec(html)?.[1];
}

test('PANEL_PALETTE agrees with package.json\'s own dark defaults', () => {
  // The declared-twice-and-tested shape `colors.test.ts` and `readme.test.ts`
  // already hold the rest of the extension's colours to -- `html.ts` cannot
  // import `render/decorations.ts`'s own COLOR_* constants without dragging
  // that file's `vscode` import down with it, so its fallbacks are checked
  // against the manifest here instead.
  const contributed = new Map<string, { readonly dark: string }>(
    (manifest.contributes?.colors ?? []).map(
      (c: { readonly id: string; readonly defaults: { readonly dark: string } }) =>
        [c.id, c.defaults]));

  for (const [key, { id, fallback }] of Object.entries(PANEL_PALETTE)) {
    const defaults = contributed.get(id);
    assert.ok(defaults, `${key} names "${id}", which package.json does not contribute`);
    assert.equal(fallback, defaults.dark,
      `${key}'s fallback ${fallback} does not match ${id}'s dark default ` +
      `${defaults.dark} in package.json`);
  }
});

test('rows come back in document order, not registry order', () => {
  const document = lineSource(['a = 1', 'b = 2', 'c = 3']);
  const annotations: PanelAnnotation[] = [
    { range: range(2, 2), value: '3', display: 'c', isBinding: true },
    { range: range(0, 0), value: '1', display: 'a', isBinding: true },
    { range: range(1, 1), value: '2', display: 'b', isBinding: true },
  ];
  const rows = rowsFor(document, annotations, 'printed');
  assert.deepEqual(rows.map((row) => row.line), [0, 1, 2]);
  assert.deepEqual(rows.map((row) => row.code), ['a = 1', 'b = 2', 'c = 3']);
});

test('a value containing markup renders as text, never as an element', () => {
  const document = lineSource(['x = 1']);
  const annotations: PanelAnnotation[] = [
    { range: range(0, 0), value: '<script>alert(1)</script>', display: 'x', isBinding: true },
  ];
  const html = valuesHtml(
    { fileName: 'x.py', rows: rowsFor(document, annotations, 'printed') },
    undefined, 'n');
  assert.ok(!html.includes('<script>alert'), 'the value must be escaped');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('a stale row carries the grey surface and the hover\'s own reason', () => {
  const document = lineSource(['y = x + 1']);
  const annotations: PanelAnnotation[] = [
    {
      range: range(0, 0), value: '2', display: 'y', isBinding: true,
      stale: true, staleReason: 'dependency',
    },
  ];
  const rows = rowsFor(document, annotations, 'printed');
  assert.equal(rows[0]!.state, 'stale');
  const html = valuesHtml({ fileName: 'x.py', rows }, undefined, 'n');
  assert.match(html, /tone-stale/);
  // The hover's own words (registry.staleReasonText), not a second, paraphrased
  // wording invented for the panel.
  assert.match(html, /re-bound since this ran/);
});

test('an error row shows the type and message, never a traceback', () => {
  const document = lineSource(['1 / 0']);
  const annotations: PanelAnnotation[] = [
    { range: range(0, 0), error: { type: 'ZeroDivisionError', message: 'division by zero' } },
  ];
  const rows = rowsFor(document, annotations, 'printed');
  assert.equal(rows[0]!.state, 'error');
  assert.equal(rows[0]!.errorText, 'ZeroDivisionError: division by zero');
  const html = valuesHtml({ fileName: 'x.py', rows }, undefined, 'n');
  assert.match(html, /tone-error/);
  assert.match(html, /ZeroDivisionError: division by zero/);
});

test('a stale error keeps the message under the grey, stale surface', () => {
  // markerFor's own ranking: stale outranks error, because a failure whose
  // statement has since been edited is not reporting the current code's
  // failure. The message stays -- it says what the error *was* -- but the
  // surface recedes to grey rather than staying red.
  const document = lineSource(['1 / 0']);
  const annotations: PanelAnnotation[] = [
    {
      range: range(0, 0),
      error: { type: 'ZeroDivisionError', message: 'division by zero' },
      stale: true, staleReason: 'edited',
    },
  ];
  const rows = rowsFor(document, annotations, 'printed');
  assert.equal(rows[0]!.state, 'stale');
  assert.equal(rows[0]!.errorText, 'ZeroDivisionError: division by zero');
  const html = valuesHtml({ fileName: 'x.py', rows }, undefined, 'n');
  // The static stylesheet always defines a `.tone-error` rule, whether or
  // not any row uses it -- so the check is against the chip's and bar's own
  // class attributes, not the whole document. The bar -- not the chip -- is
  // what carries the state's colour now (#116 review).
  assert.match(html, /class="bar tone-stale">/);
  assert.match(html, /class="chip tone-stale">/);
  assert.doesNotMatch(html, /class="bar tone-error/);
  assert.doesNotMatch(html, /class="chip tone-error/);
  assert.match(html, /ZeroDivisionError: division by zero/);
  assert.match(html, /code changed since it ran/);
});

test('a pending row shows the pending mark, never a stale value', () => {
  const document = lineSource(['slow()']);
  const annotations: PanelAnnotation[] = [
    { range: range(0, 0), pending: { message: 'running…' } },
  ];
  const rows = rowsFor(document, annotations, 'printed');
  assert.equal(rows[0]!.state, 'pending');
  const html = valuesHtml({ fileName: 'x.py', rows }, undefined, 'n');
  assert.match(html, /tone-pending/);
  assert.match(html, /running…/);
});

test('the full value is shown, not the inline chip\'s 120-character cut', () => {
  const long = Array.from({ length: 60 }, (_, i) => i).join(', ');
  const document = lineSource(['xs = list(range(60))']);
  const annotations: PanelAnnotation[] = [
    { range: range(0, 0), value: long, display: 'xs', isBinding: true },
  ];
  const html = valuesHtml(
    { fileName: 'x.py', rows: rowsFor(document, annotations, 'printed') },
    undefined, 'n');
  assert.ok(html.includes(long),
    'the panel truncated a value the inline chip alone would have cut');
  assert.ok(!html.includes('more character'), 'no truncation marker should appear');
});

test('a value\'s spaces are ordinary, not the inline chip\'s non-breaking ' +
  'ones, so a list wraps at its own commas', () => {
  // format.resultGroups substitutes non-breaking spaces throughout
  // (format.preserveSpacing), because the *inline* chip is a VS Code
  // decoration contentText and VS Code collapses runs of ordinary spaces
  // there. A webview has none of that problem, and an NBSP is by
  // definition never a line-break opportunity -- left in place, a long
  // list becomes one unbreakable word and overflow-wrap: anywhere shreds
  // it mid-number instead of wrapping at ", " (#116 review).
  const document = lineSource(['a = 1']);
  const annotations: PanelAnnotation[] = [
    { range: range(0, 0), value: '1, 2, 3', display: 'a', isBinding: true },
  ];
  const html = valuesHtml(
    { fileName: 'x.py', rows: rowsFor(document, annotations, 'printed') },
    undefined, 'n');
  assert.ok(html.includes('1, 2, 3'), 'the value should carry ordinary spaces');
  assert.ok(!html.includes(' '), 'no non-breaking space should reach the page');
});

test('printed output keeps every line, not the inline chip\'s summary', () => {
  const document = lineSource(['loop()']);
  const annotations: PanelAnnotation[] = [
    {
      range: range(0, 0), value: null, display: null,
      printed: { stdout: 'one\ntwo\nthree\n' },
    },
  ];
  const html = valuesHtml(
    { fileName: 'x.py', rows: rowsFor(document, annotations, 'printed') },
    undefined, 'n');
  assert.match(html, /one[\s\S]*two[\s\S]*three/);
  assert.ok(!html.includes('…(3 lines)'),
    'the panel must not fall back to the inline elision');
  assert.match(html, /\.chip\.block\s*\{[^}]*white-space:\s*pre-wrap/);
});

test('printed output is a single block chip under the value chips, not ' +
  'one inline chip per line', () => {
  const document = lineSource(['x = compute()']);
  const annotations: PanelAnnotation[] = [
    {
      range: range(0, 0), value: '42', display: 'x', isBinding: true,
      printed: { stdout: 'one\ntwo\nthree\n' },
    },
  ];
  const html = valuesHtml(
    { fileName: 'x.py', rows: rowsFor(document, annotations, 'printed') },
    undefined, 'n');
  // Exactly two chips: the value ("x: 42") and one block chip carrying all
  // three printed lines -- never three chips, one per line.
  const chipCount = (html.match(/class="chip /g) ?? []).length;
  assert.equal(chipCount, 2,
    'expected one value chip and one block printed chip, not one per line');
  assert.match(html, /class="chip tone-evaluated block"/);
  // Only the value chip is leading -- the printed block sits under it and
  // carries no bar of its own.
  const barCount = (html.match(/class="bar /g) ?? []).length;
  assert.equal(barCount, 1, 'only the first chip of the row gets a bar');
});

test('a multi-line printed block starts every line under the label, the ' +
  'first line included (#148)', () => {
  const document = lineSource(['loop()']);
  const annotations: PanelAnnotation[] = [
    {
      range: range(0, 0), value: null, display: null,
      printed: { stdout: 'value is 4\nvalue is 8\nvalue is 12\n' },
    },
  ];
  const html = valuesHtml(
    { fileName: 'x.py', rows: rowsFor(document, annotations, 'printed') },
    undefined, 'n');
  // The label's own span ends in a line break, before the value span even
  // starts -- so the first printed line begins the same column as the rest,
  // never sharing a line with "printed:" the way the old single-line join
  // did.
  assert.ok(html.includes('>printed:\n<'),
    'the label must be followed by a line break, not a trailing space');
  assert.ok(html.includes('<span class="seg-value">value is 4\nvalue is 8\nvalue is 12'),
    'every printed line, first included, must start after the break');
  assert.ok(!html.includes('printed: value is 4'),
    'the first line must not still be joined to the label on one line');
});

test('a single-line printed stream keeps the label and the line together ' +
  '(#148)', () => {
  const document = lineSource(['loop()']);
  const annotations: PanelAnnotation[] = [
    {
      range: range(0, 0), value: null, display: null,
      printed: { stdout: 'value is 4\n' },
    },
  ];
  const html = valuesHtml(
    { fileName: 'x.py', rows: rowsFor(document, annotations, 'printed') },
    undefined, 'n');
  assert.ok(html.includes('<span class="seg-streamLabel">printed: </span>'
    + '<span class="seg-value">value is 4</span>'),
    'a single line keeps label and line on one line, as before');
  assert.ok(!html.includes('>printed:\n<'),
    'a single line must never break after the label');
});

test('a multi-line stderr block follows the same rule as printed (#148)',
  () => {
    const document = lineSource(['loop()']);
    const annotations: PanelAnnotation[] = [
      {
        range: range(0, 0), value: null, display: null,
        printed: { stderr: 'oops\nagain\n' },
      },
    ];
    const html = valuesHtml(
      { fileName: 'x.py', rows: rowsFor(document, annotations, 'printed') },
      undefined, 'n');
    assert.ok(html.includes('>stderr:\n<'),
      'stderr must break after its label exactly as printed does');
    assert.ok(html.includes('<span class="seg-value">oops\nagain'),
      'every stderr line, first included, must start after the break');
  });

test('the accent bar is one element before the leading chip, never a ' +
  'border repeated on every wrapped line', () => {
  const long = Array.from({ length: 60 }, (_, i) => i).join(', ');
  const document = lineSource(['xs = list(range(60))']);
  const annotations: PanelAnnotation[] = [
    { range: range(0, 0), value: long, display: 'xs', isBinding: true },
  ];
  const html = valuesHtml(
    { fileName: 'x.py', rows: rowsFor(document, annotations, 'printed') },
    undefined, 'n');
  const barCount = (html.match(/class="bar /g) ?? []).length;
  assert.equal(barCount, 1,
    'a chip long enough to wrap must still carry exactly one bar');
  assert.doesNotMatch(html, /\.chip\s*\{[^}]*border-left/,
    'the chip itself must not carry a border-left any more');
});

test('a loop\'s iterations are shown the way the inline chip shows them', () => {
  const document = lineSource(['for n in range(3):', '    pass']);
  const annotations: PanelAnnotation[] = [
    {
      range: range(0, 1), anchor: 0, value: null, display: null,
      loop: { values: ['0', '1', '2'], last: null, count: 3 },
    },
  ];
  const html = valuesHtml(
    { fileName: 'x.py', rows: rowsFor(document, annotations, 'printed') },
    undefined, 'n');
  assert.match(html, /×3/);
  // `\s` rather than a literal space: the value went through
  // `preserveSpacing` on its way here, so the separator is a non-breaking
  // space, which `\s` matches and a literal `' '` in the pattern would not.
  assert.match(html, /0,\s1,\s2/);
});

test('the cursor row is found by containment across a multi-line statement', () => {
  const document = lineSource(['def f():', '    return 1']);
  const annotations: PanelAnnotation[] = [
    { range: range(0, 1), anchor: 0, value: 'def f()', display: 'f', isBinding: true },
  ];
  const rows = rowsFor(document, annotations, 'printed');
  // Line 1 (0-based) is the statement's body, below the row's own displayed
  // line 0 -- and it still highlights, the same containment `Annotations.at`
  // already applies for the hover and the announce command.
  const html = valuesHtml({ fileName: 'x.py', rows }, 1, 'n');
  assert.match(html, /class="row cursor"/);
});

test('no cursor line marks no row', () => {
  const document = lineSource(['x = 1']);
  const annotations: PanelAnnotation[] = [
    { range: range(0, 0), value: '1', display: 'x', isBinding: true },
  ];
  const html = valuesHtml(
    { fileName: 'x.py', rows: rowsFor(document, annotations, 'printed') },
    undefined, 'n');
  assert.doesNotMatch(html, /class="row cursor"/);
});

test('no active Python editor says so', () => {
  const html = valuesHtml({ fileName: undefined, rows: [] }, undefined, 'n');
  assert.match(html, /Open a Python file/);
});

test('a Python file with no annotations yet says how to get one', () => {
  const html = valuesHtml({ fileName: 'x.py', rows: [] }, undefined, 'n');
  assert.match(html, /to see its values here/);
});

test('the summary line names the file and counts stale and error rows', () => {
  const document = lineSource(['a', 'b', 'c']);
  const annotations: PanelAnnotation[] = [
    { range: range(0, 0), value: '1', display: 'a', isBinding: true },
    {
      range: range(1, 1), value: '2', display: 'b', isBinding: true,
      stale: true, staleReason: 'edited',
    },
    { range: range(2, 2), error: { type: 'ValueError', message: 'bad' } },
  ];
  const html = valuesHtml(
    { fileName: 'basics.py', rows: rowsFor(document, annotations, 'printed') },
    undefined, 'n');
  assert.equal(summaryOf(html), 'basics.py · 3 values · 1 stale · 1 error');
});

test('a summary with nothing stale or wrong says only the count', () => {
  const document = lineSource(['a']);
  const annotations: PanelAnnotation[] = [
    { range: range(0, 0), value: '1', display: 'a', isBinding: true },
  ];
  const html = valuesHtml(
    { fileName: 'basics.py', rows: rowsFor(document, annotations, 'printed') },
    undefined, 'n');
  assert.equal(summaryOf(html), 'basics.py · 1 value');
});

test('every colour rides a class, never an inline style attribute', () => {
  // The specified CSP's style-src carries only the one nonce, which does not
  // extend to an inline style="…" attribute -- so one here would paint
  // nothing at all, silently.
  const document = lineSource(['x = 1']);
  const annotations: PanelAnnotation[] = [
    {
      range: range(0, 0), value: '1', display: 'x', isBinding: true,
      stale: true, staleReason: 'edited',
    },
  ];
  const html = valuesHtml(
    { fileName: 'x.py', rows: rowsFor(document, annotations, 'printed') }, 0, 'n');
  assert.ok(!html.includes('style="'),
    'an inline style attribute cannot be painted under this CSP');
});

test('the CSP allows only the one nonce and nothing external', () => {
  const html = valuesHtml({ fileName: undefined, rows: [] }, undefined, 'abc123');
  assert.match(html, /default-src 'none'/);
  assert.match(html, /style-src 'nonce-abc123'/);
  assert.match(html, /script-src 'nonce-abc123'/);
  assert.ok(!html.includes('http://') && !html.includes('https://'),
    'no external resource should ever be referenced');
});

// -- the reveal line (#149): scroll the row that just changed into view -----

test('valuesHtml carries the reveal line and the script that scrolls to it',
  () => {
    const document = lineSource(['a = 1', 'b = 2']);
    const annotations: PanelAnnotation[] = [
      { range: range(0, 0), value: '1', display: 'a', isBinding: true },
      { range: range(1, 1), value: '2', display: 'b', isBinding: true },
    ];
    const html = valuesHtml(
      { fileName: 'x.py', rows: rowsFor(document, annotations, 'printed') },
      undefined, 'n', 1);
    // Baked into the on-load script as a literal, the same way `nonce` and
    // `cursorLine` already are -- never re-asked of the extension after the
    // page has loaded.
    assert.match(html, /\bvar revealLine = 1;/);
    assert.match(html, /\.scrollIntoView\(\{\s*block:\s*'nearest'\s*\}\)/);
  });

test('valuesHtml carries no reveal target when none is given ' +
  '(following is off, or the change named no line)', () => {
  const document = lineSource(['a = 1']);
  const annotations: PanelAnnotation[] = [
    { range: range(0, 0), value: '1', display: 'a', isBinding: true },
  ];
  const html = valuesHtml(
    { fileName: 'x.py', rows: rowsFor(document, annotations, 'printed') },
    undefined, 'n');
  assert.match(html, /\bvar revealLine = null;/);
});

// -- the provider, through the fake vscode -----------------------------------

/** A fresh fake and a freshly activated (compiled) extension, rooted at the
 * real repository -- the same technique `extension.test.ts` uses, repeated
 * here rather than shared, since that file exports no helper to reuse. */
function activated(fake: ReturnType<typeof createFakeVscode>) {
  const extension = loadCompiledExtension(outRoot, fake);
  extension.activate(createExtensionContext(root) as never);
  return extension;
}

test('activation registers a webview view provider for the values panel', () => {
  const fake = createFakeVscode();
  const extension = activated(fake);
  try {
    assert.ok(fake.webviewViewProviders.has('evalens.values'),
      'evalens.values is contributed in package.json but never registered');
  } finally {
    extension.deactivate();
  }
});

test('resolving the view with no active editor says to open a Python file',
  () => {
    const fake = createFakeVscode();
    const extension = activated(fake);
    try {
      const provider = fake.webviewViewProviders.get('evalens.values')!;
      const view = new FakeWebviewView();
      provider.resolveWebviewView(view, {}, {});

      assert.ok(view.webview.options.enableScripts,
        'the view needs scripts enabled for cursor sync and row clicks');
      assert.match(view.webview.html, /Open a Python file/);
    } finally {
      extension.deactivate();
    }
  });

test('resolving the view for a Python file with nothing evaluated yet ' +
  'says how to get a value', () => {
  const fake = createFakeVscode();
  const editor = createEditor('1 + 1\n');
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = activated(fake);
  try {
    const provider = fake.webviewViewProviders.get('evalens.values')!;
    const view = new FakeWebviewView();
    provider.resolveWebviewView(view, {}, {});

    assert.match(view.webview.html, /to see its values here/);
  } finally {
    extension.deactivate();
  }
});

test('resolving the view paints the active editor\'s real annotations',
  async () => {
    const fake = createFakeVscode();
    const editor = createEditor('40 + 2\n');
    fake.window.activeTextEditor = editor;
    fake.window.visibleTextEditors = [editor];
    const extension = activated(fake);
    try {
      await (fake.commands.registered.get('evalens.evaluateAtCursor') as
        () => Promise<void>)();

      const provider = fake.webviewViewProviders.get('evalens.values')!;
      const view = new FakeWebviewView();
      provider.resolveWebviewView(view, {}, {});

      assert.match(view.webview.html, /example\.py/,
        'the summary line should name the active file');
      assert.match(view.webview.html, /\b42\b/,
        'the row should carry the value the real kernel computed');
    } finally {
      extension.deactivate();
    }
  });

test('a later evaluation rebuilds an already-open panel (onDidChange)',
  async () => {
    const fake = createFakeVscode();
    const editor = createEditor('1 + 1\n');
    fake.window.activeTextEditor = editor;
    fake.window.visibleTextEditors = [editor];
    const extension = activated(fake);
    try {
      const provider = fake.webviewViewProviders.get('evalens.values')!;
      const view = new FakeWebviewView();
      provider.resolveWebviewView(view, {}, {});
      assert.match(view.webview.html, /to see its values here/, 'setup: empty');

      await (fake.commands.registered.get('evalens.evaluateAtCursor') as
        () => Promise<void>)();

      assert.match(view.webview.html, /\b2\b/,
        'the panel should have rebuilt once Annotations.onDidChange fired');
    } finally {
      extension.deactivate();
    }
  });

test('switching to a non-Python editor rebuilds the panel to its empty state',
  () => {
    const fake = createFakeVscode();
    const pyEditor = createEditor('1 + 1\n', '/fake/example.py', 'python');
    fake.window.activeTextEditor = pyEditor;
    fake.window.visibleTextEditors = [pyEditor];
    const extension = activated(fake);
    try {
      const provider = fake.webviewViewProviders.get('evalens.values')!;
      const view = new FakeWebviewView();
      provider.resolveWebviewView(view, {}, {});
      assert.doesNotMatch(view.webview.html, /Open a Python file/, 'setup');

      const mdEditor = createEditor('# notes', '/fake/notes.md', 'markdown');
      fake.window.activeTextEditor = mdEditor;
      fake.emitters.onDidChangeActiveTextEditor.fire(mdEditor);

      assert.match(view.webview.html, /Open a Python file/);
    } finally {
      extension.deactivate();
    }
  });

test('moving the cursor posts a message instead of rebuilding the panel',
  async () => {
    const fake = createFakeVscode();
    const editor = createEditor('1 + 1\n2 + 2\n');
    fake.window.activeTextEditor = editor;
    fake.window.visibleTextEditors = [editor];
    const extension = activated(fake);
    try {
      const evaluateAtCursor =
        fake.commands.registered.get('evalens.evaluateAtCursor') as () => Promise<void>;
      await evaluateAtCursor();
      editor.selection = new FakeSelection(
        new FakePosition(1, 0), new FakePosition(1, 0));
      await evaluateAtCursor();

      const provider = fake.webviewViewProviders.get('evalens.values')!;
      const view = new FakeWebviewView();
      provider.resolveWebviewView(view, {}, {});
      const htmlBefore = view.webview.html;

      editor.selection = new FakeSelection(
        new FakePosition(0, 0), new FakePosition(0, 0));
      fake.emitters.onDidChangeTextEditorSelection.fire(
        { textEditor: editor, selections: [editor.selection] });

      assert.equal(view.webview.html, htmlBefore,
        'a cursor move must not rebuild the panel');
      assert.deepEqual(view.webview.posted, [{ cursor: 0 }]);
    } finally {
      extension.deactivate();
    }
  });

test('a click message moves the cursor to the line and reveals it', () => {
  const fake = createFakeVscode();
  const editor = createEditor('1\n2\n3\n');
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = activated(fake);
  try {
    const provider = fake.webviewViewProviders.get('evalens.values')!;
    const view = new FakeWebviewView();
    provider.resolveWebviewView(view, {}, {});

    view.webview.fireMessage({ goto: 2 });

    assert.equal(editor.selection.active.line, 2);
    assert.equal(editor.selection.anchor.line, 2);
    assert.ok(editor.revealed.some((revealed) => revealed.start.line === 2),
      'the click must reveal the line it jumped to');
  } finally {
    extension.deactivate();
  }
});

test('a message with no goto is ignored, never throws', () => {
  const fake = createFakeVscode();
  const editor = createEditor('1\n');
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = activated(fake);
  try {
    const provider = fake.webviewViewProviders.get('evalens.values')!;
    const view = new FakeWebviewView();
    provider.resolveWebviewView(view, {}, {});

    assert.doesNotThrow(() => view.webview.fireMessage({ somethingElse: true }));
    assert.equal(editor.selection.active.line, 0, 'the cursor must not move');
  } finally {
    extension.deactivate();
  }
});

test('Evalens: Show Values Panel focuses the contributed view', async () => {
  const fake = createFakeVscode();
  const extension = activated(fake);
  try {
    await fake.executeCommand('evalens.showValuesPanel');
    assert.ok(
      fake.commands.executed.some((call) => call.id === 'evalens.values.focus'),
      'the command should reveal the view the way every other view does');
  } finally {
    extension.deactivate();
  }
});

// -- following the newest change, through the real provider (#149) ---------

test('an evaluation reveals the row it just produced, following on by ' +
  'default', async () => {
  const fake = createFakeVscode();
  const editor = createEditor('1 + 1\n2 + 2\n');
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = activated(fake);
  try {
    const provider = fake.webviewViewProviders.get('evalens.values')!;
    const view = new FakeWebviewView();
    provider.resolveWebviewView(view, {}, {});

    editor.selection = new FakeSelection(
      new FakePosition(1, 0), new FakePosition(1, 0));
    await (fake.commands.registered.get('evalens.evaluateAtCursor') as
      () => Promise<void>)();

    assert.match(view.webview.html, /\bvar revealLine = 1;/,
      'the provider should reveal the line Annotations.onDidChange named');
  } finally {
    extension.deactivate();
  }
});

test('evalens.valuesPanel.follow off means an evaluation reveals nothing',
  async () => {
    const fake = createFakeVscode();
    fake.config.set('evalens', 'valuesPanel.follow', false);
    const editor = createEditor('1 + 1\n');
    fake.window.activeTextEditor = editor;
    fake.window.visibleTextEditors = [editor];
    const extension = activated(fake);
    try {
      const provider = fake.webviewViewProviders.get('evalens.values')!;
      const view = new FakeWebviewView();
      provider.resolveWebviewView(view, {}, {});

      await (fake.commands.registered.get('evalens.evaluateAtCursor') as
        () => Promise<void>)();

      assert.match(view.webview.html, /\bvar revealLine = null;/,
        'following is off, so the panel must still rebuild but never reveal');
    } finally {
      extension.deactivate();
    }
  });

test('an edit that cannot name a single line falls back to the cursor',
  async () => {
    const fake = createFakeVscode();
    const editor = createEditor('x = [1, 2, 3]\n');
    fake.window.activeTextEditor = editor;
    fake.window.visibleTextEditors = [editor];
    const extension = activated(fake);
    try {
      await (fake.commands.registered.get('evalens.evaluateAtCursor') as
        () => Promise<void>)();

      const provider = fake.webviewViewProviders.get('evalens.values')!;
      const view = new FakeWebviewView();
      provider.resolveWebviewView(view, {}, {});

      // A same-line rewrite marks the annotation stale through `reanchor`
      // (render/registry.ts) rather than through `add`, so the fired event
      // carries no line and the reveal has to fall back to wherever the
      // cursor actually is (#149) -- put it on the file's other (blank)
      // line, so a wrong fallback to line 0, the line the edit touched,
      // would be caught.
      const oldLine = 'x = [1, 2, 3]';
      editor.document.setText('x = [1, 2, 3, 4]\n');
      editor.selection = new FakeSelection(
        new FakePosition(1, 0), new FakePosition(1, 0));
      fake.emitters.onDidChangeTextDocument.fire({
        document: editor.document,
        contentChanges: [{
          range: new FakeRange(0, 0, 0, oldLine.length),
          text: 'x = [1, 2, 3, 4]',
        }],
      });

      assert.match(view.webview.html, /\bvar revealLine = 1;/,
        'with no line on the event, the reveal should fall back to the ' +
        'cursor line rather than the line the edit actually touched');
    } finally {
      extension.deactivate();
    }
  });

test('Evalens: Toggle Follow in Values Panel flips the setting', async () => {
  const fake = createFakeVscode();
  const extension = activated(fake);
  try {
    const follow = (): unknown =>
      fake.config.getConfiguration('evalens').get('valuesPanel.follow', true);
    assert.equal(follow(), true, 'setup: unset, so defaults to true');

    await fake.executeCommand('evalens.toggleValuesPanelFollow');
    assert.equal(follow(), false);

    await fake.executeCommand('evalens.toggleValuesPanelFollow');
    assert.equal(follow(), true);
  } finally {
    extension.deactivate();
  }
});

test('the values panel title bar contributes the lock/unlock toggle', () => {
  const entries: ReadonlyArray<{
    readonly command: string; readonly when?: string; readonly icon?: string;
  }> = manifest.contributes?.menus?.['view/title'] ?? [];
  const forThisView =
    entries.filter((entry) => entry.when?.includes('view == evalens.values'));
  assert.equal(forThisView.length, 2,
    'expected exactly two view/title entries for the values panel');
  assert.ok(
    forThisView.every((entry) => entry.command === 'evalens.toggleValuesPanelFollow'),
    'both entries should point at the one toggle command');

  const unlock = forThisView.find((entry) => entry.icon === '$(unlock)');
  const lock = forThisView.find((entry) => entry.icon === '$(lock)');
  assert.ok(unlock, 'no $(unlock) entry for the values panel');
  assert.ok(lock, 'no $(lock) entry for the values panel');
  assert.match(unlock!.when!, /config\.evalens\.valuesPanel\.follow/);
  assert.doesNotMatch(unlock!.when!, /!config\.evalens\.valuesPanel\.follow/,
    'the $(unlock) entry should show while following, not while not');
  assert.match(lock!.when!, /!config\.evalens\.valuesPanel\.follow/);
});
