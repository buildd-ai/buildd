/**
 * Acceptance probe: the Quality Scout command-probe sandbox, in a real bwrap
 * namespace.
 *
 * Run: bun test ./apps/runner/src/__tests__/scout-sandbox.e2e.ts
 *
 * `apps/runner/__tests__/unit/scout-host.test.ts` only snapshots the argv
 * `buildScoutBwrapArgv` returns. This file executes it: the real argv builder,
 * the real allowlisted probe env (`buildScoutProbeEnv`) and the same spawn
 * the runner uses (`exec` from local-host, `bwrap <argv> -- bash -c <cmd>`),
 * against a fixture shaped like a runner host: a runner home holding
 * `.buildd`, `.claude`, `.config/gh` and a populated shared bun cache, a clone
 * under it, and a throwaway worktree + probe home under `.cache/buildd-scout`
 * exactly where `createScoutHostPoller` puts them.
 *
 * Every isolation assertion is paired with a MUTANT: the same check against a
 * deliberately broken argv or env, which must be caught. A check that cannot
 * fail on a broken sandbox proves nothing, and this pairing keeps that proof
 * in the suite rather than in a PR description.
 *
 * Needs Linux with unprivileged user namespaces and bubblewrap; elsewhere the
 * namespace tests skip and the banner says so. CI (`Sandbox isolation probe
 * (bwrap)` in build.yml) fails when the banner reads `full` and anything
 * skipped, or when the banner is missing.
 *
 * Fixtures live under /var/tmp, not /tmp: the argv mounts a fresh tmpfs on /tmp.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

import { buildScoutProbeEnv } from '@buildd/core/quality-scout/runner-host';
import { exec } from '@buildd/core/quality-scout/local-host';
import { buildScoutBwrapArgv } from '../scout-host';
import { checkBwrapMountIsolationSupport } from '../env-scan';

// ---------------------------------------------------------------------------
// Capability banner
// ---------------------------------------------------------------------------

const BWRAP_AVAILABLE = checkBwrapMountIsolationSupport();
export const SCOUT_SANDBOX_MODE: 'full' | 'skipped' = BWRAP_AVAILABLE ? 'full' : 'skipped';
console.log(`SCOUT_SANDBOX_MODE=${SCOUT_SANDBOX_MODE}`);
if (!BWRAP_AVAILABLE) {
  console.log('⏭️  bwrap user namespaces are unavailable on this host — Scout sandbox namespace tests will be skipped.');
}

// ---------------------------------------------------------------------------
// Fixture: a runner host
// ---------------------------------------------------------------------------

/** Credential-shaped variables a runner host holds. Names and values must both stay out of a probe. */
const PLANTED_ENV: Record<string, string> = {
  BUILDD_API_KEY: 'bld_PLANTED_buildd_key_7f3a',
  GITHUB_TOKEN: 'ghp_PLANTED_github_token_7f3a',
  GH_TOKEN: 'gho_PLANTED_gh_token_7f3a',
  ANTHROPIC_API_KEY: 'sk-ant-PLANTED_anthropic_7f3a',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-PLANTED_oauth_7f3a',
  OPENAI_API_KEY: 'sk-PLANTED_openai_7f3a',
  DATABASE_URL: 'postgres://u:PLANTED_dbpass_7f3a@db.invalid/x',
  AWS_SECRET_ACCESS_KEY: 'PLANTED_aws_secret_7f3a',
  // Not credential-shaped by name: only the allowlist (not the deny regex) keeps it out.
  APP_SIGNING_MATERIAL: 'PLANTED_unlabelled_7f3a',
};

let root: string;
let runnerHome: string;
let repoPath: string;
let worktree: string;
let home: string;
let tmp: string;
let bunInstall: string;
let bunCache: string;
let sha: string;

const SECRET_FILES = () => ({
  buildd: join(runnerHome, '.buildd', 'config.json'),
  claude: join(runnerHome, '.claude', '.credentials.json'),
  gh: join(runnerHome, '.config', 'gh', 'hosts.yml'),
});

function host(cmd: string, args: string[], cwd?: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf-8', timeout: 20_000 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

beforeAll(() => {
  root = mkdtempSync('/var/tmp/buildd-scout-sbx-');
  runnerHome = join(root, 'runner-home');

  // The runner's own secrets.
  const files = SECRET_FILES();
  for (const [name, path] of Object.entries(files)) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `PLANTED_${name}_file_secret\n`);
  }

  // The runner's bun install, with a populated shared install cache.
  bunInstall = join(runnerHome, '.bun');
  bunCache = join(bunInstall, 'install', 'cache');
  mkdirSync(join(bunInstall, 'bin'), { recursive: true });
  writeFileSync(join(bunInstall, 'bin', 'bun'), '#!/bin/sh\necho stub-bun\n', { mode: 0o755 });
  mkdirSync(join(bunCache, 'some-pkg@1.0.0'), { recursive: true });
  writeFileSync(join(bunCache, 'some-pkg@1.0.0', 'SHARED_CACHE_MARKER'), 'shared-cache\n');

  // The runner's clone.
  repoPath = join(runnerHome, 'repos', 'tool');
  host('git', ['init', '-q', repoPath]);
  writeFileSync(join(repoPath, 'README.md'), '# scout sandbox fixture\n');
  host('git', ['add', 'README.md'], repoPath);
  host('git', ['-c', 'user.name=Scout Probe', '-c', 'user.email=probe@buildd.invalid', 'commit', '-q', '-m', 'seed'], repoPath);
  sha = host('git', ['rev-parse', 'HEAD'], repoPath);

  // The run's throwaway checkout and probe home, laid out as hostClaimedScoutRun does
  // under createScoutHostPoller's tmpRoot (~/.cache/buildd-scout).
  const runRoot = join(runnerHome, '.cache', 'buildd-scout', 'scout-e2e00000-x');
  mkdirSync(runRoot, { recursive: true });
  worktree = join(runRoot, 'wt');
  home = join(runRoot, 'home');
  tmp = join(home, 'tmp');
  mkdirSync(tmp, { recursive: true });
  host('git', ['-C', repoPath, 'worktree', 'add', '-q', '--detach', worktree, sha]);
});

afterAll(() => {
  if (root) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ---------------------------------------------------------------------------
// Running a probe exactly the way the runner does
// ---------------------------------------------------------------------------

function realArgv(): string[] {
  return buildScoutBwrapArgv({ worktree, home, repoPath, bunInstallPath: bunInstall });
}

function probeEnv(): Record<string, string> {
  return buildScoutProbeEnv({ ...process.env, ...PLANTED_ENV }, { home, tmp });
}

/** `bwrap <argv> -- bash -c <cmd>`, spawned like ScoutHostPoller's wrapFor + localCommandPort. */
async function probe(cmd: string, opts: { argv?: string[]; env?: Record<string, string | undefined> } = {}) {
  const argv = opts.argv ?? realArgv();
  const r = await exec('bwrap', [...argv, '--', 'bash', '-c', cmd], { cwd: worktree, timeoutMs: 20_000, env: opts.env ?? probeEnv() });
  return { code: r.code, out: r.stdout, err: r.stderr };
}

/** Replace the first `<flag> <path> <path>` triple for `path` (mutant builder). */
function rebind(argv: string[], path: string, flag: '--bind' | '--ro-bind'): string[] {
  const out = [...argv];
  const i = out.findIndex((a, k) => (a === '--bind' || a === '--ro-bind') && out[k + 1] === path);
  if (i < 0) throw new Error(`mutant: ${path} is not bound in the argv`);
  out[i] = flag;
  return out;
}

/** Drop the `<flag> <path> ...` entry for `path`, whichever flag mounts it (mutant builder). */
function unmount(argv: string[], path: string): string[] {
  const out = [...argv];
  const i = out.findIndex((a, k) => (a === '--bind' || a === '--ro-bind' || a === '--tmpfs') && out[k + 1] === path);
  if (i < 0) throw new Error(`mutant: ${path} is not mounted in the argv`);
  out.splice(i, out[i] === '--tmpfs' ? 2 : 3);
  return out;
}

/** Insert binds just before the trailing `--chdir <worktree>` (mutant builder). */
function withExtraBind(argv: string[], ...triple: string[]): string[] {
  return [...argv.slice(0, -2), ...triple, ...argv.slice(-2)];
}

const SECRET_VALUES = Object.values(PLANTED_ENV);
const leaksEnv = (dump: string) => Object.keys(PLANTED_ENV).some((k) => new RegExp(`^${k}=`, 'm').test(dump)) || SECRET_VALUES.some((v) => dump.includes(v));

const READ_RUNNER_SECRETS = () => Object.values(SECRET_FILES()).map((f) => `cat ${f} 2>/dev/null`).join('; ') + '; true';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('probe guard', () => {
  test('reports the mode it ran in', () => {
    expect(['full', 'skipped']).toContain(SCOUT_SANDBOX_MODE);
    if (SCOUT_SANDBOX_MODE === 'skipped') console.log('   NOTE: the Scout sandbox was NOT verified on this host.');
  });

  test('the fixture is shaped like a runner host (secrets, cache and clone really exist outside)', () => {
    for (const f of Object.values(SECRET_FILES())) expect(existsSync(f)).toBe(true);
    expect(existsSync(join(bunCache, 'some-pkg@1.0.0', 'SHARED_CACHE_MARKER'))).toBe(true);
    expect(host('git', ['-C', worktree, 'rev-parse', 'HEAD'])).toBe(sha);
  });
});

describe('scout sandbox: negative isolation', () => {
  const nsTest = BWRAP_AVAILABLE ? test : test.skip;

  // (1) The layout is usable at all — otherwise every "denied" below is vacuous.
  nsTest('(1) a trivial probe succeeds, and git can read the worktree at the run SHA', async () => {
    const t = await probe('true');
    expect(t.err).toBe('');
    expect(t.code).toBe(0);

    const s = await probe(`git -C ${worktree} status --porcelain && git rev-parse HEAD && pwd`);
    expect(s.code).toBe(0);
    expect(s.out.trim().split('\n')).toEqual([sha, worktree]);
  });

  nsTest('(1) mutant: without the clone\'s .git mounted, git status fails — the check can fail', async () => {
    const s = await probe(`git -C ${worktree} status --porcelain`, { argv: unmount(realArgv(), join(repoPath, '.git')) });
    expect(s.code).not.toBe(0);
  });

  // (2) No planted credential env var reaches the probe.
  nsTest('(2) none of the planted credential env vars is visible to the probe', async () => {
    const r = await probe('env');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(new RegExp(`^HOME=${home}$`, 'm'));
    expect(leaksEnv(r.out)).toBe(false);
  });

  nsTest('(2) mutant: the host env passed straight through leaks them — the check can fail', async () => {
    const r = await probe('env', { env: { ...process.env, ...PLANTED_ENV } });
    expect(r.code).toBe(0);
    expect(leaksEnv(r.out)).toBe(true);
  });

  // (3) The runner's own home and credentials are out of reach.
  nsTest('(3) the runner\'s real home, ~/.buildd, ~/.claude and ~/.config/gh are not readable', async () => {
    const r = await probe(READ_RUNNER_SECRETS());
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('PLANTED_');
    for (const d of ['.buildd', '.claude', join('.config', 'gh')]) {
      const ls = await probe(`ls -A ${join(runnerHome, d)}`);
      expect(ls.code).not.toBe(0);
    }
    // Only the skeleton of directories leading to a mount exists in the runner home.
    const ls = await probe(`ls -A ${runnerHome}`);
    expect(ls.out.trim().split('\n').sort()).toEqual(['.bun', '.cache', 'repos']);
  });

  nsTest('(3) the host\'s actual home directory is not visible either', async () => {
    const realHome = homedir();
    const entries = host('ls', ['-A', realHome]).split('\n').filter(Boolean);
    const r = await probe(`ls -A ${realHome} 2>/dev/null; true`);
    const inside = r.out.split('\n').filter(Boolean);
    // Anything visible inside must be a skeleton dir on the path to a fixture mount, never real content.
    const skeleton = new Set(root.startsWith(`${realHome}/`) ? [root.slice(realHome.length + 1).split('/')[0]] : []);
    expect(inside.filter((e) => entries.includes(e) && !skeleton.has(e))).toEqual([]);
  });

  nsTest('(3) mutant: binding the runner home exposes its secrets — the check can fail', async () => {
    const r = await probe(READ_RUNNER_SECRETS(), { argv: withExtraBind(realArgv(), '--ro-bind', runnerHome, runnerHome) });
    expect(r.out).toContain('PLANTED_buildd_file_secret');
  });

  // (4) Write surface: the clone's .git is read-only; worktree, probe HOME and TMPDIR are writable.
  nsTest('(4) the clone\'s .git is read-only while the worktree, probe HOME and TMPDIR are writable', async () => {
    const gitDir = join(repoPath, '.git');
    const ro = await probe(`touch ${gitDir}/probe-wrote-here`);
    expect(ro.code).not.toBe(0);
    expect(ro.err).toMatch(/Read-only file system|Permission denied/i);
    expect(existsSync(join(gitDir, 'probe-wrote-here'))).toBe(false);

    const objs = await probe(`git -C ${worktree} hash-object -w README.md`);
    expect(objs.code).not.toBe(0);

    const rw = await probe(`echo wt > ${worktree}/probe-out.txt && echo h > "$HOME/probe-home.txt" && echo t > "$TMPDIR/probe-tmp.txt"`);
    expect(rw.err).toBe('');
    expect(rw.code).toBe(0);
    // Real binds, not namespace-private copies: the host sees what the probe wrote.
    expect(readFileSync(join(worktree, 'probe-out.txt'), 'utf8')).toBe('wt\n');
    expect(readFileSync(join(home, 'probe-home.txt'), 'utf8')).toBe('h\n');
    expect(readFileSync(join(tmp, 'probe-tmp.txt'), 'utf8')).toBe('t\n');
    rmSync(join(worktree, 'probe-out.txt'));
  });

  nsTest('(4) mutant: a read-write .git bind lets the probe write — the check can fail', async () => {
    const gitDir = join(repoPath, '.git');
    const r = await probe(`touch ${gitDir}/mutant-wrote-here`, { argv: rebind(realArgv(), gitDir, '--bind') });
    expect(r.code).toBe(0);
    expect(existsSync(join(gitDir, 'mutant-wrote-here'))).toBe(true);
    rmSync(join(gitDir, 'mutant-wrote-here'));
  });

  // (5) The runner's shared bun install cache is not reachable.
  nsTest('(5) the shared bun cache is not mounted', async () => {
    const r = await probe(`ls -A ${bunCache}; cat ${bunCache}/some-pkg@1.0.0/SHARED_CACHE_MARKER 2>/dev/null; true`);
    expect(r.out).not.toContain('some-pkg');
    expect(r.out).not.toContain('shared-cache');
    // The bun install itself is still usable (read-only), so `bun` resolves inside.
    const bun = await probe(`${bunInstall}/bin/bun`);
    expect(bun.out.trim()).toBe('stub-bun');
  });

  nsTest('(5) mutant: without the cache mask, the read-only ~/.bun bind exposes it — the check can fail', async () => {
    // The mutant is the pre-fix argv: the cache's rw bind dropped, nothing masking it.
    const r = await probe(`cat ${bunCache}/some-pkg@1.0.0/SHARED_CACHE_MARKER 2>/dev/null; true`, { argv: unmount(realArgv(), bunCache) });
    expect(r.out).toContain('shared-cache');
  });
});
