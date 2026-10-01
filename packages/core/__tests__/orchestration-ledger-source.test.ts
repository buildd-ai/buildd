import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * The DB half of the orchestration decision/outcome ledger. Predicates are
 * rendered with the real PgDialect (mocking `db` alone would make every WHERE
 * unobservable); only the client is stubbed.
 */

const fake = {
  inserted: [] as { table: string; values: any; target?: any }[],
  selectRows: [] as any[],
  selects: [] as { table: string; where: any }[],
  throwOnInsert: false,
  throwOnSelect: false,
};

const nameOf = (table: any) => table?.[Symbol.for('drizzle:Name')];

mock.module('../db/client', () => ({
  db: {
    insert: (table: any) => ({
      values: (values: any) => {
        const run = async (target?: any) => {
          if (fake.throwOnInsert) throw new Error('insert failed');
          fake.inserted.push({ table: nameOf(table), values, target });
        };
        const p: any = run();
        p.onConflictDoNothing = async (opts: any) => {
          fake.inserted.pop();
          await run(opts?.target);
        };
        p.catch(() => {});
        return p;
      },
    }),
    select: () => ({
      from: (table: any) => ({
        where: (where: any) => {
          fake.selects.push({ table: nameOf(table), where });
          const res: any = (async () => {
            if (fake.throwOnSelect) throw new Error('db down');
            return fake.selectRows;
          })();
          res.limit = async () => res;
          res.catch(() => {});
          return res;
        },
      }),
    }),
  },
}));

const src = await import('../orchestration-ledger-source');
const schema = await import('../db/schema');

const dialect = new PgDialect();
const render = (fragment: any) => {
  const q = dialect.sqlToQuery(fragment);
  return { sql: q.sql.replace(/\s+/g, ' ').trim().toLowerCase(), params: q.params };
};

const WS = '00000000-0000-4000-8000-0000000000aa';
const TASK = '00000000-0000-4000-8000-000000000001';
const WORKER = '00000000-0000-4000-8000-000000000009';
const SINCE = new Date('2026-09-01T00:00:00Z');
const UNTIL = new Date('2026-09-08T00:00:00Z');

beforeEach(() => {
  fake.inserted = [];
  fake.selectRows = [];
  fake.selects = [];
  fake.throwOnInsert = false;
  fake.throwOnSelect = false;
});

describe('schema', () => {
  it('declares both ledger tables with the columns the readout groups by', () => {
    const d = schema.orchestrationDecisions as any;
    for (const col of ['decisionId', 'decisionVersion', 'fingerprint', 'candidatePolicyVersion', 'candidateDigest', 'ruleVerdict', 'suggested', 'applied', 'errorKind', 'costUsd', 'latencyMs', 'experimentArm', 'propensity', 'model', 'prNumber', 'headSha', 'baseRef']) {
      expect(d[col]).toBeDefined();
    }
    const l = schema.orchestrationTouchLabels as any;
    for (const col of ['taskId', 'workerId', 'workerStatus', 'touchedPaths', 'truncated', 'prNumber', 'headSha', 'baseRef']) {
      expect(l[col]).toBeDefined();
    }
  });
});

describe('recordOrchestrationDecision', () => {
  it('inserts the row and never throws', async () => {
    await src.recordOrchestrationDecision({ teamId: 't', workspaceId: WS, decisionId: 'buildd.x' } as any);
    expect(fake.inserted).toEqual([{ table: 'orchestration_decisions', values: expect.objectContaining({ decisionId: 'buildd.x' }), target: undefined }]);
    fake.throwOnInsert = true;
    await expect(src.recordOrchestrationDecision({ teamId: 't', workspaceId: WS } as any)).resolves.toBeUndefined();
  });
});

describe('recordOrchestrationTouchLabel', () => {
  const label = { taskId: TASK, workspaceId: WS, workerId: WORKER, workerStatus: 'completed', paths: ['a.ts', 'a.ts', 'b.ts'], prNumber: 7, headSha: 'h1', baseRef: 'dev' };

  it('writes nothing for a task no decision ever looked at', async () => {
    fake.selectRows = [];
    expect(await src.recordOrchestrationTouchLabel(label)).toBe(false);
    expect(fake.inserted).toHaveLength(0);
    const where = render(fake.selects[0].where);
    expect(fake.selects[0].table).toBe('orchestration_decisions');
    expect(where.sql).toContain('"orchestration_decisions"."task_id" = $1');
    expect(where.sql).toContain('"orchestration_decisions"."workspace_id" = $2');
    expect(where.params).toEqual([TASK, WS]);
  });

  it('writes one deduped label per worker session for a decided task', async () => {
    fake.selectRows = [{ id: 'd1' }];
    expect(await src.recordOrchestrationTouchLabel(label)).toBe(true);
    expect(fake.inserted).toHaveLength(1);
    const ins = fake.inserted[0];
    expect(ins.table).toBe('orchestration_touch_labels');
    expect(ins.values).toMatchObject({ taskId: TASK, workspaceId: WS, workerId: WORKER, workerStatus: 'completed', touchedPaths: ['a.ts', 'b.ts'], truncated: false, prNumber: 7, headSha: 'h1', baseRef: 'dev' });
    expect(ins.target).toBeDefined();
  });

  it('records an empty observation as an explicit empty label (a session that edited nothing)', async () => {
    fake.selectRows = [{ id: 'd1' }];
    expect(await src.recordOrchestrationTouchLabel({ ...label, paths: [] })).toBe(true);
    expect(fake.inserted[0].values.touchedPaths).toEqual([]);
  });

  it('never throws on a failed read or write', async () => {
    fake.throwOnSelect = true;
    expect(await src.recordOrchestrationTouchLabel(label)).toBe(false);
    fake.throwOnSelect = false;
    fake.selectRows = [{ id: 'd1' }];
    fake.throwOnInsert = true;
    expect(await src.recordOrchestrationTouchLabel(label)).toBe(false);
  });

  it('skips a malformed task id without touching the DB', async () => {
    expect(await src.recordOrchestrationTouchLabel({ ...label, taskId: 'nope' })).toBe(false);
    expect(fake.selects).toHaveLength(0);
  });
});

describe('outcome-join predicates are workspace scoped', () => {
  it('decisions: workspace + window (+ decision id when given)', () => {
    const r = render(src.decisionsWhere({ workspaceId: WS, since: SINCE, until: UNTIL, decisionId: 'buildd.claim_hold' }));
    expect(r.sql).toContain('"orchestration_decisions"."workspace_id" = $1');
    expect(r.sql).toContain('"orchestration_decisions"."created_at" >= $2');
    expect(r.sql).toContain('"orchestration_decisions"."created_at" < $3');
    expect(r.sql).toContain('"orchestration_decisions"."decision_id" = $4');
    expect(r.params[0]).toBe(WS);
  });

  it('tasks, labels and PR workers: workspace + the task ids', () => {
    for (const [fn, table] of [[src.tasksWhere, 'tasks'], [src.labelsWhere, 'orchestration_touch_labels'], [src.prWorkersWhere, 'workers']] as const) {
      const r = render(fn({ workspaceId: WS, taskIds: [TASK] }));
      expect(r.sql).toContain(`"${table}"."workspace_id" = $1`);
      expect(r.sql).toContain(`"${table}"."task_id" in ($2)`.replace('"tasks"."task_id"', '"tasks"."id"'));
      expect(r.params).toEqual([WS, TASK]);
    }
    expect(render(src.prWorkersWhere({ workspaceId: WS, taskIds: [TASK] })).sql).toContain('"workers"."pr_number" is not null');
  });

  it('conflict tasks: workspace + conflict-created + the PR numbers + after the window start', () => {
    const r = render(src.conflictTasksWhere({ workspaceId: WS, prNumbers: [7, 8], since: SINCE }));
    expect(r.sql).toContain('"tasks"."workspace_id" = $1');
    expect(r.sql).toContain('"tasks"."conflict_retry_pr_number" in ($2, $3)');
    expect(r.sql).toContain('"tasks"."created_at" >= $4');
    expect(r.params.slice(0, 3)).toEqual([WS, 7, 8]);
  });

  it('gate events: workspace + only the three outcome gates + after the window start', () => {
    const r = render(src.outcomeGateEventsWhere({ workspaceId: WS, since: SINCE }));
    expect(r.sql).toContain('"gate_events"."workspace_id" = $1');
    expect(r.sql).toContain('"gate_events"."gate" in ($2, $3)');
    expect(r.params.slice(1, 3).sort()).toEqual(['merge_base_freshness', 'path_claim']);
    expect(r.sql).toContain('"gate_events"."occurred_at" >= $4');
  });

  it('an empty id list is never rendered as an unscoped read', async () => {
    fake.selectRows = [];
    const out = await src.loadOrchestrationOutcomeInput({ workspaceId: WS, since: SINCE, until: UNTIL });
    expect(out.decisions).toEqual([]);
    expect(fake.selects).toHaveLength(1);
  });
});
