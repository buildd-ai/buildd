/**
 * Cloud containers install every Node lockfile toolchain, and can hand the
 * install back to the caller to run behind the agent session.
 *
 * Before: a pnpm repo logged "non-bun toolchain (pnpm) — skipping install" and
 * the agent improvised `pnpm install` itself, after a cache restore it also had
 * to wait for. Host runners keep the bun-only install, unchanged.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/cloud-install-toolchains.test.ts
 */

import { describe, test, expect, afterAll, beforeEach } from 'bun:test';

const REPO = '/repo';
const BRANCH = 'buildd/0000abcd-slug';
const WT = `${REPO}/.buildd-worktrees/buildd_0000abcd-slug`;

type FileCall = { file: string; args: string[]; opts: Record<string, unknown> };
let fileCalls: FileCall[] = [];
let treeFiles = new Set<string>();
let manifestYaml: string | null = null;
/** Error per `<bin> <args>` invocation. */
let failures: Record<string, string> = {};

function rel(abs: string): string | null {
  if (abs === WT) return '.';
  if (abs.startsWith(`${WT}/`)) return abs.slice(WT.length + 1);
  return null;
}

function mockExecSync(cmd: string) {
  if (cmd.includes('sparse-checkout list') || cmd.includes('branch -D')) {
    const err: any = new Error('no');
    err.status = 1;
    throw err;
  }
  if (cmd.includes('rev-list --count')) return '0';
  return '';
}

function mockExecFile(file: string, args: string[], opts: Record<string, unknown>, cb: (err: Error | null) => void) {
  fileCalls.push({ file, args, opts });
  const msg = failures[`${file} ${args.join(' ')}`];
  return cb(msg ? new Error(msg) : null);
}

function mockReaddirSync(abs: string) {
  const r = rel(abs);
  if (r === null) return [];
  const prefix = r === '.' ? '' : `${r}/`;
  const names = new Set<string>();
  for (const f of treeFiles) {
    if (prefix && !f.startsWith(prefix)) continue;
    const seg = f.slice(prefix.length).split('/');
    if (seg.length > 1) names.add(seg[0]);
  }
  return [...names].map(name => ({ name, isDirectory: () => true }));
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ops = require('../../src/git-operations');
const { installWorkspaceDeps, installCommandFor, classifyInstallFailure, setupWorktree, __setGitOpsDeps, __resetGitOpsDeps, CLOUD_INSTALL_TIMEOUT_MS } = ops;

afterAll(() => __resetGitOpsDeps());

beforeEach(() => {
  fileCalls = [];
  treeFiles = new Set(['package.json']);
  manifestYaml = null;
  failures = {};
  __setGitOpsDeps({
    execSync: mockExecSync as any,
    execFile: mockExecFile as any,
    existsSync: ((abs: string) => {
      const r = rel(abs);
      if (r === null) return false;
      if (r === '.buildd/env.yaml') return manifestYaml !== null;
      return treeFiles.has(r);
    }) as any,
    readdirSync: mockReaddirSync as any,
    mkdirSync: (() => {}) as any,
    readFileSync: ((p: string) => (rel(p) === '.buildd/env.yaml' ? manifestYaml ?? '' : '# exclude\n')) as any,
    appendFileSync: () => {},
    rmSync: () => {},
    sessionLog: () => {},
  });
});

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const orig = { log: console.log, warn: console.warn };
  console.log = () => {}; console.warn = () => {};
  try { return await fn(); } finally { Object.assign(console, orig); }
};
const cloudInstall = () => quiet(() => installWorkspaceDeps(WT, 'worker-1', undefined, { allToolchains: true, timeoutMs: CLOUD_INSTALL_TIMEOUT_MS }));
const invocations = () => fileCalls.map(c => `${c.file} ${c.args.join(' ')}`);

describe('installCommandFor: the frozen/ci form, scripts on', () => {
  test.each([
    ['bun', {}, 'bun', ['install', '--frozen-lockfile'], ['install']],
    ['pnpm', {}, 'pnpm', ['install', '--frozen-lockfile'], ['install', '--no-frozen-lockfile']],
    ['node', {}, 'npm', ['ci'], ['install']],
    ['yarn', {}, 'yarn', ['install', '--frozen-lockfile'], ['install']],
    ['yarn', { yarnBerry: true }, 'yarn', ['install', '--immutable'], ['install']],
  ] as const)('%s %o', (runtime, opts, bin, frozen, unfrozen) => {
    const c = installCommandFor(runtime, opts);
    expect(c).toEqual({ bin, frozen: [...frozen], unfrozen: [...unfrozen] });
    expect([...c.frozen, ...c.unfrozen]).not.toContain('--ignore-scripts');
  });

  test('toolchains the runner does not install', () => {
    for (const r of ['uv', 'python3', 'cargo', 'go']) expect(installCommandFor(r)).toBeNull();
  });
});

describe('cloud: every Node lockfile toolchain installs', () => {
  test.each([
    ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
    ['package-lock.json', 'npm ci'],
    ['yarn.lock', 'yarn install --frozen-lockfile'],
    ['bun.lock', 'bun install --frozen-lockfile'],
    ['bun.lockb', 'bun install --frozen-lockfile'],
  ])('%s → %s', async (lockfile, command) => {
    treeFiles.add(lockfile);
    const r = await cloudInstall();
    expect(r).toEqual({ status: 'ok', dirs: ['.'] });
    expect(invocations()).toEqual([command]);
    expect(fileCalls[0].opts.cwd).toBe(WT);
    expect(fileCalls[0].opts.timeout).toBe(CLOUD_INSTALL_TIMEOUT_MS);
  });

  test('yarn 2+ (.yarnrc.yml) uses --immutable', async () => {
    treeFiles.add('yarn.lock');
    treeFiles.add('.yarnrc.yml');
    await cloudInstall();
    expect(invocations()).toEqual(['yarn install --immutable']);
  });

  test('a pnpm lockfile the frozen install rejects is retried unfrozen', async () => {
    treeFiles.add('pnpm-lock.yaml');
    failures['pnpm install --frozen-lockfile'] = 'ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with package.json';
    expect(await cloudInstall()).toEqual({ status: 'ok', dirs: ['.'], unfrozen: true });
    expect(invocations()).toEqual(['pnpm install --frozen-lockfile', 'pnpm install --no-frozen-lockfile']);
  });

  test('a missing pnpm binary is toolchain-missing, not retried', async () => {
    treeFiles.add('pnpm-lock.yaml');
    failures['pnpm install --frozen-lockfile'] = 'spawn pnpm ENOENT';
    expect(await cloudInstall()).toMatchObject({ status: 'failed', failure: 'toolchain-missing', dir: '.' });
    expect(invocations()).toEqual(['pnpm install --frozen-lockfile']);
  });

  test('a python-only repo is still skipped honestly', async () => {
    treeFiles = new Set(['uv.lock', 'pyproject.toml']);
    expect(await cloudInstall()).toEqual({ status: 'skipped', reason: 'non-bun-toolchain' });
    expect(fileCalls).toEqual([]);
  });

  test('drift messages of npm and yarn 2+ classify as lockfile drift', () => {
    expect(classifyInstallFailure(new Error('`npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.'))).toBe('lockfile-drift');
    expect(classifyInstallFailure(new Error('The lockfile would have been modified by this install, which is explicitly forbidden.'))).toBe('lockfile-drift');
  });
});

describe('host runner: unchanged', () => {
  test('a pnpm repo is skipped without allToolchains', async () => {
    treeFiles.add('pnpm-lock.yaml');
    expect(await quiet(() => installWorkspaceDeps(WT, 'worker-1'))).toEqual({ status: 'skipped', reason: 'non-bun-toolchain' });
    expect(fileCalls).toEqual([]);
  });

  test('bun keeps its 120 s bound', async () => {
    treeFiles.add('bun.lock');
    await quiet(() => installWorkspaceDeps(WT, 'worker-1'));
    expect(fileCalls[0].opts.timeout).toBe(120_000);
  });

  test('setupWorktree without deferInstall installs inline, as before', async () => {
    treeFiles.add('bun.lock');
    const r = await quiet(() => setupWorktree(REPO, BRANCH, 'main', 'worker-1'));
    expect(r.install).toEqual({ status: 'ok', dirs: ['.'] });
    expect(r.deferredInstall).toBeUndefined();
  });
});

describe('setupWorktree deferInstall', () => {
  const setup = () => quiet(() => setupWorktree(REPO, BRANCH, 'main', 'worker-1', undefined, undefined, undefined, undefined, { deferInstall: true }));

  test('returns the install unstarted; nothing runs until the caller runs it', async () => {
    treeFiles.add('bun.lock');
    const r = await setup();
    expect(r.install).toEqual({ status: 'skipped', reason: 'deferred' });
    expect(fileCalls).toEqual([]);
    expect(await quiet(() => r.deferredInstall())).toEqual({ status: 'ok', dirs: ['.'] });
    expect(invocations()).toEqual(['bun install --frozen-lockfile']);
  });

  test('a declared .buildd/env.yaml is untouched: the provision gate owns it, nothing deferred', async () => {
    treeFiles.add('pnpm-lock.yaml');
    manifestYaml = 'install:\n  command: pnpm install --frozen-lockfile\n';
    const r = await setup();
    expect(r.install).toEqual({ status: 'skipped', reason: 'declared-manifest' });
    expect(r.deferredInstall).toBeUndefined();
    expect(fileCalls).toEqual([]);
  });
});

 test('verified handover never retries a frozen install unfrozen', async () => {
  treeFiles.add('pnpm-lock.yaml');
  failures['pnpm install --frozen-lockfile'] = 'ERR_PNPM_OUTDATED_LOCKFILE';
  const result = await quiet(() => installWorkspaceDeps(WT, 'worker-1', undefined, { allToolchains: true, frozenOnly: true }));
  expect(result.status).toBe('failed');
  expect(invocations()).toEqual(['pnpm install --frozen-lockfile']);
 });
