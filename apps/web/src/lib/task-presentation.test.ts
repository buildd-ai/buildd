import { describe, it, expect } from 'bun:test';
import {
  LIVE_WORKER_STATUSES,
  LIVENESS_THRESHOLD_MS,
  STALENESS_THRESHOLD_MS,
  PROGRESS_THRESHOLD_MS,
  isGateSatisfied,
  deriveChainPosition,
  deriveIntensity,
  deriveDisplayStatus,
  deriveTaskPhase,
  isStaleWorker,
  deriveTimestampLabel,
} from './task-presentation';
import { DEP_SATISFYING_STATUSES } from './dep-gate-contract';

const MIN = 60_000;
const HR = 60 * MIN;

// ─── LIVE_WORKER_STATUSES ────────────────────────────────────────────────────

describe('LIVE_WORKER_STATUSES', () => {
  it('contains the four expected statuses', () => {
    expect([...LIVE_WORKER_STATUSES].sort()).toEqual(
      ['idle', 'running', 'starting', 'waiting_input'].sort(),
    );
  });
});

// ─── isGateSatisfied ─────────────────────────────────────────────────────────
// These cases mirror the SQL gate in the claim route (deps-gate.ts).
// Rule: status ∈ DEP_SATISFYING_STATUSES, AND — for 'completed' only — no worker
// has an open PR (prUrl IS NOT NULL, mergedAt IS NULL, lifecycle != 'closed').

describe('isGateSatisfied', () => {
  it('returns false for statuses outside DEP_SATISFYING_STATUSES', () => {
    expect(isGateSatisfied({ status: 'pending' }, [])).toBe(false);
    expect(isGateSatisfied({ status: 'assigned' }, [])).toBe(false);
    expect(isGateSatisfied({ status: 'in_progress' }, [])).toBe(false);
    expect(isGateSatisfied({ status: 'failed' }, [])).toBe(false);
  });

  // Regression: the display gate required status='completed', so a cancelled dep
  // stayed BLOCKED in the UI forever while the claim route treated it as satisfied.
  it('returns true when dep is cancelled — matches DEP_SATISFYING_STATUSES', () => {
    expect(isGateSatisfied({ status: 'cancelled' }, [])).toBe(true);
  });

  it('returns true when dep is cancelled even with an open PR — no PR guard on cancelled', () => {
    expect(
      isGateSatisfied({ status: 'cancelled' }, [
        { prUrl: 'https://github.com/org/repo/pull/9', mergedAt: null },
      ]),
    ).toBe(true);
  });

  it('returns true when completed with no workers', () => {
    expect(isGateSatisfied({ status: 'completed' }, [])).toBe(true);
  });

  it('returns true when completed and no worker has a PR (filled state)', () => {
    expect(
      isGateSatisfied({ status: 'completed' }, [
        { prUrl: null, mergedAt: null },
      ]),
    ).toBe(true);
  });

  it('returns true when completed and all PRs are merged (filled state)', () => {
    expect(
      isGateSatisfied({ status: 'completed' }, [
        { prUrl: 'https://github.com/org/repo/pull/1', mergedAt: '2025-01-01T00:00:00Z' },
      ]),
    ).toBe(true);
  });

  it('returns false when completed but PR is open — the half state', () => {
    expect(
      isGateSatisfied({ status: 'completed' }, [
        { prUrl: 'https://github.com/org/repo/pull/2', mergedAt: null },
      ]),
    ).toBe(false);
  });

  it('returns false when completed and one PR is open among several workers', () => {
    expect(
      isGateSatisfied({ status: 'completed' }, [
        { prUrl: null, mergedAt: null },
        { prUrl: 'https://github.com/org/repo/pull/3', mergedAt: null },
        { prUrl: 'https://github.com/org/repo/pull/4', mergedAt: '2025-01-02T00:00:00Z' },
      ]),
    ).toBe(false);
  });

  // Regression: the SQL gate exempts closed PRs (COALESCE(pr_lifecycle_status,'') != 'closed');
  // the display gate did not, so an abandoned PR blocked dependents in the UI forever.
  it('returns true when completed and the unmerged PR was closed/abandoned', () => {
    expect(
      isGateSatisfied({ status: 'completed' }, [
        { prUrl: 'https://github.com/org/repo/pull/5', mergedAt: null, prLifecycleStatus: 'closed' },
      ]),
    ).toBe(true);
  });

  it('returns false when completed and the unmerged PR is still open (lifecycle not closed)', () => {
    expect(
      isGateSatisfied({ status: 'completed' }, [
        { prUrl: 'https://github.com/org/repo/pull/6', mergedAt: null, prLifecycleStatus: 'ci_running' },
      ]),
    ).toBe(false);
  });

  it('agrees with the claim route on every status in DEP_SATISFYING_STATUSES', () => {
    for (const status of DEP_SATISFYING_STATUSES) {
      expect(isGateSatisfied({ status }, [])).toBe(true);
    }
  });
});

// ─── deriveChainPosition ─────────────────────────────────────────────────────

describe('deriveChainPosition', () => {
  const task = { id: 'subject', status: 'assigned' };

  it('returns index=1 and total=1 for a standalone task with no deps', () => {
    const result = deriveChainPosition({ task, deps: [], dependents: 0 });
    expect(result.index).toBe(1);
    expect(result.total).toBe(1);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toEqual({ taskId: 'subject', state: 'current' });
    expect(result.blockedBy).toHaveLength(0);
    expect(result.unblocks).toBe(0);
  });

  it('places subject at deps.length+1 in the chain', () => {
    const deps = [
      { id: 'd1', title: 'D1', status: 'completed', workers: [] },
      { id: 'd2', title: 'D2', status: 'completed', workers: [] },
    ];
    const result = deriveChainPosition({ task, deps, dependents: 3 });
    expect(result.index).toBe(3);
    expect(result.total).toBe(6); // 2 deps + subject + 3 downstream
    expect(result.unblocks).toBe(3);
  });

  it('marks a completed dep with no PR as filled', () => {
    const deps = [
      { id: 'd1', title: 'D1', status: 'completed', workers: [{ prUrl: null, mergedAt: null }] },
    ];
    const { segments } = deriveChainPosition({ task, deps, dependents: 0 });
    expect(segments[0].state).toBe('filled');
  });

  it('marks a completed dep with merged PR as filled', () => {
    const deps = [
      {
        id: 'd1',
        title: 'D1',
        status: 'completed',
        workers: [{ prUrl: 'https://github.com/pr/1', prNumber: 1, mergedAt: '2025-01-01T00:00:00Z' }],
      },
    ];
    const { segments } = deriveChainPosition({ task, deps, dependents: 0 });
    expect(segments[0].state).toBe('filled');
  });

  it('marks a completed dep with open PR as half', () => {
    const deps = [
      {
        id: 'd1',
        title: 'D1',
        status: 'completed',
        workers: [{ prUrl: 'https://github.com/pr/2', prNumber: 2, mergedAt: null }],
      },
    ];
    const { segments, blockedBy } = deriveChainPosition({ task, deps, dependents: 0 });
    expect(segments[0].state).toBe('half');
    expect(blockedBy).toHaveLength(1);
    expect(blockedBy[0].id).toBe('d1');
    expect(blockedBy[0].prUrl).toBe('https://github.com/pr/2');
    expect(blockedBy[0].prNumber).toBe(2);
  });

  it('marks a pending dep as empty', () => {
    const deps = [{ id: 'd1', title: 'D1', status: 'pending', workers: [] }];
    const { segments, blockedBy } = deriveChainPosition({ task, deps, dependents: 0 });
    expect(segments[0].state).toBe('empty');
    expect(blockedBy).toHaveLength(1);
    expect(blockedBy[0].id).toBe('d1');
  });

  it('always places subject segment last as current', () => {
    const deps = [
      { id: 'd1', title: 'D1', status: 'completed', workers: [] },
      { id: 'd2', title: 'D2', status: 'pending', workers: [] },
    ];
    const { segments } = deriveChainPosition({ task, deps, dependents: 1 });
    expect(segments).toHaveLength(3);
    expect(segments[2]).toEqual({ taskId: 'subject', state: 'current' });
  });

  it('gate predicate agreement: isGateSatisfied drives both segment state and blockedBy', () => {
    const deps = [
      { id: 'open-pr', title: 'Open PR', status: 'completed', workers: [{ prUrl: 'https://github.com/pr/99', mergedAt: null }] },
      { id: 'merged-pr', title: 'Merged PR', status: 'completed', workers: [{ prUrl: 'https://github.com/pr/98', mergedAt: '2025-01-01T00:00:00Z' }] },
      { id: 'no-pr', title: 'No PR', status: 'completed', workers: [] },
      { id: 'pending', title: 'Pending', status: 'pending', workers: [] },
    ];
    const { segments, blockedBy } = deriveChainPosition({ task, deps, dependents: 0 });

    expect(segments[0].state).toBe('half');    // open PR
    expect(segments[1].state).toBe('filled');  // merged PR
    expect(segments[2].state).toBe('filled');  // no PR
    expect(segments[3].state).toBe('empty');   // pending

    expect(blockedBy.map(b => b.id).sort()).toEqual(['open-pr', 'pending'].sort());
  });

  it('marks a cancelled dep as skipped, not empty, and does not block on it', () => {
    const deps = [{ id: 'd1', title: 'D1', status: 'cancelled', workers: [] }];
    const { segments, blockedBy, blockedByFrontier } = deriveChainPosition({
      task, deps, dependents: 0,
    });
    expect(segments[0].state).toBe('skipped');
    expect(blockedBy).toHaveLength(0);
    expect(blockedByFrontier).toHaveLength(0);
  });
});

// ─── blockedByFrontier (transitive reduction) ────────────────────────────────
// The auto-dependsOn pass in api/tasks/route.ts adds an edge to every in-flight
// task with an overlapping pathManifest. Mission tasks default to ['**'], which
// overlaps everything, so a task routinely carries 5–8 edges of which one or two
// are the real frontier. blockedBy stays truthful; blockedByFrontier is what the
// UI renders.

describe('deriveChainPosition — blockedByFrontier', () => {
  const task = { id: 'subject', status: 'pending' };

  it('equals blockedBy when no dep depends on another dep', () => {
    const deps = [
      { id: 'a', title: 'A', status: 'pending', workers: [], dependsOn: [] },
      { id: 'b', title: 'B', status: 'pending', workers: [], dependsOn: [] },
    ];
    const { blockedBy, blockedByFrontier } = deriveChainPosition({ task, deps, dependents: 0 });
    expect(blockedBy).toHaveLength(2);
    expect(blockedByFrontier.map(b => b.id)).toEqual(['a', 'b']);
  });

  it('drops a blocker that another blocker already depends on directly', () => {
    const deps = [
      { id: 'a', title: 'A', status: 'pending', workers: [], dependsOn: [] },
      { id: 'b', title: 'B', status: 'pending', workers: [], dependsOn: ['a'] },
    ];
    const { blockedBy, blockedByFrontier } = deriveChainPosition({ task, deps, dependents: 0 });
    expect(blockedBy).toHaveLength(2);
    expect(blockedByFrontier.map(b => b.id)).toEqual(['b']);
  });

  it('drops a blocker reachable transitively through several hops', () => {
    const deps = [
      { id: 'a', title: 'A', status: 'pending', workers: [], dependsOn: [] },
      { id: 'b', title: 'B', status: 'pending', workers: [], dependsOn: ['a'] },
      { id: 'c', title: 'C', status: 'pending', workers: [], dependsOn: ['b'] },
    ];
    const { blockedByFrontier } = deriveChainPosition({ task, deps, dependents: 0 });
    expect(blockedByFrontier.map(b => b.id)).toEqual(['c']);
  });

  it('reduces through a satisfied intermediate node', () => {
    // subject → {a, s, c}; c → s → a. s is completed+merged so it is not a
    // blocker, but it still proves c is downstream of a.
    const deps = [
      { id: 'a', title: 'A', status: 'pending', workers: [], dependsOn: [] },
      { id: 's', title: 'S', status: 'completed', workers: [], dependsOn: ['a'] },
      { id: 'c', title: 'C', status: 'pending', workers: [], dependsOn: ['s'] },
    ];
    const { blockedBy, blockedByFrontier } = deriveChainPosition({ task, deps, dependents: 0 });
    expect(blockedBy.map(b => b.id).sort()).toEqual(['a', 'c']);
    expect(blockedByFrontier.map(b => b.id)).toEqual(['c']);
  });

  it('keeps both blockers when neither reaches the other', () => {
    const deps = [
      { id: 'a', title: 'A', status: 'pending', workers: [], dependsOn: ['x'] },
      { id: 'b', title: 'B', status: 'pending', workers: [], dependsOn: ['y'] },
    ];
    const { blockedByFrontier } = deriveChainPosition({ task, deps, dependents: 0 });
    expect(blockedByFrontier.map(b => b.id)).toEqual(['a', 'b']);
  });

  it('never empties the frontier when blockers exist, even in a dependency cycle', () => {
    // A malformed graph (a ↔ b) would reduce both away under naive reduction,
    // leaving a BLOCKED task with no visible reason.
    const deps = [
      { id: 'a', title: 'A', status: 'pending', workers: [], dependsOn: ['b'] },
      { id: 'b', title: 'B', status: 'pending', workers: [], dependsOn: ['a'] },
    ];
    const { blockedBy, blockedByFrontier } = deriveChainPosition({ task, deps, dependents: 0 });
    expect(blockedBy).toHaveLength(2);
    expect(blockedByFrontier.length).toBeGreaterThan(0);
  });

  it('falls back to the full list when deps carry no dependsOn data', () => {
    const deps = [
      { id: 'a', title: 'A', status: 'pending', workers: [] },
      { id: 'b', title: 'B', status: 'pending', workers: [] },
    ];
    const { blockedByFrontier } = deriveChainPosition({ task, deps, dependents: 0 });
    expect(blockedByFrontier.map(b => b.id)).toEqual(['a', 'b']);
  });

  it('reproduces the prod shape: 8 edges reduce to 1 frontier blocker', () => {
    // Task 233df6 "Sync gate specs to shipped code" in prod.
    // afa5b0 + 9a1e54 are cancelled (satisfied); e4443f covers the other five.
    const deps = [
      { id: 'afa5b0', title: 'Single source of truth for claim gates', status: 'cancelled', workers: [], dependsOn: [] },
      { id: '9a1e54', title: 'Remove the capability gate', status: 'cancelled', workers: [], dependsOn: [] },
      { id: '875ff4', title: 'Budget Forecast UI', status: 'pending', workers: [], dependsOn: [] },
      { id: '8891ac', title: 'Fix planning-contract violation', status: 'pending', workers: [], dependsOn: [] },
      { id: '46bfab', title: 'Fix Pusher 413', status: 'pending', workers: [], dependsOn: [] },
      { id: 'aeb80f', title: 'SPEC: deliverable uniqueness', status: 'pending', workers: [], dependsOn: [] },
      { id: 'e4443f', title: 'DESIGN: context inheritance', status: 'pending', workers: [], dependsOn: ['875ff4', '8891ac', '46bfab', 'aeb80f', '0ced84'] },
      { id: '0ced84', title: 'AUDIT: stale CI badge', status: 'pending', workers: [], dependsOn: ['875ff4', '8891ac', '46bfab', 'aeb80f'] },
    ];
    const { blockedBy, blockedByFrontier } = deriveChainPosition({ task, deps, dependents: 0 });
    expect(blockedBy).toHaveLength(6);
    expect(blockedByFrontier.map(b => b.id)).toEqual(['e4443f']);
  });
});

// ─── deriveIntensity ─────────────────────────────────────────────────────────

describe('deriveIntensity', () => {
  const NOW = 1_700_000_000_000;
  const startedAt = new Date(NOW - 30 * 60 * 1000).toISOString(); // 30 min ago

  it('returns fresh when workerUpdatedAt is within LIVENESS_THRESHOLD_MS', () => {
    const { tier } = deriveIntensity({
      turns: [],
      startedAt,
      workerUpdatedAt: new Date(NOW - 2 * 60 * 1000).toISOString(),
      now: NOW,
    });
    expect(tier).toBe('fresh');
  });

  it('returns working when between LIVENESS and STALENESS thresholds', () => {
    const { tier } = deriveIntensity({
      turns: [],
      startedAt,
      workerUpdatedAt: new Date(NOW - 7 * 60 * 1000).toISOString(),
      now: NOW,
    });
    expect(tier).toBe('working');
  });

  it('returns slow when between STALENESS and PROGRESS thresholds', () => {
    const { tier } = deriveIntensity({
      turns: [],
      startedAt,
      workerUpdatedAt: new Date(NOW - 15 * 60 * 1000).toISOString(),
      now: NOW,
    });
    expect(tier).toBe('slow');
  });

  it('returns stalled when beyond PROGRESS_THRESHOLD_MS', () => {
    const { tier } = deriveIntensity({
      turns: [],
      startedAt,
      workerUpdatedAt: new Date(NOW - 90 * 60 * 1000).toISOString(),
      now: NOW,
    });
    expect(tier).toBe('stalled');
  });

  it('returns fresh when workerUpdatedAt is null', () => {
    const { tier } = deriveIntensity({
      turns: [],
      startedAt,
      workerUpdatedAt: null,
      now: NOW,
    });
    expect(tier).toBe('fresh');
  });

  it('produces a sparkline with correct bucket count', () => {
    const start = NOW - 20 * 60 * 1000; // 20 minutes ago → 4 buckets of 5 min
    const { sparkline } = deriveIntensity({
      turns: [],
      startedAt: new Date(start).toISOString(),
      workerUpdatedAt: new Date(NOW - 1000).toISOString(),
      now: NOW,
    });
    expect(sparkline).toHaveLength(4);
  });

  it('buckets turn timestamps into the correct 5-min window', () => {
    const start = NOW - 10 * 60 * 1000; // 10 min ago → 2 buckets
    const turns = [
      NOW - 9 * 60 * 1000,  // bucket 0
      NOW - 8 * 60 * 1000,  // bucket 0
      NOW - 4 * 60 * 1000,  // bucket 1
    ];
    const { sparkline } = deriveIntensity({
      turns,
      startedAt: new Date(start).toISOString(),
      workerUpdatedAt: new Date(NOW - 1000).toISOString(),
      now: NOW,
    });
    expect(sparkline).toHaveLength(2);
    expect(sparkline[0]).toBe(2); // two turns in first 5-min bucket
    expect(sparkline[1]).toBe(1); // one turn in second bucket
  });

  it('ignores turns before startedAt', () => {
    const start = NOW - 5 * 60 * 1000;
    const turns = [NOW - 10 * 60 * 1000]; // before start
    const { sparkline } = deriveIntensity({
      turns,
      startedAt: new Date(start).toISOString(),
      workerUpdatedAt: new Date(NOW - 1000).toISOString(),
      now: NOW,
    });
    expect(sparkline.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('STALENESS_THRESHOLD_MS is the working/slow boundary (isStaleWorker behavior preserved)', () => {
    expect(STALENESS_THRESHOLD_MS).toBe(10 * 60 * 1000);

    // At exactly the threshold boundary: working
    const atBoundary = deriveIntensity({
      turns: [],
      startedAt,
      workerUpdatedAt: new Date(NOW - STALENESS_THRESHOLD_MS + 1).toISOString(),
      now: NOW,
    });
    expect(atBoundary.tier).toBe('working');

    // Just past the threshold: slow (isStaleWorker fires here)
    const pastBoundary = deriveIntensity({
      turns: [],
      startedAt,
      workerUpdatedAt: new Date(NOW - STALENESS_THRESHOLD_MS - 1).toISOString(),
      now: NOW,
    });
    expect(pastBoundary.tier).toBe('slow');
  });
});

// ─── deriveDisplayStatus ──────────────────────────────────────────────────────

describe('deriveDisplayStatus', () => {
  it('returns running when worker is running', () => {
    expect(deriveDisplayStatus('assigned', 'running')).toBe('running');
    expect(deriveDisplayStatus('in_progress', 'running')).toBe('running');
    expect(deriveDisplayStatus('pending', 'running')).toBe('running');
  });

  it('returns running when worker is starting', () => {
    expect(deriveDisplayStatus('assigned', 'starting')).toBe('running');
  });

  it('returns running when worker is idle (between turns)', () => {
    expect(deriveDisplayStatus('assigned', 'idle')).toBe('running');
    expect(deriveDisplayStatus('in_progress', 'idle')).toBe('running');
  });

  it('returns waiting_input when worker is waiting', () => {
    expect(deriveDisplayStatus('assigned', 'waiting_input')).toBe('waiting_input');
    expect(deriveDisplayStatus('in_progress', 'waiting_input')).toBe('waiting_input');
  });

  it('returns task status when no active worker', () => {
    expect(deriveDisplayStatus('pending', null)).toBe('pending');
    expect(deriveDisplayStatus('assigned', null)).toBe('assigned');
    expect(deriveDisplayStatus('completed', null)).toBe('completed');
    expect(deriveDisplayStatus('failed', undefined)).toBe('failed');
  });

  it('active-worker overrides task chip — assigned+running => running', () => {
    expect(deriveDisplayStatus('assigned', 'running')).toBe('running');
    expect(deriveDisplayStatus('assigned', 'running')).not.toBe('assigned');
  });

  it('idle worker overrides task chip — assigned+idle => running not assigned', () => {
    expect(deriveDisplayStatus('assigned', 'idle')).toBe('running');
    expect(deriveDisplayStatus('assigned', 'idle')).not.toBe('assigned');
  });
});

// ─── isStaleWorker ────────────────────────────────────────────────────────────

describe('isStaleWorker', () => {
  const now = 1_000_000_000_000;
  const recentlyUpdated = new Date(now - 2 * MIN).toISOString();
  const staleUpdated = new Date(now - 11 * MIN).toISOString();

  it('returns false when worker is not running', () => {
    expect(isStaleWorker('waiting_input', staleUpdated, now)).toBe(false);
    expect(isStaleWorker('completed', staleUpdated, now)).toBe(false);
    expect(isStaleWorker(null, staleUpdated, now)).toBe(false);
  });

  it('returns false when updated recently', () => {
    expect(isStaleWorker('running', recentlyUpdated, now)).toBe(false);
  });

  it('returns true when running and no activity past threshold', () => {
    expect(isStaleWorker('running', staleUpdated, now)).toBe(true);
  });

  it('returns false when updatedAt is missing', () => {
    expect(isStaleWorker('running', null, now)).toBe(false);
  });

  it('staleness threshold is 10 minutes', () => {
    expect(STALENESS_THRESHOLD_MS).toBe(10 * MIN);
    const exactThreshold = new Date(now - STALENESS_THRESHOLD_MS).toISOString();
    // At exactly the threshold: not stale (strictly greater than)
    expect(isStaleWorker('running', exactThreshold, now)).toBe(false);
    // One ms over: stale
    const justOver = new Date(now - STALENESS_THRESHOLD_MS - 1).toISOString();
    expect(isStaleWorker('running', justOver, now)).toBe(true);
  });
});

// ─── deriveTaskPhase ───────────────────────────────────────────────────────────

describe('deriveTaskPhase', () => {
  it('terminal completed (execution) → completed, even with a stale waiting worker', () => {
    expect(deriveTaskPhase({ taskStatus: 'completed', workerWaitingFor: { prompt: 'x' } })).toBe('completed');
  });

  it('completed planning task → plan_review', () => {
    expect(deriveTaskPhase({ taskStatus: 'completed', taskMode: 'planning' })).toBe('plan_review');
  });

  it('failed task → failed, even with a live-ish worker status', () => {
    expect(deriveTaskPhase({ taskStatus: 'failed', workerStatus: 'running' })).toBe('failed');
  });

  it('unanswered question outranks running → waiting_input', () => {
    expect(deriveTaskPhase({ taskStatus: 'assigned', workerStatus: 'running', workerWaitingFor: { prompt: 'q' } })).toBe('waiting_input');
  });

  it('worker waiting_input status → waiting_input', () => {
    expect(deriveTaskPhase({ taskStatus: 'assigned', workerStatus: 'waiting_input' })).toBe('waiting_input');
  });

  it.each(['running', 'starting', 'idle'])('live worker status %s → running', (s) => {
    expect(deriveTaskPhase({ taskStatus: 'assigned', workerStatus: s })).toBe('running');
  });

  it('assigned with no live worker → assigned', () => {
    expect(deriveTaskPhase({ taskStatus: 'assigned' })).toBe('assigned');
  });

  it('pending + blocked → blocked (blocked outranks budget)', () => {
    expect(deriveTaskPhase({ taskStatus: 'pending', isBlocked: true, isBudgetPaused: true })).toBe('blocked');
  });

  it('pending + budget paused → budget_paused', () => {
    expect(deriveTaskPhase({ taskStatus: 'pending', isBudgetPaused: true })).toBe('budget_paused');
  });

  it('plain pending → pending', () => {
    expect(deriveTaskPhase({ taskStatus: 'pending' })).toBe('pending');
  });

  it('does not treat a dead worker (status=error) with no question as running', () => {
    expect(deriveTaskPhase({ taskStatus: 'pending', workerStatus: 'error' })).toBe('pending');
  });
});

// ─── deriveTimestampLabel ─────────────────────────────────────────────────────

describe('deriveTimestampLabel — running', () => {
  const now = 1_000_000_000_000;
  const base = {
    taskStatus: 'assigned',
    workerStatus: 'running',
    taskCreatedAt: new Date(now - 2 * HR).toISOString(),
    taskUpdatedAt: new Date(now - 5 * MIN).toISOString(),
    workerStartedAt: new Date(now - 58 * MIN).toISOString(),
    workerUpdatedAt: new Date(now - 1 * MIN).toISOString(),
    now,
  };

  it('shows running duration and last-activity', () => {
    const label = deriveTimestampLabel(base);
    expect(label).toBe('running 58m · active 1m ago');
  });

  it('shows hours when runtime >= 60m', () => {
    const label = deriveTimestampLabel({
      ...base,
      workerStartedAt: new Date(now - 90 * MIN).toISOString(),
      workerUpdatedAt: new Date(now - 2 * MIN).toISOString(),
    });
    expect(label).toBe('running 1h 30m · active 2m ago');
  });

  it('shows just now when activity is recent', () => {
    const label = deriveTimestampLabel({
      ...base,
      workerUpdatedAt: new Date(now - 30_000).toISOString(), // 30s ago
    });
    expect(label).toBe('running 58m · active just now');
  });

  it('falls back to createdAt when workerStartedAt is missing', () => {
    const label = deriveTimestampLabel({
      ...base,
      workerStartedAt: null,
    });
    expect(label).toBe('running 2h · active 1m ago');
  });
});

describe('deriveTimestampLabel — waiting_input', () => {
  const now = 1_000_000_000_000;

  it('shows needs input with runtime', () => {
    const label = deriveTimestampLabel({
      taskStatus: 'in_progress',
      workerStatus: 'waiting_input',
      taskCreatedAt: new Date(now - 2 * HR).toISOString(),
      taskUpdatedAt: new Date(now - 5 * MIN).toISOString(),
      workerStartedAt: new Date(now - 45 * MIN).toISOString(),
      now,
    });
    expect(label).toBe('needs input · 45m');
  });
});

describe('deriveTimestampLabel — idle worker (between turns)', () => {
  const now = 1_000_000_000_000;

  it('shows running label for assigned task with idle worker', () => {
    const label = deriveTimestampLabel({
      taskStatus: 'assigned',
      workerStatus: 'idle',
      taskCreatedAt: new Date(now - 2 * HR).toISOString(),
      taskUpdatedAt: new Date(now - 5 * MIN).toISOString(),
      workerStartedAt: new Date(now - 58 * MIN).toISOString(),
      workerUpdatedAt: new Date(now - 2 * MIN).toISOString(),
      now,
    });
    expect(label).toBe('running 58m · active 2m ago');
    expect(label).not.toContain('queued');
  });
});

describe('deriveTimestampLabel — queued/pending', () => {
  const now = 1_000_000_000_000;

  it('shows queued duration for assigned tasks without active worker', () => {
    const label = deriveTimestampLabel({
      taskStatus: 'assigned',
      workerStatus: null,
      taskCreatedAt: new Date(now - 3 * HR).toISOString(),
      taskUpdatedAt: new Date(now - 3 * HR).toISOString(),
      now,
    });
    expect(label).toBe('queued 3h');
  });

  it('shows queued for pending tasks', () => {
    const label = deriveTimestampLabel({
      taskStatus: 'pending',
      workerStatus: null,
      taskCreatedAt: new Date(now - 30 * MIN).toISOString(),
      taskUpdatedAt: new Date(now - 30 * MIN).toISOString(),
      now,
    });
    expect(label).toBe('queued 30m');
  });
});

describe('deriveTimestampLabel — terminal', () => {
  const now = 1_000_000_000_000;

  it('shows time-ago relative to updatedAt for completed tasks', () => {
    const label = deriveTimestampLabel({
      taskStatus: 'completed',
      workerStatus: null,
      taskCreatedAt: new Date(now - 5 * HR).toISOString(),
      taskUpdatedAt: new Date(now - 2 * HR).toISOString(),
      now,
    });
    expect(label).toBe('2h ago');
  });

  it('shows time-ago for failed tasks', () => {
    const label = deriveTimestampLabel({
      taskStatus: 'failed',
      workerStatus: null,
      taskCreatedAt: new Date(now - 10 * HR).toISOString(),
      taskUpdatedAt: new Date(now - 1 * HR).toISOString(),
      now,
    });
    expect(label).toBe('1h ago');
  });
});
