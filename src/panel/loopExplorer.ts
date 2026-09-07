import {
  LoopExplorerWire, LoopInvocation, LoopIteration, LoopOffsets, LoopSite,
} from '../kernel/protocol';

type Entry = LoopInvocation | LoopIteration;
export const LOOP_ENTRY_LIMIT = 2000;
export const LOOP_VISIBLE_LIMIT = 120;
export const LOOP_PAGE_SIZE = 20;
export const LOOP_TEXT_CHUNK = 2000;
const RETAINED_LIMIT = 65536;
const SMALL_RUN = 24;

export interface LoopViewState {
  readonly identity: number;
  readonly expanded: Map<number, boolean>;
  readonly pages: Map<number, number>;
  readonly textPages: Map<string, number>;
  readonly expandedGaps: Set<string>;
  selected?: number;
}
export function newLoopViewState(identity = 0): LoopViewState {
  return { identity, expanded: new Map(), pages: new Map(), textPages: new Map(),
    expandedGaps: new Set() };
}

/** Bounded maps plus a single conversion of each retained stream. Python
 * offsets are code points; JS slicing directly would split emoji/surrogates. */
export interface LoopExplorer {
  readonly wire: LoopExplorerWire;
  readonly entries: ReadonlyMap<number, Entry>;
  readonly sites: ReadonlyMap<number, LoopSite>;
  readonly children: ReadonlyMap<number, readonly Entry[]>;
  readonly roots: readonly LoopInvocation[];
  readonly streams: readonly [string, string];
  readonly offsets: readonly [readonly number[], readonly number[]];
}
function natural(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}
function pair(value: unknown): value is LoopOffsets {
  return Array.isArray(value) && value.length === 2 && value.every(natural);
}
function contained(child: Entry, parent: Entry): boolean {
  return child.start.every((n, i) => n >= parent.start[i]!
    && child.end[i]! <= parent.end[i]!);
}
function unitOffsets(text: string, count: number): number[] | undefined {
  const result = [0];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    if (offset >= text.length) return undefined;
    const point = text.codePointAt(offset)!;
    offset += point > 0xffff ? 2 : 1;
    result.push(offset);
  }
  return result;
}

/** Fail closed on missing/corrupt/incomplete metadata, preserving the flat
 * original output. No inference can repair a missing parent relationship. */
export function prepareLoopExplorer(
  wire: LoopExplorerWire | undefined, stdout = '', stderr = ''
): LoopExplorer | undefined {
  if (!wire || wire.version !== 1 || !natural(wire.statement_line) || !Array.isArray(wire.sites)
    || wire.sites.length < 1 || wire.sites.length > 64
    || !Array.isArray(wire.entries) || wire.entries.length > LOOP_ENTRY_LIMIT
    || !pair(wire.retained) || !pair(wire.totals)
    || wire.retained.some((n, i) => n > RETAINED_LIMIT || n > wire.totals[i]!)
    || ![wire.iterations, wire.invocations, wire.omitted_iterations,
      wire.omitted_invocations].every(natural)
    || !Array.isArray(wire.final_values) || wire.final_values.length > 100) return;
  const sites = new Map<number, LoopSite>();
  for (const site of wire.sites) {
    if (!site || !natural(site.id) || sites.has(site.id) || !natural(site.line)
      || typeof site.target !== 'string' || site.target.length > 500
      || typeof site.source !== 'string' || site.source.length > 1000
      || (site.parent !== null && !sites.has(site.parent))) return;
    sites.set(site.id, site);
  }
  const entries = new Map<number, Entry>();
  const children = new Map<number, Entry[]>();
  const roots: LoopInvocation[] = [];
  let lastId = 0;
  let retainedIterations = 0;
  let retainedInvocations = 0;
  for (const entry of wire.entries as readonly Entry[]) {
    if (!entry || !natural(entry.id) || entry.id <= lastId
      || !pair(entry.start) || !pair(entry.end)
      || entry.start.some((n, i) => n > entry.end[i]! || entry.end[i]! > wire.totals[i]!)) return;
    lastId = entry.id;
    let parentId: number | null;
    if (entry.kind === 'invocation') {
      if (!sites.has(entry.site) || !natural(entry.count)) return;
      parentId = entry.parent ?? entry.parent_invocation;
      if (parentId === null) roots.push(entry);
      else if (entries.get(parentId)?.kind !== (entry.parent === null
        ? 'invocation' : 'iteration')) return;
      if (entry.parent_invocation !== null
        && entries.get(entry.parent_invocation)?.kind !== 'invocation') return;
      retainedInvocations++;
    } else if (entry.kind === 'iteration') {
      if (!natural(entry.ordinal) || entry.ordinal === 0
        || typeof entry.value !== 'string' || entry.value.length > 1000
        || entries.get(entry.invocation)?.kind !== 'invocation') return;
      parentId = entry.invocation;
      const invocation = entries.get(parentId) as LoopInvocation;
      if (entry.ordinal > invocation.count) return;
      retainedIterations++;
    } else return;
    if (parentId !== null) {
      const parent = entries.get(parentId);
      if (!parent || !contained(entry, parent)) return;
      const siblings = children.get(parentId) ?? [];
      const previous = siblings[siblings.length - 1];
      if (previous && entry.start.some((n, i) => n < previous.end[i]!)) return;
      if (entry.kind === 'iteration' && entry.ordinal !== siblings.filter(
        (s) => s.kind === 'iteration').length + 1) return;
      siblings.push(entry);
      children.set(parentId, siblings);
    }
    entries.set(entry.id, entry);
  }
  if (!roots.length || retainedIterations + wire.omitted_iterations !== wire.iterations
    || retainedInvocations + wire.omitted_invocations !== wire.invocations) return;
  const outOffsets = unitOffsets(stdout, wire.retained[0]);
  const errOffsets = unitOffsets(stderr, wire.retained[1]);
  if (!outOffsets || !errOffsets) return;
  if (wire.final_values.some((v) => !v || typeof v.name !== 'string'
    || typeof v.value !== 'string' || v.name.length > 1000 || v.value.length > 1000)) return;
  return { wire, entries, sites, children, roots,
    streams: [stdout, stderr], offsets: [outOffsets, errOffsets] };
}

export function loopSlice(
  model: LoopExplorer, start: LoopOffsets, end: LoopOffsets, stream: 0 | 1
): string {
  const retained = model.wire.retained[stream];
  return model.streams[stream].slice(
    model.offsets[stream][Math.min(start[stream], retained)],
    model.offsets[stream][Math.min(end[stream], retained)]);
}
function e(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function count(n: number, noun: string): string {
  return `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`;
}
function lines(text: string): number {
  if (!text) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') n++;
  return n + (text.endsWith('\n') ? 0 : 1);
}
function canFold(model: LoopExplorer, entry: LoopIteration): boolean {
  // A few short printed lines still form one readable table row in a simple
  // loop. Nested groups keep their established, denser disclosure threshold.
  const singleLevel = model.sites.size === 1;
  const spans = entry.end.map((n, i) => n - entry.start[i]!);
  if ((model.children.get(entry.id)?.length ?? 0) > 0
    || (singleLevel ? spans[0]! + spans[1]! > 160 : spans.some((n) => n > 160))) return true;
  const outputLines = [0, 1].map((stream) =>
    lines(loopSlice(model, entry.start, entry.end, stream as 0 | 1)));
  return singleLevel ? outputLines[0]! + outputLines[1]! > 3
    : outputLines.some((n) => n > 1);
}
export function loopExpanded(
  model: LoopExplorer, entry: LoopIteration, state?: LoopViewState
): boolean {
  return state?.expanded.get(entry.id) ?? (model.wire.iterations <= SMALL_RUN
    && (model.children.get(entry.id)?.length ?? 0) > 0);
}
export function invocationExpanded(
  model: LoopExplorer, entry: LoopInvocation, state?: LoopViewState
): boolean {
  return state?.expanded.get(entry.id) ?? model.wire.iterations <= SMALL_RUN;
}

/** A hard DOM budget applies even when every retained node has been opened.
 * Pagination replaces old entries/chunks; hidden text is never in the DOM. */
export function loopExplorerHtml(
  model: LoopExplorer, line: number, state?: LoopViewState, outputLines = 20
): string {
  let remaining = LOOP_VISIBLE_LIMIT;
  let exhausted = false;
  let columnsShown = false;
  const button = (label: string, action: string, id: number, value = 0,
    extra = ''): string => `<button type="button" class="loop-action" `
    + `data-loop-action="${action}" data-loop-line="${line}" `
    + `data-loop-token="${state?.identity ?? 0}" `
    + `data-loop-control="${label.startsWith('Previous') ? 'previous' : 'next'}" `
    + `data-loop-id="${id}" data-loop-value="${value}" ${extra}>${label}</button>`;
  const output = (start: LoopOffsets, end: LoopOffsets, key: number,
    gap: number, empty = false): string => {
    const pieces: string[] = [];
    for (const stream of [0, 1] as const) {
      const text = loopSlice(model, start, end, stream);
      const clipped = end[stream] > start[stream]
        && end[stream] > model.wire.retained[stream];
      if (!text && !clipped) continue;
      const textKey = `${key}:${gap}:${stream}`;
      const page = Math.max(0, state?.textPages.get(textKey) ?? 0);
      // A page is capped by BOTH character count and logical lines. Chunk
      // boundaries are stable, so moving through output never skips text.
      const chunks = textChunks(text, outputLines);
      const selected = Math.min(page, chunks.length - 1);
      const raw = chunks[Math.max(0, selected)] ?? '';
      const shown = raw.replace(/\r?\n$/, '') || (text ? '(blank line)' : '');
      const label = stream ? '<span class="loop-stream-label">stderr: </span>' : '';
      const paging = chunks.length > 1
        ? `<div class="loop-note">Output part ${selected + 1} of ${chunks.length} · `
          + (selected > 0 ? button('Previous output', `text:${gap}:${stream}`, key, selected - 1) + ' · ' : '')
          + (selected < chunks.length - 1 ? button('More output', `text:${gap}:${stream}`, key, selected + 1) + ' · ' : '')
          + button('Open captured output', 'open', key, stream) + '</div>' : '';
      pieces.push(`<div class="loop-stream">${label}<span class="loop-output">${e(shown)}</span>${paging}`
        + (clipped ? '<div class="loop-note">Further output was not retained.</div>' : '') + '</div>');
    }
    if (!pieces.length) return empty ? '<span class="loop-note">No output</span>' : '';
    return pieces.join('');
  };
  const outputCount = (entry: LoopIteration): string => {
    const parts: string[] = [];
    for (const stream of [0, 1] as const) {
      const label = stream ? 'stderr' : 'printed';
      if (entry.end[stream] > entry.start[stream]
        && entry.end[stream] > model.wire.retained[stream]) {
        parts.push(`${label} output not fully retained`);
      } else {
        const text = loopSlice(model, entry.start, entry.end, stream);
        if (text) parts.push(`${label} ${count(lines(text), 'line')}`);
      }
    }
    return parts.length ? parts.join(' · ') : 'No output';
  };
  const gapHtml = (start: LoopOffsets, end: LoopOffsets, id: number,
    gap: number, incomplete = false): string => {
    // A gap after capture metadata fills has no trustworthy iteration owner.
    // Give its retained text its own fold instead of leaking it below folded
    // iterations or assigning it to the last retained iteration. Text that
    // was never captured stays an omission notice, not an expandable promise.
    if (incomplete && start.some((n, stream) =>
      Math.min(end[stream]!, model.wire.retained[stream]!) > n)) {
      const expanded = state?.expandedGaps.has(`${id}:${gap}`) ?? false;
      const toggle = button(`<span class="loop-disclosure" aria-hidden="true">${expanded ? '▾' : '▸'}</span> `
        + 'Output without retained iteration detail', `gap:${gap}`, id, 0,
        `aria-expanded="${expanded}"`);
      return '<div class="loop-data loop-direct loop-unattributed"><span></span><div>'
        + `<div class="loop-note">${toggle}</div>`
        + (expanded ? output(start, end, id, gap) : '') + '</div></div>';
    }
    const content = output(start, end, id, gap);
    return content ? `<div class="loop-data loop-direct"><span></span><div>${content}</div></div>` : '';
  };
  const invocationHtml = (invocation: LoopInvocation, depth: number,
    root = false, singleChild = false): string => {
    if (remaining-- <= 0) { exhausted = true; return ''; }
    const site = model.sites.get(invocation.site)!;
    const children = model.children.get(invocation.id) ?? [];
    const iterationCount = children.filter((c) => c.kind === 'iteration').length;
    const page = Math.max(0, Math.min(state?.pages.get(invocation.id) ?? 0,
      Math.floor(Math.max(0, children.length - 1) / LOOP_PAGE_SIZE)));
    const from = page * LOOP_PAGE_SIZE;
    const selected = children.slice(from, from + LOOP_PAGE_SIZE);
    // The parent iteration is already a fold for its only inner loop. Keep
    // independent invocation folds when there are real sibling choices, so
    // later invocations remain reachable under the shared display budget.
    const foldable = !root && !singleChild && invocation.count > 0
      && model.wire.iterations > SMALL_RUN;
    const expanded = !foldable || invocationExpanded(model, invocation, state);
    const source = foldable
      ? button(`<span class="loop-disclosure" aria-hidden="true">${expanded ? '▾' : '▸'}</span> `
        + e(site.source), 'toggle-invocation', invocation.id, 0,
        `aria-expanded="${expanded}"`) : e(site.source);
    const header = `<div class="loop-source${root ? ' loop-root-source' : ''}">${source}`
      + ` <span class="loop-note">· ${count(invocation.count, 'iteration')}`
      + (root ? '' : ` · line ${line + site.line - model.wire.statement_line + 1}`) + '</span></div>';
    const columns = !columnsShown && root
      ? '<div class="loop-columns"><span>Iteration values</span><span>Printed output</span></div>' : '';
    if (root) columnsShown = true;
    if (!expanded) return `<section class="loop-invocation" data-loop-invocation="${invocation.id}">`
      + header + '</section>';
    let body = '';
    let cursor = from === 0 ? invocation.start : children[from - 1]!.end;
    selected.forEach((iteration, index) => {
      if (remaining <= 0) { exhausted = true; return; }
      body += gapHtml(cursor, iteration.start, invocation.id, from + index);
      body += iteration.kind === 'iteration' ? iterationHtml(iteration, site, depth)
        : invocationHtml(iteration, depth + 1);
      cursor = iteration.end;
    });
    const end = Math.min(from + LOOP_PAGE_SIZE, children.length);
    if (end === children.length && !exhausted) {
      body += gapHtml(cursor, invocation.end, invocation.id, children.length,
        invocation.incomplete);
    }
    if (invocation.count === 0) body += '<div class="loop-note">No iterations</div>';
    if (iterationCount < invocation.count) body += `<div class="loop-note">`
      + `${count(invocation.count - iterationCount, 'iteration')} not individually retained.</div>`;
    const paging = children.length > LOOP_PAGE_SIZE ? `<div class="loop-paging loop-note">`
      + `${iterationCount === children.length ? 'Iterations' : 'Trace entries'} ${from + 1}–${end} of ${children.length} retained · `
      + (from > 0 ? button('Previous iterations', 'page', invocation.id, page - 1) + ' · ' : '')
      + (end < children.length ? button('More iterations', 'page', invocation.id, page + 1) : '') + '</div>' : '';
    return `<section class="loop-invocation" data-loop-invocation="${invocation.id}">`
      + header + columns + body + paging + '</section>';
  };
  const iterationHtml = (entry: LoopIteration, site: LoopSite, depth: number): string => {
    if (remaining-- <= 0) { exhausted = true; return ''; }
    const children = model.children.get(entry.id) ?? [];
    const foldable = canFold(model, entry);
    const expanded = loopExpanded(model, entry, state);
    const selected = state?.selected === entry.id ? ' loop-selected' : '';
    const label = `${site.target} = ${entry.value}`;
    const selection = button(e(label), 'select', entry.id, 0,
      `aria-label="${e(`Iteration ${entry.ordinal}, ${label}; reveal loop header`)}"`);
    if (!foldable) return `<div class="loop-data loop-iteration${selected}" data-loop-entry="${entry.id}">`
      + `<div class="loop-target">${selection}</div><div>${output(entry.start, entry.end, entry.id, 0, true)}</div></div>`;
    const toggle = button(`<span class="loop-disclosure" aria-hidden="true">${expanded ? '▾' : '▸'}</span> `
      + `Iteration ${entry.ordinal}`, 'toggle', entry.id, 0,
      `aria-expanded="${expanded}" aria-label="${e(`Iteration ${entry.ordinal}, ${label}`)}"`);
    let body = '';
    if (expanded) {
      const page = Math.max(0, Math.min(state?.pages.get(entry.id) ?? 0,
        Math.floor(Math.max(0, children.length - 1) / LOOP_PAGE_SIZE)));
      const from = page * LOOP_PAGE_SIZE;
      const end = Math.min(from + LOOP_PAGE_SIZE, children.length);
      let cursor = from === 0 ? entry.start : children[from - 1]!.end;
      children.slice(from, end).forEach((child, index) => {
        if (remaining <= 0) { exhausted = true; return; }
        body += gapHtml(cursor, child.start, entry.id, from + index);
        body += invocationHtml(child as LoopInvocation, depth + 1, false, children.length === 1);
        cursor = child.end;
      });
      if (!exhausted && end === children.length) body += gapHtml(cursor, entry.end, entry.id,
        children.length, entry.incomplete);
      if (children.length > LOOP_PAGE_SIZE) body += `<div class="loop-paging loop-note">`
        + `Nested loops ${from + 1}–${end} of ${children.length} retained · `
        + (from > 0 ? button('Previous nested loops', 'page', entry.id, page - 1) + ' · ' : '')
        + (end < children.length ? button('More nested loops', 'page', entry.id, page + 1) : '') + '</div>';
    }
    return `<section class="loop-iteration loop-group${selected}" data-loop-entry="${entry.id}">`
      + `<div class="loop-iteration-header">${toggle} <span class="loop-note">·</span> ${selection} `
      + `<span class="loop-note">· ${e(outputCount(entry))}</span></div>`
      + (expanded ? `<div class="loop-body">${body}</div>` : '') + '</section>';
  };
  let cursor: LoopOffsets = [0, 0];
  const body = model.roots.map((root, index) => {
    const prefix = gapHtml(cursor, root.start, 0, index);
    cursor = root.end;
    return prefix + invocationHtml(root, 0, true);
  }).join('') + gapHtml(cursor, model.wire.totals, 0, model.roots.length,
    model.wire.omitted_invocations > 0);
  const omitted = model.wire.omitted_iterations
    ? `<div class="loop-notice">${count(model.wire.omitted_iterations, 'iteration')} `
      + 'not individually retained. Original captured output remains available.</div>' : '';
  const final = model.wire.final_values.length
    ? '<div class="loop-final">Values after loop: '
      + model.wire.final_values.map((v) => `${e(v.name)} = ${e(v.value)}`).join(', ') + '</div>' : '';
  const clipped = model.wire.totals.some((n, i) => n > model.wire.retained[i]!);
  return `<div class="loop-explorer" data-loop-root="${line}">`
    + body + (exhausted ? '<div class="loop-notice">Visible detail limit reached. Collapse a group to explore another.</div>' : '')
    + omitted + (clipped ? '<div class="loop-notice">Output capture is incomplete; unretained text cannot be expanded.</div>' : '')
    + final + `<div class="loop-export">${button('Open captured stdout', 'open', 0, 0)}`
    + (model.streams[1] ? ` · ${button('Open captured stderr', 'open', 0, 1)}` : '') + '</div></div>';
}

/** At most 65,536 retained code points enter this function. Never split an
 * arbitrarily large original output, and never put unshown chunks in HTML. */
function textChunks(text: string, requestedLines: number): string[] {
  const chunks: string[] = [];
  const lineLimit = Math.max(1, Math.min(20, requestedLines));
  let start = 0;
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') count++;
    const code = text.charCodeAt(i);
    const surrogate = code >= 0xd800 && code <= 0xdbff;
    if ((count >= lineLimit || i - start + 1 >= LOOP_TEXT_CHUNK) && !surrogate) {
      chunks.push(text.slice(start, i + 1)); start = i + 1; count = 0;
    }
  }
  if (start < text.length) chunks.push(text.slice(start));
  return chunks;
}
export const LOOP_EXPLORER_STYLE = `
.loop-explorer { font-style: normal; font-weight: normal; color: var(--vscode-editor-foreground); white-space: normal; min-width: 0; }
.loop-explorer button { font-family: inherit; font-size: inherit; font-style: normal; background: none; border: 0; padding: 0; cursor: pointer; color: inherit; text-align: left; }
.loop-explorer button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.loop-columns, .loop-data { display: grid; grid-template-columns: minmax(9ch, 1fr) minmax(12ch, 1.3fr); column-gap: 1.2em; }
.loop-columns { color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: .45em; margin: .15em 0 .6em; }
.loop-source { font-size: .88em; margin: .4em 0 .3em; overflow-wrap: anywhere; }
.loop-root-source { font-size: 1em; margin: .15em 0 .6em; }
.loop-group { margin: .6em 0 .8em; }
.loop-iteration-header { color: var(--vscode-evalens-resultForeground); overflow-wrap: anywhere; }
.loop-disclosure { color: var(--vscode-evalens-outputLabelForeground); }
.loop-data { padding: .12em .35em; }
.loop-body { margin-top: .25em; }
.loop-body .loop-invocation { margin-left: .6em; }
.loop-target { overflow-wrap: anywhere; }
.loop-output { white-space: pre-wrap; overflow-wrap: anywhere; }
.loop-note, .loop-final, .loop-export, .loop-notice { color: var(--vscode-descriptionForeground); font-size: .86em; }
.loop-stream-label { color: var(--vscode-evalens-outputLabelForeground); }
.loop-selected > .loop-iteration-header, .loop-data.loop-selected { background: var(--vscode-editor-rangeHighlightBackground); outline: 1px solid var(--vscode-focusBorder); }
.loop-notice, .loop-paging { margin: .5em 0; }
.loop-note .loop-action, .loop-export .loop-action { color: var(--vscode-textLink-foreground); }
.loop-final { margin-top: 1em; }
.loop-export { margin-top: .5em; }
body.vscode-high-contrast .loop-selected, body.vscode-high-contrast-light .loop-selected { outline: 1px solid var(--vscode-contrastActiveBorder); }
`;
