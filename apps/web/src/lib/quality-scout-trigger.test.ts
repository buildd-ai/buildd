import { describe, expect, it } from 'bun:test';
import type { ScoutRunDeps, ScoutRunOutcome, ScoutRunRequest } from './quality-scout-run';
import {
  isPeriodicScoutDue,
  manualDedupeKey,
  resolveScoutTriggerConfig,
  SERVER_SCOUT_MAX_DURATION_MS,
  serverHttpPort,
  triggerQualityScout,
  type ScoutTriggerDeps,
  type ScoutWorkspace,
} from './quality-scout-trigger';

const SHA = 'e'.repeat(40);
const NOW = new Date('2026-10-05T12:00:00Z');
const H = 3_600_000;

function workspace(qualityScout: unknown, over: Partial<ScoutWorkspace> = {}): ScoutWorkspace {
  return {
    id: 'ws-1',
    teamId: 'team-1',
    gitConfig: { defaultBranch: 'trunk', qualityScout } as ScoutWorkspace['gitConfig'],
    configStatus: 'admin_confirmed',
    releaseConfig: null,
    githubRepo: { fullName: 'acme/tool', defaultBranch: 'trunk', installation: { installationId: 1 } },
    ...over,
  };
}

function triggerDeps(ws: ScoutWorkspace | null, head: string | null = SHA) {
  const runs: ScoutRunRequest[] = [];
  const deps: ScoutTriggerDeps = {
    now: () => NOW,
    loadWorkspace: async () => ws,
    headSha: async () => head,
    buildRunDeps: () => ({}) as ScoutRunDeps,
    run: async (req): Promise<ScoutRunOutcome> => {
      runs.push(req);
      return { status: 'skipped', reason: 'duplicate', runId: 'r' };
    },
  };
  return { deps, runs };
}

describe('resolveScoutTriggerConfig', () => {
  it('is off with nothing configured, and never periodic unless asked', () => {
    expect(resolveScoutTriggerConfig(undefined)).toMatchObject({ mode: 'off', periodicHours: null, missionCandidate: true });
  });

  it('reads triggers and budget; bounds the duration to what a server run may take', () => {
    const cfg = resolveScoutTriggerConfig({
      mode: 'propose',
      triggers: { periodicHours: 24, missionCandidate: false },
      budget: { maxProbes: 3, maxCostUsd: 0.5, maxDurationMs: 10 * H },
    });
    expect(cfg).toMatchObject({ mode: 'propose', periodicHours: 24, missionCandidate: false, budget: { maxProbes: 3, maxCostUsd: 0.5 } });
    expect(cfg.maxDurationMs).toBe(SERVER_SCOUT_MAX_DURATION_MS);
  });

  it('ignores a nonsense period rather than running constantly', () => {
    expect(resolveScoutTriggerConfig({ mode: 'shadow', triggers: { periodicHours: 0.01 } }).periodicHours).toBeNull();
    expect(resolveScoutTriggerConfig({ mode: 'shadow', triggers: { periodicHours: 'daily' } }).periodicHours).toBeNull();
  });
});

describe('isPeriodicScoutDue', () => {
  const cfg = resolveScoutTriggerConfig({ mode: 'shadow', triggers: { periodicHours: 24 } });
  it('due when never run or the period has elapsed', () => {
    expect(isPeriodicScoutDue(cfg, null, NOW)).toBe(true);
    expect(isPeriodicScoutDue(cfg, new Date(NOW.getTime() - 25 * H), NOW)).toBe(true);
    expect(isPeriodicScoutDue(cfg, new Date(NOW.getTime() - 2 * H), NOW)).toBe(false);
  });
  it('never due when off or not periodic', () => {
    expect(isPeriodicScoutDue(resolveScoutTriggerConfig({ mode: 'off', triggers: { periodicHours: 24 } }), null, NOW)).toBe(false);
    expect(isPeriodicScoutDue(resolveScoutTriggerConfig({ mode: 'shadow' }), null, NOW)).toBe(false);
  });
});

describe('manualDedupeKey', () => {
  it('a double tap is one key; a re-run later is another', () => {
    expect(manualDedupeKey(NOW)).toBe(manualDedupeKey(new Date(NOW.getTime() + 30_000)));
    expect(manualDedupeKey(NOW)).not.toBe(manualDedupeKey(new Date(NOW.getTime() + H)));
  });
});

describe('triggerQualityScout', () => {
  it('off does nothing', async () => {
    const t = triggerDeps(workspace({ mode: 'off' }));
    expect(await triggerQualityScout({ workspaceId: 'ws-1', trigger: 'manual' }, t.deps)).toMatchObject({ status: 'skipped', reason: 'mode_off' });
    expect(t.runs).toHaveLength(0);
  });

  it('manual runs the default branch head with the workspace budget, mode and policy', async () => {
    const t = triggerDeps(workspace({ mode: 'shadow', budget: { maxProbes: 3 } }));
    await triggerQualityScout({ workspaceId: 'ws-1', trigger: 'manual' }, t.deps);
    expect(t.runs[0]).toMatchObject({ mode: 'shadow', trigger: 'manual', candidate: { ref: 'trunk', sha: SHA }, budget: { maxProbes: 3 } });
    expect(t.runs[0].dedupeKey).toBe(manualDedupeKey(NOW));
  });

  it('the mission trigger exercises the integration branch at the given SHA, unless disabled', async () => {
    const t = triggerDeps(workspace({ mode: 'propose' }));
    await triggerQualityScout({ workspaceId: 'ws-1', trigger: 'mission-candidate', missionId: 'm-1', ref: 'mission/x', sha: 'f'.repeat(40) }, t.deps);
    expect(t.runs[0]).toMatchObject({ missionId: 'm-1', candidate: { ref: 'mission/x', sha: 'f'.repeat(40) } });
    expect(t.runs[0].dedupeKey).toBeUndefined();

    const off = triggerDeps(workspace({ mode: 'propose', triggers: { missionCandidate: false } }));
    expect(await triggerQualityScout({ workspaceId: 'ws-1', trigger: 'mission-candidate', ref: 'mission/x' }, off.deps)).toMatchObject({
      reason: 'trigger_disabled',
    });
  });

  it('periodic needs periodicHours', async () => {
    const t = triggerDeps(workspace({ mode: 'propose' }));
    expect(await triggerQualityScout({ workspaceId: 'ws-1', trigger: 'periodic' }, t.deps)).toMatchObject({ reason: 'trigger_disabled' });
  });

  it('skips without a repo or a resolvable head', async () => {
    expect(await triggerQualityScout({ workspaceId: 'ws-1', trigger: 'manual' }, triggerDeps(workspace({ mode: 'shadow' }, { githubRepo: null })).deps))
      .toMatchObject({ reason: 'no_repo' });
    expect(await triggerQualityScout({ workspaceId: 'ws-1', trigger: 'manual' }, triggerDeps(workspace({ mode: 'shadow' }), null).deps))
      .toMatchObject({ reason: 'no_candidate_sha' });
    expect(await triggerQualityScout({ workspaceId: 'ws-1', trigger: 'manual' }, triggerDeps(null).deps)).toMatchObject({ reason: 'no_workspace' });
  });

  it('fail-open: a throwing loader is a failed outcome, not an exception', async () => {
    const t = triggerDeps(workspace({ mode: 'shadow' }));
    t.deps.loadWorkspace = async () => { throw new Error('db down'); };
    expect(await triggerQualityScout({ workspaceId: 'ws-1', trigger: 'manual' }, t.deps)).toMatchObject({ status: 'failed', error: 'db down' });
  });
});

describe('serverHttpPort', () => {
  it('never sends a write method', async () => {
    let called = false;
    const port = serverHttpPort((async () => { called = true; return new Response('x'); }) as unknown as typeof fetch);
    expect(await port.request({ method: 'POST', url: 'https://qa.example.test/x', timeoutMs: 1000 })).toEqual({ status: null });
    expect(called).toBe(false);
  });

  it('records status, a bounded excerpt and the probe-row evidence ref', async () => {
    const port = serverHttpPort((async () => new Response('y'.repeat(5000), { status: 503 })) as unknown as typeof fetch);
    const r = await port.request({ method: 'GET', url: 'https://qa.example.test/health', timeoutMs: 1000 });
    expect(r.status).toBe(503);
    expect(r.bodyExcerpt!.length).toBe(2000);
    expect(r.evidenceRef).toBe('scout-probe-row:GET /health');
  });

  it('a network error is no response, not a throw', async () => {
    const port = serverHttpPort((async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch);
    expect((await port.request({ method: 'GET', url: 'https://qa.example.test/', timeoutMs: 1000 })).status).toBeNull();
  });
});

describe('scheduleMissionCandidateScout', () => {
  it('hands the run to the scheduler and returns immediately', async () => {
    const { scheduleMissionCandidateScout } = await import('./quality-scout-trigger');
    const scheduled: Array<() => Promise<unknown>> = [];
    scheduleMissionCandidateScout({ missionId: 'm-1', workspaceId: 'ws-1', ref: 'mission/x', sha: SHA }, (task) => { scheduled.push(task); });
    expect(scheduled).toHaveLength(1);
  });
});
