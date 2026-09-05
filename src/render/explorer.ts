import * as vscode from 'vscode';

import { KernelClient } from '../kernel/client';
import { InspectStep, Inspected, isFailure } from '../kernel/protocol';
import {
  breadcrumbTitle, InspectPickItem, quickPickItems,
} from './inspector';

/**
 * The command #23's own recommendation names as the fallback for going a
 * level deeper than a hover can lay out: "a command for drill-down... where
 * picking a field re-inspects it, so drilling in is a sequence of picks".
 *
 * No new surface beyond the QuickPick VS Code already ships, and every pick
 * is answered by the same `inspect` op the hover's table uses -- this never
 * builds an address of its own, it only extends the `path` a previous
 * response already handed back in `InspectChild.step`. See `inspector.ts`
 * for why that matters: a step this module invented would be trusting its
 * own guess about a type it has never seen the definition of.
 */
export const INSPECT_VALUE = 'evalens.inspectValue';

/** One level of the walk: the path that reached it, and its own label. */
interface Frame {
  readonly path: readonly InspectStep[];
  readonly label: string;
}

const BACK: InspectPickItem = { label: '$(arrow-left) Back' };

/**
 * Walk a value's children with the keyboard, one `inspect` request per pick.
 *
 * A loop over `showQuickPick` rather than a tree view, on rule 7's own
 * terms: this opens over the editor and closes the moment the reader is
 * done with it, rather than claiming a panel for the life of the session.
 * Cancelling (`Escape`) at any depth simply stops -- there is nothing open
 * to tear down, because nothing but this promise chain is running.
 */
export async function exploreValue(
  client: KernelClient, name: string, rootLabel: string
): Promise<void> {
  const trail: Frame[] = [{ path: [], label: rootLabel }];

  for (;;) {
    const here = trail[trail.length - 1];
    let response;
    try {
      response = await client.request(
        { op: 'inspect', name, path: here.path });
    } catch (error) {
      vscode.window.showWarningMessage(
        `Evalens: could not inspect ${here.label}: ${(error as Error).message}`);
      return;
    }
    if (isFailure(response)) {
      vscode.window.showWarningMessage(
        `Evalens: could not inspect ${here.label} -- ${response.error.message}`);
      return;
    }

    const inspected = response as Inspected;
    const items = quickPickItems(inspected);
    if (items.length === 0) {
      vscode.window.showInformationMessage(
        `Evalens: ${here.label} has nothing more to show.`);
      return;
    }

    const picked = await vscode.window.showQuickPick(
      trail.length > 1 ? [BACK, ...items] : items,
      {
        title: breadcrumbTitle(trail.map((frame) => frame.label)),
        placeHolder: `{${inspected.type}} ${inspected.value ?? ''}`,
        matchOnDescription: true,
        matchOnDetail: true,
      }
    );

    if (picked === undefined) {
      return; // Escape: the reader is done, not stuck.
    }
    if (picked === BACK) {
      trail.pop();
      continue;
    }
    if (!picked.child?.expandable || picked.child.step === undefined) {
      // A leaf, or a property: nothing to open. Its value was already the
      // detail line under it, so re-showing the same list rather than
      // ending the walk is the answer that matches what just happened --
      // "you looked at a value", not "you are done exploring".
      continue;
    }
    trail.push({
      path: [...here.path, picked.child.step],
      label: picked.child.name,
    });
  }
}
