import { afterEach, describe, expect, test } from 'bun:test';
import {
  buildWorkerBwrapArgv,
  isMountAllowlistEnabled,
  parseExtraMounts,
  CBM_BINARY_PATH,
  shouldWrapWorkerInBwrap,
} from '../../src/bwrap-mount-allowlist';

const warn = () => {};

/** Every bind mode the argv declares for `path` (a built-in appears exactly once). */
function bindFlagsFor(argv: readonly string[], path: string): string[] {
  const flags: string[] = [];
  for (let i = 0; i + 2 < argv.length; i++) {
    if ((argv[i] === '--bind' || argv[i] === '--ro-bind') && argv[i + 1] === path && argv[i + 2] === path) {
      flags.push(argv[i]);
    }
  }
  return flags;
}


describe('parseExtraMounts', () => {
  test('parses absolute ro/rw entries and defaults the mode to ro', () => {
    expect(parseExtraMounts('/opt/tools:ro,/shared/cache:rw,/data', warn)).toEqual([
      { path: '/opt/tools', mode: 'ro' },
      { path: '/shared/cache', mode: 'rw' },
      { path: '/data', mode: 'ro' },
    ]);
  });

  test('skips relative paths and unknown modes', () => {
    const warnings: string[] = [];
    expect(parseExtraMounts('relative:ro,/valid:execute,/ok:rw', message => warnings.push(message))).toEqual([
      { path: '/ok', mode: 'rw' },
    ]);
    expect(warnings).toHaveLength(2);
  });

  test('handles colons inside absolute paths by reading only a trailing mode', () => {
    expect(parseExtraMounts('/mnt/cache:segment:rw', warn)).toEqual([
      { path: '/mnt/cache:segment', mode: 'rw' },
    ]);
  });
});

describe('buildWorkerBwrapArgv', () => {
  test('composes the Claude managed-credential bind table', () => {
    expect(buildWorkerBwrapArgv({
      worktreePath: '/repo/.buildd-worktrees/task',
      repoPath: '/repo',
      homePath: '/home/runner',
      bunInstallPath: '/home/runner/.bun',
      claudeConfigDir: '/tmp/claude-cfg-worker',
      isCodexTask: false,
      extraMounts: '/opt/custom:ro,/shared/cache:rw',
      pathExists: () => true,
      warn,
    })).toMatchSnapshot();
  });

  // No production caller builds this argv: the Codex backend spawns its own
  // process and has no spawn hook to receive it (see shouldWrapWorkerInBwrap).
  // The Codex bind split is still exercised because mount-isolation.e2e.ts uses
  // it for the cross-backend credential probes — so assert the behaviour that
  // probe depends on, rather than snapshotting an argv nothing consumes.
  test('the Codex bind split mounts CODEX_HOME rw and no Claude credentials', () => {
    const argv = buildWorkerBwrapArgv({
      worktreePath: '/repo/.buildd-worktrees/task',
      repoPath: '/repo',
      homePath: '/home/runner',
      bunInstallPath: '/custom/bun',
      codexHome: '/tmp/buildd-codex-homes/worker',
      isCodexTask: true,
      pathExists: () => true,
      warn,
    });
    expect(bindFlagsFor(argv, '/tmp/buildd-codex-homes/worker')).toEqual(['--bind']);
    expect(argv.join(' ')).not.toContain('.claude');
    expect(argv.join(' ')).not.toContain('claude-cfg');
  });

  test('uses only local Claude credential files when no managed config exists', () => {
    expect(buildWorkerBwrapArgv({
      worktreePath: '/repo',
      repoPath: '/repo',
      homePath: '/home/runner',
      isCodexTask: false,
      pathExists: path => !path.endsWith('settings.json'),
      warn,
    })).toMatchSnapshot();
  });

  test('adds CBM binary ro-bind and cache dir rw-bind when provided', () => {
    expect(buildWorkerBwrapArgv({
      worktreePath: '/repo/.buildd-worktrees/task',
      repoPath: '/repo',
      homePath: '/home/runner',
      bunInstallPath: '/home/runner/.bun',
      claudeConfigDir: '/tmp/claude-cfg-worker',
      isCodexTask: false,
      cbmBinaryPath: CBM_BINARY_PATH,
      cbmCacheDir: '/tmp/cbm-worker-123',
      pathExists: () => true,
      warn,
    })).toMatchSnapshot();
  });

  test('omits CBM mounts when cbmBinaryPath and cbmCacheDir are absent', () => {
    const argv = buildWorkerBwrapArgv({
      worktreePath: '/repo/.buildd-worktrees/task',
      repoPath: '/repo',
      homePath: '/home/runner',
      bunInstallPath: '/home/runner/.bun',
      claudeConfigDir: '/tmp/claude-cfg-worker',
      isCodexTask: false,
      pathExists: () => true,
      warn,
    });
    expect(argv.join(' ')).not.toContain('codebase-memory-mcp');
    expect(argv.join(' ')).not.toContain('cbm-');
  });
});

describe('mount allowlist rollout gates', () => {
  const originalOptIn = process.env.BUILDD_SANDBOX_MOUNT_ALLOWLIST;
  const originalDisable = process.env.BUILDD_DISABLE_SANDBOX;

  afterEach(() => {
    if (originalOptIn === undefined) delete process.env.BUILDD_SANDBOX_MOUNT_ALLOWLIST;
    else process.env.BUILDD_SANDBOX_MOUNT_ALLOWLIST = originalOptIn;
    if (originalDisable === undefined) delete process.env.BUILDD_DISABLE_SANDBOX;
    else process.env.BUILDD_DISABLE_SANDBOX = originalDisable;
  });

  test('is off by default and enabled only by explicit opt-in', () => {
    delete process.env.BUILDD_SANDBOX_MOUNT_ALLOWLIST;
    delete process.env.BUILDD_DISABLE_SANDBOX;
    expect(isMountAllowlistEnabled()).toBe(false);
    process.env.BUILDD_SANDBOX_MOUNT_ALLOWLIST = '1';
    expect(isMountAllowlistEnabled()).toBe(true);
  });

  test('BUILDD_DISABLE_SANDBOX bypasses an opted-in runner', () => {
    process.env.BUILDD_SANDBOX_MOUNT_ALLOWLIST = '1';
    process.env.BUILDD_DISABLE_SANDBOX = '1';
    expect(isMountAllowlistEnabled()).toBe(false);
  });
});

describe('CBM shared-cache mounts', () => {
  test('binds a runtime dir that lives outside the cache dir', () => {
    // Shared mode: cache is host-wide, runtime dir is per-worker at /tmp/cbm-rt-<id>.
    // Without its own mount the daemon cannot bind its socket and CBM refuses to start.
    const argv = buildWorkerBwrapArgv({
      worktreePath: '/repo/.buildd-worktrees/b',
      repoPath: '/repo',
      isCodexTask: false,
      cbmCacheDir: '/home/coder/.buildd-cbm-cache',
      cbmRuntimeDir: '/tmp/cbm-rt-w1',
      pathExists: () => true,
    });
    const pairs = argv.join(' ');
    expect(pairs).toContain('--bind /home/coder/.buildd-cbm-cache /home/coder/.buildd-cbm-cache');
    expect(pairs).toContain('--bind /tmp/cbm-rt-w1 /tmp/cbm-rt-w1');
  });

  test('omits the runtime mount when it is nested in the cache dir', () => {
    const argv = buildWorkerBwrapArgv({
      worktreePath: '/repo/.buildd-worktrees/b',
      repoPath: '/repo',
      isCodexTask: false,
      cbmCacheDir: '/tmp/cbm-w1',
      pathExists: () => true,
    });
    expect(argv.filter(a => a === '/tmp/cbm-w1').length).toBeGreaterThan(0);
    expect(argv.join(' ')).not.toContain('cbm-rt-');
  });
});

// ---------------------------------------------------------------------------
// C25 — built-in binds must be un-overridable by operator input
// ---------------------------------------------------------------------------

describe('operator allowlist cannot override a built-in bind', () => {
  const base = {
    worktreePath: '/repo/.buildd-worktrees/task',
    repoPath: '/repo',
    homePath: '/home/runner',
    bunInstallPath: '/home/runner/.bun',
    claudeConfigDir: '/tmp/claude-cfg-worker',
    isCodexTask: false,
    pathExists: () => true,
  };

  test('an operator entry cannot upgrade a system ro-bind to rw', () => {
    const warnings: string[] = [];
    const argv = buildWorkerBwrapArgv({
      ...base,
      extraMounts: '/usr:rw',
      warn: message => warnings.push(message),
    });
    expect(bindFlagsFor(argv, '/usr')).toEqual(['--ro-bind']);
    expect(warnings.some(w => w.includes('/usr') && /built-in/i.test(w))).toBe(true);
  });

  test('an operator entry cannot downgrade the worktree rw-bind to ro', () => {
    const warnings: string[] = [];
    const argv = buildWorkerBwrapArgv({
      ...base,
      extraMounts: '/repo/.buildd-worktrees/task:ro',
      warn: message => warnings.push(message),
    });
    expect(bindFlagsFor(argv, '/repo/.buildd-worktrees/task')).toEqual(['--bind']);
    expect(warnings.some(w => w.includes('/repo/.buildd-worktrees/task') && /built-in/i.test(w))).toBe(true);
  });

  test('an operator entry cannot override the managed credential dir', () => {
    const argv = buildWorkerBwrapArgv({ ...base, extraMounts: '/tmp/claude-cfg-worker:ro', warn: () => {} });
    expect(bindFlagsFor(argv, '/tmp/claude-cfg-worker')).toEqual(['--bind']);
  });

  test('an operator entry cannot override a CBM bind (order-independent, not incidental)', () => {
    const argv = buildWorkerBwrapArgv({
      ...base,
      cbmBinaryPath: CBM_BINARY_PATH,
      cbmCacheDir: '/tmp/cbm-worker-123',
      extraMounts: `/tmp/cbm-worker-123:ro,${CBM_BINARY_PATH}:rw`,
      warn: () => {},
    });
    expect(bindFlagsFor(argv, '/tmp/cbm-worker-123')).toEqual(['--bind']);
    expect(bindFlagsFor(argv, CBM_BINARY_PATH)).toEqual(['--ro-bind']);
  });

  test('non-colliding operator entries still apply', () => {
    const warnings: string[] = [];
    const argv = buildWorkerBwrapArgv({
      ...base,
      extraMounts: '/opt/custom:ro,/shared/cache:rw',
      warn: message => warnings.push(message),
    });
    expect(bindFlagsFor(argv, '/opt/custom')).toEqual(['--ro-bind']);
    expect(bindFlagsFor(argv, '/shared/cache')).toEqual(['--bind']);
    expect(warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C14 — a dropped mount that CBM depends on must be an error, not a warning
// ---------------------------------------------------------------------------

describe('CBM mounts are required, not best-effort', () => {
  const base = {
    worktreePath: '/repo/.buildd-worktrees/task',
    repoPath: '/repo',
    homePath: '/home/runner',
    bunInstallPath: '/home/runner/.bun',
    claudeConfigDir: '/tmp/claude-cfg-worker',
    isCodexTask: false,
  };

  test('throws when the CBM cache dir vanished before the argv was built', () => {
    expect(() => buildWorkerBwrapArgv({
      ...base,
      cbmBinaryPath: CBM_BINARY_PATH,
      cbmCacheDir: '/tmp/cbm-worker-123',
      pathExists: path => path !== '/tmp/cbm-worker-123',
      warn: () => {},
    })).toThrow(/\/tmp\/cbm-worker-123/);
  });

  test('throws when the CBM binary bind is missing', () => {
    expect(() => buildWorkerBwrapArgv({
      ...base,
      cbmBinaryPath: CBM_BINARY_PATH,
      cbmCacheDir: '/tmp/cbm-worker-123',
      pathExists: path => path !== CBM_BINARY_PATH,
      warn: () => {},
    })).toThrow(/codebase-memory-mcp/);
  });

  test('optional mounts are still dropped with a warning', () => {
    const warnings: string[] = [];
    const argv = buildWorkerBwrapArgv({
      ...base,
      pathExists: path => path !== '/home/runner/.npm',
      warn: message => warnings.push(message),
    });
    expect(argv.join(' ')).not.toContain('/home/runner/.npm');
    expect(warnings.some(w => w.includes('/home/runner/.npm'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C28 — the outer wrapper gate (no argv is built for a backend that can't use it)
// ---------------------------------------------------------------------------

describe('shouldWrapWorkerInBwrap', () => {
  test('never wraps a Codex task — the Codex backend has no spawn hook to receive the argv', () => {
    expect(shouldWrapWorkerInBwrap({ isCodexTask: true, mountAllowlistEnabled: true, bwrapSupported: true })).toBe(false);
  });

  test('wraps a Claude task on an opted-in runner with working namespaces', () => {
    expect(shouldWrapWorkerInBwrap({ isCodexTask: false, mountAllowlistEnabled: true, bwrapSupported: true })).toBe(true);
  });

  test('does not wrap without the opt-in or without namespace support', () => {
    expect(shouldWrapWorkerInBwrap({ isCodexTask: false, mountAllowlistEnabled: false, bwrapSupported: true })).toBe(false);
    expect(shouldWrapWorkerInBwrap({ isCodexTask: false, mountAllowlistEnabled: true, bwrapSupported: false })).toBe(false);
  });
});
