/**
 * `buildd top --dev` / `buildd top-dev`: a separate dev checkout, moved to the
 * newest `origin dev` on every run, `bun install` only when the lockfile
 * changed, the last checkout (said to be stale) when the fetch fails, and the
 * production checkout never modified.
 *
 * Real git against temp repos in a temp HOME; `bun install` and top itself are
 * stand-ins. Never touches ~/.buildd or ~/.buildd-dev.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'path';
import { runTopDev, type TopDevDeps } from '../../src/top-dev';

const nodeFs = require('fs') as typeof import('fs');
const ROOT = nodeFs.mkdtempSync(join(require('os').tmpdir(), 'top-dev-'));
afterAll(() => nodeFs.rmSync(ROOT, { recursive: true, force: true }));

let T: string;
let UPSTREAM: string;
let WORK: string;
let HOME: string;
let PROD: string;
let DEV: string;

function sh(args: string[], cwd: string): string {
  const r = Bun.spawnSync(['git', ...args], {
    cwd, stdout: 'pipe', stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: T, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' },
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function write(rel: string, content: string) {
  nodeFs.mkdirSync(join(WORK, rel, '..'), { recursive: true });
  nodeFs.writeFileSync(join(WORK, rel), content);
}

/** Commit to the upstream's `branch` through the working clone. */
function commit(branch: string, files: Record<string, string>, msg: string): string {
  sh(['checkout', '-q', branch], WORK);
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  sh(['add', '-A'], WORK);
  sh(['commit', '-q', '-m', msg], WORK);
  sh(['push', '-q', 'origin', branch], WORK);
  return sh(['rev-parse', 'HEAD'], WORK);
}

function setupUpstream() {
  T = nodeFs.mkdtempSync(join(ROOT, 'case-'));
  UPSTREAM = join(T, 'upstream.git');
  WORK = join(T, 'work');
  HOME = join(T, 'home');
  PROD = join(HOME, '.buildd');
  DEV = join(HOME, '.buildd-dev');
  nodeFs.mkdirSync(HOME, { recursive: true });
  sh(['init', '-q', '--bare', '-b', 'main', UPSTREAM], T);
  sh(['clone', '-q', UPSTREAM, WORK], T);
  sh(['checkout', '-q', '-b', 'main'], WORK);
  write('package.json', '{"name":"buildd","private":true,"workspaces":["apps/*","packages/*"]}');
  write('bun.lock', 'lock v1\n');
  write('scripts/stub-server-only.ts', '');
  write('apps/runner/package.json', '{"name":"@buildd/runner"}');
  write('apps/runner/src/index.ts', '// main\n');
  write('apps/web/page.tsx', '// web\n');
  sh(['add', '-A'], WORK);
  sh(['commit', '-q', '-m', 'main'], WORK);
  sh(['push', '-q', 'origin', 'main'], WORK);
  sh(['checkout', '-q', '-b', 'dev'], WORK);
  write('apps/runner/src/index.ts', '// dev 1\n');
  sh(['commit', '-q', '-am', 'dev 1'], WORK);
  sh(['push', '-q', 'origin', 'dev'], WORK);
}

/** A production checkout the way install.sh makes it: depth 1, sparse, main only. */
function installProdLikeInstallSh() {
  nodeFs.mkdirSync(PROD, { recursive: true });
  sh(['init', '-q'], PROD);
  sh(['remote', 'add', 'origin', UPSTREAM], PROD);
  sh(['config', 'core.sparseCheckout', 'true'], PROD);
  nodeFs.writeFileSync(join(PROD, '.git', 'info', 'sparse-checkout'), 'apps/runner/\nscripts/stub-server-only.ts\nbun.lock\npackage.json\n');
  sh(['fetch', '-q', '--depth', '1', 'origin', 'main'], PROD);
  sh(['checkout', '-q', '-B', 'main', 'origin/main'], PROD);
  nodeFs.writeFileSync(join(PROD, 'config.json'), '{"apiKey":"bld_test"}');
}

/** A full (non-shallow) production checkout, so --reference can borrow its objects. */
function installProdFull() {
  sh(['clone', '-q', '--branch', 'main', UPSTREAM, PROD], T);
  nodeFs.writeFileSync(join(PROD, 'config.json'), '{"apiKey":"bld_test"}');
}

function prodSnapshot() {
  const read = (p: string) => (nodeFs.existsSync(p) ? nodeFs.readFileSync(p, 'utf-8') : null);
  return {
    head: sh(['rev-parse', 'HEAD'], PROD),
    branch: sh(['rev-parse', '--abbrev-ref', 'HEAD'], PROD),
    status: sh(['status', '--porcelain', '--ignored'], PROD),
    refs: sh(['for-each-ref'], PROD),
    config: read(join(PROD, '.git', 'config')),
    sparse: read(join(PROD, '.git', 'info', 'sparse-checkout')),
    shallow: read(join(PROD, '.git', 'shallow')),
    alternates: read(join(PROD, '.git', 'objects', 'info', 'alternates')),
    files: nodeFs.readdirSync(PROD).sort(),
    userConfig: read(join(PROD, 'config.json')),
  };
}

interface Calls { installs: string[]; tops: Array<{ dir: string; args: string[]; env: Record<string, string> }>; logs: string[] }
let calls: Calls;
let installResult: { code: number; stderr: string };
let topExit: number;

function deps(): Partial<TopDevDeps> {
  return {
    install: async (dir) => {
      calls.installs.push(dir);
      if (installResult.code === 0) nodeFs.mkdirSync(join(dir, 'node_modules'), { recursive: true });
      return installResult;
    },
    runTop: async (dir, args, env) => { calls.tops.push({ dir, args, env }); return topExit; },
    log: (line) => { calls.logs.push(line); },
  };
}

const run = (topArgs: string[] = []) => runTopDev({ prodDir: PROD, devDir: DEV, topArgs, deps: deps() });
const devHead = () => sh(['rev-parse', 'HEAD'], DEV);
const upstreamDev = () => sh(['rev-parse', 'dev'], UPSTREAM);

beforeEach(() => {
  calls = { installs: [], tops: [], logs: [] };
  installResult = { code: 0, stderr: '' };
  topExit = 0;
});

describe('first run', () => {
  test('clones dev beside the production checkout, installs once, runs top from it', async () => {
    setupUpstream();
    installProdLikeInstallSh();
    const before = prodSnapshot();

    expect(await run(['--mission', 'm1'])).toBe(0);

    expect(devHead()).toBe(upstreamDev());
    expect(nodeFs.readFileSync(join(DEV, 'apps/runner/src/index.ts'), 'utf-8')).toBe('// dev 1\n');
    expect(calls.installs).toEqual([DEV]);
    expect(calls.tops).toHaveLength(1);
    expect(calls.tops[0].dir).toBe(DEV);
    expect(calls.tops[0].args).toEqual(['--mission', 'm1']);
    expect(calls.tops[0].env.BUILDD_TOP_CHANNEL).toBe('dev');
    expect(calls.tops[0].env.BUILDD_TOP_BUILD).toBe(upstreamDev().slice(0, 7));
    expect(calls.tops[0].env.BUILDD_TOP_NOTICE ?? '').toBe('');
    // The same runner-only tree as production: the web app is not checked out.
    expect(nodeFs.existsSync(join(DEV, 'apps/web/page.tsx'))).toBe(false);

    expect(prodSnapshot()).toEqual(before);
  });

  test('a full production checkout lends its objects (--reference) and the dev clone dissociates from it', async () => {
    setupUpstream();
    installProdFull();
    const before = prodSnapshot();

    expect(await run()).toBe(0);
    expect(devHead()).toBe(upstreamDev());
    // --dissociate: the dev clone owns its objects; deleting ~/.buildd cannot break it.
    expect(nodeFs.existsSync(join(DEV, '.git', 'objects', 'info', 'alternates'))).toBe(false);
    expect(sh(['fsck', '--connectivity-only'], DEV)).toBe('');
    expect(prodSnapshot()).toEqual(before);
  });

  test('with no network it fails with a clear message and leaves nothing behind', async () => {
    setupUpstream();
    installProdLikeInstallSh();
    nodeFs.renameSync(UPSTREAM, UPSTREAM + '.offline');
    const before = prodSnapshot();

    expect(await run()).toBe(1);
    expect(calls.tops).toHaveLength(0);
    const said = calls.logs.join('\n');
    expect(said).toContain('Could not download the dev build');
    expect(said).toContain('buildd top');
    expect(nodeFs.existsSync(DEV)).toBe(false);
    expect(prodSnapshot()).toEqual(before);
  });
});

describe('later runs', () => {
  test('nothing new: no install, same checkout', async () => {
    setupUpstream();
    installProdLikeInstallSh();
    await run();
    calls = { installs: [], tops: [], logs: [] };
    expect(await run()).toBe(0);
    expect(calls.installs).toEqual([]);
    expect(calls.tops).toHaveLength(1);
  });

  test('a new dev commit is checked out; install runs only when bun.lock changed', async () => {
    setupUpstream();
    installProdLikeInstallSh();
    const before = prodSnapshot();
    await run();

    const codeOnly = commit('dev', { 'apps/runner/src/index.ts': '// dev 2\n' }, 'dev 2');
    calls = { installs: [], tops: [], logs: [] };
    expect(await run()).toBe(0);
    expect(devHead()).toBe(codeOnly);
    expect(calls.installs).toEqual([]);
    expect(calls.tops[0].env.BUILDD_TOP_BUILD).toBe(codeOnly.slice(0, 7));

    const lockChange = commit('dev', { 'bun.lock': 'lock v2\n' }, 'dev 3');
    calls = { installs: [], tops: [], logs: [] };
    expect(await run()).toBe(0);
    expect(devHead()).toBe(lockChange);
    expect(calls.installs).toEqual([DEV]);

    calls = { installs: [], tops: [], logs: [] };
    expect(await run()).toBe(0);
    expect(calls.installs).toEqual([]);

    expect(prodSnapshot()).toEqual(before);
  });

  test('a failed fetch runs the last dev checkout and says it is stale', async () => {
    setupUpstream();
    installProdLikeInstallSh();
    await run();
    const last = devHead();
    commit('dev', { 'apps/runner/src/index.ts': '// unreachable\n' }, 'dev 2');
    nodeFs.renameSync(UPSTREAM, UPSTREAM + '.offline');
    const before = prodSnapshot();

    calls = { installs: [], tops: [], logs: [] };
    expect(await run()).toBe(0);
    expect(devHead()).toBe(last);
    expect(calls.tops).toHaveLength(1);
    const notice = calls.tops[0].env.BUILDD_TOP_NOTICE;
    expect(notice).toContain('Could not update the dev build');
    expect(notice).toContain(last.slice(0, 7));
    expect(calls.tops[0].env.BUILDD_TOP_STALE).toBe('1');
    expect(calls.logs.join('\n')).toContain('Could not update the dev build');
    expect(prodSnapshot()).toEqual(before);
  });

  test('a failed install for a new lockfile goes back to the last dev commit that worked', async () => {
    setupUpstream();
    installProdLikeInstallSh();
    await run();
    const good = devHead();
    commit('dev', { 'bun.lock': 'lock broken\n' }, 'dev 2');

    installResult = { code: 1, stderr: 'error: lockfile had changes, but lockfile is frozen' };
    calls = { installs: [], tops: [], logs: [] };
    expect(await run()).toBe(0);
    expect(devHead()).toBe(good);
    expect(calls.tops[0].env.BUILDD_TOP_NOTICE).toContain('bun install failed');
    expect(calls.tops[0].env.BUILDD_TOP_BUILD).toBe(good.slice(0, 7));
  });

  test("top's restart code is never passed on to the launcher's restart loop", async () => {
    setupUpstream();
    installProdLikeInstallSh();
    topExit = 75;
    expect(await run()).toBe(1);
  });
});

describe('it only ever resets its own checkout', () => {
  test('BUILDD_DEV_DIR pointing at (or inside) the production install is refused', async () => {
    setupUpstream();
    installProdLikeInstallSh();
    const before = prodSnapshot();
    for (const devDir of [PROD, join(PROD, 'dev')]) {
      calls = { installs: [], tops: [], logs: [] };
      expect(await runTopDev({ prodDir: PROD, devDir, topArgs: [], deps: deps() })).toBe(1);
      expect(calls.logs.join('\n')).toContain('outside the production install');
      expect(calls.tops).toHaveLength(0);
    }
    expect(prodSnapshot()).toEqual(before);
  });

  test('a git checkout it did not make is left alone', async () => {
    setupUpstream();
    installProdLikeInstallSh();
    sh(['clone', '-q', UPSTREAM, DEV], T);
    const head = devHead();
    nodeFs.writeFileSync(join(DEV, 'mine.txt'), 'keep');
    expect(await run()).toBe(1);
    expect(calls.logs.join('\n')).toContain('did not make');
    expect(devHead()).toBe(head);
    expect(nodeFs.existsSync(join(DEV, 'mine.txt'))).toBe(true);
  });
});
