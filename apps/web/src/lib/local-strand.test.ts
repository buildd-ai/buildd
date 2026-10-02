import { describe, expect, it } from 'bun:test';
import {
  LOCAL_SESSION_QUIET_MS,
  continueOnRunnerBlockedReason,
  deriveLocalStrand,
  type StrandTaskRow,
} from './local-strand';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const minsAgo = (m: number) => new Date(NOW - m * 60_000);

function pending(id: string, over: Partial<StrandTaskRow> = {}): StrandTaskRow {
  return { id, status: 'pending', createdAt: minsAgo(120), workers: [], ...over };
}

function done(id: string, over: Partial<StrandTaskRow> = {}): StrandTaskRow {
  return {
    id,
    status: 'completed',
    createdAt: minsAgo(200),
    workers: [{ status: 'completed', startedAt: minsAgo(190), completedAt: minsAgo(150), updatedAt: minsAgo(150) }],
    ...over,
  };
}

const local = (tasks: StrandTaskRow[], over: Record<string, unknown> = {}) =>
  deriveLocalStrand({ executor: 'local', isHeld: false, status: 'active', tasks, now: NOW, ...over });

describe('deriveLocalStrand — the stranded predicate', () => {
  it('quiet window is a named constant of 30 minutes', () => {
    expect(LOCAL_SESSION_QUIET_MS).toBe(30 * 60_000);
  });

  it('session gone + claimable task → stranded, quiet time measured from the last session touch', () => {
    const s = local([done('a'), pending('b')]);
    expect(s?.stranded).toBe(true);
    expect(s?.claimableTaskIds).toEqual(['b']);
    // The task has waited 120m; the session last touched the mission 150m ago.
    // Quiet is measured from the later of the two: the task's arrival.
    expect(s?.quietMs).toBe(120 * 60_000);
  });

  it('session live (recent heartbeat on any mission worker) → not stranded', () => {
    const s = local([
      done('a', { workers: [{ status: 'completed', startedAt: minsAgo(40), completedAt: minsAgo(10), updatedAt: minsAgo(10) }] }),
      pending('b'),
    ]);
    expect(s?.stranded).toBe(false);
  });

  it('a live worker whose heartbeat is stale does not keep the mission alive', () => {
    const s = local([
      done('a'),
      { id: 'c', status: 'in_progress', createdAt: minsAgo(300), workers: [{ status: 'running', startedAt: minsAgo(290), updatedAt: minsAgo(95) }] },
      pending('b'),
    ]);
    expect(s?.stranded).toBe(true);
  });

  it('a task that arrived inside the window is not stranded yet (the session may be about to claim it)', () => {
    const s = local([done('a'), pending('b', { createdAt: minsAgo(5) })]);
    expect(s?.stranded).toBe(false);
    expect(s?.claimableTaskIds).toEqual(['b']);
  });

  it('held beats it: a held local mission is never stranded', () => {
    expect(local([pending('b')], { isHeld: true })).toBeNull();
  });

  it('no claimable task → not stranded', () => {
    expect(local([done('a')])?.stranded).toBe(false);
  });

  it('deps unmet → not claimable → not stranded', () => {
    const s = local([
      { id: 'dep', status: 'in_progress', createdAt: minsAgo(200), workers: [] },
      pending('b', { dependsOn: ['dep'] }),
    ]);
    expect(s?.claimableTaskIds).toEqual([]);
    expect(s?.stranded).toBe(false);
  });

  it('a dependency completed with an open PR is unmet (the claim gate)', () => {
    const s = local([
      done('dep', { workers: [{ status: 'completed', prUrl: 'https://x/pr/1', prNumber: 1, completedAt: minsAgo(150) }] }),
      pending('b', { dependsOn: ['dep'] }),
    ]);
    expect(s?.claimableTaskIds).toEqual([]);
  });

  it('quiet time starts when the last dependency merged, not when the task was filed', () => {
    const s = local([
      done('dep', { workers: [{ status: 'completed', prUrl: 'https://x/pr/1', prNumber: 1, mergedAt: minsAgo(10), completedAt: minsAgo(150), updatedAt: minsAgo(150) }] }),
      pending('b', { dependsOn: ['dep'] }),
    ]);
    expect(s?.claimableTaskIds).toEqual(['b']);
    expect(s?.stranded).toBe(false);
  });

  it('a future startAt is not claimable', () => {
    const s = local([pending('b', { startAt: new Date(NOW + 60 * 60_000) })]);
    expect(s?.claimableTaskIds).toEqual([]);
  });

  it('runner missions and terminal missions have no strand', () => {
    expect(deriveLocalStrand({ executor: 'runner', isHeld: false, status: 'active', tasks: [pending('b')], now: NOW })).toBeNull();
    expect(local([pending('b')], { status: 'completed' })).toBeNull();
  });
});

describe('continueOnRunnerBlockedReason — the flip the PATCH route enforces', () => {
  it('allows an active mission with a workspace', () => {
    expect(continueOnRunnerBlockedReason({ status: 'active', workspaceId: 'ws' })).toBeNull();
  });
  it('refuses a mission with no workspace: runners have nowhere to claim from', () => {
    expect(continueOnRunnerBlockedReason({ status: 'active', workspaceId: null })).toMatch(/workspace/);
  });
  it('refuses a terminal mission', () => {
    expect(continueOnRunnerBlockedReason({ status: 'completed', workspaceId: 'ws' })).toMatch(/completed/);
    expect(continueOnRunnerBlockedReason({ status: 'archived', workspaceId: 'ws' })).toMatch(/archived/);
  });
});
