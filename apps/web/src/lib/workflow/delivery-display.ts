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
import { attemptFailureCounts, attemptLine, type DeliveryCta, type DeliveryStage, type DeliveryView, type NextMoveOwner } from './projections';
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
  /** The next transition a person can trigger (S37's "Run fix"), the one Home's card offers. */
  cta: DeliveryCta | null;
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
    cta: v.cta,
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

/**
 * S35: which of these failed tasks are replaced work, not failures. A task is
 * replaced iff it belongs to a kernel-owned delivery (it has a view) and it is
 * not that delivery's failure: the delivery's reading is not `failed` (it is
 * live, shipped, superseded or abandoned), or it is FAILED but this task is an
 * older, superseded attempt rather than the current attempt or the owner
 * (`attemptFailureCounts`). A task with no view, including every task when the
 * view read failed, is not replaced: its failure shows through the legacy
 * reading rather than being hidden.
 *
 * Every failed count reads this: the mission page and card health, explain,
 * and (per item) the Home action queue.
 */
export function replacedFailedTaskIds(views: ReadonlyMap<string, DeliveryView>, failedTaskIds: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const id of failedTaskIds) {
    const v = views.get(id);
    if (v && !attemptFailureCounts(v, id)) out.add(id);
  }
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

// ─── The one reading every surface draws ─────────────────────────────────────

/**
 * The canonical tone of a delivery: the one colour family every surface maps
 * its own palette from (one total table per palette, never one per state).
 * - `needs`: a person's move (ESCALATED, or an approved PR waiting for its merge).
 * - `live`: a worker, the reviewer, the platform or a merge is moving it.
 * - `stalled`: platform-owned but not moving on its own (S37: a stalled or
 *   missing conflict fix; a red base). Recoverable, so never "failed".
 * - `landed` / `closed`: settled.
 * - `failed`: the delivery itself is FAILED. Nothing else counts as failed (S35).
 */
export type DeliveryTone = 'needs' | 'live' | 'stalled' | 'landed' | 'closed' | 'failed';

export interface DeliveryReading {
  /** Sentence case. A surface may upper-case it; it never rewords it. */
  label: string;
  tone: DeliveryTone;
  /** Counted in every Needs-you number (Home, the mission band, chat). */
  needsYou: boolean;
  /** Counted in every failed number (the strip header, the list histogram). */
  failed: boolean;
  /** S37: the remediation a person can kick, the action Home's card offers. */
  action: { label: string; taskId: string } | null;
}

export type DeliveryReadingInput = Pick<DeliveryDisplay, 'stage' | 'state' | 'headline' | 'owner'> & { cta?: DeliveryCta | null };

const reading = (label: string, tone: DeliveryTone, action: DeliveryReading['action'] = null): DeliveryReading =>
  ({ label, tone, needsYou: tone === 'needs', failed: tone === 'failed', action });

/**
 * What a kernel-owned delivery reads as, on every surface (§12, §17.5): the
 * task list chip and histogram, the mission board, strip, band and feed, and
 * the chat tile and dock all take their label, tone, needs-you and failed
 * counts from here, and Home's card says the same thing in its own layout.
 * Null for `working`: the owner's own attempt is the reading, so the task's
 * execution state (running, queued) is shown.
 *
 * An approved PR needs you only when the owner is a person (the policy leaves
 * the merge to them): it is the Merge card Home shows and reads "Ready to
 * merge", never "in review". When the landing path merges it, it reads live. A repair reads the kernel's headline
 * ("Conflict fix stalled", "Fixing CI"). Only a FAILED delivery is failed; a
 * stalled conflict fix or a CI fix in flight is recoverable work the platform
 * owns (S35, S36, S37).
 */
export function deliveryReading(d: DeliveryReadingInput): DeliveryReading | null {
  switch (d.stage) {
    case 'working': return null;
    case 'awaiting_push': return reading('Waiting for push', 'live');
    case 'review': return reading(d.state === 'CHANGES_REQUESTED' ? 'Changes requested' : 'In review', 'live');
    case 'fixing': return reading('Fixing', 'live');
    case 'repairing':
      if (d.cta?.action === 'repair_remediation') return reading(d.headline, 'stalled', { label: d.cta.label, taskId: d.cta.taskId });
      return reading(d.headline, d.cta?.action === 'create_conflict_fix' ? 'stalled' : 'live');
    case 'blocked': return reading('Blocked on base', 'stalled');
    // Only a person's merge reads as needs-you; under approve-and-merge or
    // auto-threshold the landing path merges it, so it is live (S35).
    case 'approved': return d.owner === 'human' ? reading('Ready to merge', 'needs') : reading('Approved · merging', 'live');
    case 'landing': return reading('Merging', 'live');
    case 'needs_you': return reading('Needs you', 'needs');
    case 'merged': return reading('Merged', 'landed');
    case 'superseded': return reading('Shipped elsewhere', 'landed');
    case 'closed':
    case 'abandoned': return reading('Closed', 'closed');
    case 'failed': return reading('Failed', 'failed');
  }
}
