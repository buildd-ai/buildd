import { describe, it, expect } from 'bun:test';

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
