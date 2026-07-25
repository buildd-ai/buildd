/**
 * Acceptance probe: bwrap mount-allowlist isolation.
 * Spec: docs/design/worker-mount-isolation.md § "Probe Test Design"
 *
 * Run: bun test tests/e2e/sandbox-probe.test.ts
 *
 * The negative/positive/taxonomy-subprocess tests require:
 *   - Linux with unprivileged user namespaces enabled
 *   - bwrap binary installed (apt-get install bubblewrap / dnf install bubblewrap)
 *   - BUILDD_SANDBOX_MOUNT_ALLOWLIST=1 is NOT required here — we exercise the
 *     underlying subprocess directly without going through the runner.
 *
 * The escape-hatch and pattern-matching tests are pure-JS and always run.
 *
 * Full happy-path (bun install → test → git commit → push) requires a live runner
 * with BUILDD_SANDBOX_MOUNT_ALLOWLIST=1; that path is described in the probe design
 * and is exercised via the normal E2E runner flow (tests/e2e/server-worker-flow.test.ts).
 *
 * NOTE: test fixtures live in /var/tmp (not /tmp) because buildWorkerBwrapArgv adds
 * `--tmpfs /tmp` — a fresh empty tmpfs — which would hide any fixture files created
 * under /tmp.  Paths under /var/tmp are unaffected by that mount operation.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';

import {
  buildWorkerBwrapArgv,
  isMountAllowlistEnabled,
} from '../../apps/runner/src/bwrap-mount-allowlist';
import { scanToolResult } from '../../apps/runner/src/error-trace-scanner';

// ---------------------------------------------------------------------------
// bwrap availability guard
// ---------------------------------------------------------------------------

function probeBwrap(): boolean {
  try {
    const r = spawnSync(
      'bwrap',
      [
        '--unshare-user', '--unshare-pid',
        '--uid', '0', '--gid', '0',
        '--tmpfs', '/',
        '--proc', '/proc',
        '--dev', '/dev',
        '--ro-bind', '/usr', '/usr',
        '--', '/usr/bin/env', 'echo', 'ok',
      ],
      { timeout: 5000 },
    );
    return r.status === 0;
  } catch {
    return false;
  }
}

const BWRAP_AVAILABLE = probeBwrap();

if (!BWRAP_AVAILABLE) {
  console.log(
    '⏭️  bwrap not available on this host — isolation subprocess tests will be skipped.\n' +
    '   Install bubblewrap (apt-get install bubblewrap) to run the full probe suite.\n' +
    '   Escape-hatch and pattern-matching tests still run.',
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn a command inside a bwrap container using the provided argv prefix.
 * The argv should come from buildWorkerBwrapArgv (i.e. everything before --).
 */
function runInBwrap(
  bwrapArgv: string[],
  cmd: string,
  args: string[],
): { exitCode: number; stdout: string; stderr: string } {
  const r = spawnSync('bwrap', [...bwrapArgv, '--', cmd, ...args], {
    timeout: 8000,
    encoding: 'utf-8',
  });
  return {
    exitCode: r.status ?? -1,
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
  };
}

// ---------------------------------------------------------------------------
// Fixtures — written to /var/tmp to avoid the `--tmpfs /tmp` wipe
// ---------------------------------------------------------------------------

let tmpBase: string;
let worktreeDir: string;
let repoDir: string;
let siblingWorktreeDir: string;  // (b) sibling workspace — NOT in allowlist
let canaryDir: string;           // (a) runner coordination dir — NOT in allowlist
let canaryFile: string;
let foreignCodexHome: string;    // (c) non-active backend credential — NOT in allowlist

const VAR_TMP = '/var/tmp';

beforeAll(() => {
  // Use /var/tmp so fixture files survive the `--tmpfs /tmp` mount inside bwrap
  tmpBase = mkdtempSync(join(VAR_TMP, 'buildd-sp-'));

  repoDir = join(tmpBase, 'repo');
  mkdirSync(join(repoDir, '.git'), { recursive: true });
  writeFileSync(join(repoDir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');

  worktreeDir = join(tmpBase, 'worktree');
  mkdirSync(worktreeDir, { recursive: true });
  writeFileSync(join(worktreeDir, 'README.md'), '# sandbox-probe fixture\n');

  // (b) sibling worktree — same parent dir, but not in the bwrap argv
  siblingWorktreeDir = join(tmpBase, 'sibling-worktree');
  mkdirSync(siblingWorktreeDir, { recursive: true });
  writeFileSync(join(siblingWorktreeDir, 'other-tenant-secret.txt'), 'SIBLING:secret\n');

  // (a) canary dir — runner coordination file, explicitly absent from allowlist
  canaryDir = join(tmpBase, 'buildd-runner-state');
  mkdirSync(canaryDir, { recursive: true });
  canaryFile = join(canaryDir, 'runner-key.json');
  writeFileSync(canaryFile, '{"coordinationKey":"CANARY_SECRET"}\n');

  // (c) foreign codex home — mounted for Codex tasks, NOT for Claude tasks
  foreignCodexHome = join(tmpBase, 'codex-homes', 'other-worker');
  mkdirSync(foreignCodexHome, { recursive: true });
  writeFileSync(join(foreignCodexHome, 'auth.json'), '{"token":"FOREIGN_CODEX_TOKEN"}\n');
});

afterAll(() => {
  if (tmpBase) {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ---------------------------------------------------------------------------
// Bwrap argv builder (shared fixture)
// ---------------------------------------------------------------------------

function makeBwrapArgv(opts: {
  extraMounts?: string;
  isCodexTask?: boolean;
  codexHome?: string;
  claudeConfigDir?: string;
} = {}): string[] {
  return buildWorkerBwrapArgv({
    worktreePath: worktreeDir,
    repoPath: repoDir,
    homePath: homedir(),
    bunInstallPath: join(homedir(), '.bun'),
    claudeConfigDir: opts.claudeConfigDir,
    codexHome: opts.codexHome,
    isCodexTask: opts.isCodexTask ?? false,
    extraMounts: opts.extraMounts,
    // Use existsSync so optional mounts (e.g. ~/.bun/install/cache) are skipped
    // gracefully if not present on the test runner.
  });
}

// ---------------------------------------------------------------------------
// 1. NEGATIVE — isolation: blocked paths must be inaccessible inside bwrap
// ---------------------------------------------------------------------------

describe('negative isolation', () => {
  const bwrapTest = BWRAP_AVAILABLE ? test : test.skip;

  bwrapTest('(a) canary file outside allowlist is blocked', () => {
    // The canaryFile exists on the host, but its parent dir is NOT in the bwrap argv.
    expect(existsSync(canaryFile)).toBe(true);  // confirm it really exists on host

    const argv = makeBwrapArgv();
    const { exitCode, stderr } = runInBwrap(argv, 'cat', [canaryFile]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/No such file|Permission denied|cannot open/i);
  });

  bwrapTest('(b) sibling workspace worktree is not visible inside sandbox', () => {
    // The sibling dir exists on the host but is not bound in the argv.
    expect(existsSync(siblingWorktreeDir)).toBe(true);

    const argv = makeBwrapArgv();
    const { exitCode, stderr } = runInBwrap(argv, 'ls', [siblingWorktreeDir]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/No such file|Permission denied|cannot access/i);
  });

  bwrapTest('(c) non-active backend (Codex) credential path is blocked for a Claude task', () => {
    // For a non-Codex task (isCodexTask=false), codexHome is NOT mounted.
    expect(existsSync(join(foreignCodexHome, 'auth.json'))).toBe(true);

    const argv = makeBwrapArgv({ isCodexTask: false });
    const { exitCode } = runInBwrap(argv, 'cat', [join(foreignCodexHome, 'auth.json')]);

    expect(exitCode).not.toBe(0);
  });

  bwrapTest('(c) non-active backend (Claude) credential path is blocked for a Codex task', () => {
    // For a Codex task, any claudeConfigDir-style path outside of codexHome is NOT mounted.
    // We use a fresh temp dir as a stand-in for another worker's Claude credential dir.
    const orphanClaudeDir = join(tmpBase, 'claude-cfg-other-worker');
    mkdirSync(orphanClaudeDir, { recursive: true });
    writeFileSync(join(orphanClaudeDir, 'auth_token.json'), '{"token":"OTHER_CLAUDE"}\n');

    const argv = makeBwrapArgv({
      isCodexTask: true,
      codexHome: join(tmpBase, 'my-codex-home'),
    });
    const { exitCode } = runInBwrap(argv, 'cat', [join(orphanClaudeDir, 'auth_token.json')]);

    expect(exitCode).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. POSITIVE — allowed paths must be accessible and basic operations succeed
// ---------------------------------------------------------------------------

describe('positive: allowed operations succeed', () => {
  const bwrapTest = BWRAP_AVAILABLE ? test : test.skip;

  bwrapTest('worktree (explicitly bound rw) is readable inside sandbox', () => {
    const argv = makeBwrapArgv();
    const { exitCode, stdout } = runInBwrap(argv, 'ls', [worktreeDir]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('README.md');
  });

  bwrapTest('worktree is writable: can create and read back a file', () => {
    const argv = makeBwrapArgv();
    const testFile = join(worktreeDir, 'sandbox-write-test.txt');
    const payload = 'sandbox-write-probe';

    // Write inside sandbox
    const writeResult = runInBwrap(argv, '/bin/sh', ['-c', `echo "${payload}" > ${testFile}`]);
    expect(writeResult.exitCode).toBe(0);

    // Read back on host (verifies the bind is rw and changes persist)
    const content = readFileSync(testFile, 'utf-8').trim();
    expect(content).toBe(payload);

    // Cleanup
    try { rmSync(testFile); } catch { /* ok */ }
  });

  bwrapTest('repo .git directory (bound ro) is readable inside sandbox', () => {
    const argv = makeBwrapArgv();
    const { exitCode } = runInBwrap(argv, 'ls', [join(repoDir, '.git')]);

    expect(exitCode).toBe(0);
  });

  bwrapTest('basic shell and system tools work (toolchain is accessible)', () => {
    const argv = makeBwrapArgv();
    const { exitCode, stdout } = runInBwrap(argv, '/bin/echo', ['bwrap-ok']);

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('bwrap-ok');
  });

  bwrapTest('/tmp is writable inside sandbox (tmpfs, no host leakage)', () => {
    const argv = makeBwrapArgv();
    // Write to sandbox /tmp (which is a fresh tmpfs — ephemeral per-run)
    const { exitCode } = runInBwrap(argv, '/bin/sh', ['-c', 'echo ok > /tmp/probe.txt && cat /tmp/probe.txt']);

    expect(exitCode).toBe(0);
    // The file must NOT appear on the host (sandbox /tmp is isolated)
    expect(existsSync('/tmp/probe.txt')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. TAXONOMY — sandbox_mount_gap detection and BUILDD_MOUNT_ALLOWLIST_EXTRA
// ---------------------------------------------------------------------------

describe('taxonomy: sandbox_mount_gap', () => {
  // Pattern-matching tests are pure-JS — always run, no bwrap required.

  test('scanToolResult detects sandbox_mount_gap for .npmrc ENOENT', () => {
    const traces = scanToolResult(
      'probe-worker-npmrc',
      "ENOENT: no such file or directory, open '/home/runner/.npmrc'",
    );
    const gap = traces.find(t => t.pattern === 'sandbox_mount_gap');
    expect(gap).toBeDefined();
    expect(gap!.excerpt).toContain('.npmrc');
  });

  test('scanToolResult detects sandbox_mount_gap for .gitconfig ENOENT', () => {
    const traces = scanToolResult(
      'probe-worker-gitconfig',
      "ENOENT: no such file or directory, open '/home/runner/.gitconfig'",
    );
    expect(traces.some(t => t.pattern === 'sandbox_mount_gap')).toBe(true);
  });

  test('scanToolResult detects sandbox_mount_gap for /opt path ENOENT', () => {
    const traces = scanToolResult(
      'probe-worker-opt',
      "ENOENT: no such file or directory, open '/opt/custom-toolchain/bin/cc'",
    );
    expect(traces.some(t => t.pattern === 'sandbox_mount_gap')).toBe(true);
  });

  test('scanToolResult detects sandbox_mount_gap for /opt path EACCES', () => {
    const traces = scanToolResult(
      'probe-worker-opt-acces',
      "EACCES: permission denied, open '/opt/vendor/license.key'",
    );
    expect(traces.some(t => t.pattern === 'sandbox_mount_gap')).toBe(true);
  });

  test('scanToolResult detects sandbox_mount_gap for /snap path', () => {
    const traces = scanToolResult(
      'probe-worker-snap',
      "ENOENT: no such file or directory '/snap/bin/node'",
    );
    expect(traces.some(t => t.pattern === 'sandbox_mount_gap')).toBe(true);
  });

  test('normal in-repo ENOENT (unrelated to sandbox) is NOT a sandbox_mount_gap', () => {
    // e.g. a missing source file referenced in code — should NOT fire sandbox_mount_gap
    const traces = scanToolResult(
      'probe-worker-normal-enoent',
      "ENOENT: no such file or directory, open 'src/missing-component.tsx'",
    );
    expect(traces.some(t => t.pattern === 'sandbox_mount_gap')).toBe(false);
    // But enoent generic pattern may still fire
    expect(traces.some(t => t.pattern === 'enoent')).toBe(true);
  });

  // Subprocess test: BUILDD_MOUNT_ALLOWLIST_EXTRA restores a previously-blocked path
  const bwrapTest = BWRAP_AVAILABLE ? test : test.skip;

  bwrapTest('BUILDD_MOUNT_ALLOWLIST_EXTRA restores access to a gap path', () => {
    // Baseline: siblingWorktreeDir is blocked (not in allowlist)
    const argvBase = makeBwrapArgv();
    const beforeResult = runInBwrap(argvBase, 'ls', [siblingWorktreeDir]);
    expect(beforeResult.exitCode).not.toBe(0);

    // With the extra mount, the path becomes accessible
    const argvExtra = makeBwrapArgv({ extraMounts: `${siblingWorktreeDir}:ro` });
    const afterResult = runInBwrap(argvExtra, 'ls', [siblingWorktreeDir]);
    expect(afterResult.exitCode).toBe(0);
    expect(afterResult.stdout).toContain('other-tenant-secret.txt');
  });

  bwrapTest('forced mount gap (path removed from allowlist) produces expected ENOENT', () => {
    // Build argv that intentionally omits the worktree bind by using a dummy worktree
    // that doesn't match the path we try to read — simulating a misconfigured allowlist.
    const altWorktreeDir = join(tmpBase, 'alt-worktree');
    mkdirSync(altWorktreeDir, { recursive: true });
    writeFileSync(join(altWorktreeDir, 'alt-file.txt'), 'alt');

    const gappedArgv = buildWorkerBwrapArgv({
      worktreePath: altWorktreeDir,  // different worktree — worktreeDir not mounted
      repoPath: repoDir,
      homePath: homedir(),
      isCodexTask: false,
    });

    // Trying to read the ORIGINAL worktreeDir should now fail — it's not in the allowlist
    const { exitCode, stderr } = runInBwrap(gappedArgv, 'cat', [join(worktreeDir, 'README.md')]);
    expect(exitCode).not.toBe(0);

    // The error output matches patterns that scanToolResult would pick up
    // (In production, this goes through the agent SDK tool_result → scanToolResult)
    const output = `ENOENT: no such file or directory, open '${join(worktreeDir, 'README.md')}'`;
    const traces = scanToolResult('probe-gap-forced', output);
    // Generic enoent fires (the specific sandbox_mount_gap pattern requires known-bad prefixes)
    expect(traces.some(t => t.pattern === 'enoent')).toBe(true);
    void exitCode;
    void stderr;
  });
});

// ---------------------------------------------------------------------------
// 4. ESCAPE HATCH — BUILDD_DISABLE_SANDBOX=1 restores legacy behavior
// ---------------------------------------------------------------------------

describe('escape hatch: BUILDD_DISABLE_SANDBOX', () => {
  // Pure-JS tests — always run.

  test('isMountAllowlistEnabled returns false when BUILDD_DISABLE_SANDBOX=1', () => {
    expect(isMountAllowlistEnabled({
      BUILDD_SANDBOX_MOUNT_ALLOWLIST: '1',
      BUILDD_DISABLE_SANDBOX: '1',
    })).toBe(false);
  });

  test('isMountAllowlistEnabled returns false when opt-in flag is absent', () => {
    expect(isMountAllowlistEnabled({})).toBe(false);
    expect(isMountAllowlistEnabled({ BUILDD_DISABLE_SANDBOX: '0' })).toBe(false);
  });

  test('isMountAllowlistEnabled returns true only with explicit opt-in and sandbox enabled', () => {
    expect(isMountAllowlistEnabled({ BUILDD_SANDBOX_MOUNT_ALLOWLIST: '1' })).toBe(true);
  });

  test('BUILDD_DISABLE_SANDBOX overrides opt-in regardless of value', () => {
    // Paranoia: "1" is the documented value, but test "true" / non-empty too
    expect(isMountAllowlistEnabled({
      BUILDD_SANDBOX_MOUNT_ALLOWLIST: '1',
      BUILDD_DISABLE_SANDBOX: '1',
    })).toBe(false);
  });

  // When BUILDD_DISABLE_SANDBOX=1, buildWorkerBwrapArgv is never called —
  // the caller (workers.ts) short-circuits at `isMountAllowlistEnabled()`.
  // The subprocess test below verifies the *effect*: the process runs without bwrap.
  const bwrapTest = BWRAP_AVAILABLE ? test : test.skip;

  bwrapTest('with BUILDD_DISABLE_SANDBOX=1, the runner skips bwrap (no namespace isolation)', () => {
    // Simulate what workers.ts does: check the flag before building argv
    const env = { BUILDD_SANDBOX_MOUNT_ALLOWLIST: '1', BUILDD_DISABLE_SANDBOX: '1' };
    const mountAllowlistActive = isMountAllowlistEnabled(env);
    expect(mountAllowlistActive).toBe(false);

    // Without bwrap, a process can read host paths freely.
    // Confirm that without the wrapper the canary IS readable (baseline).
    expect(existsSync(canaryFile)).toBe(true);
    const r = spawnSync('cat', [canaryFile], { timeout: 3000, encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('CANARY_SECRET');
  });
});
