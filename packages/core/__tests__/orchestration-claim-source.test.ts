import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Stores for hold/start at claim. Every predicate is rendered with the real
 * PgDialect (a mocked `db` alone makes WHERE scoping unobservable); only the
 * client and F's outcome loader are stubbed.
 */

const fake = {
  selects: [] as { table: string; where: any }[],
  rowsByTable: {} as Record<string, any[]>,
  throwOnSelect: false,
  executes: [] as any[],
  executeRows: [] as any[],
};
const nameOf = (table: any) => table?.[Symbol.for('drizzle:Name')];

function selectChain() {
  let table = '';
  const chain: any = {
    from: (t: any) => { table = nameOf(t); return chain; },
    where: (where: any) => {
      fake.selects.push({ table, where });
      const res: any = (async () => {
        if (fake.throwOnSelect) throw new Error('db down');
        return fake.rowsByTable[table] ?? [];
      })();
      res.catch(() => {});
      res.limit = () => res;
      res.orderBy = () => res;
      return res;
    },
  };
  return chain;
}

mock.module('../db/client', () => ({
  db: {
    select: () => selectChain(),
    execute: async (q: any) => {
      fake.executes.push(q);
      if (fake.throwOnSelect) throw new Error('db down');
      return { rows: fake.executeRows };
    },
  },
}));

const loadOutcomeCalls: any[] = [];
mock.module('../orchestration-ledger-source', () => ({
  loadOrchestrationOutcomeInput: async (opts: any) => {
    loadOutcomeCalls.push(opts);
    return { decisions: [], tasks: [{ id: TASK, workspaceId: WS, status: 'completed' }], labels: [], prs: [], conflictTasks: [], gateEvents: [] };
  },
}));

const joinForCalls: any[] = [];
mock.module('../orchestration-ledger-source', () => ({
  loadOrchestrationOutcomeInput: async (opts: any) => {
    loadOutcomeCalls.push(opts);
    return { decisions: [], tasks: [{ id: TASK, workspaceId: WS, status: 'completed' }], labels: [], prs: [], conflictTasks: [], gateEvents: [] };
  },
  loadOutcomeJoinFor: async (decisions: any[], opts: any) => {
    joinForCalls.push({ decisions, opts });
    return { decisions, tasks: [{ id: TASK, workspaceId: WS, status: 'completed' }], labels: [], prs: [], conflictTasks: [], gateEvents: [] };
  },
}));

const src = await import('../orchestration-claim-source');

const dialect = new PgDialect();
const render = (fragment: any) => {
  const q = dialect.sqlToQuery(fragment);
  return { sql: q.sql.replace(/\s+/g, ' ').trim().toLowerCase(), params: q.params };
};

const WS = '00000000-0000-4000-8000-0000000000aa';
const TASK = '00000000-0000-4000-8000-000000000001';
const HOLDER = '00000000-0000-4000-8000-000000000002';
const SINCE = new Date('2026-09-30T11:50:00Z');
const KEY = { workspaceId: WS, taskId: TASK, decisionId: 'buildd.orchestration_claim_hold', fingerprint: 'abcdefabcdef', candidateDigest: '0123456789abcdef', since: SINCE };

beforeEach(() => {
  fake.selects = [];
  fake.rowsByTable = {};
  fake.throwOnSelect = false;
  fake.executes = [];
  fake.executeRows = [];
  loadOutcomeCalls.length = 0;
});

describe('predicates are workspace- and task-scoped', () => {
  it('recentClaimDecisionWhere pins workspace, task, decision, fingerprint, digest and window', () => {
    const r = render(src.recentClaimDecisionWhere(KEY));
    expect(r.sql).toContain('"orchestration_decisions"."workspace_id" = $1');
    expect(r.sql).toContain('"orchestration_decisions"."task_id" = $2');
    expect(r.sql).toContain('"orchestration_decisions"."decision_id" = $3');
    expect(r.sql).toContain('"orchestration_decisions"."fingerprint" = $4');
    expect(r.sql).toContain('"orchestration_decisions"."candidate_digest" = $5');
    expect(r.sql).toContain('"orchestration_decisions"."created_at" >= $6');
    expect(r.params.slice(0, 5)).toEqual([WS, TASK, KEY.decisionId, KEY.fingerprint, KEY.candidateDigest]);
  });

  it('appliedStartWhere additionally requires applied, effective START and the apply arm', () => {
    const r = render(src.appliedStartWhere(KEY));
    expect(r.sql).toContain('"orchestration_decisions"."workspace_id" = $1');
    expect(r.sql).toContain('"orchestration_decisions"."applied" = $');
    expect(r.sql).toContain('"orchestration_decisions"."effective" = $');
    expect(r.sql).toContain('"orchestration_decisions"."experiment_arm" = $');
    expect(r.params).toContain('START');
    expect(r.params).toContain('apply');
    expect(r.params).toContain(true);
  });

  it('holderWorkersWhere and holderTaskWhere pin the workspace', () => {
    const w = render(src.holderWorkersWhere({ workspaceId: WS, taskId: HOLDER }));
    expect(w.sql).toContain('"workers"."workspace_id" = $1');
    expect(w.sql).toContain('"workers"."task_id" = $2');
    expect(w.params).toEqual([WS, HOLDER]);
    const t = render(src.holderTaskWhere({ workspaceId: WS, taskId: HOLDER }));
    expect(t.sql).toContain('"tasks"."workspace_id" = $1');
    expect(t.sql).toContain('"tasks"."id" = $2');
  });

  it('claimStartsWhere pins workspace, tasks and window start', () => {
    const r = render(src.claimStartsWhere({ workspaceId: WS, taskIds: [TASK], since: SINCE }));
    expect(r.sql).toContain('"workers"."workspace_id" = $1');
    expect(r.sql).toContain('"workers"."task_id" in ($2)');
    expect(r.sql).toContain('"workers"."created_at" >= $3');
  });

  it('claimDecisionsWhere pins workspace, capability, decision id and window', () => {
    const r = render(src.claimDecisionsWhere({ workspaceId: WS, since: SINCE, until: new Date('2026-10-01T00:00:00Z') }));
    expect(r.sql).toContain('"orchestration_decisions"."workspace_id" = $1');
    expect(r.sql).toContain('"orchestration_decisions"."capability" = $2');
    expect(r.sql).toContain('"orchestration_decisions"."decision_id" = $3');
    expect(r.params.slice(0, 3)).toEqual([WS, 'orchestration_claim', 'buildd.orchestration_claim_hold']);
  });
});

describe('reads never throw into the claim path', () => {
  it('findAppliedStart: true only when a matching row exists; false on a DB error', async () => {
    expect(await src.findAppliedStart(KEY)).toBe(false);
    fake.rowsByTable.orchestration_decisions = [{ id: 'd1' }];
    expect(await src.findAppliedStart(KEY)).toBe(true);
    fake.throwOnSelect = true;
    expect(await src.findAppliedStart(KEY)).toBe(false);
  });

  it('hasRecentClaimDecision: a DB error says "recent" so nothing is re-asked on a broken read', async () => {
    expect(await src.hasRecentClaimDecision(KEY)).toBe(false);
    fake.rowsByTable.orchestration_decisions = [{ id: 'd1' }];
    expect(await src.hasRecentClaimDecision(KEY)).toBe(true);
    fake.rowsByTable = {};
    fake.throwOnSelect = true;
    expect(await src.hasRecentClaimDecision(KEY)).toBe(true);
  });

  it('loadClaimHolderState THROWS on a DB error, so the adapter records a retrieval_error fallback', async () => {
    fake.throwOnSelect = true;
    await expect(src.loadClaimHolderState({ workspaceId: WS, taskId: HOLDER, prNumber: null })).rejects.toThrow('db down');
  });

  it('loadClaimHolderState reads the newest worker and the holder title', async () => {
    fake.rowsByTable.workers = [{ status: 'completed', updatedAt: new Date('2026-09-30T11:00:00Z'), prLifecycleStatus: 'conflict', prNumber: 7 }];
    fake.rowsByTable.tasks = [{ title: 'Holder' }];
    const s = await src.loadClaimHolderState({ workspaceId: WS, taskId: HOLDER, prNumber: 7 });
    expect(s).toEqual({ title: 'Holder', workerStatus: 'completed', lastActivityAt: '2026-09-30T11:00:00.000Z', prLifecycle: 'conflict', baseStale: true, stage: 'in_review' });
  });

  it('loadClaimHolderState reads an approving review on the holder PR as the approved stage', async () => {
    fake.rowsByTable.workers = [{ status: 'completed', updatedAt: new Date('2026-09-30T11:00:00Z'), prLifecycleStatus: 'ci_green', prNumber: 7 }];
    fake.rowsByTable.tasks = [{ title: 'Holder' }];
    fake.rowsByTable.review_feedback = [{ state: 'approved' }];
    const s = await src.loadClaimHolderState({ workspaceId: WS, taskId: HOLDER, prNumber: null });
    expect(s?.stage).toBe('approved');
    const review = fake.selects.find(x => x.table === 'review_feedback');
    const r = render(review!.where);
    expect(r.sql).toContain('"review_feedback"."workspace_id" = $1');
    expect(r.params).toContain(7);
  });

  it('loadClaimHolderState: a holder that never started is queued, with no review read', async () => {
    fake.rowsByTable.tasks = [{ title: 'Holder' }];
    const s = await src.loadClaimHolderState({ workspaceId: WS, taskId: HOLDER, prNumber: null });
    expect(s?.stage).toBe('queued');
    expect(fake.selects.some(x => x.table === 'review_feedback')).toBe(false);
  });

  it('loadClaimHolderState with no holder task returns null without reading', async () => {
    expect(await src.loadClaimHolderState({ workspaceId: WS, taskId: null, prNumber: null })).toBeNull();
    expect(fake.selects).toHaveLength(0);
  });
});

describe('soft-overlap start readout', () => {
  const until = new Date('2026-10-01T00:00:00Z');

  it('softStartEventsWhere pins workspace, the claim-loop gate, accepted soft_overlap_start and the window', () => {
    const r = render(src.softStartEventsWhere({ workspaceId: WS, since: SINCE, until }));
    expect(r.sql).toContain('"gate_events"."workspace_id" = $1');
    expect(r.sql).toContain('"gate_events"."gate" = $2');
    expect(r.sql).toContain('"gate_events"."outcome" = $3');
    expect(r.sql).toContain('"gate_events"."reason" = $4');
    expect(r.params.slice(0, 4)).toEqual([WS, 'claim_loop_deferral', 'accepted', 'soft_overlap_start']);
  });

  it('siblingProbeEventsWhere pins workspace and the probe gate', () => {
    const r = render(src.siblingProbeEventsWhere({ workspaceId: WS, since: SINCE, until }));
    expect(r.params.slice(0, 2)).toEqual([WS, 'sibling_conflict_probe']);
  });

  it('shapes start rows for the same labeller as the Jev decisions, rule by default', async () => {
    fake.rowsByTable.gate_events = [
      { id: 'g1', taskId: TASK, workspaceId: WS, occurredAt: SINCE, detail: { holderTaskId: HOLDER, decidedBy: 'jev', riskTier: 'uncertain' } },
      { id: 'g2', taskId: TASK, workspaceId: WS, occurredAt: SINCE, detail: { holderTaskId: HOLDER } },
      { id: 'g3', taskId: null, workspaceId: WS, occurredAt: SINCE, detail: {} },
    ];
    joinForCalls.length = 0;
    const input = await src.loadSoftStartReadoutInput({ workspaceId: WS, since: SINCE, until });
    expect(input.starts.map(s => [s.id, s.decidedBy, s.riskTier, s.holderTaskId])).toEqual([['g1', 'jev', 'uncertain', HOLDER], ['g2', 'rule', null, HOLDER]]);
    expect(joinForCalls[0].decisions[0]).toMatchObject({ id: 'g1', taskId: TASK, prNumber: null, headSha: null, createdAt: SINCE });
    expect(input.outcome.tasks).toEqual([{ id: TASK, workspaceId: WS, status: 'completed' }]);
    expect((input.outcome as any).decisions).toBeUndefined();
  });

  it('with no starts it reads nothing else', async () => {
    joinForCalls.length = 0;
    const input = await src.loadSoftStartReadoutInput({ workspaceId: WS, since: SINCE, until });
    expect(input.starts).toEqual([]);
    expect(joinForCalls).toHaveLength(0);
    expect(fake.selects).toHaveLength(1);
  });
});

describe('loadClaimHoldReadoutInput', () => {
  it('joins claim decisions, F labels and worker starts, all workspace-scoped', async () => {
    fake.rowsByTable.orchestration_decisions = [{
      id: 'd1', taskId: TASK, workspaceId: WS, decisionId: 'buildd.orchestration_claim_hold', fingerprint: 'f', candidatePolicyVersion: 'ch1.open_pr_overlap',
      model: 'typesafe/jev-1', experimentArm: 'observe', propensity: 1, applied: false, effective: 'HOLD', suggested: 'START', status: 'suggested', reason: 'shadow',
      createdAt: new Date('2026-09-30T12:00:00Z'),
    }];
    fake.rowsByTable.workers = [{ taskId: TASK, createdAt: new Date('2026-09-30T12:30:00Z') }];
    const until = new Date('2026-10-01T00:00:00Z');
    const input = await src.loadClaimHoldReadoutInput({ workspaceId: WS, since: SINCE, until });
    expect(input.decisions).toHaveLength(1);
    expect(input.starts).toEqual([{ taskId: TASK, startedAt: new Date('2026-09-30T12:30:00Z') }]);
    expect(input.tasks).toEqual([{ id: TASK, status: 'completed' }]);
    expect(input.windowEnd).toBe(until);
    expect(loadOutcomeCalls[0]).toMatchObject({ workspaceId: WS, decisionId: 'buildd.orchestration_claim_hold' });
    expect(fake.selects.map(s => s.table)).toEqual(['orchestration_decisions', 'workers']);
  });

  it('with no decisions it reads nothing else', async () => {
    const input = await src.loadClaimHoldReadoutInput({ workspaceId: WS, since: SINCE, until: new Date() });
    expect(input.decisions).toEqual([]);
    expect(fake.selects).toHaveLength(1);
    expect(loadOutcomeCalls).toHaveLength(0);
  });
});

describe('loadSoftOverlapEvidence: same-file history and predicted size', () => {
  it('reads per-file merged-PR and conflict-retry counts, workspace-scoped, and the latest expected size', async () => {
    fake.executeRows = [{ path: 'a.ts', merged_prs: 4, conflicted: 1 }];
    fake.rowsByTable.orchestration_manifest_predictions = [{ expectedSize: { files: 3, minutes: 20, source: 'neighbours', k: 3, n: 3 } }];
    const ev = await src.loadSoftOverlapEvidence({ workspaceId: WS, taskId: TASK, paths: ['a.ts', 'b.ts'] });
    expect(ev.conflictHistory?.files).toEqual([
      { path: 'a.ts', mergedPrs: 4, conflicted: 1, rate: 0.25, ci: { lower: 0.046, upper: 0.699 } },
      { path: 'b.ts', mergedPrs: 0, conflicted: 0, rate: null, ci: null },
    ]);
    // One file unsampled, the other too small a sample: not callable either way.
    expect(ev.conflictHistory?.summary).toBe('insufficient');
    expect(ev.predictedChange).toEqual({ files: 3, minutes: 20, source: 'neighbours' });
    const q = render(fake.executes[0]);
    expect(q.sql).toContain('orchestration_touch_labels');
    expect(q.sql).toContain('conflict_retry_pr_number');
    expect(q.sql).toContain('merged_at is not null');
    expect(q.params).toContain(WS);
  });

  it('no paths: no read, no history', async () => {
    const ev = await src.loadSoftOverlapEvidence({ workspaceId: WS, taskId: TASK, paths: [] });
    expect(ev.conflictHistory).toBeNull();
    expect(fake.executes).toHaveLength(0);
  });

  it('THROWS on a DB error, so the decision falls back to HOLD', async () => {
    fake.throwOnSelect = true;
    await expect(src.loadSoftOverlapEvidence({ workspaceId: WS, taskId: TASK, paths: ['a.ts'] })).rejects.toThrow('db down');
  });
});
