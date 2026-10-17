import { describe, it, expect } from 'bun:test';

import type { BackendConfinement, RunnerIsolationRecord } from '@buildd/shared';
import { deriveSandboxPosture, mountAllowlistEnforcedFrom } from './runner-heartbeats-shared';

/**
 * What the Health page says about a runner's sandbox must be what is ENFORCED.
 *
 * `sandboxEnabled` on the heartbeat is the kernel-capability probe
 * (isBwrapSupported) — it says bwrap works here, not that anything is confined.
 * The mount allowlist is opt-in (BUILDD_SANDBOX_MOUNT_ALLOWLIST) and set by no
 * Dockerfile, install script, workflow or compose file, so the worst case is a
 * host WITH bwrap installed: the page rendered a green "sandboxed" while the
 * mount allowlist was off.
 */

describe('deriveSandboxPosture', () => {
  it('is only green when the mount allowlist is actually enforced', () => {
    const posture = deriveSandboxPosture({ sandboxEnabled: true, mountAllowlistEnforced: true });
    expect(posture.tier).toBe('success');
    expect(posture.label).toBe('sandboxed');
  });

  it('is NOT green when bwrap works but nothing is enforced', () => {
    const posture = deriveSandboxPosture({ sandboxEnabled: true, mountAllowlistEnforced: false });
    expect(posture.tier).not.toBe('success');
    expect(posture.label).not.toBe('sandboxed');
    expect(posture.detail).toMatch(/allowlist/i);
  });

  it('reports an unsandboxed runner as a warning', () => {
    const posture = deriveSandboxPosture({ sandboxEnabled: false, mountAllowlistEnforced: false });
    expect(posture.tier).toBe('warning');
    expect(posture.label).toBe('unsandboxed');
  });

  it('does not invent a cause for an older runner that sends only the boolean', () => {
    // The boolean was false for four causes; "user namespaces denied" was right for one.
    const posture = deriveSandboxPosture({ sandboxEnabled: false, mountAllowlistEnforced: false, isolation: null });
    expect(posture.detail).not.toMatch(/namespaces denied/i);
    expect(posture.detail).toMatch(/does not report why/);
  });

  it('reports an unprobed runner as unknown, not as either extreme', () => {
    const posture = deriveSandboxPosture({ sandboxEnabled: null, mountAllowlistEnforced: false });
    expect(posture.tier).toBe('unknown');
    expect(posture.label).toBe('sandbox unknown');
  });

  it('never claims enforcement on a runner whose namespace probe failed', () => {
    // A capability can only be advertised by a runner that passed its own probe,
    // but the page must not depend on that invariant holding upstream.
    const posture = deriveSandboxPosture({ sandboxEnabled: false, mountAllowlistEnforced: true });
    expect(posture.tier).not.toBe('success');
  });
});

describe('mountAllowlistEnforcedFrom', () => {
  it('reads the sandbox:mount-allowlist capability the runner already reports', () => {
    expect(mountAllowlistEnforcedFrom({ envKeys: ['backend:codex', 'sandbox:mount-allowlist'] })).toBe(true);
  });

  it('is false when the capability is absent', () => {
    expect(mountAllowlistEnforcedFrom({ envKeys: ['backend:codex'] })).toBe(false);
  });

  it('is false when the runner reported no environment at all', () => {
    expect(mountAllowlistEnforcedFrom(null)).toBe(false);
    expect(mountAllowlistEnforcedFrom(undefined)).toBe(false);
    expect(mountAllowlistEnforcedFrom({})).toBe(false);
  });
});

/** Living Spec "Runner isolation": AC-1, AC-2, AC-9. */
describe('deriveSandboxPosture from the isolation record', () => {
  const T0 = '2026-10-17T00:00:00.000Z';
  const T1 = '2026-10-17T00:00:05.000Z';
  const none = (reason: BackendConfinement['reason']): BackendConfinement => ({ mechanism: 'none', scope: [], reason });

  function record(platform: RunnerIsolationRecord['platform'], claude: BackendConfinement, over: Partial<RunnerIsolationRecord> = {}): RunnerIsolationRecord {
    return {
      platform,
      evidence: [],
      claude,
      codex: { 'read-only': claude, 'workspace-write': claude },
      probeAt: T1,
      processStartedAt: T0,
      runnerVersion: '0.0.0-test',
      ...over,
    };
  }

  it('macOS on Seatbelt is confined, never "user namespaces denied" (AC-1)', () => {
    const posture = deriveSandboxPosture({
      sandboxEnabled: true,
      mountAllowlistEnforced: false,
      isolation: record('darwin', { mechanism: 'seatbelt', scope: ['write', 'network', 'env'] }),
    });
    expect(posture.tier).toBe('success');
    expect(posture.label).toBe('Seatbelt');
    expect(posture.detail).not.toMatch(/namespace/i);
  });

  it('macOS whose Seatbelt probe failed names Seatbelt, not namespaces (AC-1)', () => {
    const posture = deriveSandboxPosture({
      sandboxEnabled: false,
      mountAllowlistEnforced: false,
      isolation: record('darwin', none('backend_probe_failed')),
    });
    expect(posture.tier).toBe('warning');
    expect(posture.detail).toMatch(/Seatbelt/);
    expect(posture.detail).not.toMatch(/namespaces denied/i);
  });

  it('names each Linux cause (AC-2)', () => {
    const detail = (reason: BackendConfinement['reason'], platform: RunnerIsolationRecord['platform'] = 'linux') =>
      deriveSandboxPosture({ sandboxEnabled: false, mountAllowlistEnforced: false, isolation: record(platform, none(reason)) }).detail;
    expect(detail('userns_sysctl_denied')).toMatch(/unprivileged_userns_clone=0/);
    expect(detail('bwrap_missing')).toMatch(/bubblewrap is not installed/);
    expect(detail('bwrap_missing', 'linux-wsl')).toMatch(/WSL/);
    expect(detail('probe_exec_failed', 'linux-container')).toMatch(/container/);
    expect(detail('opt_out')).toMatch(/operator/);
  });

  it('labels the operator opt-out as disabled, not as a failure', () => {
    const posture = deriveSandboxPosture({ sandboxEnabled: false, mountAllowlistEnforced: false, isolation: record('linux', none('opt_out')) });
    expect(posture.label).toBe('sandbox disabled');
  });

  it('Linux bwrap still needs the mount allowlist to be green', () => {
    const bwrap = record('linux', { mechanism: 'bwrap', scope: ['write', 'network', 'env'] });
    expect(deriveSandboxPosture({ sandboxEnabled: true, mountAllowlistEnforced: false, isolation: bwrap }).tier).toBe('warning');
    expect(deriveSandboxPosture({ sandboxEnabled: true, mountAllowlistEnforced: true, isolation: bwrap }).tier).toBe('success');
  });

  it('a probe older than the runner process reads unknown, neither green nor denied (AC-9)', () => {
    for (const claude of [none('userns_sysctl_denied'), { mechanism: 'bwrap' as const, scope: [] }]) {
      const posture = deriveSandboxPosture({
        sandboxEnabled: true,
        mountAllowlistEnforced: true,
        isolation: record('linux', claude, { probeAt: T0, processStartedAt: T1 }),
      });
      expect(posture.tier).toBe('unknown');
    }
  });
});
