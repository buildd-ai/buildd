import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runScipGraph } from '../knowledge-store/scip-runner';
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
