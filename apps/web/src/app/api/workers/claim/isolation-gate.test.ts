import { describe, expect, it, mock } from 'bun:test';
import { decideClaimIsolation, teamSizeLoader } from './isolation-gate';

const none = { mechanism: 'none', scope: [], reason: 'bwrap_missing' };
const bwrap = { mechanism: 'bwrap', scope: ['write', 'network', 'env'] };
const isolation = (over: Record<string, unknown> = {}) => ({
  platform: 'linux',
  evidence: [],
  claude: none,
  codex: { 'read-only': bwrap, 'workspace-write': none },
  probeAt: '2026-10-17T00:00:01.000Z',
  processStartedAt: '2026-10-17T00:00:00.000Z',
  runnerVersion: '1.0.0',
  ...over,
});
const workspace = (over: Record<string, unknown> = {}) => ({ teamId: 'team-1', accessMode: 'restricted', gitConfig: {}, ...over });

describe('decideClaimIsolation', () => {
  it('holds a protected task on a runner with no confinement for its backend (AC-3)', async () => {
    const { decision, stamp } = await decideClaimIsolation({
      task: { kind: 'engineering', backend: 'claude', workspace: workspace() },
      environment: { isolation: isolation() },
      teamSize: async () => 4,
    });
    expect(decision).toMatchObject({ ok: false, code: 'confinement_not_enforced', requirement: 'protected' });
    expect(stamp).toBeNull();
  });

  it('reads the Codex mode from the task kind', async () => {
    const res = await decideClaimIsolation({
      task: { kind: 'research', backend: 'codex', workspace: workspace() },
      environment: { isolation: isolation() },
      teamSize: async () => 4,
    });
    expect(res.stamp).toEqual({ requirement: 'protected', source: 'default', mode: 'enforced' });
  });

  it('runs a single-owner team trusted_local reduced only on an opted-in runner (AC-4)', async () => {
    const task = { kind: 'engineering', backend: 'claude', workspace: workspace() };
    const without = await decideClaimIsolation({ task, environment: { isolation: isolation() }, teamSize: async () => 1 });
    expect(without.decision).toMatchObject({ ok: false, code: 'reduced_not_opted_in', requirement: 'trusted_local' });
    const withOptIn = await decideClaimIsolation({ task, environment: { isolation: isolation({ reducedOptIn: true }) }, teamSize: async () => 1 });
    expect(withOptIn.stamp).toEqual({ requirement: 'trusted_local', source: 'single_owner_team', mode: 'reduced' });
  });

  it('takes the workspace policy over the team default, and never reads the team when it is set', async () => {
    const teamSize = mock(async () => 1);
    const res = await decideClaimIsolation({
      task: { kind: 'engineering', backend: 'claude', workspace: workspace({ gitConfig: { isolationPolicy: 'protected' } }) },
      environment: { isolation: isolation({ reducedOptIn: true }) },
      teamSize,
    });
    expect(res.decision).toMatchObject({ ok: false, code: 'confinement_not_enforced' });
    expect(teamSize).not.toHaveBeenCalled();
  });

  it('holds every task on a runner that sends no probe (R-11)', async () => {
    const res = await decideClaimIsolation({
      task: { kind: 'engineering', backend: 'claude', workspace: workspace() },
      environment: { tools: [] },
      teamSize: async () => 1,
    });
    expect(res.decision).toMatchObject({ ok: false, code: 'probe_unknown' });
  });
});

describe('teamSizeLoader', () => {
  it('reads each team once and turns a failed read into null', async () => {
    const read = mock(async (id: string) => { if (id === 'bad') throw new Error('down'); return 2; });
    const load = teamSizeLoader(read);
    expect(await load('t')).toBe(2);
    expect(await load('t')).toBe(2);
    expect(await load('bad')).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
