import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Cohort-scope and neighbour-selection tests.
 *
 * WHY THE SCOPE ASSERTIONS RENDER SQL
 * -----------------------------------
 * A readout over the wrong cohort is invisible to a test that mocks `db`: under
 * a mocked client the predicate builders return opaque objects, so which COLUMN
 * a filter is keyed on cannot be observed. A suite could then prove the
 * arithmetic right while the rows it ran on pooled two policy versions — the
 * contaminated analysis, reproduced by a green test. So only the db *client* is
 * stubbed here; `drizzle-orm` and `../db/schema` are the real ones, and the
 * real `PgDialect` renders the predicate to text. Same technique as
 * `memory-digest-readout-source.test.ts`.
 */

/** Rows the stubbed client returns for the next `db.execute`. */
const fake: { executeRows: any[]; taskRows: any[]; cacheRow: any } = {
  executeRows: [],
  taskRows: [],
  cacheRow: undefined,
};

mock.module('../db/client', () => ({
  db: {
    execute: async () => ({ rows: fake.executeRows }),
    query: {
      tasks: { findMany: async () => fake.taskRows },
      systemCache: { findFirst: async () => fake.cacheRow },
    },
  },
}));

const {
  fetchNeighbourPaths,
  findNeighbourTasks,
  loadTaskAreaConfig,
  predictTaskArea,
  resetTaskAreaConfigCache,
} = await import('../task-area-prediction-source');
const { taskAreaCohortScope } = await import('../task-area-readout-source');
const { TASK_AREA_FALLBACK, TASK_AREA_TREATMENT_ARM } = await import('../task-area-prediction');
type TaskAreaConfig = import('../task-area-prediction').TaskAreaConfig;

const dialect = new PgDialect();
const render = (fragment: any) => dialect.sqlToQuery(fragment).sql.replace(/\s+/g, ' ').trim().toLowerCase();

const cfg = (over: Partial<TaskAreaConfig> = {}): TaskAreaConfig => ({ ...TASK_AREA_FALLBACK, ...over });

beforeEach(() => {
  fake.executeRows = [];
  fake.taskRows = [];
  fake.cacheRow = undefined;
  resetTaskAreaConfigCache();
});

describe('taskAreaCohortScope', () => {
  it('keys on BOTH experiment id and policy version', () => {
    // policy_version alone would pool rows from any future experiment that
    // reused a version string; experiment_id alone would pool two versions of
    // this one, whose arms mean different things and were re-randomised.
    const sql = render(taskAreaCohortScope('task-area-v1'));
    expect(sql).toContain('"experiment_id"');
    expect(sql).toContain('"policy_version"');
  });
});

describe('findNeighbourTasks', () => {
  const store = (results: any[]) => ({ query: async () => results });

  it('queries the workspace task corpus and resolves task ids from source ids', async () => {
    let seenNs = '';
    const out = await findNeighbourTasks(
      { query: async (ns: string) => { seenNs = ns; return [
        { id: 'task:11111111-1111-4111-8111-111111111111', metadata: {}, score: 0.8 },
      ]; } } as any,
      { workspaceId: 'ws-1', taskId: 'self', seedText: 'fix the claim route', config: cfg() },
    );
    expect(seenNs).toBe('ws-1:task');
    expect(out).toEqual([{ taskId: '11111111-1111-4111-8111-111111111111', score: 0.8 }]);
  });

  it('prefers metadata.taskId over parsing the source id', async () => {
    const out = await findNeighbourTasks(
      store([{ id: 'task:whatever#2', metadata: { taskId: 'abc' }, score: 0.5 }]) as any,
      { workspaceId: 'ws-1', taskId: 'self', seedText: 'x', config: cfg() },
    );
    expect(out[0].taskId).toBe('abc');
  });

  it("excludes the task's own card, so a re-claimed task cannot predict its own diff", async () => {
    const out = await findNeighbourTasks(
      store([
        { id: 'task:self', metadata: { taskId: 'self' }, score: 0.99 },
        { id: 'task:other', metadata: { taskId: 'other' }, score: 0.4 },
      ]) as any,
      { workspaceId: 'ws-1', taskId: 'self', seedText: 'x', config: cfg() },
    );
    expect(out.map(n => n.taskId)).toEqual(['other']);
  });

  it('de-duplicates chunks of the same neighbour and honours topK', async () => {
    const out = await findNeighbourTasks(
      store([
        { id: 'task:a', metadata: { taskId: 'a' }, score: 0.9 },
        { id: 'task:a#2', metadata: { taskId: 'a' }, score: 0.85 },
        { id: 'task:b', metadata: { taskId: 'b' }, score: 0.8 },
        { id: 'task:c', metadata: { taskId: 'c' }, score: 0.7 },
      ]) as any,
      { workspaceId: 'ws-1', taskId: 'self', seedText: 'x', config: cfg({ topK: 2 }) },
    );
    expect(out.map(n => n.taskId)).toEqual(['a', 'b']);
  });

  it('asks for more than topK, so dropped duplicates do not shrink the result', async () => {
    let askedTopK = 0;
    await findNeighbourTasks(
      { query: async (_ns: string, p: any) => { askedTopK = p.topK; return []; } } as any,
      { workspaceId: 'ws-1', taskId: 'self', seedText: 'x', config: cfg({ topK: 5 }) },
    );
    expect(askedTopK).toBeGreaterThan(5);
  });

  it('does not query at all on empty seed text', async () => {
    let called = false;
    const out = await findNeighbourTasks(
      { query: async () => { called = true; return []; } } as any,
      { workspaceId: 'ws-1', taskId: 'self', seedText: '   ', config: cfg() },
    );
    expect(called).toBe(false);
    expect(out).toEqual([]);
  });
});

describe('fetchNeighbourPaths', () => {
  it("reads the neighbour's merged diff from the pr corpus by default", async () => {
    fake.executeRows = [
      { taskId: 'n1', path: 'apps/web/a.ts', chunks: 4 },
      { taskId: 'n1', path: 'apps/web/b.ts', chunks: 1 },
      { taskId: 'n2', path: 'packages/core/c.ts', chunks: 2 },
    ];
    const out = await fetchNeighbourPaths(['n1', 'n2'], { workspaceId: 'ws-1', config: cfg() });
    expect(out.get('n1')).toEqual(['apps/web/a.ts', 'apps/web/b.ts']);
    expect(out.get('n2')).toEqual(['packages/core/c.ts']);
  });

  it('reads path_manifest instead when the config says manifest', async () => {
    fake.taskRows = [{ id: 'n1', pathManifest: ['docs/design', 42, 'apps/web'] }];
    const out = await fetchNeighbourPaths(['n1'], { workspaceId: 'ws-1', config: cfg({ pathSource: 'manifest' }) });
    expect(out.get('n1')).toEqual(['docs/design', 'apps/web']);
  });

  it('returns an empty map rather than querying for no neighbours', async () => {
    const out = await fetchNeighbourPaths([], { workspaceId: 'ws-1', config: cfg() });
    expect(out.size).toBe(0);
  });
});

describe('predictTaskArea', () => {
  const store = {
    query: async () => [
      { id: 'task:n1', metadata: { taskId: 'n1' }, score: 0.9 },
      { id: 'task:n2', metadata: { taskId: 'n2' }, score: 0.8 },
    ],
  } as any;

  it('computes the prediction AND the regex baseline in every arm', async () => {
    fake.executeRows = [{ taskId: 'n1', path: 'apps/web/src/lib/x.ts', chunks: 1 }];
    const out = await predictTaskArea(store, {
      taskId: '00000000-0000-4000-8000-000000000001',
      workspaceId: 'ws-1',
      title: 'Fix packages/core/db/schema.ts',
      description: null,
    }, cfg({ fraction: 0 }));

    expect(out).not.toBeNull();
    // fraction 0 ⇒ everyone is control, and the baseline is still computed.
    expect(out!.arm).not.toBe(TASK_AREA_TREATMENT_ARM);
    expect(out!.regexPaths).toEqual(['packages/core/db/schema.ts']);
    expect(out!.predictedPaths).toEqual(['apps/web/src/lib/x.ts']);
  });

  it('returns null when the experiment is switched off', async () => {
    const out = await predictTaskArea(store, {
      taskId: 't', workspaceId: 'ws-1', title: 'x', description: null,
    }, cfg({ enabled: false }));
    expect(out).toBeNull();
  });

  it('degrades to an empty prediction when the neighbour lookup throws', async () => {
    const broken = { query: async () => { throw new Error('store down'); } } as any;
    const out = await predictTaskArea(broken, {
      taskId: 't', workspaceId: 'ws-1', title: 'Fix apps/web/x.ts', description: null,
    }, cfg());
    expect(out!.predictedPaths).toEqual([]);
    // The baseline survives a broken store — the row is still comparable.
    expect(out!.regexPaths).toEqual(['apps/web/x.ts']);
    expect(out!.result.considered).toBe(0);
  });
});

describe('loadTaskAreaConfig', () => {
  it('falls back to a working config when there is no row', async () => {
    const config = await loadTaskAreaConfig();
    expect(config).toEqual(TASK_AREA_FALLBACK);
  });

  it('lets the system_cache row override the fallback with no deploy', async () => {
    fake.cacheRow = { value: { fraction: 0.5, pathSource: 'manifest', topK: 3 } };
    const config = await loadTaskAreaConfig();
    expect(config).toMatchObject({ fraction: 0.5, pathSource: 'manifest', topK: 3 });
  });

  it('ignores a row that is not an object', async () => {
    fake.cacheRow = { value: ['nope'] };
    expect(await loadTaskAreaConfig()).toEqual(TASK_AREA_FALLBACK);
  });
});
