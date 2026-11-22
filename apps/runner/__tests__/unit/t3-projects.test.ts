import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { cleanupTestWorkspace, getTestWorkspace } from '../test-workspace';
import { join } from 'path';
import { execFileSync } from 'child_process';
import {
  CLONE_RETRY_AFTER_MS,
  cloneIntoPlace,
  createT3ProjectSync,
  findT3Binary,
  t3AddProject,
  type T3SyncDeps,
  type T3Workspace,
} from '../../src/t3-projects';

const ROOT = join('/home/u', 'project');
const P = (name: string) => join(ROOT, name);

afterAll(() => cleanupTestWorkspace());

/** Deps with an in-memory disk: `local` maps repo -> path already cloned. */
function fakeDeps(workspaces: T3Workspace[], local: Record<string, string> = {}, extra: Partial<T3SyncDeps> = {}) {
  const disk = new Set<string>(Object.values(local));
  const calls = { clones: [] as string[], adds: [] as string[], rescans: 0 };
  let clock = 1_000_000;
  const deps: T3SyncDeps = {
    listWorkspaces: async () => workspaces,
    findLocal: async (ws) => (ws.repo && local[ws.repo]) || null,
    cloneInto: async (url, path) => {
      calls.clones.push(`${url} -> ${path}`);
      disk.add(path);
      const repo = workspaces.find(w => w.repo && url.includes(w.repo.replace(/^https:\/\/github.com\//, '').replace(/\.git$/, '')))?.repo;
      if (repo) local[repo] = path;
    },
    addProject: async (path, title) => { calls.adds.push(`${title} @ ${path}`); return 'added'; },
    pathExists: (p) => disk.has(p),
    rescan: async () => { calls.rescans++; },
    log: () => {},
    now: () => clock,
    ...extra,
  };
  return { deps, calls, disk, advance: (ms: number) => { clock += ms; } };
}

describe('createT3ProjectSync', () => {
  test('adds an existing clone without cloning it again', async () => {
    const { deps, calls } = fakeDeps(
      [{ id: 'w1', name: 'sample-app', repo: 'https://github.com/acme/sample-app' }],
      { 'https://github.com/acme/sample-app': `${P("sample-app")}` },
    );
    const r = await createT3ProjectSync(deps, { root: ROOT }).run();
    expect(calls.clones).toEqual([]);
    expect(calls.adds).toEqual([`sample-app @ ${P("sample-app")}`]);
    expect(r.added).toEqual([`${P("sample-app")}`]);
  });

  test('clones a missing repo into the first project root, then adds it', async () => {
    const { deps, calls } = fakeDeps([{ id: 'w1', name: 'Sample Lib', repo: 'acme/sample-lib' }]);
    const r = await createT3ProjectSync(deps, { root: ROOT }).run();
    expect(calls.clones).toEqual([`https://github.com/acme/sample-lib.git -> ${P("sample-lib")}`]);
    expect(calls.adds).toEqual([`sample-lib @ ${P("sample-lib")}`]);
    expect(r.cloned).toEqual([`${P("sample-lib")}`]);
    expect(calls.rescans).toBe(1);
  });

  test('skips workspaces with no repo', async () => {
    const { deps, calls } = fakeDeps([{ id: 'w1', name: '__coordination', repo: null }]);
    await createT3ProjectSync(deps, { root: ROOT }).run();
    expect(calls.clones).toEqual([]);
    expect(calls.adds).toEqual([]);
  });

  test('two workspaces on one repo make one clone and one project', async () => {
    const { deps, calls } = fakeDeps([
      { id: 'w1', name: 'cue', repo: 'https://github.com/acme/dispatch' },
      { id: 'w2', name: 'dispatch-ios', repo: 'acme/dispatch' },
    ]);
    await createT3ProjectSync(deps, { root: ROOT }).run();
    expect(calls.clones.length).toBe(1);
    expect(calls.adds).toEqual([`dispatch @ ${P("dispatch")}`]);
  });

  test('does not ask T3 again for a path it already registered or already had', async () => {
    let answer: 'added' | 'exists' = 'exists';
    const adds: string[] = [];
    const { deps } = fakeDeps(
      [{ id: 'w1', name: 'a', repo: 'acme/a' }],
      { 'acme/a': `${P("a")}` },
      { addProject: async (p) => { adds.push(p); return answer; } },
    );
    const sync = createT3ProjectSync(deps, { root: ROOT });
    const first = await sync.run();
    expect(first.added).toEqual([]);
    answer = 'added';
    await sync.run();
    expect(adds).toEqual([`${P("a")}`]);
  });

  test('leaves alone a folder at the clone path that is not this repo', async () => {
    const { deps, calls, disk } = fakeDeps([{ id: 'w1', name: 'infra', repo: 'acme/infrastructure' }]);
    disk.add(`${P("infrastructure")}`);
    const r = await createT3ProjectSync(deps, { root: ROOT }).run();
    expect(calls.clones).toEqual([]);
    expect(calls.adds).toEqual([]);
    expect(r.skipped[0]?.reason).toContain('already exists');
  });

  test('refuses a repo URL with shell metacharacters', async () => {
    const { deps, calls } = fakeDeps([{ id: 'w1', name: 'x', repo: 'https://github.com/acme/x;rm -rf ~' }]);
    const r = await createT3ProjectSync(deps, { root: ROOT }).run();
    expect(calls.clones).toEqual([]);
    expect(r.skipped.length).toBe(1);
  });

  test('a failed clone waits CLONE_RETRY_AFTER_MS before it is tried again', async () => {
    let tries = 0;
    const { deps, advance } = fakeDeps([{ id: 'w1', name: 'p', repo: 'acme/private' }], {}, {
      cloneInto: async () => { tries++; throw new Error('Authentication failed'); },
    });
    const sync = createT3ProjectSync(deps, { root: ROOT });
    const r = await sync.run();
    expect(r.failed[0]?.error).toContain('Authentication failed');
    await sync.run();
    expect(tries).toBe(1);
    advance(CLONE_RETRY_AFTER_MS + 1);
    await sync.run();
    expect(tries).toBe(2);
  });

  test('one T3 failure does not stop the rest', async () => {
    const adds: string[] = [];
    const { deps } = fakeDeps(
      [{ id: 'w1', name: 'a', repo: 'acme/a' }, { id: 'w2', name: 'b', repo: 'acme/b' }],
      { 'acme/a': `${P("a")}`, 'acme/b': `${P("b")}` },
      { addProject: async (p) => { if (p === P('a')) throw new Error('t3 down'); adds.push(p); return 'added'; } },
    );
    const r = await createT3ProjectSync(deps, { root: ROOT }).run();
    expect(adds).toEqual([`${P("b")}`]);
    expect(r.failed.map(f => f.error)).toEqual(['t3 down']);
  });

  test('overlapping runs share one pass', async () => {
    let lists = 0;
    const { deps } = fakeDeps([], {}, { listWorkspaces: async () => { lists++; return []; } });
    const sync = createT3ProjectSync(deps, { root: ROOT });
    await Promise.all([sync.run(), sync.run()]);
    expect(lists).toBe(1);
  });
});

// The real helpers, against a real git and a fake `t3`.
const posix = process.platform !== 'win32';

describe('cloneIntoPlace', () => {
  test.if(posix)('clones through a hidden temp folder and leaves no temp behind', async () => {
    const dir = mkdtempSync(join(getTestWorkspace(), 't3-clone-'));
    try {
      const src = join(dir, 'src');
      mkdirSync(src);
      const git = (...a: string[]) => execFileSync('git', ['-C', src, ...a], { stdio: 'ignore' });
      git('init', '-q');
      writeFileSync(join(src, 'README'), 'hi');
      git('add', '.');
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
      const root = join(dir, 'root');
      mkdirSync(root);
      const target = join(root, 'repo');
      await cloneIntoPlace(`file://${src}`, target);
      expect(existsSync(join(target, 'README'))).toBe(true);
      expect(readdirSync(root)).toEqual(['repo']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test.if(posix)('gives up without touching a folder that appeared during the clone', async () => {
    const dir = mkdtempSync(join(getTestWorkspace(), 't3-clone-'));
    try {
      const target = join(dir, 'repo');
      mkdirSync(target);
      writeFileSync(join(target, 'mine'), 'keep');
      await expect(cloneIntoPlace(`file://${join(dir, 'nope')}`, target)).rejects.toThrow();
      expect(existsSync(join(target, 'mine'))).toBe(true);
      expect(readdirSync(dir)).toEqual(['repo']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('t3AddProject', () => {
  function fakeT3(body: string) {
    const dir = mkdtempSync(join(getTestWorkspace(), 't3-bin-'));
    const bin = join(dir, 't3');
    writeFileSync(bin, `#!/bin/sh\n${body}\n`);
    chmodSync(bin, 0o755);
    return { dir, bin };
  }

  test.if(posix)('passes the path and title to `t3 project add`', async () => {
    const { dir, bin } = fakeT3(`echo "$@" > "${'$'}(dirname "$0")/args"; echo "Added project x"`);
    try {
      expect(await t3AddProject(bin, '/p/sample-lib', 'sample-lib')).toBe('added');
      expect(execFileSync('cat', [join(dir, 'args')], { encoding: 'utf8' }).trim()).toBe('project add /p/sample-lib --title sample-lib');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test.if(posix)('reads ProjectAlreadyExistsError as already there (T3 logs it on stdout)', async () => {
    const { dir, bin } = fakeT3(`echo "[17:49:07.083] ERROR (#2): ProjectAlreadyExistsError: An active project already exists"; exit 1`);
    try {
      expect(await t3AddProject(bin, '/p/a', 'a')).toBe('exists');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test.if(posix)('throws on any other failure', async () => {
    const { dir, bin } = fakeT3(`echo "ERROR (#2): WorkspaceRootNotExistsError: nope"; exit 1`);
    try {
      await expect(t3AddProject(bin, '/p/a', 'a')).rejects.toThrow('WorkspaceRootNotExistsError');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('findT3Binary', () => {
  test('finds ~/.local/bin/t3', () => {
    const h = mkdtempSync(join(getTestWorkspace(), 't3-home-'));
    try {
      mkdirSync(join(h, '.local', 'bin'), { recursive: true });
      writeFileSync(join(h, '.local', 'bin', 't3'), '');
      expect(findT3Binary({ home: h, which: () => null })).toBe(join(h, '.local', 'bin', 't3'));
    } finally { rmSync(h, { recursive: true, force: true }); }
  });

  test('falls back to PATH, and is null when T3 is not installed', () => {
    const h = mkdtempSync(join(getTestWorkspace(), 't3-home-'));
    try {
      expect(findT3Binary({ home: h, which: () => '/usr/bin/t3' })).toBe('/usr/bin/t3');
      expect(findT3Binary({ home: h, which: () => null })).toBeNull();
    } finally { rmSync(h, { recursive: true, force: true }); }
  });
});

describe('resolver.resolveExisting', () => {
  test.if(posix)('finds a clone by remote, and on a miss clones nothing and creates nothing', async () => {
    const { createWorkspaceResolver } = await import('../../src/workspace');
    const root = mkdtempSync(join(getTestWorkspace(), 't3-resolve-'));
    const iso = mkdtempSync(join(getTestWorkspace(), 't3-iso-'));
    try {
      const clone = join(root, 'local-name');
      mkdirSync(clone);
      execFileSync('git', ['-C', clone, 'init', '-q']);
      execFileSync('git', ['-C', clone, 'remote', 'add', 'origin', 'https://github.com/acme/thing.git']);
      const resolver = createWorkspaceResolver([root], iso);
      expect(await resolver.resolveExisting!({ id: 'w1', name: 'Thing', repo: 'acme/thing' })).toBe(clone);
      expect(await resolver.resolveExisting!({ id: 'w2', name: 'Other', repo: 'acme/other' })).toBeNull();
      expect(await resolver.resolveExisting!({ id: 'w3', name: 'norepo', repo: null })).toBeNull();
      expect(readdirSync(root)).toEqual(['local-name']);
      expect(readdirSync(iso)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(iso, { recursive: true, force: true });
    }
  });
});
