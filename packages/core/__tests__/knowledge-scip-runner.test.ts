import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { runScipGraph, scipProjectArgs } from '../knowledge-store/scip-runner';
import { SCIP_ROLE_DEFINITION } from '../knowledge-store/scip-parser';

// Minimal SCIP protobuf encoder — one document, one definition occurrence.
function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n & 0x7f);
  return out;
}
const tag = (f: number, w: number) => varint((f << 3) | w);
const lenDelim = (f: number, b: number[]) => [...tag(f, 2), ...varint(b.length), ...b];
const strField = (f: number, s: string) => lenDelim(f, [...Buffer.from(s, 'utf8')]);
const intField = (f: number, n: number) => [...tag(f, 0), ...varint(n)];

function sampleIndexBuffer(): Buffer {
  const sym = 'scip-typescript npm mypkg 1.0.0 `src`/`math.ts`/add().';
  const occ = [...strField(2, sym), ...intField(3, SCIP_ROLE_DEFINITION)];
  const doc = [...strField(1, 'src/math.ts'), ...lenDelim(2, occ)];
  return Buffer.from(lenDelim(2, doc));
}

const tmpDirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'scip-run-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('runScipGraph', () => {
  it('produces a graph when the indexer succeeds', async () => {
    const buf = sampleIndexBuffer();
    let invoked = 0;
    const res = await runScipGraph({
      repoPath: '/does/not/matter',
      sha: 'abc123',
      workspaceId: 'ws-1',
      cacheDir: scratch(),
      invoke: () => {
        invoked++;
      },
      readIndexFile: () => buf,
    });
    expect(invoked).toBe(1);
    expect(res.cached).toBe(false);
    expect(res.graph).not.toBeNull();
    expect(res.graph!.edges.some(e => e.type === 'defines' && e.toEntityKey === 'src/math.ts#add')).toBe(true);
  });

  it('degrades to a null graph (never throws) when the binary is unavailable', async () => {
    const res = await runScipGraph({
      repoPath: '/tmp/repo',
      workspaceId: 'ws-1',
      cacheDir: scratch(),
      invoke: () => {
        throw new Error('scip-typescript unavailable');
      },
    });
    expect(res.graph).toBeNull();
    expect(res.skippedReason).toContain('unavailable');
  });

  it('reports no-index-produced when the indexer leaves no readable output', async () => {
    const res = await runScipGraph({
      repoPath: '/tmp/repo',
      workspaceId: 'ws-1',
      cacheDir: scratch(),
      invoke: () => {},
      readIndexFile: () => null,
    });
    expect(res.graph).toBeNull();
    expect(res.skippedReason).toBe('no-index-produced');
  });

  it('reuses a cached index for the same sha and skips re-running the indexer', async () => {
    const cacheDir = scratch();
    // Pre-seed the SHA-keyed cache file (content check → reuse).
    const cachePath = join(cacheDir, `owner_name-cafebabe.scip`);
    writeFileSync(cachePath, sampleIndexBuffer());

    let invoked = 0;
    const res = await runScipGraph({
      repoPath: '/tmp/repo',
      sha: 'cafebabe',
      workspaceId: 'ws-1',
      repoSlug: 'owner/name',
      cacheDir,
      invoke: () => {
        invoked++;
      },
    });
    expect(invoked).toBe(0); // indexer NOT run — cache hit
    expect(res.cached).toBe(true);
    expect(res.graph).not.toBeNull();
  });
});

describe('runScipGraph with an async indexer', () => {
  // The real indexer takes minutes on a monorepo. It must run off the event
  // loop, so runScipGraph has to await an invoke that returns a promise
  // rather than read the output file before it exists.
  it('waits for a promise-returning invoke before reading the index', async () => {
    const dir = scratch();
    const result = await runScipGraph({
      repoPath: dir,
      workspaceId: 'ws-1',
      cacheDir: dir,
      invoke: async ({ outputPath }) => {
        await new Promise((r) => setTimeout(r, 10));
        writeFileSync(outputPath, sampleIndexBuffer());
      },
    });
    expect(result.skippedReason).toBeUndefined();
    expect(result.graph).not.toBeNull();
  });
});

describe('scipProjectArgs', () => {
  const touch = (root: string, rel: string, body = '{}') => {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };

  it('passes no projects when the repo root has its own tsconfig.json', () => {
    const dir = scratch();
    touch(dir, 'tsconfig.json');
    touch(dir, 'package.json', JSON.stringify({ workspaces: ['apps/*'] }));
    touch(dir, 'apps/web/tsconfig.json');
    expect(scipProjectArgs(dir)).toEqual([]);
  });

  // A bun/npm workspace monorepo has no root tsconfig, and scip-typescript run
  // bare in its root indexes nothing ("missing tsconfig.json") on every job.
  it('lists each workspace package that has a tsconfig.json when the root has none', () => {
    const dir = scratch();
    touch(dir, 'package.json', JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }));
    touch(dir, 'apps/web/tsconfig.json');
    touch(dir, 'apps/runner/package.json'); // no tsconfig — skipped
    touch(dir, 'packages/shared/tsconfig.json');
    touch(dir, 'packages/core/package.json');
    expect(scipProjectArgs(dir)).toEqual(['apps/web', 'packages/shared']);
  });

  it('accepts the object form of workspaces and a literal (non-glob) entry', () => {
    const dir = scratch();
    touch(dir, 'package.json', JSON.stringify({ workspaces: { packages: ['tools/cli', 'libs/*'] } }));
    touch(dir, 'tools/cli/tsconfig.json');
    touch(dir, 'libs/a/tsconfig.json');
    expect(scipProjectArgs(dir)).toEqual(['libs/a', 'tools/cli']);
  });

  it('passes no projects for a repo with neither a root tsconfig nor workspaces', () => {
    const dir = scratch();
    touch(dir, 'package.json', JSON.stringify({ name: 'x' }));
    expect(scipProjectArgs(dir)).toEqual([]);
  });

  it('passes no projects (never throws) when package.json is unreadable', () => {
    const dir = scratch();
    touch(dir, 'package.json', '{not json');
    expect(scipProjectArgs(dir)).toEqual([]);
  });
});
