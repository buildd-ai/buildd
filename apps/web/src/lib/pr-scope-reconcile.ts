/**
 * Reconcile PR-backed claim scope against the PR's actual diff.
 *
 * docs/design/conflict-aware-orchestration.md §1. A reviewer, CI or conflict
 * fix attempt copies the original task's `pathManifest` when it is filed, and
 * that manifest is often far wider than what the PR touches: an undeclared or
 * branch-wide scope, or an accumulation of runtime declarations. Two views
 * then over-block:
 *
 *  - the lease view (`path_claims`, layer 2 of the claim route), and the fix
 *    attempt's own manifest, which the claim route checks against every other
 *    live lease before it lets the fix start;
 *  - the open-PR view (layer 1), which reads `tasks.pathManifest` of every task
 *    whose worker has an open PR — the original task and any fix attempt
 *    whose worker pushed to it.
 *
 * Both are narrowed here through Step A's primitive (`narrowPathClaims`): a
 * CAS on the task's ownership revision, selective waiter wake-up, and the
 * original declaration kept in `path_declaration` for conformance and audit.
 *
 * What it will not do:
 *  - Narrow from a read it cannot trust. The PR file list is read fully
 *    paginated and pinned: the PR is read before and after the file pages, and
 *    a head or base that moved in between, a list shorter than GitHub's own
 *    `changed_files`, a closed PR or any read error all leave state untouched
 *    and record why. Missing data is not an empty diff.
 *  - Release a live writer's edits. A task with a live worker keeps every lease
 *    it holds and every path its worker has reported touching; only inherited
 *    manifest entries it has neither leased nor touched are dropped.
 *  - Add scope. Paths in the diff that the manifest lacks are not appended;
 *    this only gives back what the diff proves is not being edited.
 *
 * A read-only reviewer holds no edit lease at all: whatever it holds (observed
 * touches from checking out the PR branch, typically) is given back regardless
 * of the diff read.
 */
import { LIVE_WORKER_STATUSES, OPEN_TASK_STATUSES, type PrScopeRecord } from '@buildd/shared';
import { db } from '@buildd/core/db';
import { pathClaims, tasks, workers } from '@buildd/core/db/schema';
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { narrowPathClaims } from '@buildd/core/path-claim';
import { pathsOverlap, REPO_WIDE_SENTINEL, stripTrailingSep } from '@buildd/core/path-overlap';
import { deliverPathReleased } from '@/lib/path-claim-release';
import { workerOwnsPr } from '@/lib/repo-scope';
import { isReadOnlyReview } from '@/lib/read-only-review';

/** GitHub's page size ceiling for GET /pulls/{n}/files. */
export const PR_FILES_PAGE_SIZE = 100;
/** GitHub lists at most this many files for a PR; anything beyond is invisible. */
export const PR_FILES_LIST_CAP = 3000;

export const PR_SCOPE_SURFACE = 'pr-scope-reconcile';

export type PrScopeIncompleteReason =
  | 'read_failed'
  | 'malformed'
  | 'truncated'
  | 'head_moved'
  | 'base_moved';

export type PrScopeRead =
  | { status: 'complete'; files: string[]; headSha: string; baseSha: string }
  | { status: 'incomplete'; reason: PrScopeIncompleteReason; detail: string; headSha: string | null; baseSha: string | null }
  | { status: 'closed'; merged: boolean; headSha: string | null; baseSha: string | null };

export type GithubGet = (path: string) => Promise<unknown>;

interface PrHead { state: string; merged: boolean; headSha: string; baseSha: string; changedFiles: number | null }

function parsePr(raw: unknown): PrHead | null {
  const pr = raw as Record<string, any> | null;
  const headSha = pr?.head?.sha;
  const baseSha = pr?.base?.sha;
  if (typeof headSha !== 'string' || !headSha || typeof baseSha !== 'string' || !baseSha) return null;
  return {
    state: typeof pr?.state === 'string' ? pr.state : 'open',
    merged: pr?.merged === true || typeof pr?.merged_at === 'string',
    headSha,
    baseSha,
    changedFiles: typeof pr?.changed_files === 'number' ? pr.changed_files : null,
  };
}

/**
 * Read a PR's complete file list, pinned to one head and one base.
 *
 * Every path in the result is a path the PR changes, including both sides of a
 * rename (the source is deleted by the PR as surely as the destination is
 * written). Anything short of a whole, unmoved list is `incomplete`.
 */
export async function readPinnedPrScope(
  get: GithubGet,
  input: { repoFullName: string; prNumber: number; expectedHeadSha?: string | null },
): Promise<PrScopeRead> {
  const prPath = `/repos/${input.repoFullName}/pulls/${input.prNumber}`;
  const incomplete = (reason: PrScopeIncompleteReason, detail: string, at?: PrHead | null): PrScopeRead => ({
    status: 'incomplete', reason, detail, headSha: at?.headSha ?? null, baseSha: at?.baseSha ?? null,
  });

  let before: PrHead | null;
  try {
    before = parsePr(await get(prPath));
  } catch (err) {
    return incomplete('read_failed', `PR read failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
  }
  if (!before) return incomplete('malformed', 'PR response had no head/base sha');
  if (before.state === 'closed' || before.merged) {
    return { status: 'closed', merged: before.merged, headSha: before.headSha, baseSha: before.baseSha };
  }
  if (input.expectedHeadSha && input.expectedHeadSha !== before.headSha) {
    return incomplete('head_moved', `expected head ${input.expectedHeadSha.slice(0, 7)}, PR is at ${before.headSha.slice(0, 7)}`, before);
  }

  const files = new Set<string>();
  let listed = 0;
  const maxPages = Math.ceil(PR_FILES_LIST_CAP / PR_FILES_PAGE_SIZE);
  for (let page = 1; ; page++) {
    if (page > maxPages) {
      return incomplete('truncated', `file list reached GitHub's ${PR_FILES_LIST_CAP}-file cap`, before);
    }
    let batch: unknown;
    try {
      batch = await get(`${prPath}/files?per_page=${PR_FILES_PAGE_SIZE}&page=${page}`);
    } catch (err) {
      return incomplete('read_failed', `file page ${page} failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`, before);
    }
    if (!Array.isArray(batch)) return incomplete('malformed', `file page ${page} was not a list`, before);
    for (const f of batch as Array<Record<string, unknown>>) {
      if (typeof f?.filename !== 'string' || !f.filename) {
        return incomplete('malformed', `file page ${page} had an entry with no filename`, before);
      }
      listed++;
      files.add(stripTrailingSep(f.filename));
      if (typeof f.previous_filename === 'string' && f.previous_filename) {
        files.add(stripTrailingSep(f.previous_filename));
      }
    }
    if (batch.length < PR_FILES_PAGE_SIZE) break;
  }

  if (before.changedFiles !== null && listed < before.changedFiles) {
    return incomplete('truncated', `listed ${listed} of ${before.changedFiles} changed files`, before);
  }

  let after: PrHead | null;
  try {
    after = parsePr(await get(prPath));
  } catch (err) {
    return incomplete('read_failed', `PR re-read failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`, before);
  }
  if (!after) return incomplete('malformed', 'PR re-read had no head/base sha', before);
  if (after.state === 'closed' || after.merged) {
    return { status: 'closed', merged: after.merged, headSha: after.headSha, baseSha: after.baseSha };
  }
  if (after.headSha !== before.headSha) {
    return incomplete('head_moved', `head moved ${before.headSha.slice(0, 7)} -> ${after.headSha.slice(0, 7)} during the read`, after);
  }
  if (after.baseSha !== before.baseSha) {
    return incomplete('base_moved', `base moved ${before.baseSha.slice(0, 7)} -> ${after.baseSha.slice(0, 7)} during the read`, after);
  }

  return { status: 'complete', files: [...files].sort(), headSha: before.headSha, baseSha: before.baseSha };
}

// ── Planning (pure) ──────────────────────────────────────────────────────────

export type ScopeHolderRole = 'pr_owner' | 'fix_attempt' | 'reviewer';

export interface ScopeHolder {
  taskId: string;
  role: ScopeHolderRole;
  pathManifest: string[] | null;
  revision: number;
  /** This task's active path_claims. */
  heldLeases: string[];
  /** Paths the task's live worker(s) reported touching; null when no worker is live. */
  liveEdits: string[] | null;
}

export interface ScopeNarrowPlan {
  drop: string[];
  /** Why nothing was dropped when the read was not usable. */
  skipReason: string | null;
}

const concrete = (paths: string[] | null | undefined) =>
  (paths ?? []).filter(p => typeof p === 'string' && p.trim() && p.trim() !== REPO_WIDE_SENTINEL).map(p => stripTrailingSep(p.trim()));

const unique = (paths: string[]) => [...new Set(paths)];

/**
 * Which of a holder's paths the PR diff proves are not being edited.
 *
 * - reviewer: everything it holds — a read-only review owns no edit scope,
 *   whatever the diff read returned.
 * - unusable read: nothing.
 * - live worker: inherited manifest entries outside the diff that the worker
 *   neither leased nor touched. Leases are never released from a remote
 *   snapshot while someone may have unpushed edits under them.
 * - otherwise: manifest entries and leases outside the diff.
 *
 * A directory entry that contains any changed file is kept whole.
 */
export function planScopeNarrowing(holder: ScopeHolder, read: PrScopeRead): ScopeNarrowPlan {
  const manifest = concrete(holder.pathManifest);
  const leases = concrete(holder.heldLeases);

  if (holder.role === 'reviewer') {
    return { drop: unique([...leases, ...manifest]), skipReason: null };
  }
  if (read.status !== 'complete') {
    return {
      drop: [],
      skipReason: read.status === 'closed' ? 'pr_closed' : `${read.reason}: ${read.detail}`,
    };
  }

  const inDiff = (p: string) => pathsOverlap([p], read.files);
  if (holder.liveEdits !== null) {
    const protectedPaths = unique([...leases, ...concrete(holder.liveEdits)]);
    const drop = manifest.filter(p => !inDiff(p) && !pathsOverlap([p], protectedPaths));
    return { drop: unique(drop), skipReason: null };
  }
  return { drop: unique([...manifest, ...leases].filter(p => !inDiff(p))), skipReason: null };
}

// ── DB selection ─────────────────────────────────────────────────────────────

/**
 * Open fix attempts and reviews of PR `prNumber` in this workspace, plus the
 * tasks whose workers carry the PR (`ownerTaskIds`, any status — a completed
 * task's manifest is still the open-PR view while its PR is open).
 */
export function scopeHolderTasksWhere(workspaceId: string, prNumber: number, ownerTaskIds: string[]): SQL {
  const openAttempt = and(
    inArray(tasks.status, [...OPEN_TASK_STATUSES]),
    or(
      eq(tasks.conflictRetryPrNumber, prNumber),
      eq(tasks.reviewerRetryPrNumber, prNumber),
      eq(tasks.ciRetryPrNumber, prNumber),
      and(
        eq(tasks.category, 'review'),
        sql`${tasks.context}->>'prNumber' = ${String(prNumber)}`,
      ),
    ),
  );
  return and(
    eq(tasks.workspaceId, workspaceId),
    ownerTaskIds.length > 0 ? or(inArray(tasks.id, ownerTaskIds), openAttempt) : openAttempt,
  )!;
}

function roleOf(t: {
  category: string | null; context: unknown;
  conflictRetryPrNumber: number | null; reviewerRetryPrNumber: number | null; ciRetryPrNumber: number | null;
}, prNumber: number): ScopeHolderRole {
  if (isReadOnlyReview(t.category, t.context)) return 'reviewer';
  if (t.conflictRetryPrNumber === prNumber || t.reviewerRetryPrNumber === prNumber || t.ciRetryPrNumber === prNumber) {
    return 'fix_attempt';
  }
  return 'pr_owner';
}

/** Merge `record` into `path_declaration.prScope`, keeping the declaration snapshot. */
async function recordPrScope(workspaceId: string, taskId: string, record: PrScopeRecord): Promise<void> {
  await db.update(tasks).set({
    pathDeclaration: sql`COALESCE(${tasks.pathDeclaration}, jsonb_build_object(
      'declared', ${tasks.pathManifest}, 'source', 'runtime', 'snapshotAt', now()))
      || jsonb_build_object('prScope', ${JSON.stringify(record)}::jsonb)`,
  }).where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId)));
}

// ── Orchestration ────────────────────────────────────────────────────────────

export interface ReconcileInput {
  workspaceId: string;
  repoFullName: string;
  prNumber: number;
  /** The head the caller saw (webhook payload); a read at a different head is not trusted. */
  expectedHeadSha?: string | null;
  get: GithubGet;
}

export interface ReconcileReport {
  read: PrScopeRead['status'] | 'skipped';
  tasks: Array<{ taskId: string; role: ScopeHolderRole; status: PrScopeRecord['status']; dropped: string[]; reason: string | null }>;
}

export async function reconcilePrBackedScope(input: ReconcileInput): Promise<ReconcileReport> {
  const { workspaceId, prNumber } = input;

  const prWorkers = await db.query.workers.findMany({
    where: and(eq(workers.workspaceId, workspaceId), workerOwnsPr(input.repoFullName, prNumber)),
    columns: { taskId: true },
  });
  const ownerTaskIds = unique(prWorkers.map(w => w.taskId).filter((id): id is string => !!id));

  const rows = await db.query.tasks.findMany({
    where: scopeHolderTasksWhere(workspaceId, prNumber, ownerTaskIds),
    columns: {
      id: true, category: true, context: true, pathManifest: true, pathClaimRevision: true,
      conflictRetryPrNumber: true, reviewerRetryPrNumber: true, ciRetryPrNumber: true,
    },
  });
  if (rows.length === 0) return { read: 'skipped', tasks: [] };
  const ids = rows.map(r => r.id);

  const [liveWorkers, leases] = await Promise.all([
    db.query.workers.findMany({
      where: and(inArray(workers.taskId, ids), inArray(workers.status, [...LIVE_WORKER_STATUSES])),
      columns: { taskId: true, observedTouches: true },
    }),
    db.query.pathClaims.findMany({
      where: and(eq(pathClaims.workspaceId, workspaceId), inArray(pathClaims.taskId, ids), isNull(pathClaims.releasedAt)),
      columns: { taskId: true, path: true },
    }),
  ]);

  const liveByTask = new Map<string, string[]>();
  for (const w of liveWorkers) {
    if (!w.taskId) continue;
    liveByTask.set(w.taskId, [...(liveByTask.get(w.taskId) ?? []), ...((w.observedTouches as string[] | null) ?? [])]);
  }
  const leasesByTask = new Map<string, string[]>();
  for (const l of leases) leasesByTask.set(l.taskId, [...(leasesByTask.get(l.taskId) ?? []), l.path]);

  const holders: ScopeHolder[] = rows.map(r => ({
    taskId: r.id,
    role: roleOf(r as any, prNumber),
    pathManifest: (r.pathManifest as string[] | null) ?? null,
    revision: Number(r.pathClaimRevision ?? 0),
    heldLeases: leasesByTask.get(r.id) ?? [],
    liveEdits: liveByTask.has(r.id) ? liveByTask.get(r.id)! : null,
  }));

  const read = await readPinnedPrScope(input.get, input);
  const readAt = new Date().toISOString();
  const report: ReconcileReport = { read: read.status, tasks: [] };

  for (const holder of holders) {
    const plan = planScopeNarrowing(holder, read);
    let status: PrScopeRecord['status'] = holder.role === 'reviewer' ? 'complete' : (read.status === 'complete' ? 'complete' : read.status);
    let reason: string | null = holder.role === 'reviewer' ? 'read-only review holds no edit scope' : plan.skipReason;
    let dropped: string[] = [];

    if (plan.drop.length > 0) {
      try {
        const result = await narrowPathClaims({
          workspaceId,
          taskId: holder.taskId,
          paths: plan.drop,
          surface: PR_SCOPE_SURFACE,
          reason: holder.role === 'reviewer'
            ? `read-only review of PR #${prNumber}`
            : `outside PR #${prNumber} diff at ${read.status === 'complete' ? read.headSha.slice(0, 7) : '?'}`,
          expectedRevision: holder.revision,
        });
        if (result.kind === 'narrowed') {
          dropped = plan.drop;
          await deliverPathReleased(holder.taskId, result, 'narrowed');
        } else if (result.kind === 'revision_conflict') {
          status = 'revision_conflict';
          reason = `ownership changed during reconciliation (revision ${holder.revision} -> ${result.currentRevision}); kept as-is`;
        } else {
          continue; // task vanished from the workspace
        }
      } catch (err) {
        status = 'incomplete';
        reason = `narrow failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`;
      }
    }

    const record: PrScopeRecord = {
      prNumber,
      status,
      reason,
      headSha: read.headSha,
      baseSha: read.baseSha,
      fileCount: read.status === 'complete' ? read.files.length : null,
      dropped,
      readAt,
    };
    try {
      await recordPrScope(workspaceId, holder.taskId, record);
    } catch (err) {
      console.warn(`[pr-scope] could not record reconciliation on task ${holder.taskId}:`, err);
    }
    report.tasks.push({ taskId: holder.taskId, role: holder.role, status, dropped, reason });
  }

  return report;
}

/**
 * Fire-and-forget entry point for the webhook and the fix-attempt filers.
 * Never throws: reconciliation only ever gives scope back, so skipping it
 * leaves the conservative state in place.
 */
export async function reconcilePrBackedScopeSafely(input: Omit<ReconcileInput, 'get'> & { installationId: number }): Promise<void> {
  try {
    const { githubApi } = await import('@/lib/github');
    const report = await reconcilePrBackedScope({
      ...input,
      get: (path) => githubApi(input.installationId, path),
    });
    const narrowed = report.tasks.filter(t => t.dropped.length > 0);
    if (narrowed.length > 0 || (report.read !== 'complete' && report.read !== 'skipped')) {
      console.log(`[pr-scope] PR #${input.prNumber}: read=${report.read}, narrowed ${narrowed.length}/${report.tasks.length} task(s)`);
    }
  } catch (err) {
    console.error(`[pr-scope] reconciliation failed for PR #${input.prNumber}:`, err);
  }
}
