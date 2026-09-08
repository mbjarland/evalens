import { LoopExplorerWire, LoopHistory, LoopSite } from '../kernel/protocol';
import { hoverText, partialNote, Rendered } from './format';

interface CapturedLoops {
  readonly loopExplorer?: LoopExplorerWire;
  readonly range: { readonly start: { readonly line: number };
    readonly end: { readonly line: number } };
  readonly pending?: unknown;
  readonly error?: unknown;
  readonly staleReason?: string;
}
export interface InlineLoopHistory {
  readonly line: number;
  readonly site: LoopSite;
  readonly trace: LoopHistory;
}
const count = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;

/** These are views of one saved annotation, never independent evaluations.
 * Validate the complete bounded site set before placing any child history.
 * Detail entries can be missing: recorder summaries do not depend on them. */
export function inlineLoopHistories(
  annotation: CapturedLoops
): readonly InlineLoopHistory[] | undefined {
  const wire = annotation.loopExplorer;
  if (annotation.pending || annotation.error || !wire || wire.version !== 1
      || !count(wire.statement_line) || !Array.isArray(wire.sites)
      || wire.sites.length < 2 || wire.sites.length > 64
      || !Array.isArray(wire.histories)
      || wire.histories.length !== wire.sites.length) return undefined;
  const sites = new Map<number, LoopSite>();
  const lines = new Set<number>();
  for (const site of wire.sites) {
    if (!site || !count(site.id) || sites.has(site.id) || !count(site.line)
        || typeof site.target !== 'string' || site.target.length > 242
        || typeof site.source !== 'string' || site.source.length > 482
        || (sites.size === 0 ? site.parent !== null
          : !count(site.parent) || !sites.has(site.parent))) return undefined;
    const line = annotation.range.start.line + site.line - wire.statement_line;
    if (line < annotation.range.start.line || line > annotation.range.end.line
        || lines.has(line)) return undefined;
    lines.add(line);
    sites.set(site.id, site);
  }
  const seen = new Set<number>();
  const rows: InlineLoopHistory[] = [];
  for (const trace of wire.histories) {
    if (!trace || !count(trace.site) || seen.has(trace.site)
        || !count(trace.count) || !count(trace.invocations)
        || (trace.invocations === 0 && trace.count !== 0)
        || !Array.isArray(trace.values) || trace.values.length > 50
        || trace.values.length > trace.count
        || !trace.values.every((value: unknown) => typeof value === 'string' && value.length <= 1024)
        || (trace.count > trace.values.length
          ? typeof trace.last !== 'string' || trace.last.length > 1024
          : trace.last !== null)) return undefined;
    const site = sites.get(trace.site);
    if (!site) return undefined;
    seen.add(trace.site);
    rows.push({ site, trace,
      line: annotation.range.start.line + site.line - wire.statement_line });
  }
  return rows.sort((a, b) => a.line - b.line);
}

/** Normalize before file-load repeat suppression: a hidden final snapshot
 * must never make a later visible value look as if it was already painted. */
export function inlineLoopOwner<T extends CapturedLoops>(annotation: T): T {
  const histories = inlineLoopHistories(annotation);
  return histories
    ? { ...annotation, loop: histories[0]!.trace, names: [], more: 0 }
    : annotation;
}

/** The full saved sequence for the actual hovered header. Current namespace
 * inspection cannot explain an aggregate sequence and is deliberately absent. */
export function inlineLoopHover(
  annotation: CapturedLoops & Rendered, line: number
): string | undefined {
  const histories = inlineLoopHistories(annotation);
  if (!histories) return undefined;
  const selected = annotation.staleReason === 'edited' ? undefined
    : histories.find((history) => history.line === line);
  const root = histories[0]!;
  const caveat = annotation.partialFrom === undefined
    ? '' : `\n${partialNote(annotation.partialFrom)}`;
  if (selected && selected !== root) {
    return hoverText({ value: null, display: selected.site.target,
      loop: selected.trace }) + caveat;
  }
  const text = hoverText({ ...annotation, loop: root.trace, names: [], more: 0 });
  const snapshots = annotation.loopExplorer!.final_values;
  return text + caveat + (snapshots.length ? '\n\nFinal values after this loop:\n'
    + snapshots.map((item) => `${item.name} = ${item.value}`).join('\n') : '');
}
