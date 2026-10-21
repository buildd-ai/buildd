import { describe, expect, it } from 'bun:test';
import {
  decideTaskIsolation,
  isIsolationRefusalError,
  isolationRefusalError,
  readTaskIsolationStamp,
  reducedIsolationOptedIn,
  resolveIsolationRequirement,
  taskCodexSandboxMode,
  taskIsolationRequirement,
  type RunnerIsolationRecord,
} from '@buildd/shared';

const none = (reason: string) => ({ mechanism: 'none', scope: [], reason }) as never;
const bwrap = { mechanism: 'bwrap', scope: ['write', 'network', 'env'] } as never;
const seatbelt = { mechanism: 'seatbelt', scope: ['write', 'network'] } as never;

function record(over: Partial<RunnerIsolationRecord> = {}): RunnerIsolationRecord {
  return {
    platform: 'linux',
    evidence: ['process.platform=linux'],
    claude: none('userns_sysctl_denied'),
    codex: { 'read-only': none('userns_sysctl_denied'), 'workspace-write': none('userns_sysctl_denied') },
    probeAt: '2026-10-17T00:00:01.000Z',
    processStartedAt: '2026-10-17T00:00:00.000Z',
    runnerVersion: '1.0.0',
    ...over,
  };
}

describe('resolveIsolationRequirement (R-4)', () => {
  it('takes the workspace policy when set', () => {
    expect(resolveIsolationRequirement({ workspacePolicy: 'trusted_local', teamMemberCount: 5 }))
      .toEqual({ requirement: 'trusted_local', source: 'workspace' });
    expect(resolveIsolationRequirement({ workspacePolicy: 'protected', teamMemberCount: 1 }))
      .toEqual({ requirement: 'protected', source: 'workspace' });
  });

  it('defaults a single-owner team to trusted_local', () => {
    expect(resolveIsolationRequirement({ teamMemberCount: 1 }))
      .toEqual({ requirement: 'trusted_local', source: 'single_owner_team' });
  });

  it('is protected for a shared team, an open workspace, an unreadable team or a bad value', () => {
    expect(resolveIsolationRequirement({ teamMemberCount: 2 }).requirement).toBe('protected');
    expect(resolveIsolationRequirement({ teamMemberCount: 1, workspaceAccessMode: 'open' }).requirement).toBe('protected');
    expect(resolveIsolationRequirement({ teamMemberCount: null }).requirement).toBe('protected');
    expect(resolveIsolationRequirement({ workspacePolicy: 'yolo', teamMemberCount: 3 }).requirement).toBe('protected');
  });
});

describe('decideTaskIsolation', () => {
  it('AC-3: refuses a protected task where its backend is not confined, with cause and steps', () => {
    const d = decideTaskIsolation({ requirement: 'protected', record: record(), backend: 'claude', codexMode: 'workspace-write' });
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe('confinement_not_enforced');
    expect(d.reason).toBe('userns_sysctl_denied');
    expect(d.message).toContain('unprivileged user namespaces');
    expect(d.remedy.join(' ')).toContain('sysctl');
  });

  it('AC-3: gives a protected task to a runner that confines its backend', () => {
    const d = decideTaskIsolation({ requirement: 'protected', record: record({ claude: bwrap }), backend: 'claude', codexMode: 'workspace-write' });
    expect(d).toMatchObject({ ok: true, mode: 'enforced' });
  });

  it('checks Codex per mode', () => {
    const rec = record({ codex: { 'read-only': seatbelt, 'workspace-write': none('backend_probe_failed') }, platform: 'darwin' });
    expect(decideTaskIsolation({ requirement: 'protected', record: rec, backend: 'codex', codexMode: 'read-only' }).ok).toBe(true);
    expect(decideTaskIsolation({ requirement: 'protected', record: rec, backend: 'codex', codexMode: 'workspace-write' }).ok).toBe(false);
  });

  it('R-11: a missing or stale probe is unknown, for both requirements', () => {
    const stale = record({ claude: bwrap, reducedOptIn: true, probeAt: '2026-10-16T23:00:00.000Z' });
    for (const requirement of ['protected', 'trusted_local'] as const) {
      for (const rec of [null, stale]) {
        expect(decideTaskIsolation({ requirement, record: rec, backend: 'claude', codexMode: 'workspace-write' }))
          .toMatchObject({ ok: false, code: 'probe_unknown' });
      }
    }
  });

  it('AC-4: trusted_local runs reduced only with the operator opt-in', () => {
    expect(decideTaskIsolation({ requirement: 'trusted_local', record: record(), backend: 'codex', codexMode: 'workspace-write' }))
      .toMatchObject({ ok: false, code: 'reduced_not_opted_in' });
    expect(decideTaskIsolation({ requirement: 'trusted_local', record: record({ reducedOptIn: true }), backend: 'codex', codexMode: 'workspace-write' }))
      .toMatchObject({ ok: true, mode: 'reduced' });
  });

  it('AC-5: a protected task never runs reduced, even with the opt-in set', () => {
    for (const codexMode of ['read-only', 'workspace-write'] as const) {
      const d = decideTaskIsolation({ requirement: 'protected', record: record({ reducedOptIn: true }), backend: 'codex', codexMode });
      expect(d.ok).toBe(false);
    }
  });
});

describe('opt-in and stamp helpers', () => {
  it('reads the operator opt-in from env; the sandbox opt-out counts', () => {
    expect(reducedIsolationOptedIn({})).toBe(false);
    expect(reducedIsolationOptedIn({ BUILDD_ALLOW_REDUCED_ISOLATION: '1' })).toBe(true);
    expect(reducedIsolationOptedIn({ BUILDD_DISABLE_SANDBOX: '1' })).toBe(true);
    expect(reducedIsolationOptedIn({ BUILDD_ALLOW_REDUCED_ISOLATION: 'true' })).toBe(false);
  });

  it('holds an unstamped task to protected', () => {
    expect(taskIsolationRequirement(null)).toBe('protected');
    expect(taskIsolationRequirement({ isolation: { requirement: 'nope' } })).toBe('protected');
    expect(taskIsolationRequirement({ isolation: { requirement: 'trusted_local', source: 'workspace', mode: 'reduced' } })).toBe('trusted_local');
    expect(readTaskIsolationStamp({ isolation: { requirement: 'trusted_local', mode: 'x' } }))
      .toEqual({ requirement: 'trusted_local', source: 'default', mode: 'enforced' });
  });

  it('resolves the Codex mode from the task, else its kind', () => {
    expect(taskCodexSandboxMode('engineering', { sandboxMode: 'read-only' })).toBe('read-only');
    expect(taskCodexSandboxMode('research', null)).toBe('read-only');
    expect(taskCodexSandboxMode('engineering', { sandboxMode: 'danger-full-access' })).toBe('workspace-write');
  });
});

describe('preflight refusal of a task (smoke-test dispatch regression)', () => {
  const sandboxOff = record({ reducedOptIn: true });
  const decide = (requirement: 'protected' | 'trusted_local', rec: RunnerIsolationRecord) =>
    decideTaskIsolation({ requirement, record: rec, backend: 'claude', codexMode: 'workspace-write' });

  it('ineligible runner: a protected task on a sandbox-off runner is refused, and the stored error reads as a preflight block', () => {
    const d = decide('protected', sandboxOff);
    expect(d.ok).toBe(false);
    if (d.ok) return;
    const error = isolationRefusalError(d);
    expect(error.startsWith('Not started: ')).toBe(true);
    expect(isIsolationRefusalError(error)).toBe(true);
  });

  it('eligible runner: a trusted_local task on an opted-in sandbox-off runner runs reduced', () => {
    const d = decide('trusted_local', sandboxOff);
    expect(d).toMatchObject({ ok: true, mode: 'reduced' });
  });

  it('correctly blocked: trusted_local without the operator opt-in is refused and also reads as a preflight block', () => {
    const d = decide('trusted_local', record());
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(isIsolationRefusalError(isolationRefusalError(d))).toBe(true);
  });

  it('does not mistake an agent failure for a refusal', () => {
    expect(isIsolationRefusalError('Not started: worktree setup failed')).toBe(false);
    expect(isIsolationRefusalError('Error: tests failed')).toBe(false);
    expect(isIsolationRefusalError(null)).toBe(false);
  });
});

describe('a writes-only sandbox (Codex on Windows, network open)', () => {
  const winToken = { mechanism: 'windows_restricted_token', scope: ['write'] } as never;
  const windows = (over: Partial<RunnerIsolationRecord> = {}) => record({
    platform: 'windows',
    evidence: ['process.platform=win32'],
    claude: none('unsupported_platform'),
    codex: { 'read-only': winToken, 'workspace-write': winToken },
    ...over,
  });
  const decide = (requirement: 'protected' | 'trusted_local', rec: RunnerIsolationRecord) =>
    decideTaskIsolation({ requirement, record: rec, backend: 'codex', codexMode: 'workspace-write' });

  it('refuses a protected task: its network is not confined, and the refusal says so', () => {
    const d = decide('protected', windows());
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe('confinement_partial');
    expect(d.message).toContain('network');
    expect(d.remedy.join(' ')).toContain('WSL2');
    expect(isIsolationRefusalError(isolationRefusalError(d))).toBe(true);
  });

  it('runs a trusted_local task confined, with no operator opt-in needed', () => {
    expect(decide('trusted_local', windows())).toMatchObject({ ok: true, mode: 'enforced', confinement: { mechanism: 'windows_restricted_token' } });
  });

  it('does not change hosts whose sandbox covers writes and network', () => {
    const linux = record({ claude: bwrap, codex: { 'read-only': bwrap, 'workspace-write': bwrap } });
    expect(decide('protected', linux)).toMatchObject({ ok: true, mode: 'enforced' });
    const mac = record({ platform: 'darwin', claude: seatbelt, codex: { 'read-only': seatbelt, 'workspace-write': seatbelt } });
    expect(decide('protected', mac)).toMatchObject({ ok: true, mode: 'enforced' });
  });

  it('Claude on Windows: no sandbox, and the cause names Windows', () => {
    const d = decideTaskIsolation({ requirement: 'protected', record: windows(), backend: 'claude', codexMode: 'workspace-write' });
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.message).toContain('Windows');
    expect(d.remedy.join(' ')).toContain('WSL2');
  });
});
