import { afterEach, describe, expect, test } from 'bun:test';
import {
  buildWorkerBwrapArgv,
  isMountAllowlistEnabled,
  parseExtraMounts,
  CBM_BINARY_PATH,
} from '../../src/bwrap-mount-allowlist';

const warn = () => {};

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

  test('composes the Codex bind table without Claude credentials', () => {
    expect(buildWorkerBwrapArgv({
      worktreePath: '/repo/.buildd-worktrees/task',
      repoPath: '/repo',
      homePath: '/home/runner',
      bunInstallPath: '/custom/bun',
      codexHome: '/tmp/buildd-codex-homes/worker',
      isCodexTask: true,
      pathExists: () => true,
      warn,
    })).toMatchSnapshot();
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
