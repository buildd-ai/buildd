/**
 * The operator-recovery pass over synthetic queue facts (F-7 end to end): a
 * model that is down or out of budget leaves the deterministic grouping and
 * ranking exactly as they were; a clean merge answer regroups. Names are
 * synthetic (team-a, repo-a).
 */
import { describe, expect, it } from 'bun:test';
import type { DecisionResponse } from '@builddai/ai-kit/decide';
import { OPERATOR_REPAIR_KINDS } from '@buildd/core/decision-kind-operator-recovery';
import type { FailureIncidentRecovery } from '@buildd/shared';
import { buildRecoveryPanel, type QueueFacts, type QueueIncident } from './admin/recovery/queue';
import { DEFAULT_RECOVERY_POLICY } from './admin/recovery/automation';
import { REPAIR_KINDS } from './failure-incident-recovery-events';
import type { StoredIncident } from './failure-incident-store';
import type { OperatorDecisionDeps } from './operator-recovery-decisions';
import { runOperatorRecoveryPass, type OperatorPassDeps } from './operator-recovery-pass';

const NOW = '2026-10-13T09:00:00.000Z';
const ago = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TEAM_A = id(901), TEAM_B = id(902);
const WS_A = id(801), WS_B = id(802);

function recovery(reasonCode: string): FailureIncidentRecovery {
  return {
    v: 1, generation: 1, cause: { reasonCode, rule: 'repeated_failure', ownership: 'infrastructure' },
    subjects: [], blockers: [], overlappingPaths: [], observation: { observedAt: ago(0.1), source: 'sweep', evidenceRevision: `r-${reasonCode}` },
    firstSeenAt: ago(5), lastSeenAt: ago(0.1), lastProgressAt: null, owner: 'buildd', state: 'waiting',
    nextAction: { kind: 'wait', label: 'Waiting.', key: 'k' }, nextCheckAt: ago(-0.3), verification: { predicate: 'p', params: {} },
    budget: { spent: 0, limit: 3, deadlineAt: ago(-6), spentKeys: [] }, attempts: [],
  };
}

// Same family and error family, two cause codes: the rule key keeps them apart, ambiguously.
function incident(n: number, ws: string, reasonCode: string, firstSeenH: number): QueueIncident {
  return {
    id: id(n), version: 3, workspaceId: ws, signature: `repeated_failure|ws=${ws}|agent_timeout`, detectorVersion: 'fps-v2',
    rule: 'repeated_failure', reasonCode, title: 'Agents time out', severity: 'high', status: 'open', firstSeenAt: ago(firstSeenH), lastSeenAt: ago(0.5),
    occurrenceCount: 3, recurrenceCount: 0, affectedRefs: { taskIds: [], workerIds: [], prNumbers: [] }, evidenceRefs: [], impact: {},
    lastAlertedAt: null, lastAlertSeverity: null, linkedFixTaskId: null, acknowledgedAt: null, resolvedAt: null,
    recovery: { ...recovery(reasonCode), firstSeenAt: ago(firstSeenH) },
  };
}

function facts(incidents: QueueIncident[]): QueueFacts {
  return {
    now: NOW, window: '7d', platformWide: true, incidents,
    workspaces: new Map([[WS_A, { id: WS_A, name: 'repo-a', teamId: TEAM_A }], [WS_B, { id: WS_B, name: 'repo-b', teamId: TEAM_B }]]),
    teams: new Map([[TEAM_A, { id: TEAM_A, name: 'team-a' }], [TEAM_B, { id: TEAM_B, name: 'team-b' }]]),
    tasks: new Map(), missions: new Map(), workers: [], prTasks: new Map(), fixPrs: new Map(), attempts: [],
    lastRun: { startedAt: ago(0.2), finishedAt: ago(0.1), full: true, workspaces: 2, runFailures: 0, incidentsAssessed: 2, recoveryRepairs: 0 },
    personVerdicts: new Set(),
    automation: { paused: { platform: false, rules: [], causes: [] }, readError: false, policy: DEFAULT_RECOVERY_POLICY, model: { spentUsdToday: 0, callsToday: 0, breakerOpenUntil: null } },
  };
}

function decisionDeps(mode: 'timeout' | 'budget' | 'merge', calls: { n: number }): OperatorDecisionDeps {
  return {
    now: () => new Date(NOW),
    cached: async () => null,
    switches: async () => ({ off: new Set(), modelPaused: false }),
    usageToday: async () => (mode === 'budget' ? { calls: 600, costUsd: 1 } : { calls: 0, costUsd: 0 }),
    limits: async () => ({ dailyUsd: 5, dailyCalls: 600, timeoutMs: 800 }),
    breaker: { openUntil: async () => null, failure: async () => {}, success: async () => {} },
    claim: async () => true,
    async decide(kind) {
      calls.n++;
      if (mode === 'timeout') await new Promise(() => {});
      const answer = kind === 'buildd.operator_cause_merge' ? 'merge' : 'keep';
      return { response: { decision: answer, confidence: 0.9, reasonCode: `answer_${answer}`, source: 'model', attempts: [{ decision: answer }], costUsd: 0 } as unknown as DecisionResponse, ledger: null };
    },
    async explain(kind, _p, ctx) {
      calls.n++;
      if (mode === 'timeout') await new Promise(() => {});
      const answer = kind === 'buildd.operator_cause_merge' ? 'merge' : 'keep';
      const data = ctx.validate({ answer, confidence: 0.9, evidenceRefs: ['ev1'], rationale: 'One error family.', uncertainty: null })!;
      return { ok: true, data, model: 'm', provider: 'anthropic', usage: { inputTokens: 1, outputTokens: 1 }, route: 'anthropic' } as never;
    },
    record: async () => id(990),
  };
}

function passDeps(f: QueueFacts, mode: 'timeout' | 'budget' | 'merge', calls: { n: number }) {
  const store = new Map<string, StoredIncident>(f.incidents.map(i => [i.id, i]));
  const deps: OperatorPassDeps = {
    now: () => new Date(NOW),
    loadFacts: async () => ({ ...f, incidents: [...store.values()] as QueueIncident[] }),
    decision: decisionDeps(mode, calls),
    port: {
      findById: async i => store.get(i) ?? null,
      compareAndSwap: async (i, v, next) => {
        const cur = store.get(i);
        if (!cur || cur.version !== v) return null;
        const out = { ...next, id: i, version: v + 1 };
        store.set(i, out);
        return out;
      },
    },
    actionDeps: async () => { throw new Error('no repair expected'); },
    repairFacts: async () => null,
    excerpts: async () => [],
  };
  return { deps, store };
}

const order = (f: QueueFacts) => buildRecoveryPanel(f).causes.map(c => [c.causeKey, c.rank.position, c.grouping.source]);

describe('F-7 through the pass', () => {
  const incidents = [incident(1, WS_A, 'repeated_failure.agent_timeout', 9), incident(2, WS_B, 'repeated_failure.agent_stalled', 5)];

  for (const mode of ['timeout', 'budget'] as const) {
    it(`${mode}: grouping and ranking are unchanged`, async () => {
      const f = facts(incidents);
      const before = order(f);
      expect(before).toHaveLength(2);
      const calls = { n: 0 };
      const { deps, store } = passDeps(f, mode, calls);
      const r = await runOperatorRecoveryPass(deps);
      expect(r.merged).toBe(0);
      expect(order({ ...f, incidents: [...store.values()] as QueueIncident[] })).toEqual(before);
      if (mode === 'budget') expect(calls.n).toBe(0);
    });
  }

  it('a clean merge answer regroups the two causes into one, source model', async () => {
    const f = facts(incidents);
    const calls = { n: 0 };
    const { deps, store } = passDeps(f, 'merge', calls);
    const r = await runOperatorRecoveryPass(deps);
    expect(r.merged).toBe(1);
    const after = buildRecoveryPanel({ ...f, incidents: [...store.values()] as QueueIncident[] }).causes;
    expect(after).toHaveLength(1);
    // The older cause leads (its own rule key); the younger one joined it as a model membership.
    expect(store.get(id(2))!.recovery?.causeGroup).toMatchObject({ source: 'model', key: after[0].causeKey });
  });
});

describe('the repair kinds the model may name are the allowlist', () => {
  it('mirror RepairKind exactly', () => {
    expect([...OPERATOR_REPAIR_KINDS].sort()).toEqual([...REPAIR_KINDS].sort());
  });
});
