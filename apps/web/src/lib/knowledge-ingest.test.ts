process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── Fake GitHub API ──────────────────────────────────────────────────────────
// Dispatches on path: PR file listings and contents fetches.
let prFilePages: Array<Array<Record<string, unknown>>> = [];
let contentsByPath: Record<string, { content: string; size?: number }> = {};
let githubApiCalls: string[] = [];
let githubApiError: Error | null = null;

const mockGithubApi = mock(async (_installationId: number, path: string) => {
  githubApiCalls.push(path);
  if (githubApiError) throw githubApiError;

  const filesMatch = path.match(/\/pulls\/\d+\/files\?per_page=\d+&page=(\d+)/);
  if (filesMatch) {
    const page = parseInt(filesMatch[1], 10);
    return prFilePages[page - 1] ?? [];
  }

  const contentsMatch = path.match(/\/contents\/(.+)\?ref=/);
  if (contentsMatch) {
    const filePath = decodeURIComponent(contentsMatch[1]);
    const entry = contentsByPath[filePath];
    if (!entry) throw new Error(`GitHub API error: 404 no contents for ${filePath}`);
    const raw = Buffer.from(entry.content, 'utf8');
    return {
      content: raw.toString('base64'),
      encoding: 'base64',
      size: entry.size ?? raw.byteLength,
    };
  }

  throw new Error(`unexpected githubApi path: ${path}`);
});

mock.module('@/lib/github', () => ({
  githubApi: mockGithubApi,
}));

// ── Fake DB ──────────────────────────────────────────────────────────────────
import { knowledgeIngestJobs, githubRepos, workspaces, workers } from '@buildd/core/db/schema';

type Row = Record<string, any>;
let claimResult: Row[] = [];
let updateCalls: Array<{ table: any; set: Row }> = [];
let insertCalls: Array<{ table: any; values: Row }> = [];
let insertReturning: Row[] = [{ id: 'new-job-1' }];
let selectResults: (table: any) => Row[] = () => [];
let joinResults: (table: any) => Row[] = () => [];

mock.module('@buildd/core/db', () => ({
  db: {
    update: (table: any) => ({
      set: (set: Row) => ({
        where: (_c: any) => ({
          returning: () => {
            updateCalls.push({ table, set });
            if (set.status === 'running') return Promise.resolve(claimResult);
            return Promise.resolve([{ id: 'job-1' }]);
          },
        }),
      }),
    }),
    insert: (table: any) => ({
      values: (values: Row) => {
        insertCalls.push({ table, values });
        return {
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve(insertReturning),
          }),
        };
      },
    }),
    select: (_cols: any) => ({
      from: (table: any) => ({
        innerJoin: (_t2: any, _c: any) => ({
          where: (_c2: any) => Promise.resolve(joinResults(table)),
        }),
        where: (_c: any) => Promise.resolve(selectResults(table)),
      }),
    }),
  },
}));

// ── Fake knowledge store ─────────────────────────────────────────────────────
// chunkPrDiff stays real: it's pure and the A3 tests assert on its output shape.
import { chunkPrDiff } from '@buildd/core/knowledge-store/pr-diff-chunker';

let namespaces: string[] = [];
let deleteBySourceCalls: Array<{ namespace: string; sourcePath?: string }> = [];
let upsertCalls: Array<{ namespace: string; chunkCount: number; chunks: any[] }> = [];

class FakePgVectorStore {
  async listNamespaces() {
    return namespaces;
  }
  async deleteBySource(namespace: string, selector: { sourcePath?: string }) {
    deleteBySourceCalls.push({ namespace, sourcePath: selector.sourcePath });
  }
  async upsert(namespace: string, chunks: any[]) {
    upsertCalls.push({ namespace, chunkCount: chunks.length, chunks });
  }
}

mock.module('@buildd/core/knowledge-store', () => ({
  PgVectorStore: FakePgVectorStore,
  getVoyageEmbedder: () => null,
  buildNamespace: (workspaceId: string, corpus: string) => `${workspaceId}:${corpus}`,
  chunkPrDiff,
  // Simplified stand-in for the real ingestFiles: delete-then-upsert one chunk per file.
  ingestFiles: async (store: any, workspaceId: string, corpus: string, files: Array<{ path: string; content: string }>) => {
    const ns = `${workspaceId}:${corpus}`;
    for (const f of files) {
      await store.deleteBySource(ns, { sourcePath: f.path });
      await store.upsert(ns, [{ id: `${f.path}#1`, content: f.content }]);
    }
    return { files: files.length, chunks: files.length };
  },
}));

// Import AFTER mocks
import { enqueueMergedPrIngestJobs, runDiffIngestJob, MAX_DIFF_FILES } from './knowledge-ingest';

// ── Helpers ──────────────────────────────────────────────────────────────────
const baseJob = {
  id: 'job-1',
  workspaceId: 'ws-1',
  repo: 'test-org/test-repo',
  trigger: 'pr_merged',
  sha: 'merge-sha-1',
  prNumber: 42,
  scope: 'diff',
  status: 'running',
};

function resetAll() {
  prFilePages = [];
  contentsByPath = {};
  githubApiCalls = [];
  githubApiError = null;
  mockGithubApi.mockClear();

  claimResult = [{ ...baseJob }];
  updateCalls = [];
  insertCalls = [];
  insertReturning = [{ id: 'new-job-1' }];
  selectResults = () => [];
  // Join queries dispatch on the FROM table: repo→installation lookup vs
  // worker→task lookup (A3 metadata enrichment).
  joinResults = (table: any) => (table === githubRepos ? [{ installationId: 9001 }] : []);

  namespaces = ['ws-1:code'];
  deleteBySourceCalls = [];
  upsertCalls = [];
}

function finalUpdate(): Row | undefined {
  return updateCalls.filter(c => c.set.status !== 'running').at(-1)?.set;
}

// ── enqueueMergedPrIngestJobs ────────────────────────────────────────────────
describe('enqueueMergedPrIngestJobs', () => {
  beforeEach(resetAll);

  it('returns [] and inserts nothing when the repo is not bound to any workspace', async () => {
    selectResults = () => []; // no github_repos row, no workspaces
    const ids = await enqueueMergedPrIngestJobs({
      repoFullName: 'unbound/repo',
      prNumber: 7,
      sha: 'sha-7',
    });
    expect(ids).toEqual([]);
    expect(insertCalls.length).toBe(0);
  });

  it('enqueues one diff job per bound workspace with onConflictDoNothing', async () => {
    selectResults = (table: any) => {
      if (table === githubRepos) return [{ id: 'repo-uuid-1' }];
      if (table === workspaces) return [{ id: 'ws-1' }, { id: 'ws-2' }];
      return [];
    };
    const ids = await enqueueMergedPrIngestJobs({
      repoFullName: 'test-org/test-repo',
      prNumber: 42,
      sha: 'merge-sha-1',
    });
    expect(ids.length).toBe(2);
    expect(insertCalls.length).toBe(2);
    expect(insertCalls[0].table).toBe(knowledgeIngestJobs);
    expect(insertCalls[0].values).toMatchObject({
      workspaceId: 'ws-1',
      repo: 'test-org/test-repo',
      trigger: 'pr_merged',
      sha: 'merge-sha-1',
      prNumber: 42,
      scope: 'diff',
      status: 'queued',
    });
    expect(insertCalls[1].values.workspaceId).toBe('ws-2');
  });

  it('skips duplicate jobs (conflict → no returned row → no id)', async () => {
    selectResults = (table: any) => {
      if (table === githubRepos) return [{ id: 'repo-uuid-1' }];
      if (table === workspaces) return [{ id: 'ws-1' }];
      return [];
    };
    insertReturning = []; // simulated ON CONFLICT DO NOTHING
    const ids = await enqueueMergedPrIngestJobs({
      repoFullName: 'test-org/test-repo',
      prNumber: 42,
      sha: 'merge-sha-1',
    });
    expect(ids).toEqual([]);
    expect(insertCalls.length).toBe(1); // insert attempted, conflict swallowed
  });
});

// ── runDiffIngestJob ─────────────────────────────────────────────────────────
describe('runDiffIngestJob', () => {
  beforeEach(resetAll);

  it('is a no-op when the job is not in queued state (atomic claim)', async () => {
    claimResult = [];
    const result = await runDiffIngestJob('job-1');
    expect(result).toEqual({ claimed: false });
    expect(mockGithubApi).not.toHaveBeenCalled();
    expect(updateCalls.length).toBe(1); // only the claim attempt
  });

  it('happy path: ingests changed files, deletes removed files, records stats', async () => {
    prFilePages = [[
      { filename: 'src/app.ts', status: 'modified' },
      { filename: 'src/old.ts', status: 'removed' },
      { filename: 'src/app.test.ts', status: 'modified' }, // filtered
      { filename: 'docs/guide.md', status: 'added' },
    ]];
    contentsByPath = {
      'src/app.ts': { content: 'export const app = 1;' },
      'docs/guide.md': { content: '# Guide' },
    };

    const result = await runDiffIngestJob('job-1');
    expect(result.claimed).toBe(true);
    expect((result as any).status).toBe('done');

    // Removed file cleaned out of the code namespace
    expect(deleteBySourceCalls).toContainEqual({ namespace: 'ws-1:code', sourcePath: 'src/old.ts' });
    // Kept files upserted into corpus-appropriate namespaces
    expect(upsertCalls.some(c => c.namespace === 'ws-1:code')).toBe(true);
    expect(upsertCalls.some(c => c.namespace === 'ws-1:docs')).toBe(true);

    const done = finalUpdate();
    expect(done?.status).toBe('done');
    expect(done?.finishedAt).toBeInstanceOf(Date);
    expect(done?.stats).toMatchObject({
      filesIngested: 2,
      filesDeleted: 1,
      filesSkipped: 1,
      chunksUpserted: 2,
    });
    // No escalation, no backfill (code namespace pre-existed)
    expect(insertCalls.length).toBe(0);
  });

  it('handles renamed files: deletes the old path and ingests the new one', async () => {
    prFilePages = [[
      { filename: 'src/new-name.ts', status: 'renamed', previous_filename: 'src/old-name.ts' },
    ]];
    contentsByPath = { 'src/new-name.ts': { content: 'export const x = 1;' } };

    const result = await runDiffIngestJob('job-1');
    expect((result as any).status).toBe('done');
    expect(deleteBySourceCalls).toContainEqual({ namespace: 'ws-1:code', sourcePath: 'src/old-name.ts' });
    expect(upsertCalls.some(c => c.namespace === 'ws-1:code')).toBe(true);
  });

  it('escalates to a full job when the PR touches more than MAX_DIFF_FILES files', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `src/f${i}.ts`, status: 'modified' }));
    const page2 = Array.from({ length: 10 }, (_, i) => ({ filename: `src/g${i}.ts`, status: 'modified' }));
    prFilePages = [page1, page2];

    const result = await runDiffIngestJob('job-1');
    expect((result as any).status).toBe('done');

    const done = finalUpdate();
    expect((done?.stats as any).escalated).toBe(true);

    // A full-scope job was enqueued for the same workspace/sha
    expect(insertCalls.length).toBe(1);
    expect(insertCalls[0].values).toMatchObject({
      workspaceId: 'ws-1',
      scope: 'full',
      sha: 'merge-sha-1',
      status: 'queued',
    });
    // No contents were fetched, nothing was upserted
    expect(githubApiCalls.some(p => p.includes('/contents/'))).toBe(false);
    expect(upsertCalls.length).toBe(0);
    expect(MAX_DIFF_FILES).toBe(100);
  });

  it('escalates to a full job when fetched content exceeds the byte cap', async () => {
    const files = Array.from({ length: 5 }, (_, i) => ({ filename: `src/big${i}.ts`, status: 'modified' }));
    prFilePages = [files];
    contentsByPath = Object.fromEntries(
      files.map(f => [f.filename, { content: 'x', size: 500 * 1024 }]),
    );

    const result = await runDiffIngestJob('job-1');
    expect((result as any).status).toBe('done');
    expect((finalUpdate()?.stats as any).escalated).toBe(true);
    expect(insertCalls.length).toBe(1);
    expect(insertCalls[0].values.scope).toBe('full');
    expect(upsertCalls.length).toBe(0);
  });

  it('enqueues a full backfill job when the workspace had no pre-existing code index', async () => {
    namespaces = []; // fresh workspace
    prFilePages = [[{ filename: 'src/app.ts', status: 'modified' }]];
    contentsByPath = { 'src/app.ts': { content: 'export const app = 1;' } };

    const result = await runDiffIngestJob('job-1');
    expect((result as any).status).toBe('done');

    expect(insertCalls.length).toBe(1);
    expect(insertCalls[0].values).toMatchObject({
      workspaceId: 'ws-1',
      trigger: 'backfill',
      scope: 'full',
      status: 'queued',
    });
  });

  it('does not enqueue a backfill when the code namespace already exists', async () => {
    namespaces = ['ws-1:code'];
    prFilePages = [[{ filename: 'src/app.ts', status: 'modified' }]];
    contentsByPath = { 'src/app.ts': { content: 'export const app = 1;' } };

    await runDiffIngestJob('job-1');
    expect(insertCalls.length).toBe(0);
  });

  it('marks the job as error when the GitHub API fails', async () => {
    githubApiError = new Error('GitHub API error: 500 boom');

    const result = await runDiffIngestJob('job-1');
    expect(result.claimed).toBe(true);
    expect((result as any).status).toBe('error');

    const done = finalUpdate();
    expect(done?.status).toBe('error');
    expect(done?.error).toContain('boom');
    expect(done?.finishedAt).toBeInstanceOf(Date);
  });

  it('marks the job as error when no installation is bound to the repo', async () => {
    joinResults = () => [];
    const result = await runDiffIngestJob('job-1');
    expect((result as any).status).toBe('error');
    expect(finalUpdate()?.error).toContain('installation');
  });

  // ── A3: PR-diff corpus ─────────────────────────────────────────────────────

  const SAMPLE_PATCH = [
    '@@ -1,3 +1,4 @@',
    ' export function login() {',
    '+  audit("login");',
    '   return true;',
    ' }',
  ].join('\n');

  it('ingests per-file patch hunks into the pr corpus', async () => {
    prFilePages = [[
      { filename: 'src/auth.ts', status: 'modified', patch: SAMPLE_PATCH },
    ]];
    contentsByPath = { 'src/auth.ts': { content: 'export function login() {}' } };

    const result = await runDiffIngestJob('job-1');
    expect((result as any).status).toBe('done');

    const prUpserts = upsertCalls.filter(c => c.namespace === 'ws-1:pr');
    expect(prUpserts.length).toBe(1);
    const chunk = prUpserts[0].chunks[0];
    expect(chunk.id).toBe('pr:42#src/auth.ts');
    expect(chunk.content).toContain('+  audit("login");');
    expect(chunk.metadata).toMatchObject({ prNumber: 42, path: 'src/auth.ts', sha: 'merge-sha-1' });
    // No path-keyed supersession in the pr corpus: history stays retrievable.
    expect(chunk.sourcePath ?? null).toBeNull();

    expect((finalUpdate()?.stats as any).prChunksUpserted).toBe(1);
  });

  it('attaches taskId/missionId to pr chunks when a worker PR matches', async () => {
    prFilePages = [[{ filename: 'src/auth.ts', status: 'modified', patch: SAMPLE_PATCH }]];
    contentsByPath = { 'src/auth.ts': { content: 'x' } };
    joinResults = (table: any) => {
      if (table === githubRepos) return [{ installationId: 9001 }];
      if (table === workers) return [{ taskId: 'task-1', missionId: 'mission-1' }];
      return [];
    };

    await runDiffIngestJob('job-1');
    const chunk = upsertCalls.find(c => c.namespace === 'ws-1:pr')?.chunks[0];
    expect(chunk.metadata).toMatchObject({ taskId: 'task-1', missionId: 'mission-1' });
  });

  it('includes removed files with patches but skips filter-rejected paths and patchless files', async () => {
    prFilePages = [[
      { filename: 'src/gone.ts', status: 'removed', patch: SAMPLE_PATCH },
      { filename: 'src/auth.test.ts', status: 'modified', patch: SAMPLE_PATCH }, // filter-rejected
      { filename: 'assets/logo.png', status: 'added' }, // binary — no patch
    ]];

    const result = await runDiffIngestJob('job-1');
    expect((result as any).status).toBe('done');

    const prChunks = upsertCalls.filter(c => c.namespace === 'ws-1:pr').flatMap(c => c.chunks);
    expect(prChunks.map((c: any) => c.id)).toEqual(['pr:42#src/gone.ts']);
    expect(prChunks[0].metadata.status).toBe('removed');
  });

  it('upserts no pr chunks when no file carries a patch', async () => {
    prFilePages = [[{ filename: 'src/app.ts', status: 'modified' }]];
    contentsByPath = { 'src/app.ts': { content: 'export const app = 1;' } };

    await runDiffIngestJob('job-1');
    expect(upsertCalls.some(c => c.namespace === 'ws-1:pr')).toBe(false);
    expect((finalUpdate()?.stats as any).prChunksUpserted).toBe(0);
  });

  it('skips individual files larger than the per-file cap without escalating', async () => {
    prFilePages = [[
      { filename: 'src/huge.ts', status: 'modified' },
      { filename: 'src/ok.ts', status: 'modified' },
    ]];
    contentsByPath = {
      'src/huge.ts': { content: 'x', size: 600 * 1024 }, // > 512KB per-file cap
      'src/ok.ts': { content: 'export const ok = 1;' },
    };

    const result = await runDiffIngestJob('job-1');
    expect((result as any).status).toBe('done');
    const stats = finalUpdate()?.stats as any;
    expect(stats.escalated).toBeUndefined();
    expect(stats.filesIngested).toBe(1);
    expect(stats.filesSkipped).toBe(1);
  });
});
