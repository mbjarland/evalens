import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import {
  FakeDecorationType, FakeEditor, FakePosition, FakeVscode, FakeWebviewView,
  createEditor, createExtensionContext, createFakeVscode, loadCompiledExtension,
  paintedTexts,
} from './harness/fakeVscode';

const root = path.resolve(__dirname, '..', '..');

/**
 * #178: `evalens.inlineValues` hides the inline result/error chip while the
 * Values panel is visible and the mode is `whenPanelHidden`, and nothing
 * else -- the gutter markers, the evaluated/pending/asking region tint, the
 * pending and asking chips themselves, and the hover all keep working
 * whatever this setting says. These tests drive the real compiled extension
 * against the fake `vscode` module, the same way `panelLatestResult.test.ts`
 * and `loopHistories.test.ts` do, so a claim here is about the real
 * `Decorator`, `Annotations` and `ValuesViewProvider`, not a re-description
 * of them.
 */

function fixture(source: string, inlineValues?: 'always' | 'whenPanelHidden') {
  const fake = createFakeVscode();
  if (inlineValues !== undefined) {
    fake.config.set('evalens', 'inlineValues', inlineValues);
  }
  const editor = createEditor(source);
  fake.window.activeTextEditor = editor;
  fake.window.visibleTextEditors = [editor];
  const extension = loadCompiledExtension(path.resolve(__dirname, '..'), fake);
  extension.activate(createExtensionContext(root) as never);
  const provider = fake.webviewViewProviders.get('evalens.values')!;
  const view = new FakeWebviewView();
  provider.resolveWebviewView(view, {}, {});

  /** Simulate VS Code notifying every listener after a settings write --
   * the fake's own `update`/`set` never fires this on its own (#178). */
  const notifyConfigChanged = (section: string) => {
    fake.emitters.onDidChangeConfiguration.fire({
      affectsConfiguration: (s: string) => s === section,
    });
  };

  return {
    fake, editor, extension, provider, view, notifyConfigChanged,
    evaluate: () => fake.executeCommand('evalens.evaluateAtCursor'),
  };
}

async function hoverValue(
  fake: FakeVscode, editor: FakeEditor, line: number
): Promise<string | undefined> {
  const provider = fake.hoverProviders[0]!.provider as { provideHover(
    document: unknown, position: FakePosition
  ): Promise<{ contents: { value: string } } | undefined> };
  const hover = await provider.provideHover(editor.document, new FakePosition(line, 0));
  return hover?.contents.value;
}

/** Whether some decoration type built with `overviewRulerColor` naming
 * `colorId` was ever asked to paint a non-empty range on `editor` -- the
 * region/pending-region/asking-region tint, identified by the theme colour
 * it was constructed with rather than by import (`colors.test.ts` is the
 * one place this file's own `COLOR_*` constants are checked against the
 * manifest; importing `render/decorations.ts` here would need a real
 * `vscode` module, which is exactly the gap this harness exists to cover
 * only through the compiled extension). */
function regionPainted(
  fake: FakeVscode, editor: FakeEditor, colorId: string
): boolean {
  return fake.decorationTypes.some((type: FakeDecorationType) => {
    const options = type.options as
      { overviewRulerColor?: { id?: string } } | undefined;
    return options?.overviewRulerColor?.id === colorId
      && (editor.painted.get(type) ?? []).length > 0;
  });
}

/** Whether the gutter marker for `marker` (`evaluated`, `stale`, `error`)
 * was painted on `editor` -- identified by its own icon path, the same
 * reasoning as `regionPainted` above. */
function markerPainted(
  fake: FakeVscode, editor: FakeEditor, marker: string
): boolean {
  return fake.decorationTypes.some((type: FakeDecorationType) => {
    const options = type.options as
      { dark?: { gutterIconPath?: { fsPath?: string } } } | undefined;
    return options?.dark?.gutterIconPath?.fsPath?.endsWith(`${marker}-dark.svg`)
      && (editor.painted.get(type) ?? []).length > 0;
  });
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('the expected state never arrived');
}

test('always (the default) paints the chip exactly as before', async () => {
  const { editor, extension, evaluate } = fixture('value = 42\n');
  try {
    await evaluate();
    assert.ok(paintedTexts(editor).some((entry) => entry.text.includes('42')));
  } finally { extension.deactivate(); }
});

test('whenPanelHidden, with the panel visible, hides the result chip but ' +
  'keeps the gutter marker and the evaluated region', async () => {
  const { fake, editor, extension, evaluate } =
    fixture('value = 42\n', 'whenPanelHidden');
  try {
    await evaluate();
    assert.equal(
      paintedTexts(editor).some((entry) => entry.text.includes('42')), false,
      'the result chip should not paint while the panel is visible');
    assert.ok(
      regionPainted(fake, editor, 'evalens.evaluatedRegionBackground'),
      'the evaluated region tint should still paint');
    assert.ok(markerPainted(fake, editor, 'evaluated'),
      'the gutter marker should still paint');
  } finally { extension.deactivate(); }
});

test('whenPanelHidden hides the error chip but keeps the error marker', async () => {
  const { fake, editor, extension, evaluate } =
    fixture('1 / 0\n', 'whenPanelHidden');
  try {
    await evaluate();
    assert.equal(
      paintedTexts(editor).some((entry) => entry.text.includes('ZeroDivisionError')),
      false, 'the error chip should not paint while the panel is visible');
    assert.ok(markerPainted(fake, editor, 'error'),
      'the gutter error marker should still paint');
  } finally { extension.deactivate(); }
});

test('whenPanelHidden still paints the running chip and its pending region', async () => {
  const { fake, editor, extension, evaluate } = fixture(
    'slow_value = (__import__("time").sleep(0.4), 43)[1]\n', 'whenPanelHidden');
  try {
    const running = evaluate();
    // `pendingText`'s glyph (`status.ts`'s `MARK`, '⌛') is painted before
    // the kernel is even asked -- it is a state, not a value, so it keeps
    // painting whatever `inlineHidden` says.
    await until(() => paintedTexts(editor).some((entry) => entry.text.includes('⌛')));
    assert.ok(
      regionPainted(fake, editor, 'evalens.pendingRegionBackground'),
      'the pending region should still paint while the statement runs');
    await running;
    assert.equal(
      paintedTexts(editor).some((entry) => entry.text.includes('43')), false,
      'once it completes, the result chip is a value again and stays hidden');
  } finally { extension.deactivate(); }
});

test('toggling evalens.inlineValues repaints the chip immediately, from the ' +
  'captured value, without a second evaluation', async () => {
  const { fake, editor, extension, evaluate, notifyConfigChanged } =
    fixture('value = 42\n', 'whenPanelHidden');
  try {
    await evaluate();
    assert.equal(
      paintedTexts(editor).some((entry) => entry.text.includes('42')), false);

    // The title-bar `$(eye-closed)` button and the command palette entry
    // both run this command; the fake's own config store never fires a
    // change event on `update`, so the notification is simulated the way
    // VS Code's real configuration service would deliver it.
    await fake.executeCommand('evalens.toggleInlineValues');
    notifyConfigChanged('evalens.inlineValues');

    assert.ok(paintedTexts(editor).some((entry) => entry.text.includes('42')),
      'the captured value should repaint once the mode flips back to always');
  } finally { extension.deactivate(); }
});

test('the hover still answers with the value while its chip is hidden', async () => {
  const { fake, editor, extension, evaluate } =
    fixture('value = 42\n', 'whenPanelHidden');
  try {
    await evaluate();
    assert.equal(
      paintedTexts(editor).some((entry) => entry.text.includes('42')), false);
    const text = await hoverValue(fake, editor, 0);
    assert.match(text ?? '', /42/,
      'the hover reads the annotation, not the paint, and must not be ' +
      'affected by inlineHidden');
  } finally { extension.deactivate(); }
});

test('the panel: visible + whenPanelHidden hides; not visible shows; ' +
  'flipping the setting while visible follows; disposing shows', async () => {
  const { fake, editor, extension, evaluate, view, notifyConfigChanged } =
    fixture('value = 42\n', 'whenPanelHidden');
  try {
    // resolveWebviewView already ran with a visible view (#178's own
    // default) -- the panel starts out hiding the chip.
    await evaluate();
    assert.equal(
      paintedTexts(editor).some((entry) => entry.text.includes('42')), false,
      'visible + whenPanelHidden should hide the chip');
    assert.match(view.webview.html,
      /id="hide-inline-values" type="checkbox" checked/,
      'the panel\'s own checkbox (#181) should read checked while ' +
      'evalens.inlineValues is whenPanelHidden');

    view.setVisible(false);
    assert.ok(paintedTexts(editor).some((entry) => entry.text.includes('42')),
      'the chip should come back the moment the panel is not visible');

    view.setVisible(true);
    assert.equal(
      paintedTexts(editor).some((entry) => entry.text.includes('42')), false,
      'reopening the panel on its Values tab should hide the chip again');

    await fake.executeCommand('evalens.toggleInlineValues');
    notifyConfigChanged('evalens.inlineValues');
    assert.ok(paintedTexts(editor).some((entry) => entry.text.includes('42')),
      'flipping the setting while the panel is visible should follow ' +
      'immediately, without waiting for a visibility change');
    assert.doesNotMatch(view.webview.html,
      /id="hide-inline-values" type="checkbox" checked/,
      'unchecked once the setting is back to always');

    // Back to whenPanelHidden and visible, so disposing the view has
    // something to revert.
    await fake.executeCommand('evalens.toggleInlineValues');
    notifyConfigChanged('evalens.inlineValues');
    assert.equal(
      paintedTexts(editor).some((entry) => entry.text.includes('42')), false);

    view.fireDispose();
    assert.ok(paintedTexts(editor).some((entry) => entry.text.includes('42')),
      'a disposed view is not visible to anyone, so hiding reverts');
  } finally { extension.deactivate(); }
});
