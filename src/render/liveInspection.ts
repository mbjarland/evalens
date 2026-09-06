import type { CancellationToken } from 'vscode';
import { KernelClient } from '../kernel/client';
import { Inspected, isFailure } from '../kernel/protocol';

/** One optional read at a time; its deadline never cancels user execution. */
export class LiveInspection {
  private slot?: {
    client: KernelClient; name: string;
    result: Promise<Inspected | undefined>;
  };

  constructor(private readonly deadline = 100) {}

  async ask(
    client: KernelClient, name: string, token?: CancellationToken
  ): Promise<Inspected | undefined> {
    if (token?.isCancellationRequested) { return undefined; }
    if (this.slot && (this.slot.client !== client || this.slot.name !== name)) {
      return undefined;
    }
    if (!this.slot) {
      const slot = {
        client, name,
        result: client.requestIfIdle({ op: 'inspect', name, path: [] })
          .then((r) => r && !isFailure(r) ? r as Inspected : undefined)
          .catch(() => undefined),
      };
      this.slot = slot;
      void slot.result.finally(() => {
        if (this.slot === slot) { this.slot = undefined; }
      });
    }
    const result = this.slot.result;
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(undefined), this.deadline);
      let cancellation: { dispose(): void } | undefined;
      const finish = (value: Inspected | undefined): void => {
        clearTimeout(timer);
        cancellation?.dispose();
        resolve(value);
      };
      cancellation = token?.onCancellationRequested(() => finish(undefined));
      void result.then(finish);
    });
  }
}
