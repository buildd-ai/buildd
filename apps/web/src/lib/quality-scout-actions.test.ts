import { describe, expect, it } from 'bun:test';
import type { ScoutActionState, ScoutFinding, ScoutRun } from '@buildd/core/quality-scout/types';
import {
  actOnScoutFinding,
  buildScoutFollowUpDescription,
  decideScoutAction,
  DEFAULT_SCOUT_ACTION_POLICY,
  dismissQualityScoutFinding,
  resolveScoutActionPolicy,
  scoutFollowUpTitle,
  type ScoutActionStore,
  type ScoutFollowUpTaskInput,
} from './quality-scout-actions';

const SHA = 'a'.repeat(40);
const NOW = new Date('2026-10-05T12:00:00Z');
const DAY = 24 * 3_600_000;

const RUN: ScoutRun = {
  id: 'run-1',
  workspaceId: 'ws-1',
  missionId: null,
  trigger: 'manual',
  mode: 'propose',
  status: 'running',
  candidate: { ref: 'main', sha: SHA },
  prior: null,
  budget: { maxProbes: 4, maxCostUsd: null },
  policyVersion: 'scout-v1',
  startedAt: NOW.toISOString(),
  completedAt: null,
  error: null,
};

function finding(over: Partial<ScoutFinding> = {}): ScoutFinding {
  return {
    workspaceId: 'ws-1',
    signature: 'sig-1',
    recurrenceKey: 'quality-scout:cand-1',
    checkId: 'quality-scout:cand-1',
    family: 'contract',
    invariant: 'GET /health answers 200.',
    severity: 'high',
    confidence: 1,
    observed: 'GET /health -> 500',
    evidenceRefs: [{ kind: 'http-exchange', ref: 'ev-1' }],
    reproducibility: 'deterministic',
    state: 'open',
    actionState: 'none',
    actionTaskId: null,
    occurrenceCount: 1,
    regressionCount: 0,
    firstSeenRunId: 'run-1',
    firstSeenSha: SHA,
    lastSeenRunId: 'run-1',
    lastSeenSha: SHA,
    firstSeenAt: NOW.toISOString(),
    lastSeenAt: NOW.toISOString(),
    resolvedRunId: null,
    resolvedSha: null,
    resolvedAt: null,
    dismissedReason: null,
    dismissedAt: null,
    dismissedBy: null,
    ...over,
  };
}

const ctx = (mode: 'off' | 'shadow' | 'propose' = 'propose') => ({ mode, policy: DEFAULT_SCOUT_ACTION_POLICY, now: NOW });

describe('resolveScoutActionPolicy', () => {
  it('defaults when absent', () => {
    expect(resolveScoutActionPolicy(undefined)).toEqual(DEFAULT_SCOUT_ACTION_POLICY);
    expect(resolveScoutActionPolicy({ mode: 'propose' })).toEqual(DEFAULT_SCOUT_ACTION_POLICY);
  });

  it('takes valid overrides field by field and ignores out-of-range ones', () => {
    expect(resolveScoutActionPolicy({ policy: { minConfidence: 0.9, mediumRecurrence: { count: 3 } } })).toEqual({
      minConfidence: 0.9,
      mediumRecurrence: { count: 3, windowDays: DEFAULT_SCOUT_ACTION_POLICY.mediumRecurrence.windowDays },
    });
    expect(resolveScoutActionPolicy({ policy: { minConfidence: 0, mediumRecurrence: { count: 0, windowDays: 900 } } })).toEqual(
      DEFAULT_SCOUT_ACTION_POLICY,
    );
  });
});

describe('decideScoutAction — the §10 policy', () => {
  it('critical and high with verified evidence file one follow-up', () => {
    expect(decideScoutAction(finding({ severity: 'critical' }), ctx())).toMatchObject({ kind: 'file', followUp: 'fix' });
    expect(decideScoutAction(finding({ severity: 'high' }), ctx())).toMatchObject({ kind: 'file', followUp: 'fix' });
  });

  it('a non-deterministic severe failure files an investigation, not a fix', () => {
    expect(decideScoutAction(finding({ reproducibility: 'intermittent' }), ctx())).toMatchObject({ kind: 'file', followUp: 'investigate' });
    expect(decideScoutAction(finding({ reproducibility: 'unknown' }), ctx())).toMatchObject({ kind: 'file', followUp: 'investigate' });
  });

  it('severe without verified evidence only aggregates', () => {
    expect(decideScoutAction(finding({ evidenceRefs: [] }), ctx())).toMatchObject({ kind: 'aggregate', reason: 'insufficient_evidence' });
    expect(decideScoutAction(finding({ confidence: null }), ctx())).toMatchObject({ kind: 'aggregate', reason: 'insufficient_evidence' });
    expect(decideScoutAction(finding({ confidence: 0.5 }), ctx())).toMatchObject({ kind: 'aggregate', reason: 'insufficient_evidence' });
  });

  it('medium aggregates on first sight unless it reproduces deterministically', () => {
    expect(decideScoutAction(finding({ severity: 'medium', reproducibility: 'unknown' }), ctx())).toMatchObject({ kind: 'aggregate' });
    expect(decideScoutAction(finding({ severity: 'medium', reproducibility: 'deterministic' }), ctx())).toMatchObject({
      kind: 'file',
      reason: 'medium_deterministic',
    });
  });

  it('medium files once recurrent inside the window', () => {
    const recurrent = finding({ severity: 'medium', reproducibility: 'intermittent', occurrenceCount: 2 });
    expect(decideScoutAction(recurrent, ctx())).toMatchObject({ kind: 'file', reason: 'medium_recurrent' });
    const old = { ...recurrent, lastSeenAt: new Date(NOW.getTime() - 8 * DAY).toISOString() };
    expect(decideScoutAction(old, ctx())).toMatchObject({ kind: 'aggregate' });
  });

  it('a regression after a resolve counts as recurrence for medium', () => {
    expect(decideScoutAction(finding({ severity: 'medium', reproducibility: 'unknown', regressionCount: 1 }), ctx())).toMatchObject({
      kind: 'file',
    });
  });

  it('low is retained only', () => {
    expect(decideScoutAction(finding({ severity: 'low', occurrenceCount: 9 }), ctx())).toMatchObject({ kind: 'retain' });
  });

  it('shadow proposes instead of filing; off does nothing', () => {
    expect(decideScoutAction(finding(), ctx('shadow'))).toMatchObject({ kind: 'propose' });
    expect(decideScoutAction(finding({ severity: 'low' }), ctx('shadow'))).toMatchObject({ kind: 'retain' });
    expect(decideScoutAction(finding(), ctx('off'))).toMatchObject({ kind: 'none', reason: 'mode_off' });
  });

  it('a resolved or dismissed finding is never acted on', () => {
    expect(decideScoutAction(finding({ state: 'resolved' }), ctx())).toMatchObject({ kind: 'none' });
    expect(decideScoutAction(finding({ state: 'dismissed' }), ctx())).toMatchObject({ kind: 'none' });
  });
});

describe('follow-up task text', () => {
  it('names the invariant, the SHA and what was observed, and says it is advisory', () => {
    const f = finding();
    expect(scoutFollowUpTitle(f, 'fix')).toMatch(/^fix\(scout\): /);
    expect(scoutFollowUpTitle(f, 'investigate')).toMatch(/^investigate\(scout\): |^chore\(scout\): investigate/);
    const d = buildScoutFollowUpDescription(f, RUN, 'fix');
    expect(d).toContain(f.invariant);
    expect(d).toContain(SHA);
    expect(d).toContain('GET /health -> 500');
    expect(d).toContain('ev-1');
  });

  it('bounds the title', () => {
    expect(scoutFollowUpTitle(finding({ invariant: 'x'.repeat(500) }), 'fix').length).toBeLessThanOrEqual(120);
  });
});

// ── The atomic follow-up claim ─────────────────────────────────────────────

const RANK: Record<ScoutActionState, number> = { none: 0, retained: 1, aggregated: 2, proposed: 3, filed: 4 };

type MemTask = { status: string; held: boolean; claimed: boolean; retiredByScout: boolean; input?: ScoutFollowUpTaskInput };

function memoryStore(
  init: {
    actionState?: ScoutActionState;
    actionTaskId?: string | null;
    state?: ScoutFinding['state'];
    taskStatuses?: Record<string, string>;
    retiredByScout?: string[];
    exists?: boolean;
  } = {},
) {
  const row = {
    actionState: init.actionState ?? 'none',
    actionTaskId: init.actionTaskId ?? null,
    state: init.state ?? 'open',
    dismissedReason: null as string | null,
    dismissedBy: null as string | null,
  } as { actionState: ScoutActionState; actionTaskId: string | null; state: ScoutFinding['state']; dismissedReason: string | null; dismissedBy: string | null };
  const tasks = new Map<string, MemTask>(
    Object.entries(init.taskStatuses ?? {}).map(([id, status]) => [
      id,
      { status, held: false, claimed: status !== 'pending', retiredByScout: (init.retiredByScout ?? []).includes(id) },
    ]),
  );
  const announced: string[] = [];
  const refreshed: string[] = [];
  const retired: Array<{ id: string; why: unknown }> = [];
  /** What a runner could have claimed at the moment the follow-up claim ran. */
  const claimableAtClaim: string[] = [];
  let n = 0;
  let beforeClaim: (() => void) | null = null;
  const claimable = () => [...tasks.entries()].filter(([, t]) => t.status === 'pending' && !t.held).map(([id]) => id);
  const store: ScoutActionStore = {
    async raiseActionState(_ws, _sig, to) {
      if (row.state !== 'open' || RANK[row.actionState] >= RANK[to]) return false;
      row.actionState = to;
      return true;
    },
    async taskStatus(id) {
      return tasks.get(id)?.status ?? null;
    },
    async cancelledByScout(id) {
      return tasks.get(id)?.retiredByScout ?? false;
    },
    async insertTask(input) {
      const id = `task-${++n}`;
      tasks.set(id, { status: 'pending', held: true, claimed: false, retiredByScout: false, input });
      return { id };
    },
    async claimFollowUp(_ws, _sig, taskId, takeover) {
      beforeClaim?.();
      claimableAtClaim.push(...claimable());
      if (row.state !== 'open') return false;
      if (row.actionTaskId !== null && !takeover.includes(row.actionTaskId)) return false;
      row.actionState = 'filed';
      row.actionTaskId = taskId;
      return true;
    },
    async releaseHold(id) {
      const t = tasks.get(id);
      if (t) t.held = false;
    },
    async currentTaskId() {
      return row.actionTaskId;
    },
    async deleteTask(id) {
      if (tasks.get(id)?.status === 'pending') tasks.delete(id);
    },
    async refreshTask(id) {
      refreshed.push(id);
      return true;
    },
    async announce(id) {
      announced.push(id);
    },
    async retireFollowUp(id, why) {
      retired.push({ id, why });
      const t = tasks.get(id);
      if (!t || ['completed', 'failed', 'cancelled'].includes(t.status)) return null;
      if (t.claimed) return 'annotated';
      t.status = 'cancelled';
      t.retiredByScout = true;
      return 'cancelled';
    },
    async dismissFinding(_ws, _sig, fields) {
      if (init.exists === false) return { dismissed: false, exists: false };
      if (row.state === 'dismissed') return { dismissed: false, exists: true };
      row.state = 'dismissed';
      row.dismissedReason = fields.dismissedReason;
      row.dismissedBy = fields.dismissedBy;
      return { dismissed: true, actionTaskId: row.actionTaskId };
    },
  };
  return { store, row, tasks, announced, refreshed, retired, claimableAtClaim, race: (fn: () => void) => { beforeClaim = fn; } };
}

describe('actOnScoutFinding — one follow-up per finding, ever', () => {
  it('files and announces exactly one task', async () => {
    const m = memoryStore();
    const r = await actOnScoutFinding(finding(), RUN, ctx(), m.store);
    expect(r).toMatchObject({ outcome: 'filed', taskId: 'task-1' });
    expect(m.row).toMatchObject({ actionState: 'filed', actionTaskId: 'task-1' });
    expect(m.announced).toEqual(['task-1']);
    expect(m.tasks.get('task-1')!.input).toMatchObject({ workspaceId: 'ws-1', category: 'bug', signature: 'sig-1' });
  });

  it('a recurrence updates the live task instead of filing another', async () => {
    const m = memoryStore({ actionState: 'filed', actionTaskId: 'task-9', taskStatuses: { 'task-9': 'in_progress' } });
    const r = await actOnScoutFinding(finding({ actionState: 'filed', actionTaskId: 'task-9', occurrenceCount: 2 }), RUN, ctx(), m.store);
    expect(r).toMatchObject({ outcome: 'updated', taskId: 'task-9' });
    expect(m.refreshed).toEqual(['task-9']);
    expect(m.tasks.size).toBe(1);
  });

  it('a finding still failing after its task ended files a fresh one, taking the claim over', async () => {
    for (const status of ['completed', 'failed']) {
      const m = memoryStore({ actionState: 'filed', actionTaskId: 'task-9', taskStatuses: { 'task-9': status } });
      const r = await actOnScoutFinding(finding({ actionState: 'filed', actionTaskId: 'task-9' }), RUN, ctx(), m.store);
      expect(r).toMatchObject({ outcome: 'filed', taskId: 'task-1' });
      expect(m.tasks.get('task-1')!.input!.followUpOf).toBe('task-9');
    }
  });

  it('a follow-up the Scout itself cancelled (the finding resolved, then regressed) is replaced', async () => {
    const m = memoryStore({ actionState: 'filed', actionTaskId: 'task-9', taskStatuses: { 'task-9': 'cancelled' }, retiredByScout: ['task-9'] });
    const r = await actOnScoutFinding(finding({ actionState: 'filed', actionTaskId: 'task-9', regressionCount: 1 }), RUN, ctx(), m.store);
    expect(r).toMatchObject({ outcome: 'filed', taskId: 'task-1' });
    expect(m.row.state).toBe('open');
  });

  it('a follow-up cancelled by anyone else dismisses the finding instead of re-filing it on the next SHA', async () => {
    const m = memoryStore({ actionState: 'filed', actionTaskId: 'task-9', taskStatuses: { 'task-9': 'cancelled' } });
    const r = await actOnScoutFinding(
      finding({ actionState: 'filed', actionTaskId: 'task-9', lastSeenSha: 'b'.repeat(40) }),
      RUN,
      ctx(),
      m.store,
    );
    expect(r).toMatchObject({ outcome: 'dismissed', taskId: 'task-9' });
    expect(m.tasks.size).toBe(1);
    expect(m.announced).toEqual([]);
    expect(m.row).toMatchObject({ state: 'dismissed', dismissedBy: 'follow-up-cancelled:task-9' });
    expect(m.row.dismissedReason).toMatch(/cancelled/);
    // And the run after that leaves it alone.
    const again = await actOnScoutFinding(finding({ state: 'dismissed', actionState: 'filed', actionTaskId: 'task-9' }), RUN, ctx(), m.store);
    expect(again.outcome).toBe('noop');
    expect(m.tasks.size).toBe(1);
  });

  it('the follow-up is inserted held, so a runner cannot start it until the claim is won', async () => {
    const m = memoryStore();
    const r = await actOnScoutFinding(finding(), RUN, ctx(), m.store);
    expect(r.outcome).toBe('filed');
    expect(m.claimableAtClaim).toEqual([]);
    expect(m.tasks.get('task-1')!.held).toBe(false);
  });

  it('a finding dismissed between the read and the claim files nothing', async () => {
    const m = memoryStore();
    m.race(() => {
      m.row.state = 'dismissed';
    });
    const r = await actOnScoutFinding(finding(), RUN, ctx(), m.store);
    expect(r.outcome).toBe('suppressed');
    expect(m.tasks.size).toBe(0);
    expect(m.announced).toEqual([]);
  });

  it('losing the claim race deletes the loser task and reports the winner as suppressed', async () => {
    const m = memoryStore();
    m.race(() => {
      m.row.actionTaskId = 'task-winner';
      m.row.actionState = 'filed';
    });
    const r = await actOnScoutFinding(finding(), RUN, ctx(), m.store);
    expect(r).toMatchObject({ outcome: 'suppressed', taskId: 'task-winner' });
    expect(m.tasks.has('task-1')).toBe(false);
    expect(m.announced).toEqual([]);
    // The loser was never claimable, not even before its delete.
    expect(m.claimableAtClaim).toEqual([]);
  });

  it('two concurrent runs on the same finding produce one task', async () => {
    const m = memoryStore();
    const [a, b] = await Promise.all([actOnScoutFinding(finding(), RUN, ctx(), m.store), actOnScoutFinding(finding(), { ...RUN, id: 'run-2' }, ctx(), m.store)]);
    expect([a.outcome, b.outcome].sort()).toEqual(['filed', 'suppressed']);
    expect([...m.tasks.keys()]).toHaveLength(1);
    expect(m.announced).toHaveLength(1);
  });

  it('shadow records the proposal but files nothing; a second proposal is a dedupe', async () => {
    const m = memoryStore();
    expect(await actOnScoutFinding(finding(), RUN, ctx('shadow'), m.store)).toMatchObject({ outcome: 'proposed', taskId: null });
    expect(m.tasks.size).toBe(0);
    expect(m.row.actionState).toBe('proposed');
    expect(await actOnScoutFinding(finding({ actionState: 'proposed' }), RUN, ctx('shadow'), m.store)).toMatchObject({ outcome: 'suppressed' });
  });

  it('medium aggregates and low retains without a task; neither downgrades a filed finding', async () => {
    const m = memoryStore();
    expect((await actOnScoutFinding(finding({ severity: 'medium', reproducibility: 'unknown' }), RUN, ctx(), m.store)).outcome).toBe('aggregated');
    expect((await actOnScoutFinding(finding({ severity: 'low' }), RUN, ctx(), m.store)).outcome).toBe('noop');
    expect((await actOnScoutFinding(finding({ severity: 'low' }), RUN, ctx(), memoryStore().store)).outcome).toBe('retained');
    const filed = memoryStore({ actionState: 'filed', actionTaskId: 'task-9' });
    expect((await actOnScoutFinding(finding({ severity: 'low' }), RUN, ctx(), filed.store)).outcome).toBe('noop');
    expect(filed.row).toMatchObject({ actionState: 'filed', actionTaskId: 'task-9' });
  });

  it('off touches nothing', async () => {
    const m = memoryStore();
    expect((await actOnScoutFinding(finding(), RUN, ctx('off'), m.store)).outcome).toBe('noop');
    expect(m.row.actionState).toBe('none');
  });

  it('never throws: a store failure is reported as failed', async () => {
    const m = memoryStore();
    m.store.insertTask = async () => {
      throw new Error('db down');
    };
    expect((await actOnScoutFinding(finding(), RUN, ctx(), m.store)).outcome).toBe('failed');
  });
});

describe('dismissQualityScoutFinding — a person says it is not a defect', () => {
  const NOW_FN = () => NOW;
  it('dismisses with the reason and who, and cancels a follow-up nobody has started', async () => {
    const m = memoryStore({ actionState: 'filed', actionTaskId: 'task-9', taskStatuses: { 'task-9': 'pending' } });
    const r = await dismissQualityScoutFinding({ workspaceId: 'ws-1', signature: 'sig-1', reason: ' expected in staging ', by: 'user:u-1' }, m.store, NOW_FN);
    expect(r).toEqual({ status: 'dismissed', followUp: 'cancelled', taskId: 'task-9' });
    expect(m.row).toMatchObject({ state: 'dismissed', dismissedReason: 'expected in staging', dismissedBy: 'user:u-1' });
    expect(m.retired).toEqual([{ id: 'task-9', why: { dismissed: { reason: 'expected in staging', by: 'user:u-1', at: NOW.toISOString() } } }]);
  });

  it('a follow-up already being worked is left to its worker (annotated, not cancelled)', async () => {
    const m = memoryStore({ actionState: 'filed', actionTaskId: 'task-9', taskStatuses: { 'task-9': 'in_progress' } });
    const r = await dismissQualityScoutFinding({ workspaceId: 'ws-1', signature: 'sig-1', reason: 'nope', by: 'user:u-1' }, m.store, NOW_FN);
    expect(r).toEqual({ status: 'dismissed', followUp: 'annotated', taskId: 'task-9' });
    expect(m.tasks.get('task-9')!.status).toBe('in_progress');
  });

  it('a finding with no follow-up just dismisses', async () => {
    const m = memoryStore();
    expect(await dismissQualityScoutFinding({ workspaceId: 'ws-1', signature: 'sig-1', reason: 'nope', by: 'user:u-1' }, m.store, NOW_FN)).toEqual({
      status: 'dismissed',
      followUp: null,
      taskId: null,
    });
    expect(m.retired).toEqual([]);
  });

  it('refuses a blank reason, and reports missing or already-dismissed findings', async () => {
    const m = memoryStore();
    expect(await dismissQualityScoutFinding({ workspaceId: 'ws-1', signature: 'sig-1', reason: ' ', by: 'user:u-1' }, m.store, NOW_FN)).toEqual({
      status: 'invalid',
      error: 'reason_required',
    });
    expect(m.row.state).toBe('open');
    await dismissQualityScoutFinding({ workspaceId: 'ws-1', signature: 'sig-1', reason: 'nope', by: 'user:u-1' }, m.store, NOW_FN);
    expect((await dismissQualityScoutFinding({ workspaceId: 'ws-1', signature: 'sig-1', reason: 'again', by: 'user:u-2' }, m.store, NOW_FN)).status).toBe(
      'already_dismissed',
    );
    expect(m.row.dismissedReason).toBe('nope');
    const gone = memoryStore({ exists: false });
    expect((await dismissQualityScoutFinding({ workspaceId: 'ws-1', signature: 'nope', reason: 'x', by: 'user:u-1' }, gone.store, NOW_FN)).status).toBe('not_found');
  });

  it('a dismissed finding is never re-actioned by a later failing run', async () => {
    const m = memoryStore();
    await dismissQualityScoutFinding({ workspaceId: 'ws-1', signature: 'sig-1', reason: 'nope', by: 'user:u-1' }, m.store, NOW_FN);
    const r = await actOnScoutFinding(finding({ state: 'dismissed', occurrenceCount: 5 }), RUN, ctx(), m.store);
    expect(r.outcome).toBe('noop');
    expect(m.tasks.size).toBe(0);
  });
});
