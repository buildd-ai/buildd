import { describe, it, expect } from 'bun:test';
import type { RootCauseRecord } from '@buildd/shared';
import {
  classifyPattern,
  classifyRunnerFailure,
  foldObservation,
  MAX_ROOT_CAUSE_TASK_IDS,
  patternObservation,
  recordPatternRootCauses,
  recordRootCauseForOutcome,
  restores,
  runnerErrorClass,
  runnerFailureObservation,
  type CapabilityCheck,
  type OutcomeFactsPort,
  type RootCauseObservation,
  type RootCauseStorePort,
  type RunnerFacts,
} from './root-cause-record';

const TEAM = 'team-a';
const WS = 'ws-1';
const at = (m: number) => new Date(Date.parse('2026-10-13T10:00:00.000Z') + m * 60_000).toISOString();

const runner = (over: Partial<RunnerFacts> = {}): RunnerFacts => ({
  id: 'runner-1', authType: 'oauth', managedRunner: false, hostRunner: false, createdByUserId: 'user-1', ...over,
});

/** The store as `foldObservation` and `restores` define it: what the SQL must match. */
function memoryStore(): RootCauseStorePort & { rows: Map<string, RootCauseRecord> } {
  const rows = new Map<string, RootCauseRecord>();
  return {
    rows,
    async upsert(obs: RootCauseObservation) {
      const k = `${obs.teamId}|${obs.key}`;
      rows.set(k, foldObservation(rows.get(k) ?? null, obs));
    },
    async verifyRestored(check: CapabilityCheck) {
      let n = 0;
      for (const [k, r] of rows) if (restores(r, check)) { rows.set(k, { ...r, verifiedRestoredAt: check.at }); n++; }
      return n;
    },
  };
}

describe('runnerErrorClass', () => {
  it('is an auth failure only when the shared auth classifier says so', () => {
    expect(runnerErrorClass('Not logged in · Please run /login')).toBe('auth_failure');
    expect(runnerErrorClass('OAuth token has expired')).toBe('auth_failure');
    expect(runnerErrorClass('TypeError: x is undefined')).toBeNull();
    expect(runnerErrorClass('')).toBeNull();
    expect(runnerErrorClass(null)).toBeNull();
  });
});

describe('classifyRunnerFailure: structured runner fields only', () => {
  it('a self-hosted subscription runner has an expired sign-in', () => {
    expect(classifyRunnerFailure('auth_failure', runner())).toEqual({ classification: 'credential_expired', kind: 'runner' });
  });

  it('a self-hosted key runner had its key rejected, never a sign-in', () => {
    expect(classifyRunnerFailure('auth_failure', runner({ authType: 'api' }))).toEqual({ classification: 'api_key_rejected', kind: 'runner' });
  });

  it('a hosted runner never yields a sign-in, whatever its authType says', () => {
    for (const authType of ['oauth', 'api'] as const) {
      expect(classifyRunnerFailure('auth_failure', runner({ authType, managedRunner: true }))).toEqual({ classification: 'api_key_rejected', kind: 'provider' });
    }
  });

  it('a host runner or one with no creator is classified the same: who acts is not the classification', () => {
    expect(classifyRunnerFailure('auth_failure', runner({ hostRunner: true, createdByUserId: null })).classification).toBe('credential_expired');
  });
});

describe('classifyPattern', () => {
  it('buildd machinery is platform_managed; failing work with no established cause is unknown', () => {
    for (const rule of ['retry_fork', 'lineage_multi_pr', 'stranded_gate', 'path_overlap_stall', 'provider_attribution_mismatch']) {
      expect(classifyPattern(rule)).toBe('platform_managed');
    }
    for (const rule of ['repeated_failure', 'failure_rate_spike', 'output_unmet_boundary', 'a_rule_added_later']) {
      expect(classifyPattern(rule)).toBe('unknown');
    }
  });
});

describe('the record carries no operator state', () => {
  it('has exactly the root-cause fields', () => {
    const rec = foldObservation(null, runnerFailureObservation({ teamId: TEAM, runner: runner(), provider: 'claude', errorClass: 'auth_failure', taskId: 't1', at: at(0) }));
    expect(Object.keys(rec).sort()).toEqual(['affectedTaskIds', 'capability', 'classification', 'firstSeenAt', 'key', 'lastSeenAt', 'teamId', 'verifiedRestoredAt']);
    expect(Object.keys(rec.capability).sort()).toEqual(['component', 'kind', 'provider', 'runnerId', 'workspaceId']);
  });
});

describe('foldObservation: one record per cause', () => {
  const sighting = (taskId: string, m: number) =>
    runnerFailureObservation({ teamId: TEAM, runner: runner(), provider: 'claude', errorClass: 'auth_failure', taskId, at: at(m) });

  it('many failing tasks on one runner fold into one record with all the work, newest first', () => {
    let rec: RootCauseRecord | null = null;
    for (const [i, id] of ['t1', 't2', 't3', 't2'].entries()) rec = foldObservation(rec, sighting(id, i));
    expect(rec!.key).toBe('credential:runner-1:claude');
    expect(rec!.affectedTaskIds).toEqual(['t2', 't3', 't1']);
    expect(rec!.firstSeenAt).toBe(at(0));
    expect(rec!.lastSeenAt).toBe(at(3));
  });

  it('keeps the newest task ids when capped', () => {
    let rec: RootCauseRecord | null = null;
    for (let i = 0; i < MAX_ROOT_CAUSE_TASK_IDS + 5; i++) rec = foldObservation(rec, sighting(`t${i}`, i));
    expect(rec!.affectedTaskIds).toHaveLength(MAX_ROOT_CAUSE_TASK_IDS);
    expect(rec!.affectedTaskIds[0]).toBe(`t${MAX_ROOT_CAUSE_TASK_IDS + 4}`);
  });

  it('a repeat after a verified restore reopens the same record; a late report from before it does not', () => {
    const restored = { ...foldObservation(null, sighting('t1', 0)), verifiedRestoredAt: at(10) };
    expect(foldObservation(restored, sighting('t2', 5)).verifiedRestoredAt).toBe(at(10));
    const reopened = foldObservation(restored, sighting('t3', 20));
    expect(reopened.verifiedRestoredAt).toBeNull();
    expect(reopened.key).toBe(restored.key);
    expect(reopened.firstSeenAt).toBe(at(0));
  });
});

describe('restores: only a passing check on the affected capability', () => {
  const cred = foldObservation(null, runnerFailureObservation({ teamId: TEAM, runner: runner(), provider: 'claude', errorClass: 'auth_failure', taskId: 't1', at: at(0) }));
  const platform = foldObservation(null, patternObservation({ teamId: TEAM, workspaceId: WS, rule: 'stranded_gate', taskIds: ['t9'], firstObservedAt: at(0), lastObservedAt: at(0) }));
  const check = (over: Partial<CapabilityCheck> = {}): CapabilityCheck => ({ teamId: TEAM, runnerId: 'runner-1', provider: 'claude', workspaceId: WS, at: at(5), ...over });

  it('a success on the same runner and provider restores a credential cause', () => {
    expect(restores(cred, check())).toBe(true);
  });

  it('a success on another runner, another provider or another team proves nothing', () => {
    expect(restores(cred, check({ runnerId: 'runner-2' }))).toBe(false);
    expect(restores(cred, check({ runnerId: null }))).toBe(false);
    expect(restores(cred, check({ provider: 'codex' }))).toBe(false);
    expect(restores(cred, check({ teamId: 'team-b' }))).toBe(false);
  });

  it('a check from before the last sighting does not restore it', () => {
    expect(restores(cred, check({ at: at(0) }))).toBe(false);
    expect(restores(cred, check({ at: at(-1) }))).toBe(false);
  });

  it('a platform cause is restored by a success in its workspace, on any runner', () => {
    expect(restores(platform, check({ runnerId: 'runner-9' }))).toBe(true);
    expect(restores(platform, check({ workspaceId: 'ws-2' }))).toBe(false);
  });

  it('an already restored cause is not restored again', () => {
    expect(restores({ ...cred, verifiedRestoredAt: at(1) }, check())).toBe(false);
  });
});

describe('recordRootCauseForOutcome', () => {
  const facts = (r: RunnerFacts | null = runner()): OutcomeFactsPort => ({
    async task(taskId) { return taskId === 'missing' ? null : { teamId: TEAM, workspaceId: WS, provider: 'claude' }; },
    async runner() { return r; },
  });

  it('an auth failure records one cause on the runner; the owner signing in changes nothing until a run succeeds there', async () => {
    const store = memoryStore();
    await recordRootCauseForOutcome({ taskId: 't1', accountId: 'runner-1', status: 'failed', error: 'Not logged in · Please run /login', at: at(0) }, { store, facts: facts() });
    await recordRootCauseForOutcome({ taskId: 't2', accountId: 'runner-1', status: 'failed', error: 'oauth token has expired', at: at(1) }, { store, facts: facts() });
    expect(store.rows.size).toBe(1);
    const [rec] = store.rows.values();
    expect(rec).toMatchObject({ classification: 'credential_expired', affectedTaskIds: ['t2', 't1'], verifiedRestoredAt: null });
    expect(rec.capability).toEqual({ kind: 'runner', runnerId: 'runner-1', provider: 'claude', component: null, workspaceId: null });

    // A run on another runner succeeding is not a check on this one.
    await recordRootCauseForOutcome({ taskId: 't3', accountId: 'runner-2', status: 'completed', error: null, at: at(2) }, { store, facts: facts() });
    expect([...store.rows.values()][0].verifiedRestoredAt).toBeNull();

    await recordRootCauseForOutcome({ taskId: 't4', accountId: 'runner-1', status: 'completed', error: null, at: at(3) }, { store, facts: facts() });
    expect([...store.rows.values()][0].verifiedRestoredAt).toBe(at(3));
  });

  it('a non-auth failure, an unknown runner or a missing task records nothing', async () => {
    const store = memoryStore();
    await recordRootCauseForOutcome({ taskId: 't1', accountId: 'runner-1', status: 'failed', error: 'TypeError: boom', at: at(0) }, { store, facts: facts() });
    await recordRootCauseForOutcome({ taskId: 't1', accountId: null, status: 'failed', error: 'not logged in', at: at(0) }, { store, facts: facts() });
    await recordRootCauseForOutcome({ taskId: 't1', accountId: 'runner-1', status: 'failed', error: 'not logged in', at: at(0) }, { store, facts: facts(null) });
    await recordRootCauseForOutcome({ taskId: 'missing', accountId: 'runner-1', status: 'failed', error: 'not logged in', at: at(0) }, { store, facts: facts() });
    await recordRootCauseForOutcome({ taskId: null, accountId: 'runner-1', status: 'failed', error: 'not logged in', at: at(0) }, { store, facts: facts() });
    await recordRootCauseForOutcome({ taskId: 't1', accountId: 'runner-1', status: 'waiting_input', error: 'not logged in', at: at(0) }, { store, facts: facts() });
    expect(store.rows.size).toBe(0);
  });

  it('a hosted runner\'s auth failure is a rejected key on the provider', async () => {
    const store = memoryStore();
    await recordRootCauseForOutcome({ taskId: 't1', accountId: 'runner-1', status: 'failed', error: 'invalid api key', at: at(0) }, { store, facts: facts(runner({ managedRunner: true, authType: 'api' })) });
    expect([...store.rows.values()][0]).toMatchObject({ classification: 'api_key_rejected', capability: { kind: 'provider', runnerId: 'runner-1', provider: 'claude' } });
  });
});

describe('recordPatternRootCauses', () => {
  const sighting = (rule: string, workspaceId: string | null = WS) => ({ rule, workspaceId, taskIds: ['t1'], firstObservedAt: at(0), lastObservedAt: at(1) });

  it('records one platform cause per pattern on the workspace\'s team', async () => {
    const store = memoryStore();
    const n = await recordPatternRootCauses(WS, [sighting('stranded_gate'), sighting('repeated_failure'), sighting('repeated_failure')], { store, teamOfWorkspace: async () => TEAM });
    expect(n).toBe(3);
    expect([...store.rows.values()].map(r => [r.key, r.classification])).toEqual([
      ['pattern:stranded_gate:ws-1', 'platform_managed'],
      ['pattern:repeated_failure:ws-1', 'unknown'],
    ]);
    expect([...store.rows.values()][0].capability).toEqual({ kind: 'platform', runnerId: null, provider: null, component: 'stranded_gate', workspaceId: WS });
  });

  it('a pattern about no workspace, or a workspace with no team, records nothing', async () => {
    const store = memoryStore();
    expect(await recordPatternRootCauses(WS, [sighting('repeated_failure', null)], { store, teamOfWorkspace: async () => TEAM })).toBe(0);
    expect(await recordPatternRootCauses(WS, [sighting('repeated_failure')], { store, teamOfWorkspace: async () => null })).toBe(0);
    expect(store.rows.size).toBe(0);
  });
});
