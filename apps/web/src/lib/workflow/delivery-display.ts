/**
 * The serialisable slice of a DeliveryView that list surfaces carry to the
 * client (workflow-state-kernel §17.5, Slice E). Pure, no database import, so
 * a `'use client'` component may import it.
 *
 * Every surface that says where a kernel-owned PR stands (the task card's
 * stage, the mission strip, the chat dock and task object, the PR object,
 * explain's history) projects from this one shape into its own vocabulary.
 * None of them reads `workers.prLifecycleStatus` / `mergedAt` for a
 * kernel-owned delivery. A legacy-owned or PR-less task has no display and
 * keeps the fact-cache projection until the legacy population drains (§14).
 */
import type { PrDisplayState } from '@/lib/pr-presentation';
import { attemptLine, type DeliveryStage, type DeliveryView, type NextMoveOwner } from './projections';
import type { DeliveryState } from './types';

export interface DeliveryDisplay {
  ownerTaskId: string;
  state: DeliveryState;
  stage: DeliveryStage;
  owner: NextMoveOwner;
  needsYou: boolean;
  headline: string;
  detail: string | null;
  prNumber: number | null;
  prState: PrDisplayState | null;
  /** "CI 1 of 3 · review 1 of 3", or null when the ledger is empty. */
  attemptLine: string | null;
}

export function toDeliveryDisplay(v: DeliveryView): DeliveryDisplay {
  return {
    ownerTaskId: v.ownerTaskId,
    state: v.state,
    stage: v.stage,
    owner: v.owner,
    needsYou: v.needsYou,
    headline: v.headline,
    detail: v.detail,
    prNumber: v.prNumber,
    prState: v.prState,
    attemptLine: attemptLine(v.attempts),
  };
}

/**
 * taskId → display for the OWNER task of each kernel-owned delivery only. A
 * fix, CI or conflict attempt task keeps its own execution reading: its row
 * is history of the delivery, not the delivery (S35).
 */
export function ownerDeliveryDisplays(views: ReadonlyMap<string, DeliveryView>): Map<string, DeliveryDisplay> {
  const out = new Map<string, DeliveryDisplay>();
  for (const [taskId, v] of views) if (v.ownerTaskId === taskId) out.set(taskId, toDeliveryDisplay(v));
  return out;
}

/** Shipped: merged, or its work landed under another PR. */
export function deliveryShipped(d: Pick<DeliveryDisplay, 'state'>): boolean {
  return d.state === 'MERGED' || d.state === 'SUPERSEDED';
}

/** Settled: nothing further will happen to this PR on its own. */
export function deliverySettled(d: Pick<DeliveryDisplay, 'state'>): boolean {
  return d.state === 'MERGED' || d.state === 'SUPERSEDED' || d.state === 'ABANDONED' || d.state === 'CLOSED_UNMERGED' || d.state === 'FAILED';
}
