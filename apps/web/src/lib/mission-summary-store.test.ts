/**
 * The stored mission summary (spec 3ef37387 AC-2): over a varied fixture set,
 * after each kind of write (task status, worker progress, PR opened, merged
 * or closed, review recorded), the stored summary of every mission equals the
 * one computed from its tasks and workers.
 *
 * The writes go through the real hook point (lib/work-changed.ts) the way
 * production code reaches it: a core event's ids (`workChangeOfEvent`, what
 * `emit` notes), a kernel command's input (`workChangeOfKernelInput`, what
 * the kernel client notes), the PR fact cache's hook, or a direct note. The
 * store is the real one over an in-memory table and the fixture world.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MISSION_SUMMARY_VERSION } from '@buildd/shared';
import { recordPrFact } from '@buildd/core/pr-facts';
import { computeMissionSummary, summariesEqual } from './mission-summary';
import { createMissionSummaryStore, type MissionSummaryStoreDeps, type StoredMissionSummary } from './mission-summary-store';
import { flushWorkChanges, noteWorkChanged, setWorkChangeListenersForTests, workChangeOfEvent, workChangeOfKernelInput } from './work-changed';
import type { CoreEvent } from './core-events';
import { inputsFromWorld, makeWorld, NOW, resolveInWorld, type World } from './mission-summary.fixtures';

let world: World;
let clock: number;
let table: Map<string, StoredMissionSummary>;
let loads: string[][];
let recorded: Array<{ event: string; fields: Record<string, number> }>;

function deps(): MissionSummaryStoreDeps {
  return {
    load: async (ids) => { loads.push([...ids]); return inputsFromWorld(world, ids); },
    resolve: async (t) => resolveInWorld(world, t),
    // The real upsert's fence: a row is only replaced by one computed from later reads.
    write: async (rows) => {
      const written: string[] = [];
      for (const r of rows) {
        const prev = table.get(r.missionId);
        if (prev && prev.computedAt.getTime() > r.computedAt.getTime()) continue;
        table.set(r.missionId, structuredClone(r));
        written.push(r.missionId);
      }
      return written;
    },
    readStored: async (ids) => new Map(ids.flatMap(id => (table.has(id) ? [[id, structuredClone(table.get(id)!)] as const] : []))),
    sample: async (limit) => {
      const order = (id: string) => { const r = table.get(id); return !r || r.version !== MISSION_SUMMARY_VERSION ? -Infinity : r.computedAt.getTime(); };
      return world.missions.map(m => m.id).sort((a, b) => order(a) - order(b) || a.localeCompare(b)).slice(0, limit);
    },
    now: () => clock,
    record: (event, fields) => { recorded.push({ event, fields }); },
  };
}

let store = createMissionSummaryStore(deps());

/** Stored == computed, for every mission of the world, as it stands now. */
function expectStoredEqualsComputed() {
  const ids = world.missions.map(m => m.id);
  const inputs = inputsFromWorld(world, ids);
  for (const id of ids) {
    const stored = table.get(id);
    expect(stored, `mission ${id} has a stored summary`).toBeDefined();
    const computed = computeMissionSummary(inputs.get(id)!, stored!.computedAt.getTime());
    expect(summariesEqual(stored!.summary, computed), `mission ${id}: stored equals computed`).toBe(true);
  }
}

const emitted = (event: Record<string, unknown>) => noteWorkChanged(workChangeOfEvent(event as unknown as CoreEvent));
const tick = () => { clock += 60_000; };
const summary = (id: string) => table.get(id)!.summary;

beforeEach(async () => {
  world = makeWorld();
  clock = NOW;
  table = new Map();
  loads = [];
  recorded = [];
  store = createMissionSummaryStore(deps());
  setWorkChangeListenersForTests([async (batch) => { await store.refreshFor(batch); }]);
  // Backfill: the reconcile writes every mission it finds missing.
  await store.reconcile({ limit: 50 });
  loads = [];
});

afterEach(() => { setWorkChangeListenersForTests(null); });

describe('AC-2: stored == computed after each kind of write', () => {
  it('starts equal: the reconcile is the backfill', () => {
    expect(table.size).toBe(world.missions.length);
    expectStoredEqualsComputed();
  });

  it('task status: a claim (tasks.claimed) starts the blocked task', async () => {
    tick();
    const t = world.tasks.find(x => x.id === 't-b4')!;
    Object.assign(t, { status: 'in_progress', dependsOn: [], updatedAt: new Date(clock) });
    world.workers.push({ ...world.workers.find(w => w.id === 'w-b3')!, id: 'w-b4', taskId: 't-b4', startedAt: new Date(clock) });
    const before = summary('m-build');
    emitted({ type: 'tasks.claimed', tasks: [{ id: 't-b4', workspaceId: 'ws-1', missionId: 'm-build', context: {} }] });
    await flushWorkChanges();
    expectStoredEqualsComputed();
    expect(summary('m-build').liveWorkers).toBe(before.liveWorkers + 1);
  });

  it('worker progress: a worker report (worker.reported) completes the running task', async () => {
    tick();
    Object.assign(world.workers.find(w => w.id === 'w-b3')!, { status: 'completed', completedAt: new Date(clock), updatedAt: new Date(clock) });
    Object.assign(world.tasks.find(t => t.id === 't-b3')!, { status: 'completed', updatedAt: new Date(clock) });
    emitted({ type: 'worker.reported', taskId: 't-b3', workerId: 'w-b3', missionId: 'm-build', finalStatus: 'completed' });
    await flushWorkChanges();
    expectStoredEqualsComputed();
    expect(summary('m-build').liveWorkers).toBe(0);
    expect(summary('m-build').taskCounts.completed).toBe(3);
  });

  it('PR opened: the PR route notes its worker (no event carries it)', async () => {
    tick();
    Object.assign(world.workers.find(w => w.id === 'w-b3')!, { prUrl: 'https://github.com/acme/app/pull/13', prNumber: 13, prLifecycleStatus: 'pr_open', updatedAt: new Date(clock) });
    noteWorkChanged({ workerIds: ['w-b3'] });
    await flushWorkChanges();
    expectStoredEqualsComputed();
    expect(summary('m-build').delivery).toMatchObject({ prNumber: 13, state: 'open' });
  });

  it('PR merged: task.pr_merged lands the task', async () => {
    tick();
    Object.assign(world.workers.find(w => w.id === 'w-b2')!, { mergedAt: new Date(clock), prLifecycleStatus: 'merged', updatedAt: new Date(clock) });
    emitted({ type: 'task.pr_merged', via: 'worker', transition: 'already_completed', taskClass: 'work', taskId: 't-b2', workerId: 'w-b2', workspaceId: 'ws-1', missionId: 'm-build', release: null, repoFullName: 'acme/app', baseRef: 'main', installationId: null });
    await flushWorkChanges();
    expectStoredEqualsComputed();
    expect(summary('m-build').progress.done).toBe(2);
  });

  it('PR merged, by GitHub fact alone: pr.merged names only the repo and number', async () => {
    tick();
    Object.assign(world.workers.find(w => w.id === 'w-r-pr')!, { mergedAt: new Date(clock), prLifecycleStatus: 'merged', updatedAt: new Date(clock) });
    emitted({ type: 'pr.merged', repoFullName: 'acme/app', prNumber: 30, url: 'https://github.com/acme/app/pull/30' });
    await flushWorkChanges();
    expectStoredEqualsComputed();
    expect(summary('m-branch').delivery).toMatchObject({ source: 'mission_pr', state: 'merged' });
  });

  it('PR closed: pr.closed, and a closed unmerged PR is not done', async () => {
    tick();
    Object.assign(world.workers.find(w => w.id === 'w-b2')!, { prLifecycleStatus: 'closed', updatedAt: new Date(clock) });
    emitted({ type: 'pr.closed', workspaceId: 'ws-1', prNumber: 12, merged: false, mergeIsNew: false, workerId: 'w-b2', taskId: 't-b2', headSha: 'abc', repoFullName: 'acme/app', installationId: null });
    await flushWorkChanges();
    expectStoredEqualsComputed();
    expect(summary('m-build').progress.done).toBe(1);
  });

  it('PR state from the fact cache: recordPrFact reports the rows it wrote', async () => {
    tick();
    Object.assign(world.workers.find(w => w.id === 'w-b2')!, { prLifecycleStatus: 'ci_failed', updatedAt: new Date(clock) });
    await recordPrFact({ workerId: 'w-b2' }, { kind: 'ci', status: 'ci_failed' as never }, {
      exec: async () => [{ id: 'w-b2', task_id: 't-b2', workspace_id: 'ws-1', previous_status: 'pr_open' }],
    });
    await flushWorkChanges();
    expect(loads.flat()).toContain('m-build');
    expectStoredEqualsComputed();
  });

  it('review recorded: the kernel command names the PR by workspace and number; its fix attempt is counted', async () => {
    tick();
    world.tasks.push({ ...world.tasks.find(t => t.id === 't-b2')!, id: 't-b2-fix', title: '[review-retry] Build t-b2', taskClass: 'attempt', parentTaskId: 't-b2', status: 'pending', createdAt: new Date(clock), updatedAt: new Date(clock) });
    noteWorkChanged(workChangeOfKernelInput({ workspaceId: 'ws-1', prNumber: 12, verdict: 'changes_requested' }));
    await flushWorkChanges();
    expectStoredEqualsComputed();
    expect(summary('m-build').taskCounts.pending).toBe(2);
  });

  it('a mission row write: the owner holds the mission', async () => {
    tick();
    world.missions.find(m => m.id === 'm-build')!.isHeld = true;
    noteWorkChanged({ missionIds: ['m-build'] });
    await flushWorkChanges();
    expectStoredEqualsComputed();
    expect(summary('m-build').health).toBe('held');
  });

  it('a task moved between missions refreshes both', async () => {
    tick();
    world.tasks.find(t => t.id === 't-h1')!.missionId = 'm-plan';
    emitted({ type: 'task.left_mission', taskId: 't-h1', missionId: 'm-held', workspaceId: 'ws-1' });
    await flushWorkChanges();
    expectStoredEqualsComputed();
    expect(summary('m-held').taskCounts).toEqual({});
  });
});

describe('the writer', () => {
  it('coalesces: many notes in one request are one batched load', async () => {
    for (const id of ['t-b1', 't-b2', 't-b3', 't-b4', 't-b1', 't-r1']) noteWorkChanged({ taskIds: [id] });
    noteWorkChanged({ missionIds: ['m-build'] });
    await flushWorkChanges();
    expect(loads).toHaveLength(1);
    expect(new Set(loads[0])).toEqual(new Set(['m-build', 'm-branch']));
  });

  it('the fence: a summary computed from older reads never replaces a newer one', async () => {
    const newer = table.get('m-build')!;
    clock = NOW - 3_600_000;
    world.missions.find(m => m.id === 'm-build')!.isHeld = true;
    await store.recompute(['m-build']);
    expect(table.get('m-build')!.computedAt).toEqual(newer.computedAt);
    expect(table.get('m-build')!.summary.health).not.toBe('held');
  });

  it('a note for rows of no mission loads nothing', async () => {
    world.tasks.push({ ...world.tasks[0], id: 't-free', missionId: null });
    noteWorkChanged({ taskIds: ['t-free', 'no-such-task'] });
    await flushWorkChanges();
    expect(loads).toHaveLength(0);
  });
});

describe('the reconcile', () => {
  it('repairs a write that never refreshed, counts it as a missed write, and records the counts', async () => {
    tick();
    // A write path that forgets to note: the stored summary is now stale.
    Object.assign(world.workers.find(w => w.id === 'w-b2')!, { mergedAt: new Date(clock), prLifecycleStatus: 'merged' });
    expect(summary('m-build').progress.done).toBe(1);
    recorded = [];
    const counts = await store.reconcile({ limit: 50 });
    expect(counts).toMatchObject({ checked: world.missions.length, missing: 0, repaired: 1, missedWrites: 1 });
    expect(summary('m-build').progress.done).toBe(2);
    expectStoredEqualsComputed();
    expect(recorded).toEqual([{ event: 'mission_summary.reconcile', fields: expect.objectContaining({ repaired: 1, missedWrites: 1 }) }]);
  });

  it('a reading that only aged is repaired but is not a missed write', async () => {
    // The schedule's last run drifts past twice its interval: on-schedule turns stalled with no write at all.
    clock = NOW + 3 * 3_600_000;
    const counts = await store.reconcile({ limit: 50 });
    expect(summary('m-cron').health).toBe('stalled');
    expect(counts.repaired).toBeGreaterThanOrEqual(1);
    expect(counts.missedWrites).toBe(0);
  });

  it('is bounded, and takes missing and oldest first', async () => {
    table.delete('m-held');
    tick();
    await store.reconcile({ limit: 1 });
    expect(loads.at(-1)).toEqual(['m-held']);
    expect(table.has('m-held')).toBe(true);
    tick();
    await store.reconcile({ limit: 2 });
    // Everything else is older than m-held now.
    expect(loads.at(-1)).not.toContain('m-held');
    expect(loads.at(-1)).toHaveLength(2);
  });

  it('counts a summary of another version as such and rewrites it', async () => {
    table.set('m-done', { ...table.get('m-done')!, version: MISSION_SUMMARY_VERSION - 1 });
    const counts = await store.reconcile({ limit: 1 });
    expect(counts.otherVersion).toBe(1);
    expect(table.get('m-done')!.version).toBe(MISSION_SUMMARY_VERSION);
  });

  it('clamps the limit to 1..200', async () => {
    let asked = 0;
    const s = createMissionSummaryStore({ ...deps(), sample: async (n) => { asked = n; return []; } });
    await s.reconcile({ limit: 10_000 });
    expect(asked).toBe(200);
    await s.reconcile({ limit: 0 });
    expect(asked).toBe(1);
  });
});
