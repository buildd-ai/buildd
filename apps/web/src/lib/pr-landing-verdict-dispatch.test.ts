/**
 * A Buildd-owned gate verdict starts the work it names (task c06dedf5).
 * Before this, list_prs said "Buildd is renumbering a migration" for PRs that
 * nothing ever renumbered: the verdict was words.
 */
import { describe, expect, it } from 'bun:test';
import {
  DISPATCH_GRACE_MS,
  dispatchVerdictAction,
  labelWithDispatch,
  sweepUndispatchedEscalations,
  type DispatchDeps,
  type DispatchTarget,
  type SweepDeps,
} from './pr-landing-verdict-dispatch';

const NOW = Date.parse('2026-10-09T21:00:00Z');

const target = (over: Partial<DispatchTarget> = {}): DispatchTarget => ({
  recordId: 'rec-1', teamId: 'team', workspaceId: 'ws', prNumber: 4171, taskId: 'task-1', action: 'renumber_migration', ...over,
});

function deps(over: Partial<DispatchDeps> = {}) {
  const calls: string[] = [];
  const settled: Array<{ recordId: string; result: unknown }> = [];
  const claimed = new Set<string>();
  const d: DispatchDeps = {
    claim: async (recordId) => { if (claimed.has(recordId)) return false; claimed.add(recordId); return true; },
    settle: async (recordId, result) => { settled.push({ recordId, result }); },
    resolve: async () => ({ ok: true, target: { workspaceId: 'ws', prNumber: 4171, installationId: 9, repoFullName: 'o/r', owner: { taskId: 'task-1', workerId: 'w-1' } } as any }),
    peek: async () => ({ state: 'open', draft: false, headSha: 'h1' }),
    retryCi: async () => { calls.push('ci'); return { kind: 'dispatched', taskId: 'ci-task' } as any; },
    conflictRetry: async () => { calls.push('conflict'); return { dispatched: true, taskId: 'conflict-task' }; },
    renumber: async () => { calls.push('renumber'); return { handled: true, taskId: 'renumber-task' }; },
    collisionReason: async () => 'migration number collision: 0280_a.sql conflicts with open PR #4076 migration 0280_b.sql',
    prState: async () => 'open',
    markLandingDue: async () => { calls.push('landing'); },
    policyMerge: async () => { calls.push('policy'); return true; },
    ...over,
  };
  return { d, calls, settled };
}

describe('dispatchVerdictAction', () => {
  it('a renumber verdict files the renumber, once per state', async () => {
    const h = deps();
    expect(await dispatchVerdictAction(target(), h.d)).toEqual({ kind: 'dispatched', taskId: 'renumber-task' });
    expect(await dispatchVerdictAction(target(), h.d)).toBeNull();
    expect(h.calls).toEqual(['renumber']);
    expect(h.settled).toEqual([{ recordId: 'rec-1', result: { kind: 'dispatched', taskId: 'renumber-task' } }]);
  });

  it('a renumber verdict whose other PR has merged refreshes the branch from its base instead', async () => {
    const h = deps({ prState: async () => 'merged' });
    expect(await dispatchVerdictAction(target(), h.d)).toEqual({ kind: 'dispatched', taskId: 'conflict-task' });
    expect(h.calls).toEqual(['conflict']);
  });

  it('a slot taken on the base renumbers against the base, with no other PR to look up', async () => {
    const seen: any[] = [];
    const h = deps({
      collisionReason: async () => 'migration number collision: 0280_a.sql conflicts with open PR #null migration 0280_b.sql',
      prState: async () => { throw new Error('no other PR to read'); },
      renumber: async (p) => { seen.push(p.collision); return { handled: true, taskId: 'rn' }; },
    });
    expect(await dispatchVerdictAction(target(), h.d)).toEqual({ kind: 'dispatched', taskId: 'rn' });
    expect(seen).toEqual([{ file: '0280_a.sql', otherPrNumber: null, otherFile: '0280_b.sql', against: 'base' }]);
  });

  it('a collision it cannot read is skipped with that cause, not silently kept', async () => {
    const h = deps({ collisionReason: async () => null });
    expect(await dispatchVerdictAction(target({ detail: null }), h.d)).toEqual({ kind: 'skipped', cause: 'collision_unreadable' });
  });

  it('a red-CI verdict hands the PR to the shared CI retry', async () => {
    const h = deps();
    expect(await dispatchVerdictAction(target({ action: 'ci_fix' }), h.d)).toEqual({ kind: 'dispatched', taskId: 'ci-task' });
    expect(h.calls).toEqual(['ci']);
  });

  it('a CI retry already in flight counts as dispatched to that task', async () => {
    const h = deps({ retryCi: async () => ({ kind: 'skipped', reason: 'in_flight', inFlightTaskId: 'live' }) as any });
    expect(await dispatchVerdictAction(target({ action: 'ci_fix' }), h.d)).toEqual({ kind: 'dispatched', taskId: 'live' });
  });

  it('a CI retry that refuses is skipped with its reason', async () => {
    const h = deps({ retryCi: async () => ({ kind: 'skipped', reason: 'budget_spent' }) as any });
    expect(await dispatchVerdictAction(target({ action: 'ci_fix' }), h.d)).toEqual({ kind: 'skipped', cause: 'budget_spent' });
  });

  it('a conflict verdict files the conflict retry; an exhausted cap is skipped', async () => {
    expect(await dispatchVerdictAction(target({ action: 'conflict_fix' }), deps().d)).toEqual({ kind: 'dispatched', taskId: 'conflict-task' });
    const h = deps({ conflictRetry: async () => ({ dispatched: false, exhausted: true }) });
    expect(await dispatchVerdictAction(target({ action: 'conflict_fix' }), h.d)).toEqual({ kind: 'skipped', cause: 'conflict_fixes_spent' });
  });

  it('a stranded landing is queued for the landing sweep', async () => {
    const h = deps();
    expect(await dispatchVerdictAction(target({ action: 'retry_landing' }), h.d)).toEqual({ kind: 'queued', where: 'landing' });
    expect(h.calls).toEqual(['landing']);
  });

  it('a policy merge the merge policy keeps for a person is skipped with that cause', async () => {
    expect(await dispatchVerdictAction(target({ action: 'policy_merge' }), deps().d)).toEqual({ kind: 'queued', where: 'landing' });
    const h = deps({ policyMerge: async () => false });
    expect(await dispatchVerdictAction(target({ action: 'policy_merge' }), h.d)).toEqual({ kind: 'skipped', cause: 'merge_policy_keeps_merge' });
  });

  it('waits and holds dispatch nothing and claim nothing', async () => {
    const h = deps();
    for (const action of ['wait_ci', 'wait_machine', 'hold'] as const) {
      expect(await dispatchVerdictAction(target({ action }), h.d)).toBeNull();
    }
    expect(h.calls).toEqual([]);
    expect(h.settled).toEqual([]);
  });

  it('a closed PR is skipped, and a dispatcher that throws is recorded as skipped', async () => {
    expect(await dispatchVerdictAction(target(), deps({ peek: async () => ({ state: 'merged', draft: false, headSha: 'h' }) }).d))
      .toEqual({ kind: 'skipped', cause: 'pr_merged' });
    const h = deps({ renumber: async () => { throw new Error('github down'); } });
    expect(await dispatchVerdictAction(target(), h.d)).toEqual({ kind: 'skipped', cause: 'dispatch_error' });
    expect(h.settled).toHaveLength(1);
  });
});

describe('labelWithDispatch: the label says what is running, or the person gets it', () => {
  const rule = { owner: 'buildd', by: 'rule', action: 'renumber_migration', reason: 'Buildd is renumbering a migration that collides with another PR' } as const;

  it('names the running task', () => {
    expect(labelWithDispatch(rule, { label: 'dispatched', metadata: { taskId: '0123456789abcdef' } }, 0))
      .toMatchObject({ owner: 'buildd', reason: 'Buildd is renumbering a migration that collides with another PR (task 01234567)' });
  });

  it('says queued while nothing has started yet, inside the grace period', () => {
    expect(labelWithDispatch(rule, null, 60_000).reason).toContain('(queued)');
    expect(labelWithDispatch({ ...rule, action: 'retry_landing', reason: 'Buildd retries the merge once the base settles' }, { label: 'queued', metadata: { where: 'landing' } }, 0).reason)
      .toContain('queued for the merge sweep');
  });

  it('a skipped dispatch is the person\'s, with the cause', () => {
    const v = labelWithDispatch(rule, { label: 'skipped', metadata: { cause: 'conflict_fixes_spent' } }, 0);
    expect(v).toMatchObject({ owner: 'person', by: 'rule' });
    expect(v.reason).toContain('conflict_fixes_spent');
  });

  it('nothing started past the grace period is the person\'s', () => {
    expect(labelWithDispatch(rule, null, DISPATCH_GRACE_MS + 1)).toMatchObject({ owner: 'person' });
  });

  it('a wait is left as it is', () => {
    const wait = { owner: 'buildd', by: 'rule', action: 'wait_ci', reason: 'waiting for CI to finish' } as const;
    expect(labelWithDispatch(wait, null, DISPATCH_GRACE_MS * 3)).toEqual(wait);
  });
});

describe('sweepUndispatchedEscalations', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'r1', teamId: 'team', workspaceId: 'ws', taskId: 't1', subjectId: 'pr:ws:4171',
    appliedAnswer: 'buildd:rule:renumber_migration:', createdAt: new Date(NOW - 30 * 60_000), ...over,
  });

  function sweepDeps(rows: ReturnType<typeof row>[], withOutcome: string[] = []): { d: SweepDeps; dispatched: DispatchTarget[] } {
    const dispatched: DispatchTarget[] = [];
    return {
      dispatched,
      d: {
        listRecent: async () => rows,
        dispatchedIds: async (ids) => new Set(ids.filter(id => withOutcome.includes(id))),
        dispatch: async (t) => { dispatched.push(t); return { kind: 'dispatched', taskId: 'x' }; },
        now: () => NOW,
      },
    };
  }

  it('dispatches the newest undispatched rule verdict per PR, once', async () => {
    const h = sweepDeps([row(), row({ id: 'r0', createdAt: new Date(NOW - 60 * 60_000) })]);
    const res = await sweepUndispatchedEscalations(h.d);
    expect(h.dispatched.map(t => [t.recordId, t.prNumber, t.action])).toEqual([['r1', 4171, 'renumber_migration']]);
    expect(res).toMatchObject({ candidates: 1, dispatched: 1 });
  });

  it('skips a verdict already dispatched, a wait, a Jev verdict, a person verdict and a fresh one', async () => {
    const h = sweepDeps([
      row({ id: 'a', subjectId: 'pr:ws:1' }),
      row({ id: 'b', subjectId: 'pr:ws:2', appliedAnswer: 'buildd:rule:wait_ci:' }),
      row({ id: 'c', subjectId: 'pr:ws:3', appliedAnswer: 'buildd:jev:ci_fix:' }),
      row({ id: 'd', subjectId: 'pr:ws:4', appliedAnswer: 'person:rule:protected_path' }),
      row({ id: 'e', subjectId: 'pr:ws:5', createdAt: new Date(NOW - 60_000) }),
    ], ['a']);
    await sweepUndispatchedEscalations(h.d);
    expect(h.dispatched).toEqual([]);
  });
});

describe('the once-per-state claim and the reads, as SQL', () => {
  it('the claim is one decision_outcomes row per (record, source), backed by the unique index', async () => {
    const { getTableConfig } = await import('drizzle-orm/pg-core');
    const { decisionOutcomes } = await import('@buildd/core/db/schema');
    const { dispatchClaimRow, DISPATCH_SOURCE } = await import('./pr-landing-verdict-dispatch');
    const idx = getTableConfig(decisionOutcomes).indexes.find(i => i.config.name === 'decision_outcomes_decision_source_idx');
    expect(idx?.config.unique).toBe(true);
    expect(idx?.config.columns.map((c: any) => c.name)).toEqual(['decision_record_id', 'source']);
    expect(dispatchClaimRow('rec', 'team', new Date(NOW))).toMatchObject({ decisionRecordId: 'rec', teamId: 'team', source: DISPATCH_SOURCE, label: 'claimed' });
  });

  it('the settle touches only this record\'s dispatch row; the sweep reads only escalation-gate PR records in its window', async () => {
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { dispatchRowWhere, recentEscalationRecordsWhere } = await import('./pr-landing-verdict-dispatch');
    const dialect = new PgDialect();
    const settle = dialect.sqlToQuery(dispatchRowWhere('rec-9')!);
    expect(settle.sql).toContain('"decision_outcomes"."decision_record_id" = $1');
    expect(settle.sql).toContain('"decision_outcomes"."source" = $2');
    expect(settle.params).toEqual(['rec-9', 'escalation_dispatch']);
    const recent = dialect.sqlToQuery(recentEscalationRecordsWhere(new Date(NOW))!);
    expect(recent.sql).toContain('"decision_records"."capability" = $1');
    expect(recent.sql).toContain('"decision_records"."subject_type" = $2');
    expect(recent.sql).toContain('"decision_records"."created_at" > $3');
    expect(recent.params.slice(0, 2)).toEqual(['escalation_gate', 'pr']);
  });
});
