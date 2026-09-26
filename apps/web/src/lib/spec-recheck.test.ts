import { describe, it, expect, beforeEach, mock } from 'bun:test';

// End-to-end over lib/spec-recheck.ts + lib/doc-fix-dispatch.ts against a
// small stateful fake DB: a doc-fix merge gets a forced ledger re-run with no
// human action, a merged-and-still-open row gets exactly ONE automatic
// follow-up, and nothing is dispatched twice. docs/design/spec-conformance.md
// §9/§12.1.

type Row = Record<string, any>;
const tables: Record<string, Row[]> = { spec_discrepancies: [], tasks: [], workers: [], workspaces: [] };
let nextId = 1;

const table = (name: string, cols: string[]) =>
  Object.assign({ __table: name }, Object.fromEntries(cols.map((c) => [c, c])));

const specDiscrepancies = table('spec_discrepancies', [
  'id', 'workspaceId', 'specPath', 'assertionId', 'direction', 'status', 'firstSeenAt', 'lastCheckedAt',
  'docFixTaskId', 'recheckRequestedAt', 'autoFollowUpTaskId', 'evidence',
]);
const tasks = table('tasks', ['id', 'status']);
const workers = table('workers', ['taskId', 'prLifecycleStatus', 'mergedAt', 'startedAt', 'prUrl']);
const workspaces = table('workspaces', ['id']);

const val = (v: any) => (v instanceof Date ? v.getTime() : v);
function matches(row: Row, f: any): boolean {
  if (!f) return true;
  switch (f.op) {
    case 'and': return f.args.filter(Boolean).every((a: any) => matches(row, a));
    case 'or': return f.args.some((a: any) => matches(row, a));
    case 'eq': return val(row[f.col]) === val(f.v);
    case 'ne': return val(row[f.col]) !== val(f.v);
    case 'lt': return row[f.col] != null && val(row[f.col]) < val(f.v);
    case 'isNull': return row[f.col] == null;
    case 'isNotNull': return row[f.col] != null;
    case 'inArray': return f.v.includes(row[f.col]);
    default: throw new Error(`unmocked op ${f.op}`);
  }
}

mock.module('drizzle-orm', () => ({
  and: (...args: any[]) => ({ op: 'and', args }),
  or: (...args: any[]) => ({ op: 'or', args }),
  eq: (col: string, v: any) => ({ op: 'eq', col, v }),
  ne: (col: string, v: any) => ({ op: 'ne', col, v }),
  lt: (col: string, v: any) => ({ op: 'lt', col, v }),
  isNull: (col: string) => ({ op: 'isNull', col }),
  isNotNull: (col: string) => ({ op: 'isNotNull', col }),
  inArray: (col: string, v: any[]) => ({ op: 'inArray', col, v }),
}));
mock.module('@buildd/core/db/schema', () => ({ specDiscrepancies, tasks, workers, workspaces }));

const db = {
  select: () => ({
    from: (t: any) => ({ where: (f: any) => Promise.resolve(tables[t.__table].filter((r) => matches(r, f)).map((r) => ({ ...r }))) }),
  }),
  update: (t: any) => ({
    set: (vals: Row) => ({
      where: (f: any) => {
        const hit = tables[t.__table].filter((r) => matches(r, f));
        for (const r of hit) Object.assign(r, vals);
        const res = Promise.resolve(undefined) as any;
        res.returning = () => Promise.resolve(hit.map((r) => ({ id: r.id })));
        return res;
      },
    }),
  }),
  insert: (t: any) => ({
    values: (v: Row) => {
      const r = { id: `task-${nextId++}`, ...v };
      tables[t.__table].push(r);
      return { returning: () => Promise.resolve([r]) };
    },
  }),
  delete: (t: any) => ({
    where: (f: any) => {
      tables[t.__table] = tables[t.__table].filter((r) => !matches(r, f));
      return Promise.resolve();
    },
  }),
  query: {
    specDiscrepancies: { findFirst: ({ where }: any) => Promise.resolve(tables.spec_discrepancies.find((r) => matches(r, where))) },
    tasks: { findMany: ({ where }: any) => Promise.resolve(tables.tasks.filter((r) => matches(r, where))) },
    workers: { findMany: ({ where }: any) => Promise.resolve(tables.workers.filter((r) => matches(r, where))) },
    workspaces: { findFirst: ({ where }: any) => Promise.resolve(tables.workspaces.find((r) => matches(r, where))) },
  },
};
mock.module('@buildd/core/db', () => ({ db }));

const dispatchedTasks: Row[] = [];
mock.module('@/lib/task-dispatch', () => ({
  dispatchNewTask: (task: Row) => { dispatchedTasks.push(task); return Promise.resolve(); },
}));
mock.module('@/lib/github', () => ({ githubApi: () => Promise.resolve({}) }));

const { requestRecheckForMergedDocFix, sweepSpecDiscrepancyRechecks } = await import('./spec-recheck');
const { DOC_FIX_RECHECK_GRACE_MS, DOC_FIX_AUTOMATION_BUDGET_MS } = await import('./action-queue');

const HOUR = 60 * 60 * 1000;
const T0 = new Date('2026-06-10T12:00:00Z'); // the doc-fix merge
const at = (ms: number) => new Date(T0.getTime() + ms);

let ledgerRuns: string[] = [];
let dispatcherOk = true;
const dispatcher = async (workspaceId: string) => {
  if (!dispatcherOk) return { ok: false, reason: 'boom' };
  ledgerRuns.push(workspaceId);
  return { ok: true };
};

function seed() {
  tables.spec_discrepancies = [
    {
      id: 'd-1', workspaceId: 'ws-1', specPath: 'docs/design/x.md', assertionId: 'a-1',
      direction: 'code_ahead', status: 'open', firstSeenAt: at(-10 * 24 * HOUR), lastCheckedAt: at(-HOUR),
      docFixTaskId: 'fix-1', recheckRequestedAt: null, autoFollowUpTaskId: null,
      evidence: { detail: 'symbol found', declaredStatus: 'partially' },
    },
  ];
  tables.tasks = [{ id: 'fix-1', status: 'completed' }];
  tables.workers = [{ taskId: 'fix-1', prLifecycleStatus: 'merged', mergedAt: T0, startedAt: at(-2 * HOUR), prUrl: 'https://github.com/o/r/pull/1' }];
  tables.workspaces = [{ id: 'ws-1', name: 'ws' }];
}

/** What the ledger writer does when its (forced) run finds the gap still open: refresh. */
function ledgerRechecksStillOpen(when: Date) {
  for (const r of tables.spec_discrepancies) if (r.status === 'open') r.lastCheckedAt = when;
}

beforeEach(() => {
  seed();
  ledgerRuns = [];
  dispatchedTasks.length = 0;
  dispatcherOk = true;
  nextId = 1;
});

describe('doc-fix merge → forced ledger re-run', () => {
  it('the merge webhook dispatches the forced re-run once, and stamps the row', async () => {
    const r = await requestRecheckForMergedDocFix('fix-1', at(60_000), dispatcher);
    expect(r).toEqual({ dispatched: true, reason: 'dispatched' });
    expect(ledgerRuns).toEqual(['ws-1']);
    expect(tables.spec_discrepancies[0].recheckRequestedAt).toEqual(at(60_000));
    // A redelivered webhook is covered by the run already in flight.
    const again = await requestRecheckForMergedDocFix('fix-1', at(2 * 60_000), dispatcher);
    expect(again.dispatched).toBe(false);
    expect(ledgerRuns).toHaveLength(1);
  });

  it('a task that is not a doc fix is a no-op', async () => {
    const r = await requestRecheckForMergedDocFix('some-other-task', at(60_000), dispatcher);
    expect(r.reason).toBe('nothing_to_do');
    expect(ledgerRuns).toHaveLength(0);
  });

  it('the row never changes status on merge (§9) — only the stamp moves', async () => {
    await requestRecheckForMergedDocFix('fix-1', at(60_000), dispatcher);
    expect(tables.spec_discrepancies[0].status).toBe('open');
  });
});

describe('hourly sweep', () => {
  it('dispatches for a merged fix never rechecked after the threshold — and not twice while in flight', async () => {
    const first = await sweepSpecDiscrepancyRechecks(at(90 * 60_000), { dispatcher });
    expect(first.rechecksDispatched).toBe(1);
    const second = await sweepSpecDiscrepancyRechecks(at(95 * 60_000), { dispatcher });
    expect(second.rechecksDispatched).toBe(0);
    expect(ledgerRuns).toHaveLength(1);
  });

  it('leaves the first hour to the ordinary dev-push run', async () => {
    const r = await sweepSpecDiscrepancyRechecks(at(30 * 60_000), { dispatcher });
    expect(r.rechecksDispatched).toBe(0);
  });

  it('a failed dispatch releases the stamp so the next sweep retries', async () => {
    dispatcherOk = false;
    const failed = await sweepSpecDiscrepancyRechecks(at(90 * 60_000), { dispatcher });
    expect(failed.rechecksFailed).toBe(1);
    expect(tables.spec_discrepancies[0].recheckRequestedAt).toBeNull();
    dispatcherOk = true;
    const retried = await sweepSpecDiscrepancyRechecks(at(95 * 60_000), { dispatcher });
    expect(retried.rechecksDispatched).toBe(1);
  });

  it('stops re-dispatching past the automation budget (bounded, then the owner sees it)', async () => {
    const r = await sweepSpecDiscrepancyRechecks(at(DOC_FIX_AUTOMATION_BUDGET_MS + HOUR), { dispatcher });
    expect(r.rechecksDispatched).toBe(0);
  });
});

describe('merged, rechecked, still open → exactly one automatic follow-up', () => {
  it('files one follow-up through the doc-fix dispatch, never a second, and then leaves it to the owner', async () => {
    ledgerRechecksStillOpen(at(DOC_FIX_RECHECK_GRACE_MS + 5 * 60_000));

    const first = await sweepSpecDiscrepancyRechecks(at(2 * HOUR), { dispatcher });
    expect(first.followUpsDispatched).toBe(1);
    expect(first.rechecksDispatched).toBe(0); // already rechecked — no re-run owed
    const row = tables.spec_discrepancies[0];
    const followUp = tables.tasks.find((t) => t.id === row.docFixTaskId)!;
    expect(row.autoFollowUpTaskId).toBe(followUp.id);
    expect(followUp.title).toContain('Settle stale spec assertions');
    expect(followUp.description).toContain('skip_until');
    expect(followUp.description).toContain('git log --oneline -- docs/design/x.md');
    expect(followUp.description).toContain('https://github.com/o/r/pull/1');
    expect(followUp.creationSource).toBe('orchestrator');
    expect(followUp.context.specDocFix.followUpOf).toBe('fix-1');
    expect(dispatchedTasks).toHaveLength(1);

    // While it runs: nothing more.
    const running = await sweepSpecDiscrepancyRechecks(at(3 * HOUR), { dispatcher });
    expect(running.followUpsDispatched).toBe(0);

    // It completes and merges, the forced re-run fires, and the gap survives.
    followUp.status = 'completed';
    tables.workers.push({ taskId: followUp.id, prLifecycleStatus: 'merged', mergedAt: at(4 * HOUR), startedAt: at(3 * HOUR) });
    const recheck = await requestRecheckForMergedDocFix(followUp.id, at(4 * HOUR + 60_000), dispatcher);
    expect(recheck.dispatched).toBe(true);
    ledgerRechecksStillOpen(at(4 * HOUR + DOC_FIX_RECHECK_GRACE_MS + 60_000));

    // The cap is spent: no second follow-up, ever.
    const capped = await sweepSpecDiscrepancyRechecks(at(6 * HOUR), { dispatcher });
    expect(capped.followUpsDispatched).toBe(0);
    expect(tables.tasks.filter((t) => t.title?.startsWith('Settle stale spec assertions'))).toHaveLength(1);
    expect(tables.spec_discrepancies[0].status).toBe('open');
  });

  it('two sweeps racing on the same rows still file only one follow-up (the atomic claim decides)', async () => {
    ledgerRechecksStillOpen(at(DOC_FIX_RECHECK_GRACE_MS + 5 * 60_000));
    const [a, b] = await Promise.all([
      sweepSpecDiscrepancyRechecks(at(2 * HOUR), { dispatcher }),
      sweepSpecDiscrepancyRechecks(at(2 * HOUR), { dispatcher }),
    ]);
    expect(a.followUpsDispatched + b.followUpsDispatched).toBe(1);
    expect(dispatchedTasks).toHaveLength(1);
  });
});
