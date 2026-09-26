import { describe, it, expect } from 'bun:test';
import {
  buildActionQueue,
  buildDiscrepancyItems,
  deriveDocFixAutomation,
  rowNeedsRecheck,
  isRecheckInFlight,
  DOC_FIX_AUTOMATION_BUDGET_MS,
  DOC_FIX_RECHECK_GRACE_MS,
  DOC_FIX_RECHECK_IN_FLIGHT_MS,
  DOC_FIX_RECHECK_SWEEP_AFTER_MS,
  type DiscrepancyCandidate,
} from './action-queue';

// docs/design/spec-conformance.md §9/§12.1 — the automation state machine a
// doc-fix card moves through, and which states Home files under "agents
// handling" versus "needs you".

const NOW = new Date('2026-06-10T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

function row(overrides: Partial<DiscrepancyCandidate> = {}): DiscrepancyCandidate {
  return {
    id: 'd-1',
    workspaceId: 'ws-1',
    specPath: 'docs/design/x.md',
    assertionId: 'a-1',
    direction: 'code_ahead',
    status: 'open',
    firstSeenAt: at(-10 * 24 * HOUR),
    lastCheckedAt: at(-3 * HOUR),
    ...overrides,
  };
}

/** A completed doc fix whose PR merged `mergedAgoMs` ago. */
function merged(mergedAgoMs: number, overrides: Partial<DiscrepancyCandidate> = {}): DiscrepancyCandidate {
  return row({
    docFixTaskId: 'fix-1',
    docFixTaskStatus: 'completed',
    docFixPrLifecycleStatus: 'merged',
    docFixMergedAt: at(-mergedAgoMs),
    // Last evaluated before the merge — not yet rechecked.
    lastCheckedAt: at(-mergedAgoMs - HOUR),
    ...overrides,
  });
}

/** …and the checker has since re-evaluated it with the gap still open. */
function rechecked(mergedAgoMs: number, overrides: Partial<DiscrepancyCandidate> = {}): DiscrepancyCandidate {
  return merged(mergedAgoMs, { lastCheckedAt: at(-mergedAgoMs + DOC_FIX_RECHECK_GRACE_MS + 60_000), ...overrides });
}

describe('deriveDocFixAutomation', () => {
  it('no claim → null (the card offers Dispatch doc fix)', () => {
    expect(deriveDocFixAutomation([row()], NOW)).toBeNull();
  });

  it('a running doc fix → fix_running; the running follow-up → follow_up_running', () => {
    expect(deriveDocFixAutomation([row({ docFixTaskId: 'fix-1', docFixTaskStatus: 'in_progress' })], NOW)).toBe('fix_running');
    expect(
      deriveDocFixAutomation([row({ docFixTaskId: 'fu-1', autoFollowUpTaskId: 'fu-1', docFixTaskStatus: 'pending' })], NOW),
    ).toBe('follow_up_running');
  });

  it('completed with the PR open → pr_open; lifecycle unobserved → pr_unknown', () => {
    expect(deriveDocFixAutomation([merged(HOUR, { docFixPrLifecycleStatus: 'open' })], NOW)).toBe('pr_open');
    expect(deriveDocFixAutomation([merged(HOUR, { docFixPrLifecycleStatus: null })], NOW)).toBe('pr_unknown');
  });

  it('merged, not rechecked, a forced re-run requested after the merge → recheck_dispatched', () => {
    expect(deriveDocFixAutomation([merged(20 * 60_000, { recheckRequestedAt: at(-19 * 60_000) })], NOW)).toBe('recheck_dispatched');
  });

  it('a forced run requested BEFORE the merge does not count as covering it', () => {
    expect(deriveDocFixAutomation([merged(20 * 60_000, { recheckRequestedAt: at(-30 * 60_000) })], NOW)).toBe('recheck_queued');
  });

  it('a forced run past its in-flight window stops being claimed as running', () => {
    const c = merged(2 * HOUR, { recheckRequestedAt: at(-DOC_FIX_RECHECK_IN_FLIGHT_MS - 60_000) });
    expect(isRecheckInFlight(c, NOW)).toBe(false);
    expect(deriveDocFixAutomation([c], NOW)).toBe('recheck_queued');
  });

  it('merged past the automation budget and never rechecked → recheck_stalled (the owner sees it)', () => {
    expect(deriveDocFixAutomation([merged(DOC_FIX_AUTOMATION_BUDGET_MS + HOUR)], NOW)).toBe('recheck_stalled');
  });

  it('merged, rechecked, still open, follow-up not yet spent → follow_up_queued', () => {
    expect(deriveDocFixAutomation([rechecked(2 * HOUR)], NOW)).toBe('follow_up_queued');
  });

  it('a fix that merged long before its row was rechecked is still owed its follow-up (no budget here)', () => {
    // The live shape: fixes that merged days before the writer could reach
    // their rows. They must get their one follow-up, not skip to the owner.
    expect(deriveDocFixAutomation([rechecked(7 * 24 * HOUR)], NOW)).toBe('follow_up_queued');
  });

  it('the follow-up itself merged, was rechecked, and the gap is still open → needs_owner', () => {
    const c = rechecked(2 * HOUR, { docFixTaskId: 'fu-1', autoFollowUpTaskId: 'fu-1' });
    expect(deriveDocFixAutomation([c], NOW)).toBe('needs_owner');
  });

  it('the cap is per row: one row still owed its follow-up keeps the card with the automation', () => {
    const spent = rechecked(2 * HOUR, { id: 'd-1', docFixTaskId: 'fu-1', autoFollowUpTaskId: 'fu-1' });
    const owed = rechecked(2 * HOUR, { id: 'd-2', assertionId: 'a-2' });
    expect(deriveDocFixAutomation([spent, owed], NOW)).toBe('follow_up_queued');
  });

  it('an unattempted sibling row keeps the card on Dispatch doc fix (no follow-up for the path yet)', () => {
    expect(deriveDocFixAutomation([rechecked(2 * HOUR), row({ id: 'd-2', assertionId: 'a-2' })], NOW)).toBeNull();
  });
});

describe('rowNeedsRecheck', () => {
  it('the webhook (minAge 0) asks right after the merge', () => {
    expect(rowNeedsRecheck(merged(60_000), NOW, 0)).toBe(true);
  });

  it('the sweep leaves the first hour to the ordinary dev-push run', () => {
    expect(rowNeedsRecheck(merged(30 * 60_000), NOW, DOC_FIX_RECHECK_SWEEP_AFTER_MS)).toBe(false);
    expect(rowNeedsRecheck(merged(2 * HOUR), NOW, DOC_FIX_RECHECK_SWEEP_AFTER_MS)).toBe(true);
  });

  it('never while a forced run covering the merge is in flight (no double dispatch)', () => {
    expect(rowNeedsRecheck(merged(2 * HOUR, { recheckRequestedAt: at(-10 * 60_000) }), NOW, DOC_FIX_RECHECK_SWEEP_AFTER_MS)).toBe(false);
  });

  it('never once the row was rechecked since the merge', () => {
    expect(rowNeedsRecheck(rechecked(2 * HOUR), NOW, DOC_FIX_RECHECK_SWEEP_AFTER_MS)).toBe(false);
  });

  it('never past the automation budget — the sweep stops, the card goes to the owner', () => {
    expect(rowNeedsRecheck(merged(DOC_FIX_AUTOMATION_BUDGET_MS + HOUR), NOW, DOC_FIX_RECHECK_SWEEP_AFTER_MS)).toBe(false);
  });

  it('never for an unmerged PR, an unfinished task, or a resolved row', () => {
    expect(rowNeedsRecheck(merged(2 * HOUR, { docFixPrLifecycleStatus: 'open' }), NOW, 0)).toBe(false);
    expect(rowNeedsRecheck(merged(2 * HOUR, { docFixTaskStatus: 'in_progress' }), NOW, 0)).toBe(false);
    expect(rowNeedsRecheck(merged(2 * HOUR, { status: 'resolved' }), NOW, 0)).toBe(false);
  });
});

describe('Home placement: agent-handled rows never sit in "needs you"', () => {
  const chipFor = (rows: DiscrepancyCandidate[]) => {
    const { items } = buildDiscrepancyItems(rows, { now: NOW });
    const queue = buildActionQueue(items, [], { now: NOW } as never);
    return { chip: queue[0]?.chip, automation: items[0]?.docFixAutomation };
  };

  it.each([
    ['recheck_queued', [merged(20 * 60_000)]],
    ['recheck_dispatched', [merged(20 * 60_000, { recheckRequestedAt: at(-10 * 60_000) })]],
    ['follow_up_queued', [rechecked(2 * HOUR)]],
    ['follow_up_running', [row({ docFixTaskId: 'fu-1', autoFollowUpTaskId: 'fu-1', docFixTaskStatus: 'in_progress' })]],
  ] as const)('%s → FIXING_SPEC', (state, rows) => {
    expect(chipFor([...rows])).toEqual({ chip: 'FIXING_SPEC', automation: state });
  });

  it.each([
    ['recheck_stalled', [merged(DOC_FIX_AUTOMATION_BUDGET_MS + HOUR)]],
    ['needs_owner', [rechecked(2 * HOUR, { docFixTaskId: 'fu-1', autoFollowUpTaskId: 'fu-1' })]],
  ] as const)('%s → DISCREPANCY (a genuine automation failure reaches the owner)', (state, rows) => {
    expect(chipFor([...rows])).toEqual({ chip: 'DISCREPANCY', automation: state });
  });

  it('carries the evidence the needs_owner card renders', () => {
    const { items } = buildDiscrepancyItems(
      [rechecked(2 * HOUR, { docFixTaskId: 'fu-1', autoFollowUpTaskId: 'fu-1', declaredStatus: 'partially' })],
      { now: NOW },
    );
    expect(items[0]).toMatchObject({
      docFixAutomation: 'needs_owner',
      docFixFollowUpTaskId: 'fu-1',
      mergedDocFixTaskId: 'fu-1',
      declaredStatus: 'partially',
    });
    expect(items[0].lastCheckedHoursAgo).toBe(1);
  });
});
