/** Whole-value disclosure state is independent of inner pages and folds.
 * Result identity survives reanchoring; coordinates alone cannot name a
 * capture. Only an unchanged complete statement may inherit the reader's
 * collapsed choice when a replacement result arrives. */
import { createHash } from 'node:crypto';

export interface ResultFoldRow {
  readonly resultIdentity?: object;
  readonly capturedSource?: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly line: number;
  readonly state: string;
  readonly staleReason?: string;
}

export interface ResultFoldState {
  readonly identity: number;
  collapsed: boolean;
  /** Existing generic Show all state follows the same capture, so prefix
   * edits cannot strand it on the old line while the whole result is shut. */
  expanded?: boolean;
}

interface RetainedFold {
  readonly row: Omit<ResultFoldRow, 'capturedSource'>;
  readonly sourceKey?: string;
  readonly state: ResultFoldState;
}

export class ResultFolds {
  private documents = new WeakMap<object, readonly RetainedFold[]>();
  private nextIdentity = 0;

  sync(document: object, rows: readonly ResultFoldRow[]): ReadonlyMap<number, ResultFoldState> {
    const previous = this.documents.get(document) ?? [];
    const position = (row: ResultFoldRow) => `${row.startLine}:${row.endLine}:${row.line}`;
    const byIdentity = new Map(previous.filter((item) => item.row.resultIdentity)
      .map((item) => [item.row.resultIdentity!, item]));
    const byPosition = new Map(previous.map((item) => [position(item.row), item]));
    const next: RetainedFold[] = [];
    const result = new Map<number, ResultFoldState>();
    for (const row of rows) {
      const same = row.resultIdentity && byIdentity.get(row.resultIdentity);
      const atPosition = byPosition.get(position(row));
      // A pending placeholder temporarily displaces the old capture. Keep
      // only its source/choice, then compare the *completed* replacement's
      // full captured source before transferring that choice.
      const pending = row.state === 'pending' && (atPosition ?? previous
        .filter((item) => row.startLine >= item.row.startLine && row.endLine <= item.row.endLine)
        .sort((a, b) => (a.row.endLine - a.row.startLine) - (b.row.endLine - b.row.startLine))[0]);
      const sourceKey = same ? same.sourceKey : pending ? pending.sourceKey
        : row.capturedSource === undefined ? undefined
          : createHash('sha256').update(row.capturedSource).digest('hex');
      const replacement = atPosition && atPosition.row.staleReason !== 'edited'
        && row.staleReason !== 'edited' && sourceKey !== undefined
        && sourceKey === atPosition.sourceKey;
      const state = same ? same.state : pending ? pending.state : {
        identity: ++this.nextIdentity,
        collapsed: !!replacement && atPosition.state.collapsed,
      };
      next.push({ row: {
        resultIdentity: row.resultIdentity,
        startLine: pending ? pending.row.startLine : row.startLine,
        endLine: pending ? pending.row.endLine : row.endLine,
        line: pending ? pending.row.line : row.line, state: row.state,
        staleReason: pending ? pending.row.staleReason : row.staleReason,
      }, sourceKey, state });
      result.set(row.line, state);
    }
    if (next.length) this.documents.set(document, next);
    else this.documents.delete(document);
    return result;
  }

  close(document: object): void { this.documents.delete(document); }
  clear(): void { this.documents = new WeakMap(); }
}
