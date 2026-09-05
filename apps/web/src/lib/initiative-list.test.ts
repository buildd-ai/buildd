process.env.NODE_ENV = 'test';

import { describe, it, expect, mock, beforeEach } from 'bun:test';

/**
 * `loadInitiativeList` is the Initiatives-list half of the ONE loader that spec
 * §6.2 allows, and §5.2 / AC-20 / AC-29 make its output agree with initiative
 * detail count-for-count. Two things it does are therefore observable and worth
 * testing directly:
 *
 *  1. WHICH worker columns it asks the database for. `deriveMissionSegmentState`
 *     branches on `workers[].status`; a column set that omits `status` makes the
 *     `ghost` branch unreachable and silently promotes an in-flight retry of a
 *     completed task to `solid`, inflating `completedTasks` and `progress` on
 *     this surface only.
 *  2. HOW it narrows workers before the rollup. Detail selects all workers
 *     newest-first and passes only the newest into `computeMissionProgress`
 *     (`latestWorkerPerTask`), keeping the full list for the awaiting-merge
 *     count. Any other narrowing rule here is a disagreement.
 *
 * The db mock therefore *projects* fixture rows through the `columns` spec it was
 * handed, exactly like Drizzle does. A mock that returned fixtures verbatim would
 * hand the code columns it never selected and the ghost test would pass with the
 * bug still in place.
 */

// ── The recording / projecting db mock ───────────────────────────────────────

/** Every `db.query.initiatives.findMany` options object, in call order. */
const findManyCalls: any[] = [];
/** Rows the next findMany resolves with, pre-projection. */
let fixtureRows: any[] = [];

/**
 * Model Drizzle's relational projection: a column is present only if the query
 * asked for it, and a relation is present only if it appears under `with`.
 */
function project(rows: any[], spec: any): any[] {
  return rows.map((row) => {
    const out: any = {};
    for (const [col, wanted] of Object.entries(spec?.columns ?? {})) {
      if (wanted) out[col] = row[col];
    }
    for (const [rel, relSpec] of Object.entries<any>(spec?.with ?? {})) {
      const value = row[rel];
      if (value === undefined || value === null) {
        out[rel] = value ?? null;
        continue;
      }
      out[rel] = Array.isArray(value) ? project(value, relSpec) : project([value], relSpec)[0];
    }
    return out;
  });
}

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      initiatives: {
        findMany: async (opts: any) => {
          findManyCalls.push(opts);
          return project(fixtureRows, opts);
        },
      },
    },
    // db.select({...}).from(externalLinks).where(...) → no Linear links.
    select: () => ({ from: () => ({ where: async () => [] }) }),
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  initiatives: { id: 'id', teamId: 'team_id', status: 'status', workspaceId: 'workspace_id', priority: 'priority', createdAt: 'created_at' },
  externalLinks: { provider: 'provider', builddEntityType: 'buildd_entity_type', builddEntityId: 'buildd_entity_id' },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
  inArray: (a: any, b: any) => ({ type: 'inArray', a, b }),
  desc: (a: any) => ({ type: 'desc', a }),
}));

// `@buildd/core/mission-helpers` is deliberately NOT stubbed: the real
// `computeMissionProgress` / `deriveMissionSegmentState` rules are what the two
// surfaces must agree on.
import { computeMissionProgress } from '@buildd/core/mission-helpers';
import { loadInitiativeList } from './initiative-list';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TEAM = 'team_illustrative';

function worker(over: Record<string, unknown> = {}) {
  return {
    status: 'completed',
    prUrl: null,
    prNumber: null,
    mergedAt: null,
    prLifecycleStatus: null,
    startedAt: new Date('2026-01-02T00:00:00Z'),
    ...over,
  };
}

function task(over: Record<string, unknown> = {}) {
  return {
    id: 'task_a',
    status: 'pending',
    kind: 'execution',
    title: 'Ship the thing',
    mode: 'execution',
    creationSource: 'user',
    category: null,
    parentTaskId: null,
    dependsOn: null,
    taskClass: 'work',
    workers: [] as any[],
    ...over,
  };
}

function mission(over: Record<string, unknown> = {}) {
  return {
    id: 'mission_1',
    title: 'A mission',
    status: 'active',
    updatedAt: new Date('2026-01-03T00:00:00Z'),
    isHeld: false,
    tasks: [] as any[],
    ...over,
  };
}

function initiative(over: Record<string, unknown> = {}) {
  return {
    id: 'ini_1',
    title: 'An arc',
    description: null,
    status: 'active',
    priority: 0,
    workspaceId: 'ws_1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    workspace: { id: 'ws_1', name: 'Workspace' },
    missions: [] as any[],
    ...over,
  };
}

/** The workers sub-query spec from the last findMany call, if any. */
function workersSpec(): any {
  return findManyCalls.at(-1)?.with?.missions?.with?.tasks?.with?.workers;
}

/**
 * What initiative detail computes for the same mission: all worker columns,
 * newest-first, narrowed to the newest worker before the rollup
 * (`latestWorkerPerTask`). Computed from the *unprojected* fixture, so it is
 * independent of anything the loader selects.
 */
function detailRollup(missionRow: any) {
  return computeMissionProgress(
    (missionRow.tasks ?? []).map((t: any) => ({ ...t, workers: (t.workers ?? []).slice(0, 1) })),
  );
}

beforeEach(() => {
  findManyCalls.length = 0;
  fixtureRows = [];
});

// ── 1. Selected column set ───────────────────────────────────────────────────

describe('loadInitiativeList — worker column set', () => {
  it('selects workers.status, without which the ghost segment state is unreachable', async () => {
    fixtureRows = [initiative()];

    await loadInitiativeList({ teamIds: [TEAM], pendingSignals: true });

    // `deriveMissionSegmentState`'s first branch is
    // `workers.some(w => LIVE_SET.has(w.status))`. Undefined is in no live set,
    // so omitting this column deletes the branch.
    expect(workersSpec()?.columns?.status).toBe(true);
  });

  it('orders workers newest-first so the rollup narrows to the same worker detail uses', async () => {
    fixtureRows = [initiative()];

    await loadInitiativeList({ teamIds: [TEAM], pendingSignals: true });

    const orderBy = workersSpec()?.orderBy;
    expect(typeof orderBy).toBe('function');
    // Probe the callback with a proxy that echoes the column name it is asked for.
    const columns = new Proxy({}, { get: (_t, key) => String(key) });
    const ordered = orderBy(columns, {
      desc: (c: unknown) => ({ dir: 'desc', col: c }),
      asc: (c: unknown) => ({ dir: 'asc', col: c }),
    });
    expect(ordered).toEqual([{ dir: 'desc', col: 'startedAt' }]);
  });

  it('still asks for no worker rows at all without pendingSignals', async () => {
    fixtureRows = [initiative()];

    await loadInitiativeList({ teamIds: [TEAM] });

    // GET /api/initiatives returns these items verbatim; its payload must stay light.
    expect(workersSpec()).toBeUndefined();
  });
});

// ── 2. Agreement with initiative detail (§5.2, AC-20, AC-29) ─────────────────

describe('loadInitiativeList — rollup agrees with initiative detail', () => {
  it('does not count a completed task that has a live worker (ghost, not solid)', async () => {
    // Two deliverables. The first completed but has a worker running again — a
    // retry in flight. Detail reads that as `ghost` and does not count it.
    const inFlight = task({ id: 'task_ghost', status: 'completed', workers: [worker({ status: 'running' })] });
    const done = task({ id: 'task_done', status: 'completed', workers: [] });
    const m = mission({ tasks: [inFlight, done] });
    fixtureRows = [initiative({ missions: [m] })];

    const [item] = await loadInitiativeList({ teamIds: [TEAM], pendingSignals: true });

    const reference = detailRollup(m);
    expect(reference.completedTasks).toBe(1); // guards the fixture itself
    expect(reference.segments.map((s) => s.state)).toEqual(['ghost', 'solid']);

    expect(item.progress.totalTasks).toBe(reference.totalTasks);
    expect(item.progress.completedTasks).toBe(reference.completedTasks);
    expect(item.segments.map((s) => s.state)).toEqual(['ghost', 'solid']);
  });

  it('narrows the rollup to the newest worker, so a stale live worker cannot ghost a shipped task', async () => {
    // Newest worker shipped and merged; an older worker on the same task is
    // still recorded as live. Detail narrows to the newest → `solid`. Feeding
    // every worker into the rollup would read `ghost` and lose the completion.
    const shipped = task({
      id: 'task_shipped',
      status: 'completed',
      workers: [
        worker({ status: 'completed', prUrl: 'https://example.invalid/pr/1', prNumber: 1, mergedAt: new Date('2026-01-04T00:00:00Z'), prLifecycleStatus: 'merged', startedAt: new Date('2026-01-04T00:00:00Z') }),
        worker({ status: 'idle', startedAt: new Date('2026-01-02T00:00:00Z') }),
      ],
    });
    const m = mission({ tasks: [shipped] });
    fixtureRows = [initiative({ missions: [m] })];

    const [item] = await loadInitiativeList({ teamIds: [TEAM], pendingSignals: true });

    const reference = detailRollup(m);
    expect(reference.segments.map((s) => s.state)).toEqual(['solid']);

    expect(item.segments.map((s) => s.state)).toEqual(['solid']);
    expect(item.progress.completedTasks).toBe(reference.completedTasks);
    expect(item.progress.completedTasks).toBe(1);
  });

  it('keeps every worker on the returned task rows, because awaiting-merge reads them all', async () => {
    // The open PR that makes a task await merge is not always on the newest
    // worker, so the narrowing above MUST NOT reach the returned payload —
    // `derivePendingCounts` walks it.
    const t = task({
      id: 'task_await',
      status: 'completed',
      workers: [
        worker({ status: 'completed', startedAt: new Date('2026-01-05T00:00:00Z') }),
        worker({ status: 'completed', prUrl: 'https://example.invalid/pr/2', prNumber: 2, prLifecycleStatus: 'open', startedAt: new Date('2026-01-02T00:00:00Z') }),
      ],
    });
    fixtureRows = [initiative({ missions: [mission({ tasks: [t] })] })];

    const [item] = await loadInitiativeList({ teamIds: [TEAM], pendingSignals: true });

    const returned = item.missions[0].tasks?.[0].workers ?? [];
    expect(returned.length).toBe(2);
    expect(returned.some((w) => w.prNumber === 2 && w.prLifecycleStatus === 'open')).toBe(true);
  });
});
