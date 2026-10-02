/**
 * Warm repos (warm-repo.ts): restore a per-workspace git bundle + bun cache
 * before cloning, fall back to a normal clone on any failure, upload a new
 * generation on the refresh rules, and never put a credential in a snapshot.
 *
 * Real git, real tar, a fake snapshot store (FakeStore mirrors the Worker's
 * begin/put/commit semantics in apps/cloud-runner/src/snapshots.ts). The curl
 * transport is exercised against a real HTTP server in a child process at the
 * bottom (spawnSync blocks this thread, so the server cannot live in it).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  WARM_FETCH_REFRESH_BYTES,
  WARM_MAX_AGE_MS,
  WARM_BASE_REF,
  WarmRepoSession,
  assertSnapshotSafe,
  createCacheTarball,
  curlTransport,
  decideWarmRefresh,
  warmRepoEnabled,
  type SnapshotTransport,
} from '../../src/warm-repo';
import { ensureIsolatedClone } from '../../src/workspace';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

/** In-memory stand-in for the Worker's snapshot host. Keys are chosen here, as the Worker does. */
class FakeStore {
  files = new Map<string, Buffer>();
  manifests: Array<{ generation: string; createdAt: number; repoBytes: number; cacheBytes: number; defaultBranch: string }> = [];
  lock: string | null = null;
  calls: string[] = [];
  now = 1_000_000;
  unreachable = false;
  busy = false;

  transport(): SnapshotTransport {
    const s = this;
    return {
      getJson(path) {
        s.calls.push(`GET ${path}`);
        if (s.unreachable) return { status: 0, body: null };
        if (path !== '/warm') return { status: 404, body: null };
        const m = s.manifests.at(-1);
        return m ? { status: 200, body: m } : { status: 404, body: null };
      },
      download(path, file) {
        s.calls.push(`GET ${path}`);
        if (s.unreachable) return { status: 0, bytes: 0 };
        const b = s.files.get(path);
        if (!b) return { status: 404, bytes: 0 };
        writeFileSync(file, b);
        return { status: 200, bytes: b.length };
      },
      upload(path, file) {
        s.calls.push(`PUT ${path}`);
        const gen = path.split('/')[2];
        if (gen !== s.lock) return { status: 409, body: null };
        s.files.set(path, readFileSync(file));
        return { status: 201, body: null };
      },
      post(path, body) {
        s.calls.push(`POST ${path}`);
        if (path === '/warm/begin') {
          if (s.busy || s.lock) return { status: 409, body: { error: 'busy' } };
          s.lock = String(++s.now).padStart(16, '0');
          return { status: 201, body: { generation: s.lock } };
        }
        const m = /^\/warm\/(\d{16})\/commit$/.exec(path);
        if (m && m[1] === s.lock) {
          const repo = s.files.get(`/warm/${m[1]}/repo`);
          if (!repo) return { status: 409, body: null };
          const manifest = {
            generation: m[1]!, createdAt: s.now, repoBytes: repo.length,
            cacheBytes: s.files.get(`/warm/${m[1]}/cache`)?.length ?? 0,
            defaultBranch: (body as { defaultBranch: string }).defaultBranch,
          };
          s.manifests.push(manifest);
          s.lock = null;
          return { status: 201, body: manifest };
        }
        return { status: 404, body: null };
      },
    };
  }
}

let dir: string;
let origin: string;
let seedClone: string;
let store: FakeStore;
let lines: string[];

function session(opts: { cacheDir?: string; free?: number | null; now?: number } = {}) {
  return new WarmRepoSession({
    transport: store.transport(),
    cacheDir: opts.cacheDir ?? join(dir, 'cache'),
    tmpDir: join(dir, 'tmp'),
    freeBytes: () => (opts.free === undefined ? 100 * 1024 ** 3 : opts.free),
    now: () => opts.now ?? store.now,
    log: () => {},
  });
}

function pushCommit(file: string, content: string) {
  writeFileSync(join(seedClone, file), content);
  git(seedClone, 'add', file);
  git(seedClone, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', `add ${file}`);
  git(seedClone, 'push', '-q', 'origin', 'HEAD:main');
}

const phaseNames = () => lines.filter(l => l.startsWith('BUILDD_PHASE=')).map(l => l.split(' ')[0]!.slice('BUILDD_PHASE='.length));
const metric = (name: string) => {
  const l = lines.filter(x => x.startsWith(`BUILDD_METRIC=${name} `)).at(-1);
  return l === undefined ? undefined : Number(l.split(' ')[1]);
};
const sourceLine = () => lines.filter(l => l.startsWith('BUILDD_REPO_SOURCE=')).at(-1);

/** Clone like ensureIsolatedClone does, through the session's hooks. */
function cloneThrough(s: WarmRepoSession, wsId = 'ws-1') {
  return ensureIsolatedClone({ id: wsId, repo: origin }, join(dir, 'iso'), s.cloneHooks());
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'warm-repo-'));
  origin = join(dir, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  seedClone = join(dir, 'seed');
  execFileSync('git', ['clone', '-q', origin, seedClone], { stdio: 'pipe' });
  git(seedClone, 'checkout', '-q', '-b', 'main');
  pushCommit('README.md', 'hello\n');
  mkdirSync(join(dir, 'cache', 'is-number@7.0.0'), { recursive: true });
  writeFileSync(join(dir, 'cache', 'is-number@7.0.0', 'index.js'), 'module.exports = 1;\n');
  store = new FakeStore();
  lines = [];
  // Phase, metric and source lines (warm-repo.ts and the clone in
  // workspace.ts) print only in a cloud container, to stdout.
  prevExecutor = process.env.BUILDD_EXECUTOR;
  process.env.BUILDD_EXECUTOR = 'cloud';
  origLog = console.log;
  console.log = (...a: unknown[]) => {
    const l = a.map(String).join(' ');
    if (l.startsWith('BUILDD_')) lines.push(l);
  };
});

let prevExecutor: string | undefined;
let origLog: typeof console.log;

afterEach(() => {
  console.log = origLog;
  if (prevExecutor === undefined) delete process.env.BUILDD_EXECUTOR; else process.env.BUILDD_EXECUTOR = prevExecutor;
  rmSync(dir, { recursive: true, force: true });
});

describe('warmRepoEnabled', () => {
  test('only with BUILDD_WARM_REPO=1 and a snapshot URL', () => {
    expect(warmRepoEnabled({ BUILDD_WARM_REPO: '1', BUILDD_SNAPSHOT_URL: 'https://buildd-snapshots.invalid' })).toBe(true);
    expect(warmRepoEnabled({ BUILDD_WARM_REPO: '1' })).toBe(false);
    expect(warmRepoEnabled({ BUILDD_SNAPSHOT_URL: 'https://buildd-snapshots.invalid' })).toBe(false);
    expect(warmRepoEnabled({})).toBe(false);
  });
});

describe('restore before clone', () => {
  test('no snapshot: falls back to a normal clone, then seeds a generation even when the task failed', () => {
    const s = session();
    const path = cloneThrough(s);
    expect(git(path, 'log', '-1', '--format=%s')).toBe('add README.md');
    expect(sourceLine()).toBe('BUILDD_REPO_SOURCE=clone no_snapshot');
    expect(phaseNames()).toEqual(['clone_start', 'clone_end']);
    expect(metric('clone_bytes')).toBeGreaterThan(0);

    s.refresh('failed');
    expect(store.manifests).toHaveLength(1);
    expect(store.manifests[0]!.defaultBranch).toBe('main');
    expect(store.calls.filter(c => !c.startsWith('GET'))).toEqual([
      'POST /warm/begin',
      `PUT /warm/${store.manifests[0]!.generation}/repo`,
      `PUT /warm/${store.manifests[0]!.generation}/cache`,
      `POST /warm/${store.manifests[0]!.generation}/commit`,
    ]);
    expect(metric('warm_upload_bytes')).toBeGreaterThan(0);
  });

  test('second run restores instead of cloning, fetches what landed since, and extracts the cache', () => {
    session().refresh('failed'); // nothing cloned yet: no-op
    expect(store.calls).toEqual([]);
    const first = session();
    cloneThrough(first, 'ws-seed');
    first.refresh('completed');
    expect(store.manifests).toHaveLength(1);

    pushCommit('LATER.md', 'landed after the snapshot\n');
    lines = [];
    const cacheDir = join(dir, 'fresh-cache');
    const s = session({ cacheDir });
    const path = cloneThrough(s);

    expect(sourceLine()).toBe('BUILDD_REPO_SOURCE=warm');
    expect(phaseNames()).toEqual(['restore_warm_start', 'restore_warm_end', 'fetch_start', 'fetch_end']);
    expect(phaseNames()).not.toContain('clone_start');
    expect(metric('restore_bytes')).toBe(store.manifests[0]!.repoBytes);
    expect(metric('cache_bytes')).toBe(store.manifests[0]!.cacheBytes);
    expect(metric('fetch_bytes')).toBeGreaterThan(0);
    expect(metric('snapshot_age_ms')).toBe(0);

    // Indistinguishable from a clone for setupWorktree: real origin URL,
    // origin/HEAD, default branch checked out, up to date after the fetch.
    expect(git(path, 'remote', 'get-url', 'origin')).toBe(origin);
    expect(git(path, 'symbolic-ref', 'refs/remotes/origin/HEAD')).toBe('refs/remotes/origin/main');
    expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(path, 'rev-parse', 'origin/main')).toBe(git(seedClone, 'rev-parse', 'HEAD'));
    expect(git(path, 'rev-parse', '--abbrev-ref', 'main@{upstream}')).toBe('origin/main');
    expect(git(path, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(cacheDir, 'is-number@7.0.0', 'index.js'), 'utf-8')).toBe('module.exports = 1;\n');
  });

  test('records the snapshot tip it restored (before the fetch) under WARM_BASE_REF, so a park bundle can be built against it', () => {
    const first = session();
    cloneThrough(first, 'ws-seed');
    first.refresh('completed');
    const snapshotTip = git(seedClone, 'rev-parse', 'HEAD');
    pushCommit('LATER.md', 'landed after the snapshot\n');
    const path = cloneThrough(session());
    expect(git(path, 'rev-parse', WARM_BASE_REF)).toBe(snapshotTip);
    expect(git(path, 'rev-parse', 'origin/main')).not.toBe(snapshotTip);
  });

  test('a failed fetch after restore is logged with git\'s own error text', () => {
    const first = session();
    cloneThrough(first, 'ws-seed');
    first.refresh('completed');
    const logs: string[] = [];
    const s = new WarmRepoSession({ ...session().d, log: (m) => logs.push(m) });
    // The restored clone's origin points at a repo that is not there.
    ensureIsolatedClone({ id: 'ws-1', repo: join(dir, 'gone.git') }, join(dir, 'iso'), s.cloneHooks());
    const line = logs.find(l => l.startsWith('[warm] fetch after restore failed'));
    expect(line).toBeDefined();
    // The `fatal:` line that names the cause, not the trailing advice line.
    expect(line).toContain('gone.git');
  });

  test('disabled: no store call, reason disabled', () => {
    const s = session();
    s.disabled = true;
    cloneThrough(s);
    expect(store.calls).toEqual([]);
    expect(sourceLine()).toBe('BUILDD_REPO_SOURCE=clone disabled');
  });

  test('store unreachable: clone, reason unavailable, and no upload attempted afterwards', () => {
    store.unreachable = true;
    const s = session();
    cloneThrough(s);
    expect(sourceLine()).toBe('BUILDD_REPO_SOURCE=clone unavailable');
    s.refresh('completed');
    expect(store.calls.some(c => c.startsWith('POST'))).toBe(false);
  });

  test('snapshot larger than a quarter of free disk: skipped with reason disk', () => {
    const seed = session(); cloneThrough(seed, 'ws-seed'); seed.refresh('completed');
    lines = [];
    const s = session({ free: 1024 });
    const path = cloneThrough(s);
    expect(sourceLine()).toBe('BUILDD_REPO_SOURCE=clone disk');
    expect(phaseNames()).toEqual(['clone_start', 'clone_end']);
    expect(git(path, 'log', '-1', '--format=%s')).toBe('add README.md');
  });

  test('corrupt bundle: restore fails, the half-restored directory is removed, and a normal clone follows', () => {
    const seed = session(); cloneThrough(seed, 'ws-seed'); seed.refresh('completed');
    const gen = store.manifests[0]!.generation;
    store.files.set(`/warm/${gen}/repo`, Buffer.from('not a bundle'));
    lines = [];
    const s = session();
    const path = cloneThrough(s);
    expect(sourceLine()).toBe('BUILDD_REPO_SOURCE=clone restore_failed');
    expect(phaseNames()).toEqual(['restore_warm_start', 'restore_warm_end', 'clone_start', 'clone_end']);
    expect(git(path, 'log', '-1', '--format=%s')).toBe('add README.md');
    expect(git(path, 'remote', 'get-url', 'origin')).toBe(origin);
    // A corrupt generation is replaced on the next refresh, whatever the outcome.
    s.refresh('failed');
    expect(store.manifests).toHaveLength(2);
  });

  test('a missing cache object does not fail the restore', () => {
    const seed = session(); cloneThrough(seed, 'ws-seed'); seed.refresh('completed');
    store.files.delete(`/warm/${store.manifests[0]!.generation}/cache`);
    lines = [];
    cloneThrough(session({ cacheDir: join(dir, 'c2') }));
    expect(sourceLine()).toBe('BUILDD_REPO_SOURCE=warm');
    expect(existsSync(join(dir, 'c2', 'is-number@7.0.0'))).toBe(false);
  });

  test('an existing clone is reused untouched: no restore, no clone, no store call', () => {
    const s = session();
    cloneThrough(s);
    store.calls = []; lines = [];
    cloneThrough(session());
    expect(store.calls).toEqual([]);
    expect(lines).toEqual([]);
  });
});

describe('refresh rules', () => {
  test('decideWarmRefresh', () => {
    const warm = (ageMs: number, fetchBytes: number) => ({ source: 'warm' as const, ageMs, fetchBytes });
    expect(decideWarmRefresh({ source: 'clone', reason: 'no_snapshot' }, 'failed')).toBe('seed');
    expect(decideWarmRefresh({ source: 'clone', reason: 'restore_failed' }, 'wait_timeout')).toBe('seed');
    expect(decideWarmRefresh({ source: 'clone', reason: 'unavailable' }, 'completed')).toBe('none');
    expect(decideWarmRefresh({ source: 'clone', reason: 'disk' }, 'completed')).toBe('none');
    expect(decideWarmRefresh({ source: 'clone', reason: 'disabled' }, 'completed')).toBe('none');
    expect(decideWarmRefresh(warm(0, 0), 'completed')).toBe('none');
    expect(decideWarmRefresh(warm(WARM_MAX_AGE_MS + 1, 0), 'completed')).toBe('refresh');
    expect(decideWarmRefresh(warm(0, WARM_FETCH_REFRESH_BYTES + 1), 'completed')).toBe('refresh');
    // Only after success, so a failing task never spends its exit on an upload.
    expect(decideWarmRefresh(warm(WARM_MAX_AGE_MS + 1, 0), 'failed')).toBe('none');
    expect(decideWarmRefresh(warm(WARM_MAX_AGE_MS + 1, 0), 'wait_timeout')).toBe('none');
  });

  test('a fresh warm restore uploads nothing; an old one uploads a new generation after success', () => {
    const seed = session(); cloneThrough(seed, 'ws-seed'); seed.refresh('completed');
    const fresh = session();
    cloneThrough(fresh, 'ws-a');
    store.calls = [];
    fresh.refresh('completed');
    expect(store.calls).toEqual([]);

    const old = session({ now: store.now + WARM_MAX_AGE_MS + 1 });
    cloneThrough(old, 'ws-b');
    old.refresh('completed');
    expect(store.manifests).toHaveLength(2);
  });

  test('another refresh in flight (begin 409): nothing uploaded, no throw', () => {
    store.busy = true;
    const s = session();
    cloneThrough(s);
    expect(() => s.refresh('completed')).not.toThrow();
    expect(store.calls.filter(c => c.startsWith('PUT'))).toEqual([]);
    expect(store.manifests).toHaveLength(0);
  });

  test('an upload failure leaves no commit (the generation stays invisible)', () => {
    const s = session();
    cloneThrough(s);
    const t = store.transport();
    const upload = t.upload;
    (s as unknown as { d: { transport: SnapshotTransport } }).d.transport = { ...t, upload: (p, f) => (p.endsWith('/repo') ? { status: 500, body: null } : upload(p, f)) };
    s.refresh('failed');
    expect(store.manifests).toHaveLength(0);
    expect(store.calls.some(c => c.endsWith('/commit'))).toBe(false);
  });
});

describe('snapshots never contain credentials', () => {
  const SECRET = 'ghs_warmRepoTestSecretValue1234567890';

  function cloneOnly() {
    const s = session();
    const path = cloneThrough(s);
    return { s, path };
  }

  test.each([
    ['credential helper in .git/config', (p: string) => git(p, 'config', 'credential.helper', `store --file=/tmp/${SECRET}`)],
    ['per-URL credential config', (p: string) => git(p, 'config', 'credential.https://github.com.username', 'x-access-token')],
    ['token in an https remote', (p: string) => git(p, 'remote', 'set-url', 'origin', `https://x-access-token:${SECRET}@github.com/acme/widget.git`)],
    ['token in an extra header', (p: string) => git(p, 'config', 'http.https://github.com/.extraheader', `AUTHORIZATION: basic ${SECRET}`)],
  ])('refuses to upload with %s', (_label, taint) => {
    const { s, path } = cloneOnly();
    taint(path);
    expect(() => assertSnapshotSafe(path)).toThrow();
    s.refresh('failed');
    expect(store.calls.some(c => c.startsWith('POST') || c.startsWith('PUT'))).toBe(false);
    for (const b of store.files.values()) expect(b.includes(SECRET)).toBe(false);
  });

  test('the bundle carries remote refs only: no config, no hooks, no untracked or env files, no local task branches', () => {
    const { s, path } = cloneOnly();
    // Things that sit on the disk of a clone and must not travel.
    git(path, 'config', 'buildd.probe', SECRET);
    writeFileSync(join(path, '.env'), `GITHUB_TOKEN=${SECRET}\n`);
    writeFileSync(join(path, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\necho ${SECRET}\n`);
    git(path, 'checkout', '-q', '-b', 'buildd/task-branch');
    writeFileSync(join(path, 'wip.txt'), `${SECRET}\n`);
    git(path, 'add', 'wip.txt');
    git(path, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'unpushed work');
    git(path, 'checkout', '-q', 'main');

    s.refresh('failed');
    const gen = store.manifests[0]!.generation;
    const bundle = store.files.get(`/warm/${gen}/repo`)!;
    expect(bundle.includes(SECRET)).toBe(false);
    const heads = bundle.toString('latin1').split('\n\n')[0]!;
    expect(heads).toContain('refs/remotes/origin/main');
    expect(heads).not.toContain('refs/heads/');

    // And the restored clone has none of it.
    const restored = cloneThrough(session(), 'ws-restored');
    expect(existsSync(join(restored, '.env'))).toBe(false);
    expect(existsSync(join(restored, '.git', 'hooks', 'post-checkout'))).toBe(false);
    expect(readFileSync(join(restored, '.git', 'config'), 'utf-8')).not.toContain(SECRET);
    expect(readFileSync(join(restored, '.git', 'config'), 'utf-8')).not.toMatch(/credential|extraheader/);
    expect(() => git(restored, 'rev-parse', '--verify', 'refs/heads/buildd/task-branch')).toThrow();
  });

  test('the cache tarball leaves out registry config and env files, and holds no env secret', () => {
    const cacheDir = join(dir, 'cache');
    writeFileSync(join(cacheDir, '.npmrc'), `//registry.npmjs.org/:_authToken=${SECRET}\n`);
    writeFileSync(join(cacheDir, '.env'), `NPM_TOKEN=${SECRET}\n`);
    mkdirSync(join(cacheDir, 'pkg@1.0.0'), { recursive: true });
    writeFileSync(join(cacheDir, 'pkg@1.0.0', '.env.local'), `X=${SECRET}\n`);
    writeFileSync(join(cacheDir, '.netrc'), `machine github.com password ${SECRET}\n`);
    const prev = process.env.NPM_TOKEN;
    process.env.NPM_TOKEN = SECRET; // role env reaches bun install as env, never the cache
    try {
      const out = join(dir, 'cache.tar');
      createCacheTarball(cacheDir, out);
      const tar = readFileSync(out);
      expect(tar.includes(SECRET)).toBe(false);
      const list = execFileSync('tar', ['-tf', out], { encoding: 'utf-8' }).split('\n').filter(Boolean);
      expect(list.some(l => l.endsWith('is-number@7.0.0/index.js'))).toBe(true);
      expect(list.some(l => /(^|\/)\.(npmrc|env|netrc)/.test(l))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.NPM_TOKEN; else process.env.NPM_TOKEN = prev;
    }
  });
});

describe('curlTransport against a real HTTP server', () => {
  test('GET json, download, upload, POST, and unreachable', async () => {
    const serverScript = join(dir, 'server.ts');
    writeFileSync(serverScript, `
      const stored = new Map();
      const s = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
        const p = new URL(req.url).pathname;
        if (req.method === 'GET' && p === '/warm') return Response.json({ ok: 1 });
        if (req.method === 'PUT') { stored.set(p, new Uint8Array(await req.arrayBuffer())); return new Response(JSON.stringify({ len: req.headers.get('content-length') }), { status: 201 }); }
        if (req.method === 'GET' && stored.has(p)) return new Response(stored.get(p));
        if (req.method === 'POST') return Response.json({ got: await req.json() }, { status: 201 });
        return new Response('nope', { status: 404 });
      } });
      console.log('PORT=' + s.port);
    `);
    const child = spawn(process.execPath, [serverScript], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        child.stdout!.on('data', (d: Buffer) => { const m = /PORT=(\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); });
        child.on('exit', () => reject(new Error('server exited')));
      });
      const t = curlTransport(`http://127.0.0.1:${port}`);
      expect(t.getJson('/warm')).toEqual({ status: 200, body: { ok: 1 } });
      expect(t.getJson('/missing').status).toBe(404);
      const src = join(dir, 'up.bin');
      writeFileSync(src, Buffer.alloc(3000, 7));
      expect(t.upload('/warm/x/repo', src)).toEqual({ status: 201, body: { len: '3000' } });
      const dst = join(dir, 'down.bin');
      expect(t.download('/warm/x/repo', dst)).toEqual({ status: 200, bytes: 3000 });
      expect(statSync(dst).size).toBe(3000);
      expect(t.post('/warm/begin', { a: 1 })).toEqual({ status: 201, body: { got: { a: 1 } } });
      expect(t.download('/nothing', join(dir, 'n.bin')).status).toBe(404);
      expect(existsSync(join(dir, 'n.bin'))).toBe(false);
    } finally {
      child.kill();
    }
    expect(curlTransport('http://127.0.0.1:1').getJson('/warm').status).toBe(0);
  });
});
