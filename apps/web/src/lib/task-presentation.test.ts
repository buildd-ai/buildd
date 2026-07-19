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
  isStaleWorker,
} from './task-presentation';

// ─── LIVE_WORKER_STATUSES ────────────────────────────────────────────────────

describe('LIVE_WORKER_STATUSES', () => {
  it('contains the four expected statuses', () => {
    expect([...LIVE_WORKER_STATUSES].sort()).toEqual(
      ['idle', 'running', 'starting', 'waiting_input'].sort(),
    );
  });
});

// ─── isGateSatisfied ─────────────────────────────────────────────────────────
// These cases mirror the SQL gate in the claim route.
// Rule: status='completed' AND no worker has prUrl IS NOT NULL AND mergedAt IS NULL.

describe('isGateSatisfied', () => {
  it('returns false when dep is not completed', () => {
    expect(isGateSatisfied({ status: 'pending' }, [])).toBe(false);
    expect(isGateSatisfied({ status: 'assigned' }, [])).toBe(false);
    expect(isGateSatisfied({ status: 'in_progress' }, [])).toBe(false);
    expect(isGateSatisfied({ status: 'failed' }, [])).toBe(false);
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

// ─── Backward-compat smoke ────────────────────────────────────────────────────

describe('existing exports still work after move to task-presentation', () => {
  it('deriveDisplayStatus: idle worker → running', () => {
    expect(deriveDisplayStatus('assigned', 'idle')).toBe('running');
  });

  it('isStaleWorker: non-running worker is never stale', () => {
    expect(isStaleWorker('idle', new Date(0).toISOString())).toBe(false);
  });

  it('isStaleWorker: running worker with old timestamp is stale', () => {
    expect(isStaleWorker('running', new Date(0).toISOString())).toBe(true);
  });
});
