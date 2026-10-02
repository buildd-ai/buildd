/**
 * Serverless fallback for `full`-scope knowledge ingest jobs.
 *
 * Full jobs are normally run by a runner that holds a checkout of the repo
 * (apps/runner/src/knowledge-ingest.ts). When no runner offers one — no runner
 * has the repo cloned, its clone cannot fetch, or every runner is busy — the
 * job used to sit `queued` indefinitely, reported only as `stalled` in the
 * claim response nobody reads.
 *
 * This executor takes a job once it is stalled (classifyIngestJobLiveness, the
 * same rule the claim route reports) and reads the repo through the GitHub
 * tree + blob API at the job's sha, as diff ingest already does, so it needs no
 * checkout. One cron tick processes a bounded slice: files in a fixed (path)
 * order, in small batches, until the tick's time budget runs out. Progress is
 * a cursor in `stats.fallback`, so the next tick resumes where this one
 * stopped. Re-running a slice is harmless: ingest upserts are keyed by path
 * and unchanged files are hash-skipped.
 *
 * While it owns a job the row is `running` with lease owner
 * FALLBACK_LEASE_OWNER and a lease longer than the cron interval, so reclaim
 * never mistakes a job between ticks for a dead executor, and no runner claims
 * it (runners only claim `queued`). Overlapping ticks are kept apart by a CAS
 * on heartbeat_at.
 *
 * The tick never throws. A failing slice is recorded on the job and retried
 * next tick; after FALLBACK_MAX_FAILURES consecutive failing ticks the job is
 * parked in `error` with the last error.
 */
import { createHash } from 'crypto';
import { and, asc, eq, isNull, or, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { githubInstallations, githubRepos, knowledgeIngestJobs } from '@buildd/core/db/schema';
import {
  classifyIngestCorpus,
  shouldIngestFile,
} from '@buildd/core/knowledge-store/ingest-filter';
import { classifyIngestJobLiveness } from '@/lib/knowledge-ingest-lease';
import type { IngestBatchFile, IngestBatchResult } from '@/lib/knowledge-ingest-batch';

export const FALLBACK_LEASE_OWNER = 'serverless-fallback';
/** Longer than the hourly cron interval, so a job between ticks still reads as live. */
export const FALLBACK_LEASE_MS = 3 * 60 * 60 * 1000;
/** Wall-clock budget for one tick. The cron route's maxDuration is 300s. */
export const FALLBACK_TICK_BUDGET_MS = 200_000;
/** Per-batch caps, matching the runner's: small enough that one batch embeds quickly. */
export const FALLBACK_BATCH_FILES = 16;
export const FALLBACK_BATCH_BYTES = 300_000;
/** Consecutive failing ticks before the job is parked in `error`. */
export const FALLBACK_MAX_FAILURES = 5;
const MAX_CANDIDATES = 50;
const BINARY_SNIFF_BYTES = 8192;

export interface FallbackJob {
  id: string;
  workspaceId: string;
  repo: string;
  sha: string | null;
  scope: string;
  status: string;
  attempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  heartbeatAt: Date | null;
  startedAt: Date | null;
  createdAt: Date;
  finishedAt?: Date | null;
  error?: string | null;
  stats: Record<string, unknown> | null;
}

/** Resumable progress, stored at stats.fallback. */
export interface FallbackProgress {
  sha: string;
  /** Index into the filtered, path-sorted file list of the next file to ingest. */
  cursor: number;
  total?: number;
  /** ISO time of the first claim of this run; the completion sweep is anchored here. */
  startedAt: string;
  filesIngested?: number;
  chunksUpserted?: number;
  filesSkipped?: number;
  skippedUnchanged?: number;
  ticks?: number;
  failures?: number;
  lastError?: string;
}

export type JobPatch = Partial<Omit<FallbackJob, 'id' | 'workspaceId' | 'repo' | 'scope' | 'createdAt'>>;

/** Persistence seam. The default is drizzle; tests use an in-memory table. */
export interface FallbackStore {
  /** Full jobs that are queued, or running under the fallback's lease. */
  listCandidates(): Promise<FallbackJob[]>;
  /**
   * Take the job for this tick. For a queued job: CAS on status='queued'. For
   * a job the fallback already runs: CAS on lease owner + the heartbeat value
   * read, so two overlapping ticks cannot both proceed. Returns the updated
   * row, or null when another executor got there first.
   */
  claim(job: FallbackJob, patch: JobPatch): Promise<FallbackJob | null>;
  /** Write progress/terminal state; only while the fallback still owns the row. */
  save(jobId: string, patch: JobPatch): Promise<boolean>;
}

export interface FallbackDeps {
  store: FallbackStore;
  github: (installationId: number, path: string) => Promise<any>;
  installationIdForRepo: (repo: string) => Promise<number>;
  ingestBatch: (workspaceId: string, files: IngestBatchFile[]) => Promise<IngestBatchResult>;
  /** Prune chunks not refreshed since the run began; returns the count. */
  sweep: (workspaceId: string, since: Date) => Promise<number>;
  log?: (msg: string) => void;
}

export interface FallbackTickOptions {
  now?: () => Date;
  budgetMs?: number;
  batchFiles?: number;
  batchBytes?: number;
}

export interface FallbackTickResult {
  considered: number;
  claimed: string[];
  completed: string[];
  failed: string[];
  errors: Array<{ id: string; error: string }>;
  filesIngested: number;
  raceLost: number;
}

/** An error retrying cannot fix: the job is failed at once. */
class FatalFallbackError extends Error {}

interface TreeEntry {
  path: string;
  sha: string;
  size: number;
}

function readProgress(job: FallbackJob): FallbackProgress | null {
  const p = (job.stats as Record<string, any> | null)?.fallback;
  if (!p || typeof p !== 'object' || typeof p.sha !== 'string' || typeof p.cursor !== 'number') return null;
  return p as FallbackProgress;
}

function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

async function resolveSha(deps: FallbackDeps, installationId: number, job: FallbackJob): Promise<string> {
  if (job.sha) return job.sha;
  const repo = await deps.github(installationId, `/repos/${job.repo}`);
  const branch = repo?.default_branch;
  if (typeof branch !== 'string' || !branch) {
    throw new FatalFallbackError(`could not resolve the default branch of ${job.repo}`);
  }
  const commit = await deps.github(installationId, `/repos/${job.repo}/commits/${encodePath(branch)}`);
  if (typeof commit?.sha !== 'string') {
    throw new Error(`could not resolve the head of ${job.repo}@${branch}`);
  }
  return commit.sha;
}

async function listTree(deps: FallbackDeps, installationId: number, repo: string, sha: string): Promise<TreeEntry[]> {
  const tree = await deps.github(installationId, `/repos/${repo}/git/trees/${sha}?recursive=1`);
  if (tree?.truncated) {
    throw new FatalFallbackError(
      `GitHub truncated the tree listing of ${repo}@${sha.slice(0, 12)} (repo too large for the serverless fallback); ` +
        'it needs a runner with a checkout',
    );
  }
  if (!Array.isArray(tree?.tree)) throw new Error(`unexpected tree response for ${repo}@${sha}`);
  return (tree.tree as Array<{ path: string; type: string; sha: string; size?: number }>)
    .filter(e => e.type === 'blob')
    .filter(e => classifyIngestCorpus(e.path) !== null && shouldIngestFile(e.path, { sizeBytes: e.size ?? 0 }))
    .map(e => ({ path: e.path, sha: e.sha, size: e.size ?? 0 }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function fetchBlob(
  deps: FallbackDeps,
  installationId: number,
  repo: string,
  entry: TreeEntry,
): Promise<IngestBatchFile | null> {
  const blob = await deps.github(installationId, `/repos/${repo}/git/blobs/${encodeURIComponent(entry.sha)}`);
  if (!blob?.content || blob.encoding !== 'base64') return null;
  const buf = Buffer.from(blob.content, 'base64');
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null; // binary
  const content = buf.toString('utf8');
  return { path: entry.path, content, fileHash: createHash('sha256').update(content).digest('hex') };
}

/** Next slice from `cursor`, bounded by file count and (listed) byte size. */
function nextSlice(entries: TreeEntry[], cursor: number, maxFiles: number, maxBytes: number): TreeEntry[] {
  const out: TreeEntry[] = [];
  let bytes = 0;
  for (let i = cursor; i < entries.length; i++) {
    const e = entries[i];
    if (out.length > 0 && (out.length >= maxFiles || bytes + e.size > maxBytes)) break;
    out.push(e);
    bytes += e.size;
  }
  return out;
}

function isEligible(job: FallbackJob, now: Date): boolean {
  if (job.scope !== 'full') return false;
  if (job.status === 'running') return job.leaseOwner === FALLBACK_LEASE_OWNER;
  return job.status === 'queued' && classifyIngestJobLiveness(job, now) === 'stalled';
}

/**
 * One cron tick: continue any job the fallback already owns, then take
 * stalled queued jobs, until the time budget is spent. Never throws.
 */
export async function runFullIngestFallbackTick(
  deps: FallbackDeps,
  opts: FallbackTickOptions = {},
): Promise<FallbackTickResult> {
  const now = opts.now ?? (() => new Date());
  const budgetMs = opts.budgetMs ?? FALLBACK_TICK_BUDGET_MS;
  const batchFiles = opts.batchFiles ?? FALLBACK_BATCH_FILES;
  const batchBytes = opts.batchBytes ?? FALLBACK_BATCH_BYTES;
  const log = deps.log ?? ((m: string) => console.log(m));
  const tickStart = now().getTime();
  const outOfTime = () => now().getTime() - tickStart >= budgetMs;

  const out: FallbackTickResult = {
    considered: 0,
    claimed: [],
    completed: [],
    failed: [],
    errors: [],
    filesIngested: 0,
    raceLost: 0,
  };

  let candidates: FallbackJob[];
  try {
    candidates = await deps.store.listCandidates();
  } catch (err) {
    console.error('[knowledge-ingest:fallback] listing candidates failed:', err);
    return out;
  }
  const at = now();
  // Jobs already in flight first: finishing one beats starting another.
  const eligible = candidates
    .filter(j => isEligible(j, at))
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'running' ? -1 : 1;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
  out.considered = eligible.length;

  for (const candidate of eligible) {
    if (outOfTime()) break;
    const claimAt = now();
    const prior = readProgress(candidate);
    const claimed = await deps.store
      .claim(candidate, {
        status: 'running',
        leaseOwner: FALLBACK_LEASE_OWNER,
        leaseExpiresAt: new Date(claimAt.getTime() + FALLBACK_LEASE_MS),
        heartbeatAt: claimAt,
        ...(candidate.status === 'queued' ? { startedAt: claimAt } : {}),
      })
      .catch(err => {
        console.error(`[knowledge-ingest:fallback] claim failed for job ${candidate.id}:`, err);
        return null;
      });
    if (!claimed) {
      out.raceLost++;
      continue;
    }
    out.claimed.push(claimed.id);

    let progress: FallbackProgress | null = prior;
    try {
      const installationId = await deps.installationIdForRepo(claimed.repo).catch(err => {
        throw new FatalFallbackError(err instanceof Error ? err.message : String(err));
      });
      const sha = progress?.sha ?? (await resolveSha(deps, installationId, claimed));
      if (!progress || progress.sha !== sha) {
        progress = { sha, cursor: 0, startedAt: claimAt.toISOString() };
      }
      const entries = await listTree(deps, installationId, claimed.repo, sha);
      progress.total = entries.length;
      progress.ticks = (progress.ticks ?? 0) + 1;
      log(
        `[knowledge-ingest:fallback] job ${claimed.id} ${claimed.repo}@${sha.slice(0, 12)}: ` +
          `resuming at ${progress.cursor}/${entries.length}`,
      );

      // At least one batch per claimed job, so a tick always makes progress.
      let firstBatch = true;
      while (progress.cursor < entries.length && (firstBatch || !outOfTime())) {
        firstBatch = false;
        const slice = nextSlice(entries, progress.cursor, batchFiles, batchBytes);
        const files: IngestBatchFile[] = [];
        let unreadable = 0;
        const fetched = await Promise.all(slice.map(e => fetchBlob(deps, installationId, claimed.repo, e)));
        for (const f of fetched) {
          if (f) files.push(f);
          else unreadable++;
        }
        const res = files.length > 0
          ? await deps.ingestBatch(claimed.workspaceId, files)
          : { filesIngested: 0, chunksUpserted: 0, filesSkipped: 0, filesDeleted: 0, skippedUnchanged: 0 };
        progress.cursor += slice.length;
        progress.filesIngested = (progress.filesIngested ?? 0) + res.filesIngested;
        progress.chunksUpserted = (progress.chunksUpserted ?? 0) + res.chunksUpserted;
        progress.filesSkipped = (progress.filesSkipped ?? 0) + res.filesSkipped + unreadable;
        progress.skippedUnchanged = (progress.skippedUnchanged ?? 0) + res.skippedUnchanged;
        progress.failures = 0;
        delete progress.lastError;
        out.filesIngested += res.filesIngested;
        const beat = now();
        await deps.store.save(claimed.id, {
          heartbeatAt: beat,
          leaseExpiresAt: new Date(beat.getTime() + FALLBACK_LEASE_MS),
          stats: { ...(claimed.stats ?? {}), fallback: progress },
        });
      }

      if (progress.cursor >= entries.length) {
        const prunedChunks = await deps.sweep(claimed.workspaceId, new Date(progress.startedAt));
        const stats: Record<string, unknown> = {
          ...(claimed.stats ?? {}),
          mode: 'serverless-fallback',
          sha,
          filesListed: entries.length,
          filesIngested: progress.filesIngested ?? 0,
          filesSkipped: progress.filesSkipped ?? 0,
          skippedUnchanged: progress.skippedUnchanged ?? 0,
          chunksUpserted: progress.chunksUpserted ?? 0,
          prunedChunks,
          ticks: progress.ticks,
          fallback: progress,
        };
        await deps.store.save(claimed.id, {
          status: 'done',
          stats,
          finishedAt: now(),
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        out.completed.push(claimed.id);
        log(`[knowledge-ingest:fallback] job ${claimed.id} done: ${entries.length} files listed`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      out.errors.push({ id: claimed.id, error: message });
      const failures = (progress?.failures ?? 0) + 1;
      const fatal = err instanceof FatalFallbackError || failures >= FALLBACK_MAX_FAILURES;
      console.error(`[knowledge-ingest:fallback] job ${claimed.id} tick failed (${failures}x):`, err);
      const stats = progress
        ? { ...(claimed.stats ?? {}), fallback: { ...progress, failures, lastError: message.slice(0, 500) } }
        : claimed.stats;
      try {
        if (fatal) {
          await deps.store.save(claimed.id, {
            status: 'error',
            error: `serverless fallback could not ingest ${claimed.repo}: ${message}`.slice(0, 1000),
            stats,
            finishedAt: now(),
            leaseOwner: null,
            leaseExpiresAt: null,
          });
          out.failed.push(claimed.id);
        } else {
          await deps.store.save(claimed.id, { stats });
        }
      } catch (saveErr) {
        console.error(`[knowledge-ingest:fallback] could not record failure on job ${claimed.id}:`, saveErr);
      }
    }
  }

  return out;
}

// ── Default (drizzle + GitHub App) wiring ────────────────────────────────────

type JobRow = typeof knowledgeIngestJobs.$inferSelect;

/**
 * CAS for taking a job for one tick. Queued: still queued. Already ours: still
 * running under our lease AND the heartbeat we read is unchanged, so of two
 * overlapping ticks only the first proceeds.
 */
export function fallbackClaimGuard(job: Pick<FallbackJob, 'id' | 'status' | 'heartbeatAt'>): SQL | undefined {
  if (job.status === 'queued') {
    return and(eq(knowledgeIngestJobs.id, job.id), eq(knowledgeIngestJobs.status, 'queued'));
  }
  return and(
    eq(knowledgeIngestJobs.id, job.id),
    eq(knowledgeIngestJobs.status, 'running'),
    eq(knowledgeIngestJobs.leaseOwner, FALLBACK_LEASE_OWNER),
    job.heartbeatAt ? eq(knowledgeIngestJobs.heartbeatAt, job.heartbeatAt) : isNull(knowledgeIngestJobs.heartbeatAt),
  );
}

export const drizzleFallbackStore: FallbackStore = {
  async listCandidates() {
    const rows = (await db
      .select()
      .from(knowledgeIngestJobs)
      .where(
        and(
          eq(knowledgeIngestJobs.scope, 'full'),
          or(
            eq(knowledgeIngestJobs.status, 'queued'),
            and(
              eq(knowledgeIngestJobs.status, 'running'),
              eq(knowledgeIngestJobs.leaseOwner, FALLBACK_LEASE_OWNER),
            ),
          ),
        ),
      )
      .orderBy(asc(knowledgeIngestJobs.createdAt))
      .limit(MAX_CANDIDATES)) as JobRow[];
    return rows as unknown as FallbackJob[];
  },

  async claim(job, patch) {
    const updated = await db
      .update(knowledgeIngestJobs)
      .set(patch as Partial<JobRow>)
      .where(fallbackClaimGuard(job))
      .returning();
    return (updated[0] as unknown as FallbackJob) ?? null;
  },

  async save(jobId, patch) {
    const updated = await db
      .update(knowledgeIngestJobs)
      .set(patch as Partial<JobRow>)
      .where(
        and(
          eq(knowledgeIngestJobs.id, jobId),
          eq(knowledgeIngestJobs.status, 'running'),
          eq(knowledgeIngestJobs.leaseOwner, FALLBACK_LEASE_OWNER),
        ),
      )
      .returning({ id: knowledgeIngestJobs.id });
    return updated.length > 0;
  },
};

async function installationIdForRepo(repo: string): Promise<number> {
  const rows = await db
    .select({ installationId: githubInstallations.installationId })
    .from(githubRepos)
    .innerJoin(githubInstallations, eq(githubRepos.installationId, githubInstallations.id))
    .where(eq(githubRepos.fullName, repo));
  if (rows.length === 0) throw new Error(`no GitHub installation bound for repo ${repo}`);
  return rows[0].installationId;
}

/** Production dependencies. Lazy imports keep this module light to load. */
export async function defaultFallbackDeps(): Promise<FallbackDeps> {
  const [{ githubApi }, { ingestFileBatch, sweepUnrefreshedFileChunks }] = await Promise.all([
    import('@/lib/github'),
    import('@/lib/knowledge-ingest-batch'),
  ]);
  return {
    store: drizzleFallbackStore,
    github: githubApi,
    installationIdForRepo,
    ingestBatch: (workspaceId, files) => ingestFileBatch(workspaceId, files),
    sweep: sweepUnrefreshedFileChunks,
  };
}
