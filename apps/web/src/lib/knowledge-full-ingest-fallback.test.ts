// The serverless fallback for `full` ingest jobs no runner will take.
//
// Regression: full jobs only ran when a runner offered a checkout of the repo,
// and with no runner holding a usable clone they sat `queued` for weeks. The
// fallback reads the repo through the GitHub tree/blob API at the job's sha, a
// bounded slice per cron tick, and resumes from a cursor stored on the job.
import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  runFullIngestFallbackTick,
  fallbackClaimGuard,
  FALLBACK_LEASE_OWNER,
  type FallbackDeps,
  type FallbackJob,
  type FallbackStore,
} from './knowledge-full-ingest-fallback';

const HOUR = 60 * 60 * 1000;
const T0 = new Date('2026-10-02T12:00:00Z');

function queuedJob(overrides: Partial<FallbackJob> = {}): FallbackJob {
  return {
    id: 'job-1',
    workspaceId: 'ws-1',
    repo: 'test-org/test-repo',
    sha: 'sha-1',
    scope: 'full',
    status: 'queued',
    attempts: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    startedAt: null,
    // Queued well past the stall window: no runner is offering this repo.
    createdAt: new Date(T0.getTime() - 3 * HOUR),
    stats: null,
    ...overrides,
  };
}

/** In-memory job table honouring the same CAS rules the drizzle store uses. */
function memoryStore(jobs: FallbackJob[]) {
  const rows = new Map(jobs.map(j => [j.id, { ...j }]));
  const store: FallbackStore = {
    async listCandidates() {
      return [...rows.values()]
        .filter(
          j =>
            j.scope === 'full' &&
            (j.status === 'queued' || (j.status === 'running' && j.leaseOwner === FALLBACK_LEASE_OWNER)),
        )
        .map(j => ({ ...j }));
    },
    async claim(job, patch) {
      const row = rows.get(job.id);
      if (!row) return null;
      if (job.status === 'queued' && row.status !== 'queued') return null;
      if (job.status === 'running') {
        if (row.status !== 'running' || row.leaseOwner !== FALLBACK_LEASE_OWNER) return null;
        if ((row.heartbeatAt?.getTime() ?? null) !== (job.heartbeatAt?.getTime() ?? null)) return null;
      }
      Object.assign(row, patch);
      return { ...row };
    },
    async save(jobId, patch) {
      const row = rows.get(jobId);
      if (!row || row.status !== 'running' || row.leaseOwner !== FALLBACK_LEASE_OWNER) return false;
      Object.assign(row, patch);
      return true;
    },
  };
  return { store, rows };
}

interface FakeRepo {
  files: Record<string, string>;
  truncated?: boolean;
  defaultBranchSha?: string;
}

function fakeGithub(repo: FakeRepo, opts: { failBlob?: (path: string) => boolean } = {}) {
  const calls: string[] = [];
  const blobPath = new Map<string, string>();
  const github = async (_installationId: number, path: string): Promise<any> => {
    calls.push(path);
    if (/\/git\/trees\//.test(path)) {
      return {
        truncated: !!repo.truncated,
        tree: Object.entries(repo.files).map(([p, content]) => {
          const sha = `blob-${p}`;
          blobPath.set(sha, p);
          return { path: p, type: 'blob', sha, size: Buffer.byteLength(content) };
        }),
      };
    }
    const blob = path.match(/\/git\/blobs\/(.+)$/);
    if (blob) {
      const p = blobPath.get(decodeURIComponent(blob[1]))!;
      if (opts.failBlob?.(p)) throw new Error('GitHub API error: 502 bad gateway');
      return { encoding: 'base64', content: Buffer.from(repo.files[p]).toString('base64') };
    }
    if (/\/commits\//.test(path)) return { sha: repo.defaultBranchSha ?? 'sha-head' };
    if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) return { default_branch: 'main' };
    throw new Error(`unexpected GitHub call ${path}`);
  };
  return { github, calls };
}

function deps(over: Partial<FallbackDeps> & Pick<FallbackDeps, 'store' | 'github'>) {
  const ingested: string[][] = [];
  const sweeps: Array<{ workspaceId: string; since: Date }> = [];
  const d: FallbackDeps = {
    installationIdForRepo: async () => 42,
    ingestBatch: async (_ws, files) => {
      ingested.push(files.map(f => f.path));
      return {
        filesIngested: files.length,
        chunksUpserted: files.length,
        filesSkipped: 0,
        filesDeleted: 0,
        skippedUnchanged: 0,
      };
    },
    sweep: async (workspaceId, since) => {
      sweeps.push({ workspaceId, since });
      return 2;
    },
    ...over,
  };
  return { deps: d, ingested, sweeps };
}

const repoFiles = {
  'src/a.ts': 'export const a = 1;',
  'src/b.ts': 'export const b = 2;',
  'docs/guide.md': '# Guide\n\nText.',
  'assets/logo.png': 'binary-ish',
};

describe('runFullIngestFallbackTick', () => {
  it('leaves a queued job alone while a runner may still take it', async () => {
    const fresh = queuedJob({ createdAt: new Date(T0.getTime() - 5 * 60 * 1000) });
    const { store, rows } = memoryStore([fresh]);
    const { github, calls } = fakeGithub({ files: repoFiles });
    const { deps: d } = deps({ store, github });
    const out = await runFullIngestFallbackTick(d, { now: () => T0 });
    expect(out.claimed).toEqual([]);
    expect(calls).toEqual([]);
    expect(rows.get('job-1')!.status).toBe('queued');
  });

  it('runs a stalled job end to end in one tick when it fits, then sweeps and completes', async () => {
    const { store, rows } = memoryStore([queuedJob()]);
    const { github } = fakeGithub({ files: repoFiles });
    const { deps: d, ingested, sweeps } = deps({ store, github });

    const out = await runFullIngestFallbackTick(d, { now: () => T0 });

    expect(out.claimed).toEqual(['job-1']);
    expect(out.completed).toEqual(['job-1']);
    // Filtered (no png), deterministic path order.
    expect(ingested.flat()).toEqual(['docs/guide.md', 'src/a.ts', 'src/b.ts']);
    const row = rows.get('job-1')!;
    expect(row.status).toBe('done');
    expect(row.leaseOwner).toBeNull();
    expect(row.finishedAt).toBeInstanceOf(Date);
    expect(row.stats).toMatchObject({ mode: 'serverless-fallback', sha: 'sha-1', filesIngested: 3, prunedChunks: 2 });
    // The sweep is anchored on the first claim of this run.
    expect(sweeps).toEqual([{ workspaceId: 'ws-1', since: T0 }]);
  });

  it('resolves the default branch head for a job with no sha', async () => {
    const { store, rows } = memoryStore([queuedJob({ sha: null })]);
    const { github, calls } = fakeGithub({ files: repoFiles, defaultBranchSha: 'sha-main' });
    const { deps: d } = deps({ store, github });
    await runFullIngestFallbackTick(d, { now: () => T0 });
    expect(calls).toContain('/repos/test-org/test-repo/git/trees/sha-main?recursive=1');
    expect(rows.get('job-1')!.stats).toMatchObject({ sha: 'sha-main' });
  });

  it('stops at the tick budget, stores a cursor, and resumes on the next tick without redoing work', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`src/f${String(i).padStart(2, '0')}.ts`] = `export const v${i} = ${i};`;
    const { store, rows } = memoryStore([queuedJob()]);
    const { github } = fakeGithub({ files });
    const { deps: d, ingested } = deps({ store, github });

    // Each clock read advances 1s; a 3.5s budget allows only a few batches of 2.
    let t = T0.getTime();
    const clock = () => new Date((t += 1000));
    const first = await runFullIngestFallbackTick(d, { now: clock, budgetMs: 3_500, batchFiles: 2 });
    expect(first.completed).toEqual([]);
    const afterFirst = rows.get('job-1')!;
    expect(afterFirst.status).toBe('running');
    expect(afterFirst.leaseOwner).toBe(FALLBACK_LEASE_OWNER);
    const cursor = (afterFirst.stats as any).fallback.cursor;
    expect(cursor).toBeGreaterThan(0);
    expect(cursor).toBeLessThan(10);
    expect(ingested.flat().length).toBe(cursor);

    // Following ticks pick the running job back up and finish it.
    for (let i = 0; i < 10 && rows.get('job-1')!.status === 'running'; i++) {
      await runFullIngestFallbackTick(d, { now: clock, budgetMs: 3_500, batchFiles: 2 });
    }
    expect(rows.get('job-1')!.status).toBe('done');
    // Every file exactly once: resuming never re-sends what already landed.
    expect(ingested.flat()).toEqual(Object.keys(files).sort());
  });

  it('a second overlapping tick cannot claim the same running job', async () => {
    const running = queuedJob({
      status: 'running',
      leaseOwner: FALLBACK_LEASE_OWNER,
      heartbeatAt: new Date(T0.getTime() - HOUR),
      startedAt: new Date(T0.getTime() - 2 * HOUR),
      stats: { fallback: { sha: 'sha-1', cursor: 0, startedAt: new Date(T0.getTime() - 2 * HOUR).toISOString() } },
    });
    const { store } = memoryStore([running]);
    const stale = { ...running };
    // Someone else advances the heartbeat first.
    await store.claim(stale, { heartbeatAt: T0 });
    const { github } = fakeGithub({ files: repoFiles });
    const { deps: d } = deps({
      store: { ...store, listCandidates: async () => [stale] },
      github,
    });
    const out = await runFullIngestFallbackTick(d, { now: () => T0 });
    expect(out.claimed).toEqual([]);
    expect(out.raceLost).toBe(1);
  });

  it('keeps going after a transient failure and records it, without losing progress', async () => {
    const { store, rows } = memoryStore([queuedJob()]);
    let failing = true;
    const { github } = fakeGithub({ files: repoFiles }, { failBlob: p => failing && p === 'src/a.ts' });
    const { deps: d } = deps({ store, github });

    const first = await runFullIngestFallbackTick(d, { now: () => T0, batchFiles: 1 });
    expect(first.errors).toEqual([{ id: 'job-1', error: expect.stringContaining('502') }]);
    const row = rows.get('job-1')!;
    expect(row.status).toBe('running');
    expect((row.stats as any).fallback).toMatchObject({ cursor: 1, failures: 1 });

    failing = false;
    await runFullIngestFallbackTick(d, { now: () => new Date(T0.getTime() + HOUR), batchFiles: 1 });
    expect(rows.get('job-1')!.status).toBe('done');
  });

  it('parks the job in error after repeated failing ticks', async () => {
    const { store, rows } = memoryStore([queuedJob()]);
    const { github } = fakeGithub({ files: repoFiles }, { failBlob: () => true });
    const { deps: d } = deps({ store, github });
    for (let i = 0; i < 10 && rows.get('job-1')!.status !== 'error'; i++) {
      await runFullIngestFallbackTick(d, { now: () => new Date(T0.getTime() + i * HOUR) });
    }
    const row = rows.get('job-1')!;
    expect(row.status).toBe('error');
    expect(row.error).toContain('serverless fallback');
    expect(row.leaseOwner).toBeNull();
  });

  it('fails a repo whose tree listing GitHub truncated, instead of indexing part of it', async () => {
    const { store, rows } = memoryStore([queuedJob()]);
    const { github } = fakeGithub({ files: repoFiles, truncated: true });
    const { deps: d, ingested } = deps({ store, github });
    await runFullIngestFallbackTick(d, { now: () => T0 });
    expect(rows.get('job-1')!.status).toBe('error');
    expect(rows.get('job-1')!.error).toMatch(/truncated/);
    expect(ingested).toEqual([]);
  });

  it('fails immediately when the repo has no GitHub installation', async () => {
    const { store, rows } = memoryStore([queuedJob()]);
    const { github } = fakeGithub({ files: repoFiles });
    const { deps: d } = deps({
      store,
      github,
      installationIdForRepo: async () => {
        throw new Error('no GitHub installation bound for repo test-org/test-repo');
      },
    });
    await runFullIngestFallbackTick(d, { now: () => T0 });
    expect(rows.get('job-1')!.status).toBe('error');
    expect(rows.get('job-1')!.error).toContain('no GitHub installation');
  });

  it('skips binary blobs', async () => {
    const { store } = memoryStore([queuedJob()]);
    const { github } = fakeGithub({ files: { 'src/a.ts': 'ok', 'src/b.ts': 'bin\u0000ary' } });
    const { deps: d, ingested } = deps({ store, github });
    await runFullIngestFallbackTick(d, { now: () => T0 });
    expect(ingested.flat()).toEqual(['src/a.ts']);
  });
});

describe('fallbackClaimGuard (rendered SQL)', () => {
  const dialect = new PgDialect();
  const render = (job: Parameters<typeof fallbackClaimGuard>[0]) => {
    const q = dialect.sqlToQuery(fallbackClaimGuard(job)!);
    return { sql: q.sql, params: q.params };
  };

  it('a queued job is claimed only while still queued', () => {
    const { sql, params } = render({ id: 'job-1', status: 'queued', heartbeatAt: null });
    expect(sql).toContain('"status" = $2');
    expect(params).toEqual(['job-1', 'queued']);
  });

  it('a job already ours is claimed only under our lease and the heartbeat we read', () => {
    const beat = new Date('2026-10-02T11:00:00Z');
    const { sql, params } = render({ id: 'job-1', status: 'running', heartbeatAt: beat });
    expect(sql).toContain('"lease_owner" = $3');
    expect(sql).toContain('"heartbeat_at" = $4');
    expect(params.slice(0, 3)).toEqual(['job-1', 'running', FALLBACK_LEASE_OWNER]);
  });

  it('a NULL heartbeat is matched with IS NULL, not = NULL', () => {
    const { sql } = render({ id: 'job-1', status: 'running', heartbeatAt: null });
    expect(sql).toContain('"heartbeat_at" is null');
  });
});
