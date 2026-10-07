import { describe, expect, it } from 'bun:test';
import { scoutRunId, type ScoutRunDeps, type ScoutRunOutcome, type ScoutRunRequest } from './quality-scout-run';
import type { ScoutProbeRecord, ScoutRun, ScoutRunMetrics } from '@buildd/core/quality-scout/types';
import {
  buildServerScoutRunDeps,
  checkManualScoutRateLimit,
  finalizeExpiredQualityScoutRuns,
  type ExpiredScoutDeps,
  scoutRunnerNeeds,
  isPeriodicScoutDue,
  isQualityScoutDisabled,
  MANUAL_SCOUT_RUNS_PER_HOUR,
  runPeriodicQualityScouts,
  type PeriodicScoutDeps,
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

const publicDns = { allowLocal: false, lookup: async () => [{ address: '93.184.216.34', family: 4 }] };

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
    const port = serverHttpPort((async () => { called = true; return new Response('x'); }) as unknown as typeof fetch, publicDns);
    expect(await port.request({ method: 'POST', url: 'https://qa.example.test/x', timeoutMs: 1000 })).toEqual({ status: null });
    expect(called).toBe(false);
  });

  it('records status, a bounded excerpt and the probe-row evidence ref', async () => {
    const port = serverHttpPort((async () => new Response('y'.repeat(5000), { status: 503 })) as unknown as typeof fetch, publicDns);
    const r = await port.request({ method: 'GET', url: 'https://qa.example.test/health', timeoutMs: 1000 });
    expect(r.status).toBe(503);
    expect(r.bodyExcerpt!.length).toBe(2000);
    expect(r.evidenceRef).toBe('scout-probe-row:GET /health');
  });

  it('a network error is no response, not a throw', async () => {
    const port = serverHttpPort((async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch, publicDns);
    expect((await port.request({ method: 'GET', url: 'https://qa.example.test/', timeoutMs: 1000 })).status).toBeNull();
  });

  function recordingFetch(answer: (url: string) => Response) {
    const calls: Array<{ url: string; redirect?: RequestRedirect }> = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, redirect: init?.redirect });
      return answer(url);
    }) as unknown as typeof fetch;
    return { f, calls };
  }

  it('refuses a private, loopback or link-local target without sending anything', async () => {
    const { f, calls } = recordingFetch(() => new Response('x'));
    const port = serverHttpPort(f, { allowLocal: false });
    for (const url of ['http://127.0.0.1/x', 'http://10.0.0.5/x', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/x', 'http://localhost/x']) {
      expect((await port.request({ method: 'GET', url, timeoutMs: 1000 })).status).toBeNull();
    }
    // A public-looking name that resolves somewhere private is refused too.
    const rebound = serverHttpPort(f, { allowLocal: false, lookup: async () => [{ address: '192.168.1.10', family: 4 }] });
    expect((await rebound.request({ method: 'GET', url: 'https://qa.example.test/x', timeoutMs: 1000 })).status).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('never lets fetch follow a redirect on its own', async () => {
    const { f, calls } = recordingFetch(() => new Response('ok'));
    await serverHttpPort(f, publicDns).request({ method: 'GET', url: 'https://qa.example.test/x', timeoutMs: 1000 });
    expect(calls[0].redirect).toBe('manual');
  });

  it('follows a same-host redirect and records where it ended', async () => {
    const { f, calls } = recordingFetch((url) =>
      url.endsWith('/old') ? new Response(null, { status: 302, headers: { location: '/new' } }) : new Response('fresh', { status: 200 }));
    const r = await serverHttpPort(f, publicDns).request({ method: 'GET', url: 'https://qa.example.test/old', timeoutMs: 1000 });
    expect(calls.map(c => c.url)).toEqual(['https://qa.example.test/old', 'https://qa.example.test/new']);
    expect(r).toMatchObject({ status: 200, finalUrl: 'https://qa.example.test/new', bodyExcerpt: 'fresh' });
  });

  it('does not follow a redirect to a different host: the 3xx itself is the observation', async () => {
    const { f, calls } = recordingFetch(() => new Response(null, { status: 301, headers: { location: 'http://169.254.169.254/latest/meta-data' } }));
    const r = await serverHttpPort(f, publicDns).request({ method: 'GET', url: 'https://qa.example.test/x', timeoutMs: 1000 });
    expect(calls).toHaveLength(1);
    expect(r).toMatchObject({ status: 301, finalUrl: 'https://qa.example.test/x' });
  });

  it('stops after a bounded number of same-host hops', async () => {
    const { f, calls } = recordingFetch((url) => new Response(null, { status: 302, headers: { location: `${url}x` } }));
    const r = await serverHttpPort(f, publicDns).request({ method: 'GET', url: 'https://qa.example.test/x', timeoutMs: 1000 });
    expect(calls.length).toBeLessThanOrEqual(6);
    expect(r.status).toBe(302);
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

describe('kill switch (QUALITY_SCOUT_DISABLED)', () => {
  const on = { QUALITY_SCOUT_DISABLED: '1' };

  it('reads the flag strictly: 1/true are on, anything else is off', () => {
    expect(isQualityScoutDisabled(on)).toBe(true);
    expect(isQualityScoutDisabled({ QUALITY_SCOUT_DISABLED: 'true' })).toBe(true);
    expect(isQualityScoutDisabled({ QUALITY_SCOUT_DISABLED: '0' })).toBe(false);
    expect(isQualityScoutDisabled({})).toBe(false);
  });

  it('turns every configured mode into off', () => {
    expect(resolveScoutTriggerConfig({ mode: 'propose', triggers: { periodicHours: 24 } }, on).mode).toBe('off');
  });

  it('manual, mission and periodic triggers all skip as mode_off', async () => {
    const prev = process.env.QUALITY_SCOUT_DISABLED;
    process.env.QUALITY_SCOUT_DISABLED = '1';
    try {
      const t = triggerDeps(workspace({ mode: 'propose', triggers: { periodicHours: 1 } }));
      for (const trigger of ['manual', 'mission-candidate', 'periodic'] as const) {
        expect(await triggerQualityScout({ workspaceId: 'ws-1', trigger, ref: 'trunk' }, t.deps)).toMatchObject({ status: 'skipped', reason: 'mode_off' });
      }
      expect(t.runs).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.QUALITY_SCOUT_DISABLED;
      else process.env.QUALITY_SCOUT_DISABLED = prev;
    }
  });

  it('the periodic sweep does not even list workspaces', async () => {
    const p = periodicDeps([]);
    let listed = false;
    p.deps.listConfigured = async () => { listed = true; return []; };
    const out = await runPeriodicQualityScouts(NOW, { deps: p.deps, schedule: p.schedule, env: on });
    expect(listed).toBe(false);
    expect(out.scheduled).toEqual([]);
  });
});

interface FakeWs { id: string; lastStartedAt: Date | null; head: string | null; runState?: { status: string; startedAt: Date } | null; repo?: boolean }

function periodicDeps(list: FakeWs[], periodicHours = 24) {
  const byId = new Map(list.map(w => [w.id, w]));
  const scheduled: Array<() => Promise<unknown>> = [];
  const headCalls: string[] = [];
  const deps: PeriodicScoutDeps = {
    listConfigured: async () => list.map(w => ({ id: w.id, gitConfig: { defaultBranch: 'trunk', qualityScout: { mode: 'shadow', triggers: { periodicHours } } } as ScoutWorkspace['gitConfig'] })),
    lastRunStartedAt: async (id) => byId.get(id)!.lastStartedAt,
    loadWorkspace: async (id) => workspace({ mode: 'shadow', triggers: { periodicHours } }, { id, ...(byId.get(id)!.repo === false ? { githubRepo: null } : {}) }),
    headSha: async (ws) => { headCalls.push(ws.id); return byId.get(ws.id)!.head; },
    autoRunState: async (runId) => {
      for (const w of list) if (w.head && runId === scoutRunId(w.id, 'periodic', w.head)) return w.runState ?? null;
      return null;
    },
  };
  return { deps, scheduled, headCalls, schedule: (task: () => Promise<unknown>) => { scheduled.push(task); } };
}

describe('runPeriodicQualityScouts', () => {
  const old = new Date(NOW.getTime() - 48 * H);
  const recent = new Date(NOW.getTime() - 2 * H);
  const sha = (c: string) => c.repeat(40);

  it('schedules a due workspace whose head has not been exercised', async () => {
    const p = periodicDeps([{ id: 'a', lastStartedAt: old, head: sha('a') }]);
    const out = await runPeriodicQualityScouts(NOW, { deps: p.deps, schedule: p.schedule, env: {} });
    expect(out).toMatchObject({ configured: 1, due: 1, scheduled: ['a'], unchanged: 0, errors: 0 });
    expect(p.scheduled).toHaveLength(1);
  });

  it('a workspace never run before is due', async () => {
    const p = periodicDeps([{ id: 'a', lastStartedAt: null, head: sha('a') }]);
    expect((await runPeriodicQualityScouts(NOW, { deps: p.deps, schedule: p.schedule, env: {} })).scheduled).toEqual(['a']);
  });

  it('not due inside the period, and no GitHub call is made for it', async () => {
    const p = periodicDeps([{ id: 'a', lastStartedAt: recent, head: sha('a') }]);
    const out = await runPeriodicQualityScouts(NOW, { deps: p.deps, schedule: p.schedule, env: {} });
    expect(out).toMatchObject({ configured: 1, due: 0, scheduled: [] });
    expect(p.headCalls).toEqual([]);
  });

  it('an unchanged head (its auto run already exists) is not due and takes no slot', async () => {
    const done = { status: 'completed', startedAt: old };
    const list: FakeWs[] = [
      { id: 'idle-1', lastStartedAt: old, head: sha('1'), runState: done },
      { id: 'idle-2', lastStartedAt: old, head: sha('2'), runState: done },
      { id: 'idle-3', lastStartedAt: old, head: sha('3'), runState: done },
      { id: 'busy', lastStartedAt: old, head: sha('b') },
    ];
    const p = periodicDeps(list);
    const out = await runPeriodicQualityScouts(NOW, { deps: p.deps, schedule: p.schedule, env: {}, maxWorkspaces: 3 });
    expect(out.scheduled).toEqual(['busy']);
    expect(out.unchanged).toBe(3);
    expect(out.due).toBe(1);
  });

  it('a failed or abandoned run on the same head is retried (the run would take it over)', async () => {
    const p = periodicDeps([
      { id: 'failed', lastStartedAt: old, head: sha('f'), runState: { status: 'failed', startedAt: old } },
      { id: 'stale', lastStartedAt: old, head: sha('s'), runState: { status: 'running', startedAt: old } },
      { id: 'live', lastStartedAt: old, head: sha('l'), runState: { status: 'running', startedAt: new Date(NOW.getTime() - 60_000) } },
    ]);
    const out = await runPeriodicQualityScouts(NOW, { deps: p.deps, schedule: p.schedule, env: {} });
    expect(out.scheduled).toEqual(['failed', 'stale']);
    expect(out.unchanged).toBe(1);
  });

  it('a workspace that cannot run (no repo, no head) takes no slot', async () => {
    const p = periodicDeps([
      { id: 'norepo', lastStartedAt: old, head: sha('n'), repo: false },
      { id: 'nohead', lastStartedAt: old, head: null },
      { id: 'ok', lastStartedAt: old, head: sha('o') },
    ]);
    const out = await runPeriodicQualityScouts(NOW, { deps: p.deps, schedule: p.schedule, env: {}, maxWorkspaces: 1 });
    expect(out.scheduled).toEqual(['ok']);
    expect(out.unrunnable).toBe(2);
  });

  it('caps the slots, and passes the checked head to the run so it is not looked up twice', async () => {
    const list: FakeWs[] = ['a', 'b', 'c', 'd'].map(id => ({ id, lastStartedAt: old, head: sha(id) }));
    const p = periodicDeps(list);
    const out = await runPeriodicQualityScouts(NOW, { deps: p.deps, schedule: p.schedule, env: {}, maxWorkspaces: 2 });
    expect(out.scheduled).toEqual(['a', 'b']);
    expect(out.due).toBe(4);
    expect(p.headCalls).toEqual(['a', 'b']);
  });

  it('one workspace throwing is counted and the sweep goes on', async () => {
    const p = periodicDeps([{ id: 'bad', lastStartedAt: old, head: sha('x') }, { id: 'ok', lastStartedAt: old, head: sha('o') }]);
    const orig = p.deps.lastRunStartedAt;
    p.deps.lastRunStartedAt = async (id) => { if (id === 'bad') throw new Error('db blip'); return orig(id); };
    const out = await runPeriodicQualityScouts(NOW, { deps: p.deps, schedule: p.schedule, env: {} });
    expect(out).toMatchObject({ errors: 1, scheduled: ['ok'] });
  });
});

describe('checkManualScoutRateLimit', () => {
  it('allows up to the hourly cap of manual runs, then refuses with a retry hint', async () => {
    const starts = Array.from({ length: MANUAL_SCOUT_RUNS_PER_HOUR - 1 }, (_, i) => new Date(NOW.getTime() - (50 - i) * 60_000));
    expect(await checkManualScoutRateLimit('ws-1', NOW, { recentManualStarts: async () => starts })).toEqual({ allowed: true });

    const full = [new Date(NOW.getTime() - 50 * 60_000), ...starts];
    const r = await checkManualScoutRateLimit('ws-1', NOW, { recentManualStarts: async () => full });
    expect(r.allowed).toBe(false);
    // The oldest counted run leaves the window in 10 minutes.
    expect(r.retryAfterSec).toBe(600);
  });

  it('fails open when the count cannot be read', async () => {
    expect(await checkManualScoutRateLimit('ws-1', NOW, { recentManualStarts: async () => { throw new Error('db'); } })).toEqual({ allowed: true });
  });
});

// ── Runner host ─────────────────────────────────────────────────────────────

describe('gitConfig.qualityScout.host', () => {
  it('defaults to auto; server is the opt-out; nonsense falls back to auto', () => {
    expect(resolveScoutTriggerConfig({ mode: 'shadow' }).host).toBe('auto');
    expect(resolveScoutTriggerConfig({ mode: 'shadow', host: 'server' }).host).toBe('server');
    expect(resolveScoutTriggerConfig({ mode: 'shadow', host: 'cloud' }).host).toBe('auto');
  });

  it('reads the runner bound from budget.runnerMaxDurationMs: default 20 min, capped at 60', () => {
    expect(resolveScoutTriggerConfig({ mode: 'shadow' }).runnerMaxDurationMs).toBe(20 * 60_000);
    expect(resolveScoutTriggerConfig({ mode: 'shadow', budget: { runnerMaxDurationMs: 5 * 60_000 } }).runnerMaxDurationMs).toBe(5 * 60_000);
    expect(resolveScoutTriggerConfig({ mode: 'shadow', budget: { runnerMaxDurationMs: 5 * H } }).runnerMaxDurationMs).toBe(60 * 60_000);
  });

  it('the trigger hands the runner bound to the run', async () => {
    const t = triggerDeps(workspace({ mode: 'shadow', budget: { runnerMaxDurationMs: 7 * 60_000 } }));
    await triggerQualityScout({ workspaceId: 'ws-1', trigger: 'manual' }, t.deps);
    expect(t.runs[0].host).toEqual({ runnerMaxDurationMs: 7 * 60_000 });
  });

  it('host: server builds a single-host run with no runner lookup — today\'s pipeline exactly', () => {
    const req = { workspaceId: 'ws-1', trigger: 'manual', mode: 'shadow', candidate: { ref: 'trunk', sha: SHA } } as ScoutRunRequest;
    expect(buildServerScoutRunDeps(workspace({ mode: 'shadow', host: 'server' }), req).runnerHost).toBeUndefined();
    expect(typeof buildServerScoutRunDeps(workspace({ mode: 'shadow' }), req).runnerHost).toBe('function');
  });
});

describe('scoutRunnerNeeds', () => {
  it('unions the adverts that name the repo, case-insensitively', () => {
    const envs = [
      { scoutHost: { repos: ['Acme/Tool'], command: true } },
      { scoutHost: { repos: ['acme/tool', 'acme/other'], capture: true } },
      { scoutHost: { repos: ['acme/other'], appBoot: true } },
    ];
    expect([...scoutRunnerNeeds(envs, 'acme/tool')].sort()).toEqual(['capture', 'command']);
  });

  it('a malformed advert, or one that says false, counts for nothing', () => {
    const envs = [null, {}, { scoutHost: 'yes' }, { scoutHost: { repos: 'acme/tool', command: true } }, { scoutHost: { repos: ['acme/tool'], command: 'true', capture: false } }];
    expect(scoutRunnerNeeds(envs, 'acme/tool').size).toBe(0);
  });
});

describe('runPeriodicQualityScouts — a parked run', () => {
  it('a head whose run is awaiting a runner counts as exercised, not due', async () => {
    const p = periodicDeps([{ id: 'parked', lastStartedAt: new Date(NOW.getTime() - 48 * H), head: 'p'.repeat(40), runState: { status: 'awaiting_host', startedAt: new Date(NOW.getTime() - 48 * H) } }]);
    const out = await runPeriodicQualityScouts(NOW, { deps: p.deps, schedule: p.schedule, env: {} });
    expect(out.scheduled).toEqual([]);
    expect(out.unchanged).toBe(1);
  });
});

describe('finalizeExpiredQualityScoutRuns', () => {
  const parkedRun = (id: string): ScoutRun => ({
    id, workspaceId: 'ws-1', missionId: null, trigger: 'periodic', mode: 'shadow', status: 'awaiting_host',
    candidate: { ref: 'trunk', sha: SHA }, prior: null, budget: { maxProbes: 4, maxCostUsd: null }, policyVersion: 'scout-v1',
    startedAt: new Date(NOW.getTime() - 2 * H).toISOString(), completedAt: null, error: null,
    parking: {
      parkedAt: new Date(NOW.getTime() - 2 * H).toISOString(),
      hostDeadline: new Date(NOW.getTime() - H).toISOString(),
      runnerMaxDurationMs: 20 * 60_000,
      profile: { capabilities: [] } as unknown as NonNullable<ScoutRun['parking']>['profile'],
      plan: {
        candidatesGenerated: 1, candidatesTruncated: 0, decisionsAsked: 0, decisionFailures: 0, costCapHit: false,
        stages: Object.fromEntries(['profile', 'signals', 'generate', 'select', 'execute', 'act'].map((s) => [s, { ms: 0, costUsd: null }])) as NonNullable<ScoutRun['parking']>['plan']['stages'],
        warnings: [], deadlineHit: false, reproducibility: {},
      },
      lease: null,
      leaseLapses: 0,
    },
  });
  const runnerProbe: ScoutProbeRecord = {
    candidateId: 'cmd', family: 'contract', probeKind: 'regression', title: 't', invariant: 'i', sourceSignals: [], preconditions: [],
    executor: 'verification-command', estimatedCost: 'low', risk: 'medium', mutates: false, evidenceRequirements: [], unsupportedReason: null,
    selection: { status: 'selected', via: 'decision', reasonCode: 'x', decisionSource: null }, host: 'runner', result: null,
  };

  function sweepDeps(runs: ScoutRun[], takeable: Set<string>) {
    const saved = new Map<string, { run: ScoutRun; metrics?: ScoutRunMetrics }>();
    const probes = new Map<string, ScoutProbeRecord[]>();
    const ledger = {
      latestRun: async () => null,
      claimRun: async () => 'claimed' as const,
      async saveRun(run: ScoutRun, _t?: unknown, metrics?: ScoutRunMetrics) { saved.set(run.id, { run, metrics }); },
      async saveProbes(run: ScoutRun, ps: readonly ScoutProbeRecord[]) { probes.set(run.id, [...ps]); },
      findings: { find: async () => null, insert: async () => true, update: async () => true },
      resolveForPass: async () => [],
    };
    const deps: ExpiredScoutDeps = {
      now: () => NOW,
      listExpired: async () => runs,
      take: async (id) => takeable.delete(id),
      loadProbes: async () => [runnerProbe],
      loadWorkspace: async () => workspace({ mode: 'shadow' }),
      finalizeDeps: () => ({ now: () => NOW, ledger, actions: {} as ScoutRunDeps['actions'], headSha: async () => SHA }),
    };
    return { deps, saved, probes };
  }

  it('finalizes an expired parked run: its runner probes end unsupported no_runner_claimed, never pass', async () => {
    const s = sweepDeps([parkedRun('r1')], new Set(['r1']));
    const out = await finalizeExpiredQualityScoutRuns({ deps: s.deps });
    expect(out).toEqual({ expired: 1, finalized: ['r1'], raced: 0, errors: 0 });
    expect(s.saved.get('r1')!.run.status).toBe('completed');
    const [p] = s.probes.get('r1')!;
    expect(p.result?.verdict).toBe('unsupported');
    expect(p.result?.reason).toBe('no_runner_claimed');
    expect(s.saved.get('r1')!.metrics!.verdicts.pass).toBe(0);
  });

  it('hands the caller\'s team and workspaces to the expired-run query', async () => {
    const s = sweepDeps([], new Set());
    const seen: unknown[] = [];
    s.deps.listExpired = async (_now, _limit, scope) => { seen.push(scope); return []; };
    await finalizeExpiredQualityScoutRuns({ deps: s.deps, teamId: 'team-a', workspaceIds: ['ws-1'] });
    await finalizeExpiredQualityScoutRuns({ deps: s.deps });
    expect(seen).toEqual([{ teamId: 'team-a', workspaceIds: ['ws-1'] }, {}]);
  });

  it('a run someone else already took is counted as raced and not finalized twice', async () => {
    const s = sweepDeps([parkedRun('r1')], new Set());
    const out = await finalizeExpiredQualityScoutRuns({ deps: s.deps });
    expect(out).toMatchObject({ expired: 1, finalized: [], raced: 1 });
    expect(s.saved.size).toBe(0);
  });

  it('one run throwing is counted and the sweep goes on', async () => {
    const s = sweepDeps([parkedRun('bad'), parkedRun('ok')], new Set(['bad', 'ok']));
    const loadProbes = s.deps.loadProbes;
    s.deps.loadProbes = async (id) => { if (id === 'bad') throw new Error('db'); return loadProbes(id); };
    const out = await finalizeExpiredQualityScoutRuns({ deps: s.deps });
    expect(out).toMatchObject({ expired: 2, finalized: ['ok'], errors: 1 });
  });
});
