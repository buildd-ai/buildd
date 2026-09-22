/**
 * Regression: dependency install ran at the wrong path and failed silently.
 *
 *  - `cwd` was always the worktree ROOT, so every worktree of a repo whose
 *    manifest lives in a subdirectory failed with a missing manifest.
 *  - The return type was `Promise<void>`. The outcome reached nothing: not
 *    `SetupWorktreeResult`, not the worker, not `sessionLog`, not
 *    `appendErrorTraces`. Workers finished `done` with broken workspace
 *    imports and nothing anywhere said so.
 *  - The frozen→unfrozen retry was unconditional. On a registry 401 it doubled
 *    the stall and then reported "lockfile may have drifted", which is the
 *    wrong cause.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/worktree-install-outcome.test.ts
 */

import { describe, test, expect, afterAll, beforeEach } from 'bun:test';

const REPO = '/repo';
const DEFAULT_BRANCH = 'main';
const BRANCH = 'buildd/0000abcd-slug';
const WT = `${REPO}/.buildd-worktrees/buildd_0000abcd-slug`;

type FileCall = { file: string; args: string[]; opts: Record<string, unknown> };

let syncCalls: string[] = [];
let fileCalls: FileCall[] = [];
/** Repo-relative paths that exist inside the worktree. */
let treeFiles: Set<string> = new Set();
/** `.buildd/env.yaml` contents, or null for "no declared manifest". */
let manifestYaml: string | null = null;
/** Error message each `bun install` should reject with, keyed by frozen-ness. */
let installErrors: { frozen?: string; unfrozen?: string } = {};

function mockExecSync(cmd: string) {
  syncCalls.push(cmd);
  if (cmd.includes('worktree list --porcelain')) return '';
  if (cmd.includes('sparse-checkout list')) {
    const err: any = new Error('not sparse');
    err.status = 1;
    throw err;
  }
  if (cmd.includes('branch -D')) {
    const err: any = new Error('branch not found');
    err.status = 1;
    throw err;
  }
  if (cmd.includes('rev-list --count')) return '0';
  return '';
}

function mockExecFile(
  file: string,
  args: string[],
  opts: Record<string, unknown>,
  cb: (err: Error | null, stdout?: string, stderr?: string) => void,
) {
  fileCalls.push({ file, args, opts });
  const frozen = args.includes('--frozen-lockfile');
  const msg = frozen ? installErrors.frozen : installErrors.unfrozen;
  if (msg) return cb(new Error(msg));
  return cb(null, '', '');
}

/** Absolute path → repo-relative-inside-the-worktree, or null if outside. */
function relInWorktree(abs: string): string | null {
  for (const root of [WT, `${WT}-wworker-1`]) {
    if (abs === root) return '.';
    if (abs.startsWith(`${root}/`)) return abs.slice(root.length + 1);
  }
  return null;
}

function mockExistsSync(abs: string): boolean {
  const rel = relInWorktree(abs);
  if (rel === null) return false;
  if (rel === '.buildd/env.yaml') return manifestYaml !== null;
  return treeFiles.has(rel);
}

/** Immediate subdirectories of `abs`, derived from `treeFiles`. */
function mockReaddirSync(abs: string): Array<{ name: string; isDirectory: () => boolean }> {
  const rel = relInWorktree(abs);
  if (rel === null) return [];
  const prefix = rel === '.' ? '' : `${rel}/`;
  const names = new Set<string>();
  for (const f of treeFiles) {
    if (prefix && !f.startsWith(prefix)) continue;
    const seg = f.slice(prefix.length).split('/');
    if (seg.length > 1) names.add(seg[0]);
  }
  return [...names].map(name => ({ name, isDirectory: () => true }));
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setupWorktree, __setGitOpsDeps, __resetGitOpsDeps } = require('../../src/git-operations');

afterAll(() => {
  __resetGitOpsDeps();
});

beforeEach(() => {
  syncCalls = [];
  fileCalls = [];
  treeFiles = new Set(['package.json', 'bun.lock']);
  manifestYaml = null;
  installErrors = {};
  __setGitOpsDeps({
    execSync: mockExecSync as any,
    execFile: mockExecFile as any,
    existsSync: mockExistsSync as any,
    readdirSync: mockReaddirSync as any,
    mkdirSync: (() => {}) as any,
    readFileSync: ((p: string) => {
      if (relInWorktree(p) === '.buildd/env.yaml') return manifestYaml ?? '';
      return '# exclude\n';
    }) as any,
    appendFileSync: () => {},
    rmSync: () => {},
    sessionLog: () => {},
  });
});

const installs = () => fileCalls.filter(c => c.file === 'bun' && c.args[0] === 'install');
const setup = () => setupWorktree(REPO, BRANCH, DEFAULT_BRANCH, 'worker-1');

describe('install location', () => {
  test('installs at the worktree root when the root carries the lockfile', async () => {
    const result = await setup();

    expect(installs().length).toBe(1);
    expect(installs()[0].opts.cwd).toBe(WT);
    expect(result.install).toEqual({ status: 'ok', dirs: ['.'] });
  });

  test('install resolves a nested manifest', async () => {
    treeFiles = new Set(['packages/api/package.json', 'packages/api/bun.lock']);

    const result = await setup();

    expect(installs().length).toBe(1);
    expect(installs()[0].opts.cwd).toBe(`${WT}/packages/api`);
    expect(result.install).toEqual({ status: 'ok', dirs: ['packages/api'] });
  });

  test('no manifest anywhere: zero bun invocations, and it is NOT called drift', async () => {
    treeFiles = new Set(['README.md']);

    const result = await setup();

    expect(installs()).toEqual([]);
    expect(result.install).toEqual({ status: 'skipped', reason: 'no-manifest' });
  });

  test('a non-bun toolchain is skipped honestly rather than half-installed', async () => {
    treeFiles = new Set(['Cargo.toml', 'Cargo.lock']);

    const result = await setup();

    expect(installs()).toEqual([]);
    expect(result.install).toEqual({ status: 'skipped', reason: 'non-bun-toolchain' });
  });

  test('a declared .buildd/env.yaml install command defers to the provision gate', async () => {
    manifestYaml = 'install:\n  command: bun install --frozen-lockfile\n';

    const result = await setup();

    // Exactly one owner each: declared repos → the gate, undeclared → here.
    expect(installs()).toEqual([]);
    expect(result.install).toEqual({ status: 'skipped', reason: 'declared-manifest' });
  });
});

describe('install failure is classified and surfaced', () => {
  test('a silent install failure is now surfaced on the setup result', async () => {
    installErrors = {
      frozen: 'error: lockfile had changes, but lockfile is frozen',
      unfrozen: 'error: failed to resolve dependency',
    };

    const result = await setup();

    expect(result.install.status).toBe('failed');
    expect(result.install.dir).toBe('.');
    expect(result.install.message).toContain('failed to resolve');
    // The class describes the attempt that actually gave up, not the first one:
    // the frozen attempt's drift was answered (by the retry), and what remains
    // unexplained is the unfrozen failure.
    expect(result.install.failure).toBe('unknown');
    // Setup itself still succeeds: a degraded tree beats no tree.
    expect(result.path).toBe(WT);
  });

  test('both attempts rejecting the lockfile reports lockfile-drift', async () => {
    installErrors = {
      frozen: 'error: lockfile had changes, but lockfile is frozen',
      unfrozen: 'error: lockfile would be modified but --no-save was passed',
    };

    const result = await setup();

    expect(result.install.status).toBe('failed');
    expect(result.install.failure).toBe('lockfile-drift');
  });

  test('the echoed `--frozen-lockfile` flag alone is never read as drift', async () => {
    // Every failure of the frozen attempt echoes the command line. Matching the
    // flag name would classify all of them as drift and retry all of them —
    // the same misattribution the old warning text made.
    installErrors = { frozen: 'Command failed: bun install --frozen-lockfile\nerror: EACCES' };

    const result = await setup();

    expect(installs().length).toBe(1);
    expect(result.install.failure).toBe('unknown');
  });

  test('drift DOES get the unfrozen retry', async () => {
    installErrors = { frozen: 'error: lockfile had changes, but lockfile is frozen' };

    const result = await setup();

    expect(installs().length).toBe(2);
    expect(installs()[1].args).not.toContain('--frozen-lockfile');
    expect(result.install).toEqual({ status: 'ok', dirs: ['.'], unfrozen: true });
  });

  test('a registry 401 is registry-auth and is NOT retried unfrozen', async () => {
    installErrors = { frozen: 'error: GET https://registry.example/pkg - 401 Unauthorized' };

    const result = await setup();

    // Retrying a credential fault just doubles the stall and misblames the lockfile.
    expect(installs().length).toBe(1);
    expect(result.install.status).toBe('failed');
    expect(result.install.failure).toBe('registry-auth');
  });

  test('a missing bun binary is toolchain-missing, not drift', async () => {
    installErrors = { frozen: 'spawn bun ENOENT' };

    const result = await setup();

    expect(installs().length).toBe(1);
    expect(result.install.failure).toBe('toolchain-missing');
  });

  test('a timeout is classified as timeout', async () => {
    installErrors = { frozen: 'Command failed: bun install --frozen-lockfile\nETIMEDOUT' };

    const result = await setup();

    expect(result.install.failure).toBe('timeout');
  });

  test('an unrecognised failure is unknown, never silently drift', async () => {
    installErrors = { frozen: 'error: something nobody has seen before' };

    const result = await setup();

    expect(installs().length).toBe(1);
    expect(result.install.failure).toBe('unknown');
  });
});
