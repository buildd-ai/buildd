/**
 * Runner-side knowledge ingest poller (Workspace KM v2 spec §3.3 — stream A2).
 *
 * Full-scope ingest jobs (backfill / escalated large diffs / manual) need a
 * repo checkout, which runners already hold. On each idle heartbeat tick the
 * poller offers the server the "owner/name" slugs of every local clone; if a
 * queued full job matches, it reads the repo tree at the job's sha (via
 * git ls-tree/show — no working-tree mutation) and writes chunks to the DB.
 *
 * Two execution modes:
 *   local  — DATABASE_URL + VOYAGE_API_KEY present on the runner host.
 *             Uses PgVectorStore + ingestFiles directly: no Vercel billing,
 *             no maxDuration ceiling, handles code/docs/spec in a single pass.
 *             Fixes the F2 path-format split via path-based pruneOrphans sweep.
 *   http   — Fallback when DATABASE_URL/VOYAGE_API_KEY are absent.
 *             Streams file batches to /api/knowledge/ingest-jobs/:id/files,
 *             which chunks/embeds/upserts on Vercel (original behaviour).
 *
 * Gated by KNOWLEDGE_INGEST_JOBS (default on; set to 0 to disable).
 */
import {
  createGitRepoReader,
  createHttpIngestApi,
  runFullIngestJob,
  type FullIngestApiClient,
  type FullIngestJob,
} from '@buildd/core/knowledge-store/full-ingest';

export interface LocalRepo {
  path: string;
  /** "owner/name" (lowercase) or null when the dir has no recognizable remote. */
  normalizedUrl: string | null;
}

export type PollOutcome = 'disabled' | 'busy' | 'idle' | 'ran' | 'error';

export interface KnowledgeIngestPollerOptions {
  enabled: boolean;
  api: FullIngestApiClient;
  scanRepos: () => LocalRepo[];
  /** Injectable for tests; defaults to the git-reader + batch executor. */
  executeJob?: (job: FullIngestJob, repoPath: string) => Promise<{ status: 'done' | 'error' }>;
  log?: (msg: string) => void;
}

export class KnowledgeIngestPoller {
  private running = false;

  constructor(private readonly opts: KnowledgeIngestPollerOptions) {}

  get isRunning(): boolean {
    return this.running;
  }

  /** Claim and execute at most one full ingest job. Never throws. */
  async poll(): Promise<PollOutcome> {
    if (!this.opts.enabled) return 'disabled';
    if (this.running) return 'busy';
    this.running = true;
    const log = this.opts.log ?? ((msg: string) => console.log(msg));
    try {
      const repos = this.opts.scanRepos().filter(r => r.normalizedUrl);
      if (repos.length === 0) return 'idle';
      const bytSlug = new Map(repos.map(r => [r.normalizedUrl!.toLowerCase(), r.path]));

      const job = await this.opts.api.claimJob([...bytSlug.keys()]);
      if (!job) return 'idle';

      const repoPath = bytSlug.get(job.repo.toLowerCase());
      if (!repoPath) {
        // Shouldn't happen (we only offered repos we have) — but never leave a
        // job stuck in 'running'; error state allows a retry enqueue.
        await this.opts.api.completeJob(job.id, {
          status: 'error',
          error: 'runner has no local checkout for this repo',
        });
        return 'error';
      }

      log(`[knowledge-ingest] job ${job.id} (${job.trigger}) for ${job.repo} @ ${job.sha ?? 'HEAD'}`);
      const execute = this.opts.executeJob ?? defaultExecuteJob(this.opts.api);
      const result = await execute(job, repoPath);
      log(`[knowledge-ingest] job ${job.id} finished: ${result.status}`);
      return result.status === 'done' ? 'ran' : 'error';
    } catch (err) {
      (this.opts.log ?? console.error)(
        `[knowledge-ingest] poll failed: ${err instanceof Error ? err.message : err}`,
      );
      return 'error';
    } finally {
      this.running = false;
    }
  }
}

function defaultExecuteJob(api: FullIngestApiClient) {
  return async (job: FullIngestJob, repoPath: string) => {
    const reader = createGitRepoReader(repoPath, job.sha);
    return runFullIngestJob(job, reader, api, undefined, {
      // SCIP precise-graph enrichment (stream B2b). Dynamic import keeps
      // scip-runner's child_process/fs surface lazy and off the static graph;
      // any failure (binary absent, project won't index) is a graceful no-op.
      scipEnrich: async j => {
        if (process.env.KNOWLEDGE_SCIP !== '1') return null; // opt-in for now
        const { runScipGraph } = await import('@buildd/core/knowledge-store/scip-runner');
        return runScipGraph({
          repoPath,
          sha: reader.resolvedSha ?? j.sha ?? null,
          workspaceId: j.workspaceId,
          repoSlug: j.repo,
          log: msg => console.log(`[knowledge-ingest] ${msg}`),
        });
      },
    });
  };
}

/**
 * Local execution path: runs when DATABASE_URL + VOYAGE_API_KEY are present on
 * the runner host. Writes directly to PgVectorStore — no Vercel billing, no
 * maxDuration ceiling. Handles code, docs, AND spec corpora in one pass.
 *
 * The path-based pruneOrphans sweep after ingest also fixes the F2 split:
 * old chunks stored with subdir-relative paths (e.g. "core/foo.ts") are not in
 * the seen set (which has "packages/core/foo.ts") and get deleted automatically.
 */
function createLocalExecuteJob(api: FullIngestApiClient) {
  return async (job: FullIngestJob, repoPath: string): Promise<{ status: 'done' | 'error' }> => {
    const log = (msg: string) => console.log(msg);
    log(`[knowledge-ingest:local] job ${job.id} (${job.trigger}) ${job.repo} @ ${job.sha ?? 'HEAD'}`);
    const startedAt = Date.now();
    try {
      const [
        { createGitRepoReader: makeReader },
        { shouldIngestFile, classifyIngestCorpus },
        { PgVectorStore, ingestFiles },
        { getVoyageEmbedderForCorpus },
        { pruneOrphans },
      ] = await Promise.all([
        import('@buildd/core/knowledge-store/full-ingest'),
        import('@buildd/core/knowledge-store/ingest-filter'),
        import('@buildd/core/knowledge-store'),
        import('@buildd/core/knowledge-store/voyage-embedder'),
        import('@buildd/core/knowledge-store/ingest'),
      ]);

      const reader = makeReader(repoPath, job.sha);
      const allPaths = await reader.listFiles();

      const codeFiles: Array<{ path: string; content: string }> = [];
      const docsFiles: Array<{ path: string; content: string }> = [];
      let skipped = 0;

      for (const filePath of allPaths) {
        if (!shouldIngestFile(filePath)) { skipped++; continue; }
        const corpus = classifyIngestCorpus(filePath);
        if (!corpus) { skipped++; continue; }
        const content = await reader.readFile(filePath);
        if (!content) { skipped++; continue; }
        if (corpus === 'code') codeFiles.push({ path: filePath, content });
        else docsFiles.push({ path: filePath, content });
      }

      log(`[knowledge-ingest:local] job ${job.id}: ${codeFiles.length} code, ${docsFiles.length} docs, ${skipped} filtered`);

      const BATCH = 50;
      let totalChunks = 0;
      let skippedUnchanged = 0;

      const codeStore = new PgVectorStore(getVoyageEmbedderForCorpus('code'));
      const docsStore = new PgVectorStore(getVoyageEmbedderForCorpus('docs'));
      const specStore = new PgVectorStore(getVoyageEmbedderForCorpus('spec'));

      for (let i = 0; i < codeFiles.length; i += BATCH) {
        const res = await ingestFiles(codeStore, job.workspaceId, 'code', codeFiles.slice(i, i + BATCH));
        totalChunks += res.chunks;
        skippedUnchanged += res.skippedUnchanged;
      }
      for (let i = 0; i < docsFiles.length; i += BATCH) {
        const batch = docsFiles.slice(i, i + BATCH);
        const docsRes = await ingestFiles(docsStore, job.workspaceId, 'docs', batch);
        await ingestFiles(specStore, job.workspaceId, 'spec', batch.map(f => ({ ...f })));
        totalChunks += docsRes.chunks;
        skippedUnchanged += docsRes.skippedUnchanged;
      }

      // Namespace-wide orphan sweep. Empty prefix = entire namespace.
      // This also clears any F2 stale chunks keyed with wrong paths (e.g. "core/..."
      // stored by old CI runs, not present in the seen set of "packages/core/...").
      const codeSeenPaths = new Set(codeFiles.map(f => f.path));
      const docsSeenPaths = new Set(docsFiles.map(f => f.path));
      const [codePruned, docsPruned, specPruned] = await Promise.all([
        pruneOrphans(codeStore, job.workspaceId, 'code', '', codeSeenPaths),
        pruneOrphans(docsStore, job.workspaceId, 'docs', '', docsSeenPaths),
        pruneOrphans(specStore, job.workspaceId, 'spec', '', docsSeenPaths),
      ]);

      const stats = {
        filesListed: allPaths.length,
        filesSent: codeFiles.length + docsFiles.length,
        filesSkipped: skipped,
        chunksUpserted: totalChunks,
        skippedUnchanged,
        prunedCode: codePruned.length,
        prunedDocs: docsPruned.length,
        prunedSpec: specPruned.length,
        durationMs: Date.now() - startedAt,
        sha: reader.resolvedSha,
        mode: 'local',
      };
      log(`[knowledge-ingest:local] job ${job.id} done: ${JSON.stringify(stats)}`);

      // sweep:false — we ran pruneOrphans locally (more precise than time-based sweep).
      await api.completeJob(job.id, { status: 'done', stats, sweep: false });
      return { status: 'done' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[knowledge-ingest:local] job ${job.id} failed:`, err);
      try { await api.completeJob(job.id, { status: 'error', error: message }); } catch {}
      return { status: 'error' };
    }
  };
}

/** Wire-up used by the WorkerManager: HTTP api from the runner's server config. */
export function createKnowledgeIngestPoller(config: {
  builddServer: string;
  apiKey: string;
  scanRepos: () => LocalRepo[];
}): KnowledgeIngestPoller {
  const api = createHttpIngestApi({ serverUrl: config.builddServer, apiKey: config.apiKey });
  const hasLocalDb = !!(process.env.DATABASE_URL && process.env.VOYAGE_API_KEY);
  if (hasLocalDb) {
    console.log('[knowledge-ingest] local mode: DATABASE_URL + VOYAGE_API_KEY detected — embedding runs on runner, not Vercel');
  }
  return new KnowledgeIngestPoller({
    enabled: process.env.KNOWLEDGE_INGEST_JOBS !== '0',
    api,
    scanRepos: config.scanRepos,
    executeJob: hasLocalDb ? createLocalExecuteJob(api) : undefined,
  });
}
