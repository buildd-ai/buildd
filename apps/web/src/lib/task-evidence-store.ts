/**
 * Persist `tasks.result.evidence` / `result.mismatch` for a task that has just
 * ended. Loads what the assembly in `task-evidence.ts` needs, reads the PR's
 * checks from GitHub best-effort, and merges the record into `result` with one
 * atomic UPDATE (no read-modify-write: the release sequence and webhooks also
 * write `result`).
 *
 * Never throws into the caller — completion must not depend on it.
 */
import { and, asc, eq, or, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, workers, workspaces, workerErrorTraces } from '@buildd/core/db/schema';
import type { TaskEvidence, TaskMismatch } from '@buildd/shared';
import { githubApi } from '@/lib/github';
import { resolvePrRepo } from '@/lib/repo-scope';
import { WORKSPACE_INSTALLATION_WITH, pickWorkspaceRepoIdentity, installationIdForRepo } from '@/lib/workspace-installation';
import { buildTaskEvidence, summarizeCheckRuns, type EvidenceTrace } from '@/lib/task-evidence';

const TRACE_LIMIT = 200;
const CI_LOOKUP_TIMEOUT_MS = 4000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

/** Checks on the PR's head right now, or null when they could not be read. */
async function fetchPrChecks(input: {
  repo: string;
  prNumber: number;
  installationId: number;
}): Promise<TaskEvidence['ciChecks'] | null> {
  try {
    const pr = await withTimeout(
      githubApi(input.installationId, `/repos/${input.repo}/pulls/${input.prNumber}`),
      CI_LOOKUP_TIMEOUT_MS,
    ) as { head?: { sha?: string } };
    const sha = pr?.head?.sha;
    if (!sha) return null;
    const data = await withTimeout(
      githubApi(input.installationId, `/repos/${input.repo}/commits/${sha}/check-runs?per_page=100`),
      CI_LOOKUP_TIMEOUT_MS,
    ) as { check_runs?: unknown[] };
    return summarizeCheckRuns((data?.check_runs ?? []) as never[]);
  } catch (err) {
    console.warn(`[task-evidence] could not read checks for ${input.repo}#${input.prNumber}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export interface PersistedEvidence {
  evidence: TaskEvidence | null;
  mismatch: TaskMismatch[];
}

export async function persistTaskEvidence(
  taskId: string,
  workerId: string,
  opts: { isSensitive?: boolean; fetchChecks?: typeof fetchPrChecks } = {},
): Promise<PersistedEvidence | null> {
  try {
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
      columns: { id: true, status: true, result: true, context: true, workspaceId: true },
    });
    if (!task || (task.status !== 'completed' && task.status !== 'failed')) return null;

    const worker = await db.query.workers.findFirst({
      where: eq(workers.id, workerId),
      columns: { prUrl: true, prNumber: true, error: true },
    });
    const result = (task.result ?? {}) as Record<string, unknown>;
    const ctx = (task.context ?? {}) as Record<string, unknown>;

    const rows = opts.isSensitive
      ? []
      : await db
          .select({ pattern: workerErrorTraces.pattern, excerpt: workerErrorTraces.excerpt, ts: workerErrorTraces.ts })
          .from(workerErrorTraces)
          .where(eq(workerErrorTraces.workerId, workerId))
          .orderBy(asc(workerErrorTraces.ts))
          .limit(TRACE_LIMIT);
    const traces: EvidenceTrace[] = rows;

    const prNumber = (typeof result.prNumber === 'number' ? result.prNumber : null) ?? worker?.prNumber ?? null;
    const prUrl = (typeof result.prUrl === 'string' ? result.prUrl : null) ?? worker?.prUrl ?? null;

    let ciChecks: TaskEvidence['ciChecks'] | null = null;
    if (prNumber != null) {
      const ws = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, task.workspaceId),
        columns: { repo: true },
        with: WORKSPACE_INSTALLATION_WITH,
      });
      const identity = pickWorkspaceRepoIdentity(ws);
      const repo = resolvePrRepo({ prUrl, workspaceRepo: identity.fullName });
      if (repo) {
        const installationId =
          (repo === identity.fullName ? identity.installationId : null) ?? (await installationIdForRepo(repo));
        if (installationId) {
          ciChecks = await (opts.fetchChecks ?? fetchPrChecks)({ repo, prNumber, installationId });
        }
      }
    }

    const failureContext = (ctx.failureContext ?? null) as { summary?: unknown; errorType?: unknown; job?: unknown } | null;
    const ciDigest = !opts.isSensitive && failureContext?.errorType === 'ci_failure' && typeof failureContext.summary === 'string'
      ? failureContext.summary
      : null;

    const firstRed = ciChecks?.find(c => c.state === 'failed');
    const links: TaskEvidence['links'] = {
      ...(typeof ctx.ciRunUrl === 'string' ? { ciRunUrl: ctx.ciRunUrl } : firstRed?.url ? { ciRunUrl: firstRed.url } : {}),
      ...(prUrl ? { prUrl } : {}),
      fullLogUrl: `/app/tasks/${taskId}`,
    };

    const errorText = opts.isSensitive
      ? null
      : (typeof result.error === 'string' ? result.error : null) ?? worker?.error ?? null;

    const built = buildTaskEvidence({
      status: task.status,
      summary: opts.isSensitive ? null : typeof result.summary === 'string' ? result.summary : null,
      error: errorText,
      diff: {
        files: typeof result.files === 'number' ? result.files : 0,
        added: typeof result.added === 'number' ? result.added : 0,
        removed: typeof result.removed === 'number' ? result.removed : 0,
      },
      traces,
      ciDigest,
      ciChecks,
      links,
      fixCheck: failureContext?.errorType === 'ci_failure' && typeof failureContext.job === 'string' ? failureContext.job : null,
    });
    if (!built.evidence && built.mismatch.length === 0) return built;

    const patch: Record<string, unknown> = {};
    if (built.evidence) patch.evidence = built.evidence;
    if (built.mismatch.length > 0) patch.mismatch = built.mismatch;

    await db
      .update(tasks)
      .set({ result: sql`COALESCE(${tasks.result}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
      .where(and(eq(tasks.id, taskId), or(eq(tasks.status, 'completed'), eq(tasks.status, 'failed'))));
    return built;
  } catch (err) {
    console.error(`[task-evidence] failed to persist evidence for task ${taskId.slice(0, 8)}:`, err);
    return null;
  }
}
