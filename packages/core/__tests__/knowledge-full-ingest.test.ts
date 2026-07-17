import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import * as childProcess from 'node:child_process';
const { execFileSync } = childProcess;
import { join } from 'path';
import { tmpdir } from 'os';
import {
  planFileBatches,
  runFullIngestJob,
  createGitRepoReader,
  MAX_BATCH_FILES,
  MAX_BATCH_BYTES,
  type FullIngestJob,
  type RepoReader,
  type FullIngestApiClient,
} from '../knowledge-store/full-ingest';

const job: FullIngestJob = {
  id: 'job-1',
  workspaceId: 'ws-1',
  repo: 'test-org/test-repo',
  sha: null,
  scope: 'full',
  trigger: 'backfill',
};

function fakeApi(overrides: Partial<FullIngestApiClient> = {}) {
  const pushed: Array<Array<{ path: string; content: string }>> = [];
  const completions: Array<Record<string, unknown>> = [];
  const api: FullIngestApiClient = {
    claimJob: async () => null,
    pushFiles: async (_jobId, files) => {
      pushed.push(files);
      return { filesIngested: files.length, chunksUpserted: files.length * 2, filesSkipped: 0, filesDeleted: 0 };
    },
    completeJob: async (_jobId, result) => {
      completions.push(result as Record<string, unknown>);
    },
    ...overrides,
  };
  return { api, pushed, completions };
}

function fakeReader(files: Record<string, string | null>, resolvedSha = 'sha-head'): RepoReader {
  return {
    resolvedSha,
    listFiles: async () => Object.keys(files),
    readFile: async (path: string) => files[path] ?? null,
  };
}

describe('planFileBatches', () => {
  it('packs files into batches under the file-count cap', () => {
    const files = Array.from({ length: 90 }, (_, i) => ({ path: `f${i}.ts`, content: 'x' }));
    const batches = planFileBatches(files, { maxFiles: 40, maxBytes: 1_000_000 });
    expect(batches.length).toBe(3);
    expect(batches[0].length).toBe(40);
    expect(batches[2].length).toBe(10);
  });

  it('starts a new batch when the byte budget would be exceeded', () => {
    const files = [
      { path: 'a.ts', content: 'x'.repeat(600) },
      { path: 'b.ts', content: 'x'.repeat(600) },
      { path: 'c.ts', content: 'x'.repeat(600) },
    ];
    const batches = planFileBatches(files, { maxFiles: 40, maxBytes: 1000 });
    expect(batches.length).toBe(3);
  });

  it('a single file larger than the byte budget still ships alone', () => {
    const files = [{ path: 'big.ts', content: 'x'.repeat(5000) }];
    const batches = planFileBatches(files, { maxFiles: 40, maxBytes: 1000 });
    expect(batches.length).toBe(1);
    expect(batches[0][0].path).toBe('big.ts');
  });

  it('returns [] for no files', () => {
    expect(planFileBatches([], { maxFiles: 10, maxBytes: 100 })).toEqual([]);
  });

  it('exports sane default caps', () => {
    expect(MAX_BATCH_FILES).toBeGreaterThan(0);
    expect(MAX_BATCH_BYTES).toBeGreaterThan(100_000);
  });
});

describe('runFullIngestJob', () => {
  it('walks files through the shared filter, pushes batches, completes with stats', async () => {
    const { api, pushed, completions } = fakeApi();
    const reader = fakeReader({
      'src/app.ts': 'export const app = 1;',
      'docs/guide.md': '# Guide',
      'src/app.test.ts': 'test file — filtered out',
      'bun.lock': 'lockfile — filtered out',
      'node_modules/dep/index.js': 'dep — filtered out',
      'assets/logo.png': 'binary ext — filtered out',
    });

    const result = await runFullIngestJob(job, reader, api);
    expect(result.status).toBe('done');

    const sentPaths = pushed.flat().map(f => f.path).sort();
    expect(sentPaths).toEqual(['docs/guide.md', 'src/app.ts']);

    expect(completions.length).toBe(1);
    expect(completions[0].status).toBe('done');
    expect(completions[0].sweep).toBe(true);
    const stats = completions[0].stats as Record<string, unknown>;
    expect(stats.filesListed).toBe(6);
    expect(stats.filesSent).toBe(2);
    expect(stats.filesIngested).toBe(2);
    expect(stats.chunksUpserted).toBe(4);
    expect(stats.sha).toBe('sha-head');
    expect(typeof stats.durationMs).toBe('number');
  });

  it('computes and attaches fileHash to each pushed entry', async () => {
    const { api, pushed } = fakeApi();
    const reader = fakeReader({ 'src/app.ts': 'export const app = 1;' });

    await runFullIngestJob(job, reader, api);

    const entry = pushed.flat()[0];
    expect(typeof entry.fileHash).toBe('string');
    expect(entry.fileHash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  it('accumulates skippedUnchanged from server responses into stats', async () => {
    // Simulate a server that reports some files as hash-skipped
    const { api, completions } = fakeApi({
      pushFiles: async (_jobId, files) => ({
        filesIngested: files.length - 1,
        chunksUpserted: (files.length - 1) * 2,
        filesSkipped: 0,
        filesDeleted: 0,
        skippedUnchanged: 1,
      }),
    });
    const reader = fakeReader({
      'src/app.ts': 'export const app = 1;',
      'src/util.ts': 'export const util = 2;',
    });

    const result = await runFullIngestJob(job, reader, api);
    expect(result.status).toBe('done');
    const stats = completions[0].stats as Record<string, unknown>;
    expect(stats.skippedUnchanged).toBe(1);
  });

  it('skips files the reader rejects (binary/oversized) and counts them', async () => {
    const { api, pushed, completions } = fakeApi();
    const reader = fakeReader({
      'src/app.ts': 'export const app = 1;',
      'src/binary-ish.ts': null, // reader returns null → unreadable/binary
    });

    const result = await runFullIngestJob(job, reader, api);
    expect(result.status).toBe('done');
    expect(pushed.flat().map(f => f.path)).toEqual(['src/app.ts']);
    const stats = completions[0].stats as Record<string, unknown>;
    expect(stats.filesSkipped).toBe(1);
  });

  it('reports errors on the job instead of throwing', async () => {
    const { api, completions } = fakeApi({
      pushFiles: async () => {
        throw new Error('server exploded');
      },
    });
    const reader = fakeReader({ 'src/app.ts': 'export const app = 1;' });

    const result = await runFullIngestJob(job, reader, api);
    expect(result.status).toBe('error');
    expect(result.error).toContain('server exploded');
    expect(completions.length).toBe(1);
    expect(completions[0].status).toBe('error');
    expect(completions[0].error).toContain('server exploded');
  });

  it('completes with done and zero stats when nothing is ingestible', async () => {
    const { api, pushed, completions } = fakeApi();
    const reader = fakeReader({ 'assets/logo.png': 'nope' });

    const result = await runFullIngestJob(job, reader, api);
    expect(result.status).toBe('done');
    expect(pushed.length).toBe(0);
    expect((completions[0].stats as Record<string, unknown>).filesSent).toBe(0);
  });
});

// ── SCIP precise-graph enrichment (stream B2b) ────────────────────────────────

const fakeGraph = {
  entities: [
    { workspaceId: 'ws-1', kind: 'file' as const, key: 'src/a.ts', canonicalName: 'a.ts' },
    { workspaceId: 'ws-1', kind: 'symbol' as const, key: 'src/a.ts#foo', canonicalName: 'foo', role: 'defines' as const },
  ],
  edges: [
    {
      workspaceId: 'ws-1',
      fromEntityKey: 'src/a.ts',
      fromEntityKind: 'file' as const,
      toEntityKey: 'src/a.ts#foo',
      toEntityKind: 'symbol' as const,
      type: 'defines' as const,
      weight: 1.0,
      rule: 'scip:defines',
    },
  ],
  aliases: [{ entityKind: 'symbol' as const, entityKey: 'src/a.ts#foo', alias: 'foo', source: 'scip' as const }],
  stats: { documents: 1, definitions: 1, references: 0, imports: 0, aliases: 1 },
};

describe('runFullIngestJob — SCIP enrichment', () => {
  const reader = fakeReader({ 'src/a.ts': 'export const foo = 1;' });

  it('transmits the derived graph via pushGraph and records scip stats', async () => {
    const graphs: Array<{ jobId: string; graph: unknown }> = [];
    const { api, completions } = fakeApi({
      pushGraph: async (jobId, graph) => {
        graphs.push({ jobId, graph });
        return { edges: graph.edges.length, aliases: graph.aliases.length };
      },
    });

    const result = await runFullIngestJob(job, reader, api, undefined, {
      scipEnrich: async () => ({ graph: fakeGraph, cached: false }),
    });
    expect(result.status).toBe('done');
    expect(graphs).toHaveLength(1);
    expect(graphs[0].jobId).toBe('job-1');

    const scip = (completions[0].stats as Record<string, unknown>).scip as Record<string, unknown>;
    expect(scip.attempted).toBe(true);
    expect(scip.persisted).toBe(true);
    expect(scip.edgesWritten).toBe(1);
    expect(scip.aliasesWritten).toBe(1);
    expect(scip.definitions).toBe(1);
  });

  it('records counts but marks persisted=false when pushGraph is unavailable', async () => {
    const { api, completions } = fakeApi(); // no pushGraph
    await runFullIngestJob(job, reader, api, undefined, {
      scipEnrich: async () => ({ graph: fakeGraph, cached: true }),
    });
    const scip = (completions[0].stats as Record<string, unknown>).scip as Record<string, unknown>;
    expect(scip.persisted).toBe(false);
    expect(scip.cached).toBe(true);
  });

  it('records a skip reason when SCIP produced no graph', async () => {
    const { api, completions } = fakeApi({ pushGraph: async () => ({ edges: 0, aliases: 0 }) });
    await runFullIngestJob(job, reader, api, undefined, {
      scipEnrich: async () => ({ graph: null, skippedReason: 'scip-typescript unavailable' }),
    });
    const scip = (completions[0].stats as Record<string, unknown>).scip as Record<string, unknown>;
    expect(scip.attempted).toBe(true);
    expect(scip.skippedReason).toContain('unavailable');
  });

  it('never fails the job when the enricher throws — ast-grep ingest stands', async () => {
    const { api, completions, pushed } = fakeApi();
    const result = await runFullIngestJob(job, reader, api, undefined, {
      scipEnrich: async () => {
        throw new Error('boom');
      },
    });
    expect(result.status).toBe('done'); // file ingest unaffected
    expect(pushed.flat().map(f => f.path)).toEqual(['src/a.ts']);
    const scip = (completions[0].stats as Record<string, unknown>).scip as Record<string, unknown>;
    expect(scip.skippedReason).toContain('boom');
  });

  it('omits scip stats entirely when no enricher is configured', async () => {
    const { api, completions } = fakeApi();
    await runFullIngestJob(job, reader, api);
    expect((completions[0].stats as Record<string, unknown>).scip).toBeUndefined();
  });
});

describe('createGitRepoReader', () => {
  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kfi-git-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.ts'), 'export const app = 1;\n');
    writeFileSync(join(dir, 'README.md'), '# Readme\n');
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 255, 0, 3]));
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    return dir;
  }

  it('lists files and reads contents at HEAD when no sha is given', async () => {
    const dir = makeRepo();
    try {
      const reader = createGitRepoReader(dir);
      const files = await reader.listFiles();
      expect(files).toContain('src/app.ts');
      expect(files).toContain('README.md');
      expect(await reader.readFile('src/app.ts')).toBe('export const app = 1;\n');
      expect(reader.resolvedSha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for binary files', async () => {
    const dir = makeRepo();
    try {
      const reader = createGitRepoReader(dir);
      expect(await reader.readFile('blob.bin')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to HEAD when the requested sha is unknown', async () => {
    const dir = makeRepo();
    try {
      const reader = createGitRepoReader(dir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
      const files = await reader.listFiles();
      expect(files).toContain('src/app.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads at an explicit historic sha', async () => {
    const dir = makeRepo();
    try {
      const firstSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
      writeFileSync(join(dir, 'src', 'app.ts'), 'export const app = 2;\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-q', '-m', 'update'], { cwd: dir });

      const reader = createGitRepoReader(dir, firstSha);
      expect(await reader.readFile('src/app.ts')).toBe('export const app = 1;\n');
      expect(reader.resolvedSha).toBe(firstSha);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
