import { describe, it, expect, beforeEach, mock } from 'bun:test';

/**
 * The bwrap capability probe, and the capability the runner advertises from it.
 *
 * Two consumers with two different requirements share this file:
 *
 *  - Claude Code's INNER sandbox unshares user + pid + net, so its probe must
 *    exercise all three (checkBwrapSupport).
 *  - The OUTER mount-allowlist wrapper (buildWorkerBwrapArgv) deliberately does
 *    not unshare net — the agent needs egress — so it only needs user + pid
 *    (checkBwrapMountIsolationSupport).
 *
 * One boolean carrying the strictest requirement reported the sandbox
 * unavailable on hosts where the mount allowlist would have worked.
 *
 * NOTE: apps/runner/src/env-scan.test.ts covers the same module but is NOT
 * collected by scripts/run-unit-tests.ts (UNIT_TEST_ROOTS omits
 * apps/runner/src/), so probe behaviour that must be enforced lives here.
 */

const mockExecSync = mock((_cmd: string) => Buffer.from(''));
mock.module('child_process', () => ({ execSync: mockExecSync }));

const mockReadFileSync = mock((_path: string) => '');
const mockExistsSync = mock((_path: string) => false);
mock.module('fs', () => ({ readFileSync: mockReadFileSync, existsSync: mockExistsSync }));

import {
  checkBwrapSupport,
  checkBwrapMountIsolationSupport,
  scanEnvironment,
} from '../../src/env-scan';

/** Host that refuses a network namespace but permits user + pid. */
function netNamespaceRefused() {
  mockExecSync.mockImplementation((cmd: string) => {
    if (cmd === 'which bwrap') return Buffer.from('/usr/bin/bwrap\n');
    if (typeof cmd === 'string' && cmd.includes('--unshare-net')) {
      throw new Error('bwrap: Creating new namespace failed: Operation not permitted');
    }
    return Buffer.from('ok\n');
  });
}

describe('checkBwrapMountIsolationSupport', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockExecSync.mockImplementation(() => Buffer.from('ok\n'));
  });

  it('probes only the namespaces the outer wrapper unshares (user + pid, never net)', () => {
    const calls: string[] = [];
    mockExecSync.mockImplementation((cmd: string) => {
      calls.push(cmd);
      return Buffer.from('ok\n');
    });
    checkBwrapMountIsolationSupport();
    const probe = calls.find(c => c.includes('bwrap') && c.includes('echo'));
    expect(probe).toBeDefined();
    expect(probe).toContain('--unshare-user');
    expect(probe).toContain('--unshare-pid');
    expect(probe).not.toContain('--unshare-net');
  });

  it('is true on a host that refuses net namespaces but allows user + pid', () => {
    netNamespaceRefused();
    // The strict probe correctly reports false for Claude Code's inner sandbox…
    expect(checkBwrapSupport()).toBe(false);
    // …while the mount-allowlist wrapper is genuinely usable there.
    expect(checkBwrapMountIsolationSupport()).toBe(true);
  });

  it('is false when user namespaces themselves are refused', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'which bwrap') return Buffer.from('/usr/bin/bwrap\n');
      throw new Error('bwrap: No permissions to create a new namespace');
    });
    expect(checkBwrapMountIsolationSupport()).toBe(false);
  });

  it('is false when bwrap is not installed', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'which bwrap') throw new Error('not found');
      return Buffer.from('ok\n');
    });
    expect(checkBwrapMountIsolationSupport()).toBe(false);
  });

  it('is false when BUILDD_DISABLE_SANDBOX=1, without probing', () => {
    const original = process.env.BUILDD_DISABLE_SANDBOX;
    process.env.BUILDD_DISABLE_SANDBOX = '1';
    try {
      expect(checkBwrapMountIsolationSupport()).toBe(false);
      expect(mockExecSync).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) delete process.env.BUILDD_DISABLE_SANDBOX;
      else process.env.BUILDD_DISABLE_SANDBOX = original;
    }
  });
});

describe('sandbox:mount-allowlist capability', () => {
  const originalOptIn = process.env.BUILDD_SANDBOX_MOUNT_ALLOWLIST;
  const originalDisable = process.env.BUILDD_DISABLE_SANDBOX;

  function restore() {
    if (originalOptIn === undefined) delete process.env.BUILDD_SANDBOX_MOUNT_ALLOWLIST;
    else process.env.BUILDD_SANDBOX_MOUNT_ALLOWLIST = originalOptIn;
    if (originalDisable === undefined) delete process.env.BUILDD_DISABLE_SANDBOX;
    else process.env.BUILDD_DISABLE_SANDBOX = originalDisable;
  }

  beforeEach(() => {
    mockExecSync.mockReset();
    mockExecSync.mockImplementation(() => Buffer.from('ok\n'));
    mockExistsSync.mockImplementation(() => false);
    mockReadFileSync.mockImplementation(() => '');
  });

  it('is advertised when the runner opts in and the namespace is available', () => {
    try {
      process.env.BUILDD_SANDBOX_MOUNT_ALLOWLIST = '1';
      delete process.env.BUILDD_DISABLE_SANDBOX;
      expect(scanEnvironment().envKeys).toContain('sandbox:mount-allowlist');
    } finally {
      restore();
    }
  });

  it('is NOT advertised on an opted-in runner whose kernel refuses the namespace', () => {
    // This capability is what Health reports as "enforcement is on". A runner
    // that cannot create the namespace enforces nothing, so advertising it
    // would make a green badge mean only "the env var is set".
    try {
      process.env.BUILDD_SANDBOX_MOUNT_ALLOWLIST = '1';
      delete process.env.BUILDD_DISABLE_SANDBOX;
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('bwrap') && cmd.includes('echo')) {
          throw new Error('bwrap: No permissions to create a new namespace');
        }
        return Buffer.from('ok\n');
      });
      expect(scanEnvironment().envKeys).not.toContain('sandbox:mount-allowlist');
    } finally {
      restore();
    }
  });

  it('is NOT advertised on a capable runner that never opted in', () => {
    try {
      delete process.env.BUILDD_SANDBOX_MOUNT_ALLOWLIST;
      delete process.env.BUILDD_DISABLE_SANDBOX;
      expect(scanEnvironment().envKeys).not.toContain('sandbox:mount-allowlist');
    } finally {
      restore();
    }
  });

  it('is NOT advertised when the sandbox kill switch is set', () => {
    try {
      process.env.BUILDD_SANDBOX_MOUNT_ALLOWLIST = '1';
      process.env.BUILDD_DISABLE_SANDBOX = '1';
      expect(scanEnvironment().envKeys).not.toContain('sandbox:mount-allowlist');
    } finally {
      restore();
    }
  });
});
