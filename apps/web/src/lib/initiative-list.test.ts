process.env.NODE_ENV = 'test';

import { describe, it, expect, mock, beforeEach } from 'bun:test';

/**
 * `loadInitiativeList` feeds GET /api/initiatives and Home's progress headline.
 * Its payload is a light mission index: no task or worker rows. The db mock
 * *projects* fixture rows through the `columns` spec it was handed, exactly like
 * Drizzle does, so a field the loader never selected cannot leak into a test.
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
    title: 'An initiative',
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

const lastSpec = () => findManyCalls.at(-1);

beforeEach(() => {
  findManyCalls.length = 0;
  fixtureRows = [];
});

describe('loadInitiativeList', () => {
  it('returns the human-set fields: status, owner and target date', async () => {
    fixtureRows = [initiative({ status: 'planned', ownerUserId: 'user_2', targetDate: '2026-11-15' })];
    const [item] = await loadInitiativeList({ teamIds: [TEAM] });
    expect(item.status).toBe('planned');
    expect(item.ownerUserId).toBe('user_2');
    expect(item.targetDate).toBe('2026-11-15');
  });

  it('asks for no worker rows: the payload is a mission index', async () => {
    fixtureRows = [initiative({ missions: [mission({ tasks: [task({ workers: [worker()] })] })] })];
    const [item] = await loadInitiativeList({ teamIds: [TEAM] });
    expect(lastSpec()?.with?.missions?.with?.tasks?.with).toBeUndefined();
    expect((item.missions[0] as any).tasks).toBeUndefined();
  });

  it('rolls progress up by mission', async () => {
    fixtureRows = [initiative({ missions: [mission({ id: 'm1', status: 'completed' }), mission({ id: 'm2' })] })];
    const [item] = await loadInitiativeList({ teamIds: [TEAM] });
    expect(item.progress.completedMissions).toBe(1);
    expect(item.progress.totalMissions).toBe(2);
    expect(item.progress.progress).toBe(50);
  });
});
