import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * The task-estimates I/O half (packages/core/task-estimate-source.ts): the
 * write's skip / insert-once / never-throws contract against a stubbed
 * client, the prior's numbers-and-enum-keys-only shape, the prior query
 * rendered through the real PgDialect, and the pure evidence builders.
 */

const TASK = '00000000-0000-4000-8000-000000000001';
const WS = '00000000-0000-4000-8000-0000000000aa';
const TEAM = '00000000-0000-4000-8000-0000000000bb';
const SECRET_TITLE = 'Rotate the payroll export credentials';

const fake = {
  task: null as any,
  team: null as any,
  estimates: [] as Array<{ taskId: string; estimatorVersion: string; [k: string]: unknown }>,
  inserts: [] as any[],
  conflictTargets: [] as any[],
  insertThrows: null as Error | null,
  taskThrows: null as Error | null,
};

mock.module('../db/client', () => ({
  db: {
    query: {
      tasks: { findFirst: async () => { if (fake.taskThrows) throw fake.taskThrows; return fake.task; } },
      teams: { findFirst: async () => fake.team },
      systemCache: { findFirst: async () => null },
    },
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => fake.estimates.map(e => ({ id: 'est-1', ...e })) }),
      }),
    }),
    insert: () => ({
      values: (v: any) => ({
        onConflictDoNothing: (opts: any) => {
          fake.conflictTargets.push(opts?.target);
          return {
            returning: async () => {
              if (fake.insertThrows) throw fake.insertThrows;
              const dup = fake.estimates.some(e => e.taskId === v.taskId && e.estimatorVersion === v.estimatorVersion);
              if (dup) return [];
              fake.estimates.push(v);
              fake.inserts.push(v);
              return [{ id: 'est-1' }];
            },
          };
        },
      }),
    }),
    execute: async () => ({ rows: [] }),
  },
}));

const src = await import('../task-estimate-source');
const { priorAggregateQuery } = await import('../task-estimate-source');
const { ESTIMATOR_VERSION, estimateTask } = await import('../task-estimate');

const taskRow = (o: Record<string, unknown> = {}) => ({
  id: TASK, workspaceId: WS, title: SECRET_TITLE, description: 'details', kind: 'engineering', complexity: 'normal',
  createdAt: new Date('2026-10-01T00:00:00Z'), pathManifest: null, taskClass: 'work', workspace: { teamId: TEAM }, ...o,
});

const inputs = () => ({
  kind: 'engineering', bucket: null, k0: 8,
  neighbours: { n: 4, p50Minutes: 30, p80Minutes: 60, p50Tokens: 100_000, p80Tokens: 200_000 },
  clusters: null,
  prior: {},
});

let warnings: string[] = [];
const realWarn = console.warn;

beforeEach(() => {
  fake.task = taskRow();
  fake.team = { taskEstimates: { enabled: true, setBy: 'u', setAt: '2026-10-01T00:00:00Z' } };
  fake.estimates = [];
  fake.inserts = [];
  fake.conflictTargets = [];
  fake.insertThrows = null;
  fake.taskThrows = null;
  warnings = [];
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
  src.resetTaskEstimateCaches();
});
afterEach(() => { console.warn = realWarn; });

describe('writeTaskEstimate', () => {
  it('skips when the team has not opted in (NULL, missing key, or anything but enabled: true)', async () => {
    const loadInputs = mock(async () => inputs() as any);
    for (const team of [{ taskEstimates: null }, { taskEstimates: {} }, { taskEstimates: { enabled: 'true' } }, { taskEstimates: { enabled: false } }, null]) {
      fake.team = team;
      expect(await src.writeTaskEstimate(TASK, { loadInputs })).toBe('skipped');
    }
    expect(loadInputs).not.toHaveBeenCalled();
    expect(fake.inserts).toHaveLength(0);
  });

  it('skips a task that does not exist, or is not a work task', async () => {
    fake.task = null;
    expect(await src.writeTaskEstimate(TASK, { loadInputs: async () => inputs() as any })).toBe('skipped');
    fake.task = taskRow({ taskClass: 'attempt' });
    expect(await src.writeTaskEstimate(TASK, { loadInputs: async () => inputs() as any })).toBe('skipped');
    expect(fake.inserts).toHaveLength(0);
  });

  it('inserts one frozen row when on; a second call is "exists" and writes nothing', async () => {
    const loadInputs = mock(async () => inputs() as any);
    expect(await src.writeTaskEstimate(TASK, { loadInputs })).toBe('written');
    expect(await src.writeTaskEstimate(TASK, { loadInputs })).toBe('exists');
    expect(fake.inserts).toHaveLength(1);
    const row = fake.inserts[0];
    expect(row).toMatchObject({ teamId: TEAM, workspaceId: WS, taskId: TASK, estimatorVersion: ESTIMATOR_VERSION });
    expect(Number.isInteger(row.p50Tokens) && Number.isInteger(row.p80Tokens)).toBe(true);
    expect(row.p80Minutes).toBeGreaterThanOrEqual(row.p50Minutes);
    expect(typeof row.explanation.summary).toBe('string');
    // Conflict target is the (task_id, estimator_version) unique index.
    expect(fake.conflictTargets[0].map((c: any) => c.name)).toEqual(['task_id', 'estimator_version']);
  });

  it('a concurrent writer that wins the race makes this call "exists" (ON CONFLICT DO NOTHING)', async () => {
    let first = true;
    const loadInputs = async () => {
      // Another writer lands between the pre-check and this insert.
      if (first) { first = false; fake.estimates.push({ taskId: TASK, estimatorVersion: ESTIMATOR_VERSION }); }
      return inputs() as any;
    };
    expect(await src.writeTaskEstimate(TASK, { loadInputs })).toBe('exists');
    expect(fake.inserts).toHaveLength(0);
  });

  it('returns "failed" and does not throw when the estimator throws', async () => {
    const out = await src.writeTaskEstimate(TASK, {
      loadInputs: async () => inputs() as any,
      estimate: () => { throw new TypeError(`bad input for ${SECRET_TITLE}`); },
    });
    expect(out).toBe('failed');
    expect(fake.inserts).toHaveLength(0);
  });

  it('returns "failed" and does not throw when the DB throws (read or insert)', async () => {
    fake.insertThrows = new Error(`Failing row contains (${SECRET_TITLE})`);
    expect(await src.writeTaskEstimate(TASK, { loadInputs: async () => inputs() as any })).toBe('failed');
    fake.insertThrows = null;
    fake.taskThrows = new Error('connection reset');
    expect(await src.writeTaskEstimate(TASK, { loadInputs: async () => inputs() as any })).toBe('failed');
  });

  it('a failing input loader is "failed" too', async () => {
    expect(await src.writeTaskEstimate(TASK, { loadInputs: async () => { throw new Error('boom'); } })).toBe('failed');
  });

  it('logs ids and error names only, never task text or an error message', async () => {
    fake.insertThrows = new Error(`Failing row contains (${SECRET_TITLE})`);
    await src.writeTaskEstimate(TASK, { loadInputs: async () => inputs() as any });
    await src.writeTaskEstimate(TASK, { loadInputs: async () => inputs() as any, estimate: () => { throw new Error(SECRET_TITLE); } });
    expect(warnings.length).toBeGreaterThan(0);
    for (const w of warnings) {
      expect(w).toContain(TASK);
      expect(w).not.toContain('payroll');
      expect(w).not.toContain('Failing row');
    }
  });

  it('writes what the real estimator computes from the loaded inputs', async () => {
    await src.writeTaskEstimate(TASK, { loadInputs: async () => inputs() as any });
    const expected = estimateTask(inputs() as any);
    expect(fake.inserts[0].p50Minutes).toBeCloseTo(expected.p50Minutes, 6);
    expect(fake.inserts[0].explanation).toEqual(expected.explanation);
  });
});

describe('readTaskEstimatesSetting', () => {
  it('only a literal enabled: true is on', () => {
    expect(src.readTaskEstimatesSetting({ enabled: true })).toBe(true);
    for (const v of [null, undefined, {}, { enabled: 1 }, { enabled: 'true' }, [true], 'enabled']) {
      expect(src.readTaskEstimatesSetting(v)).toBe(false);
    }
  });
});

describe('buildPriorTable: numbers and enum keys only', () => {
  const row = (o: Record<string, unknown>) => ({
    kind: 'engineering', bucket: 'M', n: '12', p50_minutes: '40.5', p80_minutes: 90, p50_tokens: '150000',
    p80_tokens: 300000, repairs_per_task: '0.25', ...o,
  });

  it('keys by known kind and S/M/L; every value is a finite number', () => {
    const table = src.buildPriorTable([
      row({}),
      row({ kind: 'unknown', bucket: 'S', n: 5 }),
      // Free text in the kind column never becomes a key.
      row({ kind: 'apps/web/src/secret-thing', n: 50 }),
      row({ kind: 'engineering', bucket: 'XL', n: 50 }),
      // Extra columns are not carried.
      row({ kind: 'research', title: SECRET_TITLE, workspace_id: WS, path: 'apps/web' }),
    ]);
    expect(table).toEqual({
      engineering: { M: { n: 12, p50Minutes: 40.5, p80Minutes: 90, p50Tokens: 150000, p80Tokens: 300000, repairsPerTask: 0.25 } },
      unknown: { S: { n: 5, p50Minutes: 40.5, p80Minutes: 90, p50Tokens: 150000, p80Tokens: 300000, repairsPerTask: 0.25 } },
      research: { M: { n: 12, p50Minutes: 40.5, p80Minutes: 90, p50Tokens: 150000, p80Tokens: 300000, repairsPerTask: 0.25 } },
    });

    const kinds = new Set<string>(src.PRIOR_KINDS);
    const cellKeys = new Set(['n', 'p50Minutes', 'p80Minutes', 'p50Tokens', 'p80Tokens', 'repairsPerTask']);
    for (const [kind, byBucket] of Object.entries(table)) {
      expect(kinds.has(kind)).toBe(true);
      for (const [bucket, cell] of Object.entries(byBucket!)) {
        expect(['S', 'M', 'L']).toContain(bucket);
        for (const [k, v] of Object.entries(cell!)) {
          expect(cellKeys.has(k)).toBe(true);
          expect(typeof v).toBe('number');
          expect(Number.isFinite(v)).toBe(true);
        }
      }
    }
    expect(JSON.stringify(table)).not.toContain('secret');
  });

  it('drops cells under the minimum n and rows with a non-numeric or negative value', () => {
    expect(src.buildPriorTable([
      row({ n: src.PRIOR_MIN_CELL_N - 1 }),
      row({ kind: 'design', p50_minutes: 'abc' }),
      row({ kind: 'writing', p80_tokens: -1 }),
      row({ kind: 'analysis', repairs_per_task: null }),
    ])).toEqual({});
  });
});

describe('priorAggregateQuery (rendered)', () => {
  const cutoff = new Date('2026-10-01T00:00:00Z');
  const q = new PgDialect().sqlToQuery(priorAggregateQuery(cutoff));
  const text = q.sql.replace(/\s+/g, ' ').toLowerCase();

  it('reads completed work tasks only, created and finished before the cutoff', () => {
    expect(text).toContain("t.task_class = 'work'");
    expect(text).toContain("t.status = 'completed'");
    expect(text).toContain('t.created_at < $1::timestamptz');
    expect(text).toContain('w.completed_at < $3::timestamptz');
    expect(text).toContain("a.task_class = 'attempt'");
    expect(q.params).toEqual(Array(4).fill(cutoff.toISOString()));
  });

  it('sizes tasks as the backtest does: completed sessions summed, whole tasks only, unrecorded tokens excluded', () => {
    expect(text).toContain("w.status = 'completed'");
    expect(text).toContain('sum(extract(epoch from (w.completed_at - w.started_at)) / 60.0) as minutes');
    expect(text).toContain('sum(coalesce(w.input_tokens, 0) + coalesce(w.output_tokens, 0)) as tokens');
    expect(text).toContain('not exists ( select 1 from workers wf where wf.task_id = t.id and wf.completed_at >= $2::timestamptz )');
    expect(text).toContain('order by s.tokens) filter (where s.tokens > 0)');
  });

  it('groups by kind and bucket only, and selects only those two keys plus numbers', () => {
    expect(text).toMatch(/group by d\.kind, d\.bucket\s*$/);
    const finalSelect = text.slice(text.lastIndexOf('select d.kind'), text.lastIndexOf(' from done d'));
    expect(finalSelect).not.toMatch(/title|description|path|workspace_id|label|\bd\.id\b/);
    const aliases = [...finalSelect.matchAll(/ as ([a-z0-9_]+)/g)].map(m => m[1]);
    expect(aliases).toEqual(['kind', 'bucket', 'n', 'p50_minutes', 'p80_minutes', 'p50_tokens', 'p80_tokens', 'repairs_per_task']);
  });

  it('is not scoped to a workspace: the prior is cross-workspace aggregates', () => {
    expect(text).not.toContain('workspace_id');
  });
});

describe('neighbourEvidenceFrom (pure)', () => {
  const cutoff = new Date('2026-10-01T00:00:00Z');
  const before = (h: number) => new Date(cutoff.getTime() - h * 3_600_000);
  const s = (taskId: string, startH: number, minutes: number, tokens = 1000) => ({
    taskId, startedAt: before(startH), completedAt: new Date(before(startH).getTime() + minutes * 60_000), inputTokens: tokens, outputTokens: 0,
  });

  it('p50/p80 over per-task sums of minutes and tokens', () => {
    const e = src.neighbourEvidenceFrom(['a', 'b', 'c'], [s('a', 10, 10, 100), s('a', 8, 10, 100), s('b', 10, 40, 400), s('c', 10, 60, 600)], { cutoff });
    expect(e).toEqual({ n: 3, p50Minutes: 40, p80Minutes: 60, p50Tokens: 400, p80Tokens: 600 });
  });

  it('a session ending at/after the cutoff and a neighbour created after it are the future', () => {
    const late = { taskId: 'a', startedAt: before(1), completedAt: new Date(cutoff.getTime() + 60_000), inputTokens: 1, outputTokens: 1 };
    const e = src.neighbourEvidenceFrom(['a', 'b', 'c'], [late, s('b', 10, 40), s('c', 10, 60)], {
      cutoff, createdAtById: new Map([['c', new Date(cutoff.getTime() + 1)]]),
    });
    expect(e).toBeNull(); // only b is left; one neighbour is not evidence
  });
});

describe('resolveTaskEstimateK0', () => {
  it('fallback 8, env over fallback, system_cache over env; bad values refused, not clamped', () => {
    expect(src.resolveTaskEstimateK0({}, null)).toEqual({ k0: 8, rejected: [] });
    expect(src.resolveTaskEstimateK0({ BUILDD_TASK_ESTIMATE_K0: '12' }, null).k0).toBe(12);
    expect(src.resolveTaskEstimateK0({ BUILDD_TASK_ESTIMATE_K0: '12' }, { k0: 4 }).k0).toBe(4);
    const bad = src.resolveTaskEstimateK0({ BUILDD_TASK_ESTIMATE_K0: 'lots' }, { k0: -1 });
    expect(bad.k0).toBe(8);
    expect(bad.rejected).toHaveLength(2);
  });
});
