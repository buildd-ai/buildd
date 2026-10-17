import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

/**
 * The runner's isolation record (Living Spec "Runner isolation": R-1, R-2, R-6;
 * AC-1, AC-2, AC-5, AC-6).
 *
 * The bwrap probe's single boolean was false for four causes, and the runner
 * read every false as "no confinement" on every platform — including macOS,
 * where `which bwrap` always fails and both CLIs confine with Seatbelt.
 */

const mockExecSync = mock((_cmd: string) => Buffer.from(''));
mock.module('child_process', () => ({ execSync: mockExecSync }));

const mockReadFileSync = mock((_path: string) => '');
const mockExistsSync = mock((_path: string) => false);
mock.module('fs', () => ({ readFileSync: mockReadFileSync, existsSync: mockExistsSync }));

import {
  probeBwrapNamespacesDetailed,
  CLAUDE_INNER_SANDBOX_UNSHARE,
  detectHostPlatform,
  buildIsolationRecord,
  claudeSessionSandbox,
  type HostProbeDeps,
  type IsolationProbeInputs,
} from '../../src/isolation-probe';
import { isIsolationRecordCurrent } from '@buildd/shared';

const T0 = '2026-10-17T00:00:00.000Z';
const T1 = '2026-10-17T00:00:05.000Z';

function inputs(over: Partial<IsolationProbeInputs>): IsolationProbeInputs {
  return {
    host: { platform: 'linux', evidence: ['process.platform=linux'] },
    optOut: false,
    bwrap: { ok: true },
    seatbelt: null,
    probeAt: T1,
    processStartedAt: T0,
    runnerVersion: '0.0.0-test',
    ...over,
  };
}

function hostDeps(over: Partial<HostProbeDeps> & { files?: Record<string, string> }): HostProbeDeps {
  const files = over.files ?? {};
  return {
    platform: 'linux',
    env: {},
    exists: (p) => p in files,
    read: (p) => files[p] ?? null,
    ...over,
  };
}

describe('probeBwrapNamespacesDetailed — the cause, not just false (AC-2)', () => {
  const realPlatform = process.platform;
  let originalDisable: string | undefined;

  beforeEach(() => {
    originalDisable = process.env.BUILDD_DISABLE_SANDBOX;
    delete process.env.BUILDD_DISABLE_SANDBOX;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    mockExecSync.mockReset();
    mockReadFileSync.mockReset();
    mockExecSync.mockImplementation(() => Buffer.from('ok\n'));
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
    if (originalDisable === undefined) delete process.env.BUILDD_DISABLE_SANDBOX;
    else process.env.BUILDD_DISABLE_SANDBOX = originalDisable;
  });

  it('passes when bwrap creates the namespaces', () => {
    expect(probeBwrapNamespacesDetailed(CLAUDE_INNER_SANDBOX_UNSHARE, true)).toEqual({ ok: true });
  });

  it('opt_out with BUILDD_DISABLE_SANDBOX=1, before running anything', () => {
    process.env.BUILDD_DISABLE_SANDBOX = '1';
    expect(probeBwrapNamespacesDetailed(CLAUDE_INNER_SANDBOX_UNSHARE, true)).toEqual({ ok: false, reason: 'opt_out' });
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('userns_sysctl_denied with unprivileged_userns_clone=0', () => {
    mockReadFileSync.mockImplementation(() => '0\n');
    expect(probeBwrapNamespacesDetailed(CLAUDE_INNER_SANDBOX_UNSHARE, true)).toEqual({ ok: false, reason: 'userns_sysctl_denied' });
  });

  it('bwrap_missing when bwrap is not on PATH', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'which bwrap') throw new Error('not found');
      return Buffer.from('ok\n');
    });
    expect(probeBwrapNamespacesDetailed(CLAUDE_INNER_SANDBOX_UNSHARE, true)).toEqual({ ok: false, reason: 'bwrap_missing' });
  });

  it('probe_exec_failed when bwrap is installed but the exec is blocked', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'which bwrap') return Buffer.from('/usr/bin/bwrap\n');
      throw new Error('bwrap: No permissions to create a new namespace');
    });
    expect(probeBwrapNamespacesDetailed(CLAUDE_INNER_SANDBOX_UNSHARE, true)).toEqual({ ok: false, reason: 'probe_exec_failed' });
  });
});

describe('detectHostPlatform (R-1)', () => {
  it('darwin, with no Linux probes', () => {
    const read = mock((_p: string) => null);
    const exists = mock((_p: string) => false);
    expect(detectHostPlatform(hostDeps({ platform: 'darwin', read, exists })).platform).toBe('darwin');
    expect(read).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
  });

  it('plain Linux', () => {
    expect(detectHostPlatform(hostDeps({ files: { '/proc/version': 'Linux version 6.8.0-generic' } }))).toEqual({
      platform: 'linux',
      evidence: ['process.platform=linux'],
    });
  });

  it('WSL from /proc/version or WSL_DISTRO_NAME', () => {
    expect(detectHostPlatform(hostDeps({ files: { '/proc/version': 'Linux version 5.15.153.1-microsoft-standard-WSL2' } })).platform).toBe('linux-wsl');
    expect(detectHostPlatform(hostDeps({ env: { WSL_DISTRO_NAME: 'Ubuntu' } })).platform).toBe('linux-wsl');
  });

  it('a container from /.dockerenv or the init cgroup', () => {
    const docker = detectHostPlatform(hostDeps({ files: { '/.dockerenv': '' } }));
    expect(docker.platform).toBe('linux-container');
    expect(docker.evidence).toContain('/.dockerenv');
    expect(detectHostPlatform(hostDeps({ files: { '/proc/1/cgroup': '0::/kubepods/besteffort/pod1' } })).platform).toBe('linux-container');
  });

  it('anything else is other', () => {
    expect(detectHostPlatform(hostDeps({ platform: 'win32' })).platform).toBe('other');
  });
});

describe('buildIsolationRecord (R-2, R-6)', () => {
  it('darwin with Seatbelt: both backends confined, whatever bwrap says (AC-1, AC-5)', () => {
    const rec = buildIsolationRecord(inputs({
      host: { platform: 'darwin', evidence: ['process.platform=darwin'] },
      bwrap: { ok: false, reason: 'bwrap_missing' },
      seatbelt: true,
    }));
    expect(rec.claude.mechanism).toBe('seatbelt');
    expect(rec.codex['read-only'].mechanism).toBe('seatbelt');
    expect(rec.codex['workspace-write'].mechanism).toBe('seatbelt');
  });

  it('darwin never reports a Linux cause (AC-1)', () => {
    for (const bwrap of [{ ok: false as const, reason: 'userns_sysctl_denied' as const }, { ok: false as const, reason: 'bwrap_missing' as const }, null]) {
      const rec = buildIsolationRecord(inputs({ host: { platform: 'darwin', evidence: [] }, bwrap, seatbelt: false }));
      expect(rec.claude).toEqual({ mechanism: 'none', scope: [], reason: 'backend_probe_failed' });
      expect(rec.codex['workspace-write'].reason).toBe('backend_probe_failed');
    }
  });

  it('Linux keeps the bwrap cause per backend and mode (AC-2)', () => {
    for (const reason of ['userns_sysctl_denied', 'bwrap_missing', 'probe_exec_failed'] as const) {
      const rec = buildIsolationRecord(inputs({ bwrap: { ok: false, reason } }));
      expect(rec.claude.reason).toBe(reason);
      expect(rec.codex['read-only'].reason).toBe(reason);
      expect(rec.codex['workspace-write'].reason).toBe(reason);
    }
  });

  it('Linux with a passing probe confines both backends with bwrap', () => {
    const rec = buildIsolationRecord(inputs({ host: { platform: 'linux-container', evidence: [] } }));
    expect(rec.claude.mechanism).toBe('bwrap');
    expect(rec.codex['workspace-write'].mechanism).toBe('bwrap');
    expect(rec.platform).toBe('linux-container');
  });

  it('the operator opt-out wins on every platform (AC-2)', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const rec = buildIsolationRecord(inputs({ host: { platform, evidence: [] }, optOut: true, seatbelt: true }));
      expect(rec.claude.reason).toBe('opt_out');
      expect(rec.codex['read-only'].reason).toBe('opt_out');
    }
  });

  it('an unsupported platform says so', () => {
    const rec = buildIsolationRecord(inputs({ host: { platform: 'other', evidence: [] }, bwrap: null }));
    expect(rec.claude.reason).toBe('unsupported_platform');
  });

  it('carries the probe time, the process start and the runner version (R-2, R-11)', () => {
    const rec = buildIsolationRecord(inputs({}));
    expect(rec.probeAt).toBe(T1);
    expect(rec.processStartedAt).toBe(T0);
    expect(rec.runnerVersion).toBe('0.0.0-test');
    expect(isIsolationRecordCurrent(rec)).toBe(true);
  });
});

describe('isIsolationRecordCurrent (R-11, AC-9)', () => {
  it('a probe older than the process is not current', () => {
    expect(isIsolationRecordCurrent(buildIsolationRecord(inputs({ probeAt: T0, processStartedAt: T1 })))).toBe(false);
  });

  it('an absent record is not current', () => {
    expect(isIsolationRecordCurrent(null)).toBe(false);
    expect(isIsolationRecordCurrent(undefined)).toBe(false);
  });
});

describe('claudeSessionSandbox (R-6, AC-6)', () => {
  const configured = { enabled: true, allowUnsandboxedCommands: false };

  it('on darwin keeps the workspace sandbox and the env scrub as configured', () => {
    const rec = buildIsolationRecord(inputs({
      host: { platform: 'darwin', evidence: [] },
      bwrap: { ok: false, reason: 'bwrap_missing' },
      seatbelt: true,
    }));
    expect(claudeSessionSandbox(rec.claude, configured)).toEqual({ sandbox: configured, disableEnvScrub: false });
    expect(claudeSessionSandbox(rec.claude, undefined)).toEqual({ sandbox: undefined, disableEnvScrub: false });
  });

  it('a workspace that did not opt in passes no sandbox option', () => {
    const rec = buildIsolationRecord(inputs({}));
    expect(claudeSessionSandbox(rec.claude, { enabled: false })).toEqual({ sandbox: undefined, disableEnvScrub: false });
  });

  it('forces the sandbox and the scrub off only where Claude has no confinement', () => {
    const rec = buildIsolationRecord(inputs({ bwrap: { ok: false, reason: 'userns_sysctl_denied' } }));
    expect(claudeSessionSandbox(rec.claude, configured)).toEqual({ sandbox: { enabled: false }, disableEnvScrub: true });
  });
});
