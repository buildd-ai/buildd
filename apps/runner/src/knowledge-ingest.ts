/**
 * Runner-side knowledge ingest poller (Workspace KM v2 spec §3.3 — stream A2).
 *
 * Full-scope ingest jobs (backfill / escalated large diffs / manual) need a
 * repo checkout, which runners already hold. On each idle heartbeat tick the
 * poller offers the server the "owner/name" slugs of every local clone; if a
 * queued full job matches, it reads the repo tree at the job's sha (via
 * git ls-tree/show — no working-tree mutation) and streams file batches to the
 * server, which chunks/embeds/upserts. All heavy lifting lives in
 * @buildd/core/knowledge-store/full-ingest so CI can reuse it.
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
    return runFullIngestJob(job, reader, api);
  };
}

/** Wire-up used by the WorkerManager: HTTP api from the runner's server config. */
export function createKnowledgeIngestPoller(config: {
  builddServer: string;
  apiKey: string;
  scanRepos: () => LocalRepo[];
}): KnowledgeIngestPoller {
  return new KnowledgeIngestPoller({
    enabled: process.env.KNOWLEDGE_INGEST_JOBS !== '0',
    api: createHttpIngestApi({ serverUrl: config.builddServer, apiKey: config.apiKey }),
    scanRepos: config.scanRepos,
  });
}
