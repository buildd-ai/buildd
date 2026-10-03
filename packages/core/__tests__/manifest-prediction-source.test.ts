import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * The stores half of creation-time manifest prediction (design §5a). The SQL
 * is rendered with the real PgDialect so workspace scoping and the leakage
 * cutoff are observable; only the client is stubbed. The orchestration is
 * driven through injected deps: no network, no DB.
 */

const fake = {
  inserted: [] as { table: string; values: any; target?: any }[],
  executed: [] as any[],
  executeRows: [] as any[],
  selectRows: [] as any[],
  tableRows: {} as Record<string, any[]>,
  selects: [] as { table: string; where: any }[],
  throwOnInsert: false,
};
const nameOf = (table: any) => table?.[Symbol.for('drizzle:Name')];

mock.module('../db/client', () => ({
  db: {
    execute: async (q: any) => { fake.executed.push(q); return { rows: fake.executeRows }; },
    insert: (table: any) => ({
      values: (values: any) => ({
        onConflictDoNothing: async (opts: any) => {
          if (fake.throwOnInsert) throw new Error('insert failed');
          fake.inserted.push({ table: nameOf(table), values, target: opts?.target });
        },
      }),
    }),
    select: () => ({
      from: (table: any) => ({
        where: (where: any) => {
          fake.selects.push({ table: nameOf(table), where });
          const rows = fake.tableRows[nameOf(table)] ?? fake.selectRows;
          const res: any = Promise.resolve(rows);
          res.groupBy = async () => fake.selectRows;
          res.limit = async () => rows;
          return res;
        },
      }),
    }),
  },
}));

const src = await import('../manifest-prediction-source');
const { DONE_LABEL, MANIFEST_DECISION_ID } = await import('../manifest-prediction');
const schema = await import('../db/schema');

const dialect = new PgDialect();
const render = (fragment: any) => {
  const q = dialect.sqlToQuery(fragment);
  return { sql: q.sql.replace(/\s+/g, ' ').trim().toLowerCase(), params: q.params };
};

const WS = '00000000-0000-4000-8000-0000000000aa';
const TEAM = '00000000-0000-4000-8000-0000000000bb';
const TASK = '00000000-0000-4000-8000-000000000001';
const N1 = '00000000-0000-4000-8000-000000000011';
const N2 = '00000000-0000-4000-8000-000000000012';
const CREATED = new Date('2026-09-10T00:00:00Z');
const BEFORE = new Date('2026-09-09T00:00:00Z');
const AFTER = new Date('2026-09-11T00:00:00Z');

beforeEach(() => {
  fake.inserted = [];
  fake.executed = [];
  fake.executeRows = [];
  fake.selectRows = [];
  fake.tableRows = {};
  fake.selects = [];
  fake.throwOnInsert = false;
});

const okAccess = { ok: true as const, apiKey: 'k', model: 'typesafe/jev-1.13' };

function input(over: Partial<Parameters<typeof src.predictCreationManifest>[0]> = {}) {
  return {
    taskId: TASK,
    teamId: TEAM,
    workspaceId: WS,
    missionId: null,
    accountId: null,
    title: 'Fix the claim route',
    description: 'touch apps/web/src/app/api/workers/claim/route.ts',
    createdAt: CREATED,
    callerManifest: null,
    ...over,
  };
}

/** A call that answers the first offered file label, then DONE once `n` were picked. */
function pickFirst(n: number) {
  let calls = 0;
  const call = mock(async (params: any) => {
    calls++;
    const labels = Object.keys(params.questions.pick.criteria);
    const choice = calls > n ? DONE_LABEL : labels[0];
    return {
      ok: true,
      model: 'typesafe/jev-1.13',
      answers: { pick: { type: 'choice', choice, probabilities: {}, confidence: 0.9 } },
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      latencyMs: 5,
      attempts: 1,
    };
  });
  return call;
}

describe('schema', () => {
  it('declares the prediction table with the columns labelling reads', () => {
    const t = schema.orchestrationManifestPredictions as any;
    for (const col of ['taskId', 'workspaceId', 'teamId', 'candidates', 'picks', 'selected', 'stopReason', 'complete', 'unknownScope', 'coverage', 'taskCreatedAt', 'regexPaths', 'neighbourUnionPaths', 'candidatePolicyVersion']) {
      expect(t[col]).toBeDefined();
    }
  });
});

describe('the CBM candidate adapter', () => {
  it('is unavailable server-side (no revision-pinned index), so coverage is neighbour-diff only', async () => {
    const r = await src.getServerCbmCandidateAdapter().lookup({ workspaceId: WS, revision: null, seedText: 'x', limit: 10 });
    expect(r.status).toBe('unavailable');
  });
});

describe('leakage-safe neighbour reads', () => {
  it('completion lookup is workspace-scoped over the neighbour ids', () => {
    const w = render(src.neighbourCompletionWhere({ workspaceId: WS, taskIds: [N1, N2] }));
    expect(w.sql).toContain('"workers"."workspace_id" = $1');
    expect(w.sql).toContain('"workers"."task_id" in ($2, $3)');
    expect(w.sql).toContain('"workers"."completed_at" is not null');
    expect(w.params).toEqual([WS, N1, N2]);
  });

  it('diff paths come from the workspace pr namespace, current chunks, before the cutoff', () => {
    const q = render(src.neighbourDiffPathsQuery({ workspaceId: WS, taskIds: [N1], cutoff: CREATED }));
    expect(q.sql).toContain('namespace = $1');
    expect(q.params[0]).toBe(`${WS}:pr`);
    expect(q.sql).toContain("corpus = 'pr'");
    expect(q.sql).toContain('is_current = true');
    expect(q.sql).toContain('coalesce(source_ts, updated_at) < $');
    expect(q.params).toContain(CREATED.toISOString());
  });

  it('loadNeighbourEvidence reuses the task-corpus neighbours, drops the task itself and dates each neighbour', async () => {
    const store = {
      query: mock(async () => [
        { id: `task:${TASK}`, metadata: { taskId: TASK }, score: 0.99 },
        { id: `task:${N1}`, metadata: { taskId: N1 }, score: 0.8 },
        { id: `task:${N2}`, metadata: { taskId: N2 }, score: 0.7 },
      ]),
    };
    fake.selectRows = [{ taskId: N1, completedAt: BEFORE }, { taskId: N2, completedAt: AFTER }];
    fake.executeRows = [{ taskId: N1, path: 'a.ts' }];
    const ev = await src.loadNeighbourEvidence(store as any, { workspaceId: WS, taskId: TASK, seedText: 'x', cutoff: CREATED });
    expect(ev.map(e => e.taskId)).toEqual([N1, N2]);
    expect(ev[0]).toEqual({ taskId: N1, score: 0.8, completedAt: BEFORE, paths: ['a.ts'] });
    expect(ev[1].completedAt).toEqual(AFTER);
    // The task-corpus query is the workspace's own namespace.
    expect((store.query.mock.calls[0] as any)[0]).toBe(`${WS}:task`);
  });
});

describe('predictCreationManifest', () => {
  const neighbours = async () => [
    { taskId: N1, score: 0.9, completedAt: BEFORE, paths: ['a.ts', 'b.ts'] },
    { taskId: N2, score: 0.9, completedAt: AFTER, paths: ['future.ts'] },
  ];

  it('explicit caller manifests win: no access read, no retrieval, nothing written', async () => {
    const resolveAccess = mock(async () => okAccess);
    const loadNeighbours = mock(neighbours);
    const r = await src.predictCreationManifest(input({ callerManifest: ['x.ts'] }), { resolveAccess, loadNeighbours });
    expect(r).toEqual({ skipped: 'caller_declared' });
    expect(resolveAccess).not.toHaveBeenCalled();
    expect(loadNeighbours).not.toHaveBeenCalled();
  });

  it('the repo-wide sentinel is missing scope, not a declaration', async () => {
    const recordPrediction = mock(async () => {});
    const r = await src.predictCreationManifest(input({ callerManifest: ['**'] }), {
      resolveAccess: async () => ({ ok: false, error: { kind: 'capability_disabled', capability: 'orchestration_manifest' } }) as any,
      recordPrediction,
    });
    expect(r).toEqual({ skipped: 'capability_disabled' });
  });

  it('a too-wide glob is missing scope (same test as the creation gate), so a prediction is attempted', async () => {
    const resolveAccess = mock(async () => ({ ok: false, error: { kind: 'capability_disabled', capability: 'orchestration_manifest' } }) as any);
    const r = await src.predictCreationManifest(input({ callerManifest: ['apps/**'] }), { resolveAccess });
    expect(r).toEqual({ skipped: 'capability_disabled' });
    expect(resolveAccess).toHaveBeenCalledTimes(1);
  });

  it('a team that has not opted in costs one access read and nothing else', async () => {
    const loadNeighbours = mock(neighbours);
    const recordPrediction = mock(async () => {});
    const recordDecision = mock(async () => {});
    const r = await src.predictCreationManifest(input(), {
      resolveAccess: async () => ({ ok: false, error: { kind: 'capability_disabled', capability: 'orchestration_manifest' } }) as any,
      loadNeighbours, recordPrediction, recordDecision,
    });
    expect(r).toEqual({ skipped: 'capability_disabled' });
    expect(loadNeighbours).not.toHaveBeenCalled();
    expect(recordPrediction).not.toHaveBeenCalled();
    expect(recordDecision).not.toHaveBeenCalled();
  });

  it('shadow: selects multiple files over past-only candidates, records each pick and the prediction, applies nothing', async () => {
    const recordPrediction = mock(async (_row: any) => {});
    const recordDecision = mock(async (_row: any) => {});
    const call = pickFirst(2);
    const r = await src.predictCreationManifest(input(), {
      resolveAccess: async () => okAccess,
      loadNeighbours: neighbours,
      call: call as any,
      recordPrediction,
      recordDecision,
    });
    expect('row' in r).toBe(true);
    const row = (recordPrediction.mock.calls[0] as any)[0];
    expect(row.candidates).toEqual(['a.ts', 'b.ts']);
    expect(row.candidates).not.toContain('future.ts');
    expect(row.selected).toEqual(['a.ts', 'b.ts']);
    expect(row.stopReason).toBe('exhausted');
    expect(row.complete).toBe(true);
    // CBM unavailable server-side ⇒ omissions unknown ⇒ never a complete manifest.
    expect(row.unknownScope).toBe(true);
    expect(row.allApplied).toBe(false);
    expect(row.coverage.source).toBe('neighbour_diff_only');
    expect(row.coverage.cbm).toBe('unavailable');
    expect(row.coverage.excludedFuture).toBe(1);
    expect(row.picks).toHaveLength(2);
    expect(row.picks[1].offered).toEqual([1]);
    expect(row.mode).toBe('shadow');
    expect(row.decisionId).toBe(MANIFEST_DECISION_ID);
    expect(row.taskCreatedAt).toEqual(CREATED);
    expect(row.regexPaths).toEqual(['apps/web/src/app/api/workers/claim/route.ts']);
    expect(row.neighbourUnionPaths).toEqual(['a.ts', 'b.ts']);
    // One content-free ledger row per pick, each with its own fingerprint and step.
    expect(recordDecision).toHaveBeenCalledTimes(2);
    const d0 = (recordDecision.mock.calls[0] as any)[0];
    const d1 = (recordDecision.mock.calls[1] as any)[0];
    expect([d0.step, d1.step]).toEqual([0, 1]);
    expect(d0.fingerprint).not.toBe(d1.fingerprint);
    expect(d0.status).toBe('suggested');
    expect(d0.applied).toBe(false);
    expect(d0.capability).toBe('orchestration_manifest');
    expect(d0.candidateCount).toBe(2);
    expect(d0.ruleVerdict).toBe(DONE_LABEL);
    // Content-free: labels only.
    expect(d0.suggested).toBe('c0');
    // The access read happens once, not per pick.
  });

  it('a requested applying fraction without readout evidence is granted as zero (promotion guard)', async () => {
    const rows: any[] = [];
    await src.predictCreationManifest(input(), {
      resolveAccess: async () => okAccess, loadNeighbours: neighbours, call: pickFirst(2) as any,
      recordPrediction: async () => {}, recordDecision: async (row) => { rows.push(row); },
      applyingFraction: 1,
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).toMatchObject({ applyingFraction: 0, experimentArm: 'observe', applied: false });
  });

  it('access is resolved once for all picks', async () => {
    const resolveAccess = mock(async () => okAccess);
    await src.predictCreationManifest(input(), {
      resolveAccess, loadNeighbours: neighbours, call: pickFirst(2) as any,
      recordPrediction: async () => {}, recordDecision: async () => {},
    });
    expect(resolveAccess).toHaveBeenCalledTimes(1);
  });

  it('the pick cap truncates and leaves unknown scope', async () => {
    const recordPrediction = mock(async (_row: any) => {});
    await src.predictCreationManifest(input({ pickCap: 1 }), {
      resolveAccess: async () => okAccess, loadNeighbours: neighbours, call: pickFirst(5) as any,
      recordPrediction, recordDecision: async () => {},
    });
    const row = (recordPrediction.mock.calls[0] as any)[0];
    expect(row.selected).toEqual(['a.ts']);
    expect(row.stopReason).toBe('pick_cap');
    expect(row.complete).toBe(false);
    expect(row.pickCap).toBe(1);
  });

  it('no candidates: no decision call, the prediction says so', async () => {
    const call = pickFirst(5);
    const recordPrediction = mock(async (_row: any) => {});
    await src.predictCreationManifest(input(), {
      resolveAccess: async () => okAccess, loadNeighbours: async () => [], call: call as any,
      recordPrediction, recordDecision: async () => {},
    });
    expect(call).not.toHaveBeenCalled();
    const row = (recordPrediction.mock.calls[0] as any)[0];
    expect(row.stopReason).toBe('no_candidates');
    expect(row.candidates).toEqual([]);
    expect(row.unknownScope).toBe(true);
  });

  it('an opted-in team with no key records the miss without retrieval or calls', async () => {
    const loadNeighbours = mock(neighbours);
    const recordPrediction = mock(async (_row: any) => {});
    await src.predictCreationManifest(input(), {
      resolveAccess: async () => ({ ok: false, error: { kind: 'missing_key' } }) as any,
      loadNeighbours, recordPrediction, recordDecision: async () => {},
    });
    expect(loadNeighbours).not.toHaveBeenCalled();
    expect((recordPrediction.mock.calls[0] as any)[0].stopReason).toBe('missing_key');
  });

  it('retrieval that overruns the shared deadline is abandoned; no calls, unknown scope', async () => {
    let t = 0;
    const call = pickFirst(5);
    const recordPrediction = mock(async (_row: any) => {});
    await src.predictCreationManifest(input(), {
      now: () => t,
      deadlineMs: 50,
      resolveAccess: async () => okAccess,
      loadNeighbours: () => new Promise(resolve => setTimeout(() => { t = 1_000; resolve([]); }, 200)),
      call: call as any,
      recordPrediction, recordDecision: async () => {},
    });
    expect(call).not.toHaveBeenCalled();
    const row = (recordPrediction.mock.calls[0] as any)[0];
    expect(row.stopReason).toBe('retrieval_deadline');
    expect(row.unknownScope).toBe(true);
  });

  it('never throws: a throwing neighbour load, decision and ledger all fail safe', async () => {
    const r = await src.predictCreationManifest(input(), {
      resolveAccess: async () => okAccess,
      loadNeighbours: async () => { throw new Error('vector store down'); },
      call: (async () => { throw new Error('provider down'); }) as any,
      recordPrediction: async () => { throw new Error('db down'); },
      recordDecision: async () => { throw new Error('db down'); },
    });
    expect(r).toBeDefined();
  });

  it('a decision error falls back to the deterministic rule (declare nothing)', async () => {
    const recordPrediction = mock(async (_row: any) => {});
    await src.predictCreationManifest(input(), {
      resolveAccess: async () => okAccess,
      loadNeighbours: neighbours,
      call: (async () => ({ ok: false, error: { kind: 'http', status: 500 }, latencyMs: 1, attempts: 1 })) as any,
      recordPrediction, recordDecision: async () => {},
    });
    const row = (recordPrediction.mock.calls[0] as any)[0];
    expect(row.selected).toEqual([]);
    expect(row.stopReason).toBe('fallback');
  });
});

describe('recordManifestPrediction', () => {
  it('inserts once per task and candidate policy, and never throws', async () => {
    const row = { taskId: TASK, workspaceId: WS, teamId: TEAM } as any;
    await src.recordManifestPrediction(row);
    expect(fake.inserted[0].table).toBe('orchestration_manifest_predictions');
    expect(fake.inserted[0].target).toHaveLength(2);
    fake.throwOnInsert = true;
    await src.recordManifestPrediction(row);
  });
});

describe('readout predicates', () => {
  it('predictions are workspace-scoped within the window', () => {
    const w = render(src.manifestPredictionsWhere({ workspaceId: WS, since: BEFORE, until: AFTER }));
    expect(w.sql).toContain('"orchestration_manifest_predictions"."workspace_id" = $1');
    expect(w.sql).toContain('"orchestration_manifest_predictions"."created_at" >= $2');
    expect(w.sql).toContain('"orchestration_manifest_predictions"."created_at" < $3');
  });
});


describe('manifest outcome PR union', () => {
  const setup = () => {
    fake.tableRows.orchestration_manifest_predictions = [{ id: 'prediction', taskId: TASK, candidates: ['session.ts', 'pr.ts'], selected: ['pr.ts'], picks: [], stopReason: 'done', complete: true, unknownScope: false, allApplied: false, regexPaths: [], neighbourUnionPaths: [] }];
    fake.tableRows.orchestration_touch_labels = [{ taskId: TASK, workerStatus: 'completed', touchedPaths: ['session.ts'] }];
    fake.tableRows.workers = [{ taskId: TASK, prNumber: 1, mergedAt: AFTER }];
  };
  it('unions the pinned PR files into terminal session observations', async () => {
    setup();
    const rows = await src.loadManifestPredictionLabels({ workspaceId: WS, since: BEFORE, until: AFTER }, {
      loadPrDiffs: async () => new Map([[TASK, [{ prNumber: 1, status: 'complete', files: ['pr.ts'], headSha: 'head', baseSha: 'base' }]]]),
    });
    expect(rows[0].label).toMatchObject({ status: 'observed', actual: ['pr.ts', 'session.ts'], landed: true, unknownScope: false });
    expect(rows[0].prDiffs[0]).toMatchObject({ status: 'complete', headSha: 'head', baseSha: 'base' });
  });
  it('grades a complete PR even when no terminal label exists', async () => {
    setup(); fake.tableRows.orchestration_touch_labels = [];
    const rows = await src.loadManifestPredictionLabels({ workspaceId: WS, since: BEFORE, until: AFTER }, {
      loadPrDiffs: async () => new Map([[TASK, [{ prNumber: 1, status: 'complete', files: ['pr.ts'], headSha: 'head', baseSha: 'base' }]]]),
    });
    expect(rows[0].label).toMatchObject({ status: 'observed', actual: ['pr.ts'] });
  });
  it('keeps failed session work out of the PR truth', async () => {
    setup(); fake.tableRows.orchestration_touch_labels[0].workerStatus = 'failed';
    const rows = await src.loadManifestPredictionLabels({ workspaceId: WS, since: BEFORE, until: AFTER }, {
      loadPrDiffs: async () => new Map([[TASK, [{ prNumber: 1, status: 'complete', files: ['pr.ts'], headSha: 'head', baseSha: 'base' }]]]),
    });
    expect(rows[0].label).toMatchObject({ status: 'observed', actual: ['pr.ts'], failedWork: ['session.ts'], failed: true });
  });
  it('does not grade truncated successful touch observations', async () => {
    setup(); fake.tableRows.orchestration_touch_labels[0].truncated = true;
    const rows = await src.loadManifestPredictionLabels({ workspaceId: WS, since: BEFORE, until: AFTER }, { loadPrDiffs: async () => new Map() });
    expect(rows[0].label).toMatchObject({ status: 'missing', reason: 'incomplete_observation', reasons: ['touch_labels_truncated'] });
  });
  it('loads the label PR when the worker no longer carries it', async () => {
    setup(); fake.tableRows.workers = []; fake.tableRows.orchestration_touch_labels[0].prNumber = 1;
    const loadPrDiffs = mock(async () => new Map());
    await src.loadManifestPredictionLabels({ workspaceId: WS, since: BEFORE, until: AFTER }, { loadPrDiffs });
    expect(loadPrDiffs).toHaveBeenCalledWith(WS, [{ taskId: TASK, prNumber: 1 }]);
  });
  it('records truncated PR data and withholds complete-scope grading', async () => {
    setup();
    const rows = await src.loadManifestPredictionLabels({ workspaceId: WS, since: BEFORE, until: AFTER }, {
      loadPrDiffs: async () => new Map([[TASK, [{ prNumber: 1, status: 'incomplete', reason: 'truncated', detail: 'partial file list', headSha: 'head', baseSha: 'base' }]]]),
    });
    expect(rows[0].label).toMatchObject({ status: 'missing', reason: 'incomplete_observation', observedPaths: ['session.ts'], reasons: ['pr_diff_truncated'] });
    expect(rows[0].prDiffs[0]).toMatchObject({ status: 'incomplete', reason: 'truncated' });
  });
});
