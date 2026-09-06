#!/usr/bin/env node
'use strict';
/**
 * Generate every README still from its committed spec (#113).
 *
 * The pipeline is the real one, start to finish: a real kernel subprocess
 * (`kernel/evalens_kernel.py`) evaluates the spec's source; the response goes
 * through the same `present`/`capNames`/`PaintedAbove` functions the compiled
 * extension uses (`out/render/*.js`, built by `npm run compile`); the real
 * `Decorator.show()` paints it into a mocked editor and hands back the exact
 * `renderOptions` it would give a real one; those are turned into HTML laid
 * out under VS Code's own rules (Menlo 12px, `white-space:nowrap`, one
 * `inline-block` span per token); and headless Chrome shoots it at 2x. No
 * value on any still is typed -- every one of them was produced by running
 * the code beside it.
 *
 * Three things below are load-bearing and easy to silently undo in a future
 * edit:
 *
 * 1. **Every substituted space is `\u00a0`, written as the escape.** A
 *    literal NBSP pasted into a heredoc once silently became a plain space,
 *    and every gap in the source collapsed back onto single-space width.
 *    `nbsp()` is the only place spaces become non-breaking; nothing here
 *    should ever contain a literal U+00A0 character in the source file.
 * 2. **Segment order comes from `calls` (invocation order), never from a
 *    decoration type's key.** `Decorator`'s own `segmentTypes` are sorted by
 *    generated class name for VS Code's benefit (see `paintOrder` in
 *    `layers.ts`), which is not left-to-right order. What *is* left-to-right
 *    order is the sequence `show()` pushed values into `results[slot]` in --
 *    so the per-line array this script paints from is built by walking
 *    `calls` in the order `setDecorations` was actually invoked.
 * 3. **`capNames` runs on the cursor path exactly where `evaluateAtCursor`
 *    runs it: after `present()`, only on a `value` presentation, never on an
 *    `error` one.** The kernel's own per-line cap (`NAME_LIMIT`) is a
 *    transport bound now (#85), not a display cap, so skipping this step
 *    would occasionally paint more names than a real keypress ever shows.
 *    `eval_watch`'s annotation is built the same way `addInlineWatch` builds
 *    it -- straight off `present()`, with no `capNames` step -- because that
 *    is what the real command does; see the doc comment on `renderWatch`.
 *
 * Usage:
 *   node bin/render-stills.js                  # every spec in docs/stills/
 *   node bin/render-stills.js docs/stills/x.json [...]   # just these
 *
 * Each spec is only re-rendered when its own content has changed since the
 * last render -- see `specHash`. A spec that has not changed is skipped
 * entirely, Chrome included, which is what makes a second run a no-op.
 */

const Module = require('module');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STILLS_DIR = path.join(ROOT, 'docs', 'stills');
const { specHash } = require('./stills-hash.js');

// ---------------------------------------------------------------- vscode mock
// `out/render/decorations.js` and its imports (`out/render/config.js`) do
// `require('vscode')`. There is no such module outside an editor process, so
// module resolution is patched, process-wide, to hand back the mock instead
// -- the same technique #95's evidence harness used.
const mock = require('./vscode-mock.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function patchedResolve(request, ...rest) {
  return request === 'vscode' ? 'vscode' : origResolve.call(this, request, ...rest);
};
const origLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  return request === 'vscode' ? mock : origLoad.call(this, request, parent, isMain);
};

const OUT = path.join(ROOT, 'out');
const { Decorator } = require(path.join(OUT, 'render', 'decorations.js'));
const { present } = require(path.join(OUT, 'render', 'present.js'));
const { capNames, PaintedAbove } = require(path.join(OUT, 'render', 'repeats.js'));
const { printedFrom } = require(path.join(OUT, 'render', 'format.js'));
const { KernelClient } = require(path.join(OUT, 'kernel', 'client.js'));

// ------------------------------------------------------------------ palette
// The same theme-colour defaults `package.json` contributes, so a colour
// change to that file is a colour change here too rather than a second copy
// to remember to edit.
const PALETTE = Object.fromEntries(
  JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    .contributes.colors.map((c) => [c.id, c.defaults.dark])
);
const hex = (themeColor) => (
  themeColor && themeColor.id ? (PALETTE[themeColor.id] || '#ff00ff') : undefined
);

// -------------------------------------------------------------- tokenizing
// A hand-rolled approximation of Dark Modern's Python grammar, for the code
// half of the mockup only -- the annotation half is the real renderer's own
// output, captured below, not approximated.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Hazard 1: this is the only place a space becomes non-breaking, and it must
// stay the escape below -- see the module doc comment.
const nbsp = (s) => s.replace(/ /g, '\u00a0');

const KEYWORDS = new Set([
  'for', 'in', 'if', 'else', 'elif', 'while', 'return', 'import', 'from',
  'as', 'and', 'or', 'not', 'is', 'with', 'try', 'except', 'pass', 'break',
  'continue',
]);
const KEYWORDS2 = new Set(['def', 'class', 'True', 'False', 'None', 'lambda']);
const BUILTINS = new Set([
  'print', 'len', 'range', 'sum', 'int', 'str', 'float', 'list', 'dict',
  'set', 'sorted', 'min', 'max', 'abs', 'round', 'enumerate', 'zip', 'input',
  'type', 'isinstance',
]);

function tokenize(line) {
  const out = [];
  const re = /(\s+)|(f?"(?:[^"\\]|\\.)*"|f?'(?:[^'\\]|\\.)*')|(#.*)|(\d+(?:\.\d+)?)|([A-Za-z_]\w*)|(.)/g;
  let m;
  while ((m = re.exec(line))) {
    if (m[1]) out.push([m[1], 'd']);
    else if (m[2]) out.push([m[2], 'str']);
    else if (m[3]) out.push([m[3], 'cmt']);
    else if (m[4]) out.push([m[4], 'num']);
    else if (m[5]) {
      const word = m[5];
      out.push([word, KEYWORDS.has(word) ? 'kw' : KEYWORDS2.has(word) ? 'kw2' : 'id']);
    } else out.push([m[6], 'd']);
  }
  // A second pass, not a lookahead in the loop above: whether an identifier
  // is being *called* depends on the next token, which regex alternation
  // does not hand back until the match after it. `other.append(4)` and
  // `sum(squares)` both want the call colour, whether or not the name is
  // one of `BUILTINS` -- real syntax highlighting does not know the stdlib
  // either, it knows `name` immediately followed by `(`.
  for (let i = 0; i < out.length; i += 1) {
    const [word, kind] = out[i];
    if (kind !== 'id') continue;
    const next = out[i + 1];
    if (BUILTINS.has(word) || (next && next[0] === '(')) out[i] = [word, 'fn'];
  }
  return out;
}

// ---------------------------------------------------------- kernel driving
/**
 * Walk `lines` the way `Evaluate and Advance` walks a file: one `eval` per
 * top-level statement, in file order, each one a separate request against
 * the same persistent kernel -- so a name a later line reads was bound by an
 * earlier request into the kernel's own namespace, never smuggled in here.
 *
 * Statement starts come from the kernel's own `outline` op rather than one
 * line per array entry, so a multi-line statement (the `for` loop below) is
 * one press, not three -- exactly what a real walk down the file would be.
 */
async function walkStatements(client, lines, filename, onResult) {
  const source = lines.join('\n') + '\n';
  const outline = await client.request({ op: 'outline', source, filename });
  const starts = (outline.statements || [])
    .map((s) => (s.range ? s.range.start.line : s.start_line ?? s.line))
    .filter((n) => typeof n === 'number');
  const lineNumbers = starts.length ? starts : lines.map((_, i) => i);
  for (const line of lineNumbers) {
    const response = await client.request({
      op: 'eval', source, line, character: 0, filename, allow_stdin: false,
    });
    await onResult(line, response);
  }
}

/**
 * A `Presentation` (`value` or `error`) turned into the `Annotation` shape
 * `Decorator.show()` paints from -- field-for-field what `evaluate.ts`'s own
 * `annotationFor` (load path) and its inline ternary (cursor path) build,
 * minus the two fields (`pending`, `partialFrom`) nothing rendered here ever
 * has. One function for both branches because a still is never pending and
 * never computed from a partial parse.
 */
function toAnnotation(presentation, lines) {
  const r = presentation.range;
  const range = new mock.Range(
    r.start.line, r.start.character, r.end.line, r.end.character);
  const source = lines.slice(range.start.line, range.end.line + 1).join('\n');
  const anchor = presentation.anchor === undefined ? {} : { anchor: presentation.anchor };

  if (presentation.kind === 'error') {
    return {
      range, ...anchor, source,
      ...(presentation.binds === undefined ? {} : { binds: presentation.binds }),
      ...(presentation.reads === undefined ? {} : { reads: presentation.reads }),
      error: { type: presentation.type, message: presentation.message },
      hover: presentation.hover,
    };
  }
  return {
    range, ...anchor, source,
    ...(presentation.value === null ? {} : { value: presentation.value }),
    display: presentation.display,
    ...(presentation.loop === undefined ? {} : { loop: presentation.loop }),
    ...(presentation.bindings === undefined ? {} : { bindings: presentation.bindings }),
    ...(presentation.names === undefined ? {} : { names: presentation.names }),
    ...(presentation.printed === undefined ? {} : { printed: presentation.printed }),
    ...(presentation.more === undefined ? {} : { more: presentation.more }),
    ...(presentation.isBinding === undefined ? {} : { isBinding: presentation.isBinding }),
  };
}

/**
 * `setup` lines run for real, against the same kernel, before the lines that
 * actually get painted -- so a figure can open mid-file (`total = sum(squares)`
 * needs `squares` bound; the watch's `total += x` needs `total` at 0) the
 * same way the README's own prose does, without inventing a value nothing
 * computed. Nothing about a setup line is painted or shown as source: the
 * figure's own `lines` are the whole of what the reader sees, in the image
 * and in the copyable block beneath it.
 */
async function runSetup(client, lines, filename) {
  if (!lines || !lines.length) return;
  await walkStatements(client, lines, filename, async () => {});
}

/** Cursor path: one `eval` per statement, `present` -> `capNames` -> paint. */
async function renderCursor(client, spec, filename) {
  const annotations = [];
  await walkStatements(client, spec.lines, filename, async (line, response) => {
    let shown = present(response, line);
    if (shown.kind === 'value') shown = capNames(shown, 4);
    if (shown.kind === 'value' || shown.kind === 'error') {
      annotations.push(toAnnotation(shown, spec.lines));
    } else {
      console.error(`${spec.output}: line ${line + 1} produced "${shown.kind}", not painted`);
    }
  });
  return annotations;
}

/**
 * The load path: one `eval_file` request, `PaintedAbove` suppressing an
 * unchanged repeat exactly as a real `Evaluate File` does, `capNames`
 * applied by `PaintedAbove.keep` itself. Unchanged from the script this was
 * promoted from -- it is what already produces `hero.png` and
 * `spot-the-bug.png` byte-for-byte, and nothing about the six new cursor and
 * watch figures touches it.
 */
async function renderLoad(client, spec, filename) {
  const annotations = [];
  const loaded = await client.request({
    op: 'eval_file', source: spec.lines.join('\n') + '\n', filename,
    path: filename, allow_stdin: false,
  });
  const above = new PaintedAbove();
  for (const outcome of loaded.results || []) {
    if (!outcome.ok) {
      console.error(`${spec.output}: a load statement failed:`, JSON.stringify(outcome).slice(0, 160));
      continue;
    }
    const printed = printedFrom(outcome.stdout, outcome.stderr);
    const kept = above.keep({ ...outcome, printed });
    if (kept === undefined) continue;
    const shown = capNames({ kind: 'value', ...kept, more: kept.more_names }, 4);
    annotations.push({
      range: new mock.Range(
        kept.range.start.line, kept.range.start.character,
        kept.range.end.line, kept.range.end.character),
      ...(kept.anchor !== undefined ? { anchor: kept.anchor } : {}),
      source: spec.lines.slice(kept.range.start.line, kept.range.end.line + 1).join('\n'),
      value: kept.value === null ? undefined : kept.value,
      display: kept.display,
      ...(kept.loop ? { loop: kept.loop } : {}),
      ...(kept.bindings ? { bindings: kept.bindings } : {}),
      ...(shown.names ? { names: shown.names } : {}),
      ...(shown.more !== undefined ? { more: shown.more } : {}),
      ...(kept.is_binding !== undefined ? { isBinding: kept.is_binding } : {}),
      ...(printed ? { printed } : {}),
    });
  }
  return annotations;
}

/**
 * `eval_watch`, once, on the loop the spec's `line`/`character` resolve to --
 * #48's "a trace, not a watch". `addInlineWatch` (`src/evaluate.ts`) builds
 * its annotation straight from `present()`'s output with **no** `capNames`
 * step, because the real command never applies one either: a nomination adds
 * at most one more name to a loop's own trace, which is not the wall of
 * names `capNames` exists to cut down. Matching that exactly, rather than
 * capping here "to be safe", is the point -- a still that capped when the
 * real command would not is a still that asserts something the tool does
 * not.
 */
async function renderWatch(client, spec, filename) {
  const source = spec.lines.join('\n') + '\n';
  const response = await client.request({
    op: 'eval_watch', source, line: 0, character: 0, filename,
    allow_stdin: false, watch: spec.watch,
  });
  const shown = present(response, 0);
  if (shown.kind !== 'value' && shown.kind !== 'error') {
    console.error(`${spec.output}: watch produced "${shown.kind}", not painted`);
    return [];
  }
  return [toAnnotation(shown, spec.lines)];
}

// -------------------------------------------------------------- HTML build
/**
 * `calls` is every `setDecorations(type, options)` the real `Decorator.show`
 * made, captured in the order it made them by the mock editor below. Two
 * things about turning that into per-line styles are easy to get wrong:
 *
 * - **A decoration type's own base `after` (set once, in its constructor) is
 *   not repeated on every range.** `errorType`'s colour, background, border
 *   and chip shape are all set there, once, and a plain (non-stale) error's
 *   per-range `renderOptions.after` carries only `margin` and `contentText`
 *   -- so reading the per-range object alone silently drops the colour an
 *   error is supposed to be painted in. Every style below is the type's own
 *   `after` merged with the range's, range winning where both set the same
 *   key -- real VS Code decoration semantics, not an approximation of them.
 * - **Which gutter marker a line gets is real data, not a guess.** The three
 *   marker types (`evaluated`, `stale`, `error`) are told apart by which
 *   `evaluated-dark.svg`/`stale-dark.svg`/`error-dark.svg` their (mocked)
 *   `gutterIconPath` points at, so an erroring line gets the error glyph
 *   because the real `Decorator` chose it, not because this script assumed
 *   every painted line looks the same.
 */
function buildHtml(spec, annotations) {
  const lines = spec.lines;
  const calls = [];
  const editor = {
    document: {
      lineCount: lines.length,
      lineAt: (n) => ({ text: lines[n], range: new mock.Range(n, 0, n, lines[n].length) }),
    },
    options: { tabSize: 4 },
    setDecorations(type, options) { if (options.length) calls.push({ type, options }); },
  };
  new Decorator({ fsPath: ROOT }).show(editor, annotations);

  const perLine = lines.map(() => []);
  const regionLines = new Set();
  const markerByLine = new Map();
  for (const { type, options } of calls) {
    const base = type._options || {};
    const dark = base.dark;
    const iconPath = dark && dark.gutterIconPath && dark.gutterIconPath.fsPath;
    const marker = iconPath
      && ['evaluated', 'stale', 'error'].find((m) => iconPath.endsWith(`${m}-dark.svg`));
    if (marker) {
      for (const o of options) markerByLine.set(o.range.start.line, marker);
      continue;
    }
    for (const o of options) {
      const after = o.renderOptions && o.renderOptions.after;
      if (after) {
        perLine[o.range.start.line].push({ ...base.after, ...after });
      } else if (base.backgroundColor && base.backgroundColor.id === 'evalens.evaluatedRegionBackground') {
        for (let l = o.range.start.line; l <= o.range.end.line; l += 1) regionLines.add(l);
      }
    }
  }

  const span = (a) => {
    const style = [`color:${hex(a.color)}`];
    if (a.backgroundColor) style.push(`background-color:${hex(a.backgroundColor)}`);
    if (a.border) style.push(`border:${a.border}`);
    if (a.borderColor) style.push(`border-color:${hex(a.borderColor)}`);
    if (a.textDecoration) style.push(`text-decoration:${a.textDecoration}`);
    if (a.margin) style.push(`margin:${a.margin}`);
    if (a.fontStyle) style.push(`font-style:${a.fontStyle}`);
    return `<span style="${style.join(';')}">${esc(a.contentText)}</span>`;
  };

  const gutterCache = new Map();
  const gutterUri = (marker) => {
    if (!gutterCache.has(marker)) {
      const svg = fs.readFileSync(
        path.join(ROOT, 'media', 'gutter', `${marker}-dark.svg`), 'utf8');
      gutterCache.set(marker, `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
    }
    return gutterCache.get(marker);
  };

  const rows = lines.map((text, i) => {
    const code = tokenize(text)
      .map(([t, c]) => `<span class="tok tok-${c}">${nbsp(esc(t))}</span>`).join('');
    const ann = perLine[i].map(span).join('');
    const marker = markerByLine.get(i);
    const glyph = marker
      ? `<img src="${gutterUri(marker)}" width="13" height="13" alt="">` : '';
    const region = regionLines.has(i) ? ' region' : '';
    return `<div class="line"><div class="glyph">${glyph}</div>`
      + `<div class="lineno">${i + 1}</div>`
      + `<div class="content"><span class="view-lines">`
      + `<span class="${region.trim()}">${code}</span>${ann}</span></div></div>`;
  }).join('\n');

  const width = spec.width || 640;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#0d1117}*{box-sizing:border-box}
body{display:inline-flex;padding:20px;font-family:-apple-system,"Segoe UI",sans-serif}
.window{width:${width}px;border-radius:8px;overflow:hidden;background:#1e1e1e;box-shadow:0 18px 46px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.4)}
.titlebar{height:30px;background:#323233;display:flex;align-items:center;padding:0 12px;position:relative;border-bottom:1px solid #000}
.dots{display:flex;gap:7px}.dot{width:11px;height:11px;border-radius:50%}.dot.red{background:#ff5f57}.dot.yellow{background:#febc2e}.dot.green{background:#28c840}
.titletext{position:absolute;left:0;right:0;text-align:center;color:#9d9d9d;font-size:12px}
.tabbar{height:34px;background:#252526;display:flex;align-items:stretch;border-bottom:1px solid #1e1e1e}
.tab{display:flex;align-items:center;gap:7px;padding:0 14px;background:#1e1e1e;color:#e8e8e8;font-size:13px;border-right:1px solid #252526;border-top:2px solid #d1a35c}
.tabicon{width:8px;height:8px;border-radius:2px;background:linear-gradient(135deg,#ffd43b,#3776ab)}
.editor{background:#1e1e1e;padding:9px 0}
.line{display:flex;align-items:flex-start;height:20px;line-height:20px}
.glyph{width:18px;flex:0 0 18px;display:flex;align-items:center;justify-content:center;opacity:.95}.glyph img{display:block}
.lineno{width:26px;flex:0 0 26px;text-align:right;padding-right:12px;color:#6e7681;font:12px Menlo,"SF Mono",monospace}
.content{flex:1 1 auto;min-width:0}.view-lines{white-space:nowrap;font:12px Menlo,"SF Mono",monospace}.view-lines span{display:inline-block}
.region{background:rgba(74,156,140,.13)}
.tok-d,.tok-id{color:#9cdcfe}.tok-d{color:#d4d4d4}.tok-num{color:#b5cea8}.tok-fn{color:#dcdcaa}.tok-kw{color:#c586c0}.tok-kw2{color:#569cd6}.tok-str{color:#ce9178}.tok-cmt{color:#6a9955}
</style></head><body><div><div class="window">
<div class="titlebar"><div class="dots"><div class="dot red"></div><div class="dot yellow"></div><div class="dot green"></div></div><div class="titletext">${esc(spec.title)} — evalens</div></div>
<div class="tabbar"><div class="tab"><span class="tabicon"></span>${esc(spec.title)}</div></div>
<div class="editor">\n${rows}\n</div></div></div></body></html>`;
}

// ------------------------------------------------------------------ Chrome
function findChrome() {
  const candidates = [
    process.env.EVALENS_CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      'render-stills: no Chrome/Chromium found. Set EVALENS_CHROME_PATH to one.');
  }
  return found;
}

/**
 * `html` shot at 2x, cropped to its own content rather than to a hand-picked
 * window size: `fullPage` asks Chrome for the page's real layout box, so the
 * pixel math (chip padding, line height, the titlebar/tabbar chrome) never
 * has to be re-derived here by hand, and can never quietly drift from it.
 */
async function shoot(browser, html) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 100, height: 100, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'load' });
    return await page.screenshot({ fullPage: true });
  } finally {
    await page.close();
  }
}

// -------------------------------------------------------------------- spec
/**
 * `specHash` (from `./stills-hash.js`) is a sha256 over every field but
 * `hash` itself, so the file can carry its own freshness check --
 * "regenerate `docs/stills/x.json` and `media/demo/x.png` stop matching" --
 * without a second manifest file to keep in sync, and `stills.test.ts`
 * checks the very same function against what is actually committed. Key
 * order is whatever `fs.readFileSync` + `JSON.parse` handed back, which is
 * source order; this script always writes `hash` last (see `writeSpec`), so
 * that order -- and therefore the hash -- stays stable across regenerations
 * that change nothing.
 */
function writeSpec(specPath, spec, hash) {
  const { hash: _oldHash, ...rest } = spec;
  fs.writeFileSync(specPath, `${JSON.stringify({ ...rest, hash }, null, 2)}\n`);
}

async function renderSpec(specPath, browser) {
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const currentHash = specHash(spec);
  const outputPath = path.join(ROOT, spec.output);

  if (spec.hash === currentHash && fs.existsSync(outputPath)) {
    return 'unchanged';
  }

  const base = path.basename(specPath, '.json');
  const filename = `/tmp/evalens-still-${base}.py`;
  const client = new KernelClient({
    resolvePython: async () => 'python3',
    kernelPath: path.join(ROOT, 'kernel', 'evalens_kernel.py'),
  });
  let annotations;
  try {
    await runSetup(client, spec.setup, `/tmp/evalens-still-${base}-setup.py`);
    if (spec.mode === 'load') annotations = await renderLoad(client, spec, filename);
    else if (spec.mode === 'watch') annotations = await renderWatch(client, spec, filename);
    else annotations = await renderCursor(client, spec, filename);
  } finally {
    client.dispose();
  }

  const html = buildHtml(spec, annotations);
  const png = await shoot(browser, html);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, png);
  writeSpec(specPath, spec, currentHash);
  console.log(`rendered ${path.relative(ROOT, specPath)} -> ${spec.output}`);
  return 'rendered';
}

async function main() {
  const args = process.argv.slice(2);
  const specPaths = (args.length
    ? args.map((p) => path.resolve(p))
    : fs.readdirSync(STILLS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(STILLS_DIR, f))
  ).sort();

  if (!specPaths.length) {
    console.log('render-stills: no specs found under docs/stills/');
    return;
  }

  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
  });
  const counts = { rendered: 0, unchanged: 0 };
  try {
    for (const specPath of specPaths) {
      const outcome = await renderSpec(specPath, browser);
      counts[outcome] += 1;
    }
  } finally {
    // Belt and suspenders on the resource rule: `browser.close()` asks
    // Chrome to shut down over CDP, and killing the process this script
    // itself launched is the fallback for the case where it does not.
    const proc = browser.process();
    await browser.close();
    if (proc && proc.pid && proc.exitCode === null && proc.signalCode === null) {
      try { process.kill(proc.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
  console.log(`render-stills: ${counts.rendered} rendered, ${counts.unchanged} unchanged`);
}

main().catch((error) => {
  console.error('render-stills FAILED:', error.stack || error);
  process.exitCode = 1;
});
