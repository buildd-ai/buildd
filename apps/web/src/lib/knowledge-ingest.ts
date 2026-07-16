/**
 * Serverless knowledge-ingest pipeline (Workspace KM v2, spec §3 — stream A1).
 *
 * Merged PRs on repos bound to one or more workspaces enqueue a `diff`-scope
 * job into `knowledge_ingest_jobs` (idempotent via a partial unique index on
 * (workspace_id, sha, scope)). `runDiffIngestJob` then executes the job
 * serverless: list the PR's changed files, fetch blob contents at the merge
 * SHA via the GitHub contents API (no checkout), chunk + upsert through the
 * existing knowledge-store ingest path, and delete chunks for removed files.
 *
 * Oversized diffs (>MAX_DIFF_FILES files or >MAX_DIFF_TOTAL_BYTES fetched)
 * escalate to a `full`-scope job; the full-job executor lands in stream A2 —
 * here we only enqueue. Likewise, a workspace with no pre-existing `code`
 * namespace gets a `full` backfill job enqueued after its first diff run.
 */
import { db } from '@buildd/core/db';
import { knowledgeIngestJobs, githubRepos, githubInstallations, workspaces, workers, tasks } from '@buildd/core/db/schema';
import { and, eq, inArray, or } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import {
  shouldIngestFile,
  classifyIngestCorpus,
  MAX_INGEST_FILE_BYTES,
} from '@buildd/core/knowledge-store/ingest-filter';

export const MAX_DIFF_FILES = 100;
export const MAX_DIFF_TOTAL_BYTES = 2 * 1024 * 1024;

type IngestJob = typeof knowledgeIngestJobs.$inferSelect;

export interface EnqueueMergedPrParams {
  /** "owner/name" */
  repoFullName: string;
  prNumber: number;
  /** Merge commit SHA (fallback: head SHA). */
  sha: string;
}

export type DiffIngestOutcome =
  | { claimed: false }
  | { claimed: true; status: 'done'; stats: Record<string, unknown> }
  | { claimed: true; status: 'error'; error: string };

/**
 * Enqueue a `diff` ingest job for every workspace bound to the repo.
 * Resolution: github_repos.fullName → workspaces.githubRepoId.
 * Idempotent: duplicate deliveries hit the partial unique index and insert
 * nothing. Returns the ids of newly created jobs only.
 */
export async function enqueueMergedPrIngestJobs(params: EnqueueMergedPrParams): Promise<string[]> {
  const repoRows = await db
    .select({ id: githubRepos.id })
    .from(githubRepos)
    .where(eq(githubRepos.fullName, params.repoFullName));
  if (repoRows.length === 0) return [];

  const boundWorkspaces = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(inArray(workspaces.githubRepoId, repoRows.map(r => r.id)));
  if (boundWorkspaces.length === 0) return [];

  const jobIds: string[] = [];
  for (const ws of boundWorkspaces) {
    const inserted = await db
      .insert(knowledgeIngestJobs)
      .values({
        workspaceId: ws.id,
        repo: params.repoFullName,
        trigger: 'pr_merged',
        sha: params.sha,
        prNumber: params.prNumber,
        scope: 'diff',
        status: 'queued',
      })
      .onConflictDoNothing()
      .returning({ id: knowledgeIngestJobs.id });
    if (inserted[0]) jobIds.push(inserted[0].id);
  }
  return jobIds;
}

/**
 * Execute a queued diff ingest job. Atomic claim via
 * UPDATE … WHERE status='queued' RETURNING — safe under concurrent delivery.
 * Never throws: failures are recorded on the job row (status='error').
 */
export async function runDiffIngestJob(jobId: string): Promise<DiffIngestOutcome> {
  // Atomic claim — a second concurrent call finds no queued row and bails.
  const claimed = await db
    .update(knowledgeIngestJobs)
    .set({ status: 'running', startedAt: new Date() })
    .where(and(eq(knowledgeIngestJobs.id, jobId), eq(knowledgeIngestJobs.status, 'queued')))
    .returning();
  if (claimed.length === 0) return { claimed: false };
  const job = claimed[0] as IngestJob;

  try {
    const { stats, changedFiles } = await executeDiffJob(job);
    await db
      .update(knowledgeIngestJobs)
      .set({ status: 'done', stats, changedFiles, finishedAt: new Date() })
      .where(eq(knowledgeIngestJobs.id, job.id))
      .returning();
    return { claimed: true, status: 'done', stats };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[knowledge-ingest] job ${job.id} failed:`, err);
    try {
      await db
        .update(knowledgeIngestJobs)
        .set({ status: 'error', error: message, finishedAt: new Date() })
        .where(eq(knowledgeIngestJobs.id, job.id))
        .returning();
    } catch (updateErr) {
      console.error(`[knowledge-ingest] failed to record error on job ${job.id}:`, updateErr);
    }
    return { claimed: true, status: 'error', error: message };
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

interface DiffExecution {
  stats: Record<string, unknown>;
  changedFiles: string[];
}

async function executeDiffJob(job: IngestJob): Promise<DiffExecution> {
  if (!job.prNumber || !job.sha) {
    throw new Error(`diff job ${job.id} is missing prNumber/sha`);
  }

  // Resolve the numeric GitHub installation id for token minting.
  const installRows = await db
    .select({ installationId: githubInstallations.installationId })
    .from(githubRepos)
    .innerJoin(githubInstallations, eq(githubRepos.installationId, githubInstallations.id))
    .where(eq(githubRepos.fullName, job.repo));
  if (installRows.length === 0) {
    throw new Error(`no GitHub installation bound for repo ${job.repo}`);
  }
  const installationId = installRows[0].installationId;

  // List the PR's changed files (paginated). Stop as soon as the cap is blown.
  const prFiles: Array<{ filename: string; status: string; previous_filename?: string; patch?: string }> = [];
  for (let page = 1; ; page++) {
    const batch = await githubApi(
      installationId,
      `/repos/${job.repo}/pulls/${job.prNumber}/files?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    prFiles.push(...batch);
    if (prFiles.length > MAX_DIFF_FILES || batch.length < 100) break;
  }

  if (prFiles.length > MAX_DIFF_FILES) {
    return escalateToFullJob(job, `${prFiles.length} changed files > ${MAX_DIFF_FILES}`);
  }

  // Partition: paths to delete (removed + renamed-from) vs paths to fetch.
  const deletions: string[] = [];
  const toFetch: string[] = [];
  let skipped = 0;
  for (const f of prFiles) {
    if (f.status === 'renamed' && f.previous_filename && classifyIngestCorpus(f.previous_filename)) {
      deletions.push(f.previous_filename);
    }
    if (f.status === 'removed') {
      if (classifyIngestCorpus(f.filename)) deletions.push(f.filename);
      else skipped++;
      continue;
    }
    if (!shouldIngestFile(f.filename)) {
      skipped++;
      continue;
    }
    toFetch.push(f.filename);
  }

  // Fetch blob contents at the merge SHA — no checkout needed.
  const sources: Record<'code' | 'docs', Array<{ path: string; content: string }>> = { code: [], docs: [] };
  let totalBytes = 0;
  for (const filePath of toFetch) {
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const data = await githubApi(
      installationId,
      `/repos/${job.repo}/contents/${encodedPath}?ref=${job.sha}`,
    );
    if (!data?.content || data.encoding !== 'base64') {
      skipped++;
      continue;
    }
    const size: number = typeof data.size === 'number' ? data.size : 0;
    if (size > MAX_INGEST_FILE_BYTES) {
      skipped++;
      continue;
    }
    totalBytes += size;
    if (totalBytes > MAX_DIFF_TOTAL_BYTES) {
      return escalateToFullJob(job, `fetched bytes ${totalBytes} > ${MAX_DIFF_TOTAL_BYTES}`);
    }
    const corpus = classifyIngestCorpus(filePath);
    if (!corpus) {
      skipped++;
      continue;
    }
    sources[corpus].push({
      path: filePath,
      content: Buffer.from(data.content, 'base64').toString('utf8'),
    });
  }

  // Knowledge-store work. Dynamic import keeps this module light for route
  // tests (the store pulls in drizzle/pgvector machinery at load time).
  const { PgVectorStore, getVoyageEmbedder, buildNamespace, ingestFiles, chunkPrDiff } =
    await import('@buildd/core/knowledge-store');

  // code/docs/spec all embed with voyage-code-3 (see getVoyageEmbedderForCorpus).
  const store = new PgVectorStore(getVoyageEmbedder('voyage-code-3'));

  // Capture pre-run state BEFORE any upserts so the backfill check reflects
  // whether this workspace had a code index before this job ran.
  const existingNamespaces = await store.listNamespaces();
  const hadCodeIndex = existingNamespaces.includes(buildNamespace(job.workspaceId, 'code'));

  // Deletions first: removed/renamed-away files leave no stale chunks behind.
  let filesDeleted = 0;
  for (const filePath of deletions) {
    const corpus = classifyIngestCorpus(filePath);
    if (!corpus) continue;
    await store.deleteBySource(buildNamespace(job.workspaceId, corpus), { sourcePath: filePath });
    filesDeleted++;
  }

  // Upserts via the shared ingest path (fileToChunks under the hood).
  let filesIngested = 0;
  let chunksUpserted = 0;
  for (const corpus of ['code', 'docs'] as const) {
    if (sources[corpus].length === 0) continue;
    const res = await ingestFiles(store, job.workspaceId, corpus, sources[corpus]);
    filesIngested += res.files;
    chunksUpserted += res.chunks;
  }

  // PR-diff corpus (spec §3.5, A3): ingest the patch itself — per-file hunks
  // into `pr`, source_id `pr:{n}#{path}`. The files listing above already
  // carries `patch` per file, so no extra fetches. Files without a patch
  // (binary/huge) and filter-rejected paths are skipped; removed files keep
  // their deletion diff (that's real change history).
  const prDiffFiles = prFiles
    .filter(f => typeof f.patch === 'string' && f.patch.length > 0 && shouldIngestFile(f.filename))
    .map(f => ({ path: f.filename, patch: f.patch, status: f.status }));

  let prChunksUpserted = 0;
  if (prDiffFiles.length > 0) {
    // Enrich with the producing task/mission when a worker opened this PR.
    let taskId: string | undefined;
    let missionId: string | undefined;
    const taskRows = await db
      .select({ taskId: workers.taskId, missionId: tasks.missionId })
      .from(workers)
      .innerJoin(tasks, eq(workers.taskId, tasks.id))
      .where(eq(workers.prUrl, `https://github.com/${job.repo}/pull/${job.prNumber}`));
    if (taskRows[0]) {
      taskId = taskRows[0].taskId ?? undefined;
      missionId = taskRows[0].missionId ?? undefined;
    }

    const prChunks = chunkPrDiff(prDiffFiles, {
      prNumber: job.prNumber,
      sha: job.sha,
      taskId,
      missionId,
      sourceTs: job.createdAt ?? new Date(),
    });
    if (prChunks.length > 0) {
      // Separate store: `pr` embeds with the default voyage-4-large model
      // (getVoyageEmbedderForCorpus policy), not the code-3 store above.
      const prStore = new PgVectorStore(getVoyageEmbedder('voyage-4-large'));
      await prStore.upsert(buildNamespace(job.workspaceId, 'pr'), prChunks);
      prChunksUpserted = prChunks.length;
    }
  }

  // First-index backfill (spec §3.4): the diff alone isn't a full index —
  // enqueue a full backfill job so the whole repo gets ingested.
  let backfillEnqueued = false;
  if (!hadCodeIndex) {
    // Belt-and-braces: skip insert when a full job is already active for this
    // workspace+repo (the unique partial index catches the same race at the DB
    // layer, but an explicit check avoids a spurious conflict log entry).
    const activeFull = await db
      .select({ id: knowledgeIngestJobs.id })
      .from(knowledgeIngestJobs)
      .where(
        and(
          eq(knowledgeIngestJobs.workspaceId, job.workspaceId),
          eq(knowledgeIngestJobs.repo, job.repo),
          eq(knowledgeIngestJobs.scope, 'full'),
          or(
            eq(knowledgeIngestJobs.status, 'queued'),
            eq(knowledgeIngestJobs.status, 'running'),
          ),
        ),
      )
      .limit(1);
    if (activeFull.length === 0) {
      const inserted = await db
        .insert(knowledgeIngestJobs)
        .values({
          workspaceId: job.workspaceId,
          repo: job.repo,
          trigger: 'backfill',
          sha: job.sha,
          scope: 'full',
          status: 'queued',
        })
        .onConflictDoNothing()
        .returning({ id: knowledgeIngestJobs.id });
      backfillEnqueued = inserted.length > 0;
    }
  }

  return {
    stats: { filesIngested, filesSkipped: skipped, filesDeleted, chunksUpserted, prChunksUpserted, totalBytes, backfillEnqueued },
    changedFiles: [...toFetch, ...deletions],
  };
}

/**
 * Diff too large for the serverless path — mark this job done with
 * `{escalated: true}` and enqueue a `full`-scope job for the runner fleet
 * (executor ships in stream A2).
 */
async function escalateToFullJob(job: IngestJob, reason: string): Promise<DiffExecution> {
  // Skip insert when a full job is already active — the unique partial index
  // (knowledge_ingest_jobs_active_full_idx) is the hard guard; this check avoids
  // a spurious conflict log on every overlapping escalation.
  const activeFull = await db
    .select({ id: knowledgeIngestJobs.id })
    .from(knowledgeIngestJobs)
    .where(
      and(
        eq(knowledgeIngestJobs.workspaceId, job.workspaceId),
        eq(knowledgeIngestJobs.repo, job.repo),
        eq(knowledgeIngestJobs.scope, 'full'),
        or(
          eq(knowledgeIngestJobs.status, 'queued'),
          eq(knowledgeIngestJobs.status, 'running'),
        ),
      ),
    )
    .limit(1);

  if (activeFull.length === 0) {
    await db
      .insert(knowledgeIngestJobs)
      .values({
        workspaceId: job.workspaceId,
        repo: job.repo,
        trigger: job.trigger,
        sha: job.sha,
        prNumber: job.prNumber,
        scope: 'full',
        status: 'queued',
      })
      .onConflictDoNothing()
      .returning({ id: knowledgeIngestJobs.id });
  }

  return { stats: { escalated: true, reason }, changedFiles: [] };
}
