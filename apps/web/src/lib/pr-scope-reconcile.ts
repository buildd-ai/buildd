/**
 * Reconcile PR-backed claim scope against the PR's actual diff.
 *
 * knowledge-base: buildd/design/conflict-aware-orchestration.md §1. A reviewer, CI or conflict
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
 *  - Narrow a live PR owner. While the task that owns the PR has a live
 *    worker, its own declaration is the only cover for edits it has not
 *    committed or leased yet (a Bash or Codex write the runner never saw), and
 *    a remote PR snapshot cannot see a dirty worktree. It is left whole and
 *    recorded as `live_writer`; it is narrowed on a later push once its worker
 *    has ended.
 *  - Release a live fix attempt's edits. A fix attempt with a live worker keeps
 *    every lease it holds and every path its worker has reported touching;
 *    only inherited manifest entries it has neither leased nor touched are
 *    dropped.
 *  - Add new scope. Paths in the diff that the manifest never had are not
 *    appended.
 *
 * What it puts back: a path an earlier reconciliation dropped that a later
 * complete read finds in the diff. A push between the pinned read and the
 * narrowing, or GitHub's file list lagging behind a push, can drop a path the
 * new head then changes; reconciliation is the only thing that removed it, so
 * it is the thing that restores it, under the same revision CAS.
 *
 * A read-only reviewer holds no edit lease at all: whatever it holds (observed
 * touches from checking out the PR branch, typically) is given back regardless
 * of the diff read.
 */
import { LIVE_WORKER_STATUSES, OPEN_TASK_STATUSES, type PrScopeRecord } from '@buildd/shared';
import { db } from '@buildd/core/db';
import { pathClaims, tasks, workers } from '@buildd/core/db/schema';
import { and, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { narrowPathClaims } from '@buildd/core/path-claim';
import { pathsOverlap, REPO_WIDE_SENTINEL, stripTrailingSep } from '@buildd/core/path-overlap';
import { deliverPathReleased } from '@/lib/path-claim-release';
import { workerOwnsPr } from '@/lib/repo-scope';
import { isReadOnlyReview } from '@/lib/read-only-review';

export { readPinnedPrScope, PR_FILES_PAGE_SIZE, PR_FILES_LIST_CAP } from '@buildd/core/pr-scope-read';
import { readPinnedPrScope, type PrScopeRead, type GithubGet } from '@buildd/core/pr-scope-read';
export type { PrScopeRead, PrScopeIncompleteReason, GithubGet } from '@buildd/core/pr-scope-read';
export const PR_SCOPE_SURFACE = 'pr-scope-reconcile';

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
  /** Paths earlier PR-scope reconciliations removed from this task. */
  priorDrops: string[];
}

export interface ScopeNarrowPlan {
  drop: string[];
  /** Earlier PR-scope drops this read shows in the diff, to put back in the manifest. */
  restore: string[];
  /** Why nothing was dropped when the read was not usable. */
  skipReason: string | null;
  /** The PR owner's worker is live: its own declaration is not narrowed. */
  liveWriter: boolean;
}

const concrete = (paths: string[] | null | undefined) =>
  (paths ?? []).filter(p => typeof p === 'string' && p.trim() && p.trim() !== REPO_WIDE_SENTINEL).map(p => stripTrailingSep(p.trim()));

const unique = (paths: string[]) => [...new Set(paths)];

/**
 * Which of a holder's paths the PR diff proves are not being edited.
 *
 * - reviewer: everything it holds — a read-only review owns no edit scope,
 *   whatever the diff read returned. Nothing is restored to it.
 * - unusable read: nothing either way.
 * - PR owner with a live worker: nothing dropped (`liveWriter`).
 * - fix attempt with a live worker: inherited manifest entries outside the
 *   diff that the worker neither leased nor touched. Leases are never released
 *   from a remote snapshot while someone may have unpushed edits under them.
 * - otherwise: manifest entries and leases outside the diff.
 *
 * And, for any editor on a complete read: earlier PR-scope drops that are in
 * the diff and that the manifest no longer covers come back (`restore`). An
 * undeclared (null) manifest was never narrowed, so it has nothing to restore.
 *
 * A directory entry that contains any changed file is kept whole.
 */
export function planScopeNarrowing(holder: ScopeHolder, read: PrScopeRead): ScopeNarrowPlan {
  const manifest = concrete(holder.pathManifest);
  const leases = concrete(holder.heldLeases);
  const none = { drop: [] as string[], restore: [] as string[], skipReason: null, liveWriter: false };

  if (holder.role === 'reviewer') {
    return { ...none, drop: unique([...leases, ...manifest]) };
  }
  if (read.status !== 'complete') {
    return { ...none, skipReason: read.status === 'closed' ? 'pr_closed' : `${read.reason}: ${read.detail}` };
  }

  const inDiff = (p: string) => pathsOverlap([p], read.files);
  const covered = (p: string) => manifest.some(m => m === p || p.startsWith(`${m}/`));
  const restore = holder.pathManifest === null
    ? []
    : unique(concrete(holder.priorDrops).filter(p => inDiff(p) && !covered(p)));

  if (holder.liveEdits !== null && holder.role === 'pr_owner') {
    return { ...none, restore, liveWriter: true };
  }
  if (holder.liveEdits !== null) {
    const protectedPaths = unique([...leases, ...concrete(holder.liveEdits)]);
    const drop = manifest.filter(p => !inDiff(p) && !pathsOverlap([p], protectedPaths));
    return { ...none, drop: unique(drop), restore };
  }
  return { ...none, drop: unique([...manifest, ...leases].filter(p => !inDiff(p))), restore };
}

/**
 * Paths earlier PR-scope reconciliations took off this task: every recorded
 * narrowing this surface made, plus the last reconciliation's own record
 * (narrowings are capped, the record is not).
 */
export function priorPrScopeDrops(pathDeclaration: unknown): string[] {
  const decl = (pathDeclaration ?? {}) as {
    narrowings?: Array<{ surface?: unknown; dropped?: unknown }>;
    prScope?: { dropped?: unknown; restored?: unknown };
  };
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []);
  const dropped = [
    ...(Array.isArray(decl.narrowings) ? decl.narrowings : [])
      .filter(n => n?.surface === PR_SCOPE_SURFACE)
      .flatMap(n => strings(n.dropped)),
    ...strings(decl.prScope?.dropped),
  ];
  return unique(dropped);
}

/**
 * Put `paths` back on the task's manifest, guarded by the ownership revision
 * like every other ownership write. Returns the new revision, or null when the
 * revision moved (someone else changed ownership since the read: keep theirs).
 */
async function restoreManifestPaths(input: {
  workspaceId: string; taskId: string; paths: string[]; expectedRevision: number;
}): Promise<number | null> {
  const rows = await db.update(tasks).set({
    pathManifest: sql`COALESCE(${tasks.pathManifest}, '[]'::jsonb) || ${JSON.stringify(input.paths)}::jsonb`,
    pathClaimRevision: sql`${tasks.pathClaimRevision} + 1`,
  }).where(and(
    eq(tasks.id, input.taskId),
    eq(tasks.workspaceId, input.workspaceId),
    eq(tasks.pathClaimRevision, input.expectedRevision),
    isNotNull(tasks.pathManifest),
  )).returning({ revision: tasks.pathClaimRevision });
  const row = rows[0];
  return row ? Number(row.revision) : null;
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
  tasks: Array<{
    taskId: string; role: ScopeHolderRole; status: PrScopeRecord['status'];
    dropped: string[]; restored: string[]; reason: string | null;
  }>;
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
      id: true, category: true, context: true, pathManifest: true, pathDeclaration: true, pathClaimRevision: true,
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
    priorDrops: priorPrScopeDrops((r as { pathDeclaration?: unknown }).pathDeclaration),
  }));

  const read = await readPinnedPrScope(input.get, input);
  const readAt = new Date().toISOString();
  const report: ReconcileReport = { read: read.status, tasks: [] };

  for (const holder of holders) {
    const plan = planScopeNarrowing(holder, read);
    let status: PrScopeRecord['status'] = holder.role === 'reviewer' ? 'complete' : (read.status === 'complete' ? 'complete' : read.status);
    let reason: string | null = holder.role === 'reviewer' ? 'read-only review holds no edit scope' : plan.skipReason;
    let dropped: string[] = [];
    let restored: string[] = [];
    let revision = holder.revision;
    let casLost = false;

    if (plan.liveWriter) {
      status = 'live_writer';
      reason = 'PR owner has a live worker; its own declaration is not narrowed from a remote snapshot';
    }

    if (plan.restore.length > 0) {
      try {
        const next = await restoreManifestPaths({
          workspaceId, taskId: holder.taskId, paths: plan.restore, expectedRevision: revision,
        });
        if (next === null) {
          casLost = true;
          status = 'revision_conflict';
          reason = `ownership changed during reconciliation (revision ${holder.revision} moved); kept as-is`;
        } else {
          restored = plan.restore;
          revision = next;
        }
      } catch (err) {
        casLost = true;
        status = 'incomplete';
        reason = `restore failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`;
      }
    }

    if (plan.drop.length > 0 && !casLost) {
      try {
        const result = await narrowPathClaims({
          workspaceId,
          taskId: holder.taskId,
          paths: plan.drop,
          surface: PR_SCOPE_SURFACE,
          reason: holder.role === 'reviewer'
            ? `read-only review of PR #${prNumber}`
            : `outside PR #${prNumber} diff at ${read.status === 'complete' ? read.headSha.slice(0, 7) : '?'}`,
          expectedRevision: revision,
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
      ...(restored.length > 0 ? { restored } : {}),
      readAt,
    };
    try {
      await recordPrScope(workspaceId, holder.taskId, record);
    } catch (err) {
      console.warn(`[pr-scope] could not record reconciliation on task ${holder.taskId}:`, err);
    }
    report.tasks.push({ taskId: holder.taskId, role: holder.role, status, dropped, restored, reason });
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
    const restored = report.tasks.filter(t => t.restored.length > 0);
    if (narrowed.length > 0 || restored.length > 0 || (report.read !== 'complete' && report.read !== 'skipped')) {
      console.log(`[pr-scope] PR #${input.prNumber}: read=${report.read}, narrowed ${narrowed.length}/${report.tasks.length} task(s), restored ${restored.length}`);
    }
  } catch (err) {
    console.error(`[pr-scope] reconciliation failed for PR #${input.prNumber}:`, err);
  }
}
