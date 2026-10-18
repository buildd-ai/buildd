/**
 * Read-through PR state refresh — a render-time FAST PATH, not a poller.
 *
 * Called from Home, mission detail and task list routes so a view someone is
 * actually looking at reflects a merge that landed seconds ago. Convergence is
 * NOT its job: lib/pr-reconcile.ts (the single GitHub poller, on the hourly
 * pr-reconcile cron) is what guarantees every row's lifecycle state is inside
 * its tier SLA whether or not anybody opens a page. Before that guarantee
 * existed, this function WAS the only defence, and its bounded batch is exactly
 * why four merged PRs sat on Home for up to 90 days.
 *
 * Rate-limited to match the backfill script (200 ms between GitHub calls).
 * Batch capped at 10 workers per render to bound GitHub API fan-out — and
 * ordered least-recently-checked first, so under a backlog the cap is a fair
 * queue rather than an arbitrary sample that can starve the same rows forever.
 * Non-fatal: GitHub errors are logged; prLastCheckedAt is left unset (the
 * attempt clock and failure count belong to pr-reconcile). A failed row is held
 * out of this fast path, in-process, for FAILURE_BACKOFF_MS — see below.
 *
 * A delivery-owned row (a kernel-authority delivery, kill switch on, owns its
 * PR: pr-fact-scope.ts `kernelOwnedRowSql`, the one definition the fact funnel
 * uses; docs/specs/workflow-kernel-library.md §1 AC-3) is read but never healed
 * here: a render, MCP read or explain records at most a fact
 * (`recordPrStateObserved`, an unapplied `pr_closed` fact, which also queues the
 * kernel's fast heal) and writes no lifecycle column, during the request or in
 * after(). A moved row keeps its clocks so pr-reconcile still sees it stale.
 * Rows with no delivery, or a delivery released to legacy, heal as before.
 */

import { emit } from '@/lib/core-emit';
import { db } from '@buildd/core/db';
import { workers, workspaces } from '@buildd/core/db/schema';
import { and, eq, inArray, isNotNull, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import { githubApi, fetchCiLifecycleStatus } from '@/lib/github';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { checkDependsOnResolved } from '@/lib/task-dependencies';
import {
  WORKSPACE_INSTALLATION_WITH,
  pickWorkspaceRepoIdentity,
  createTeamInstallationResolver,
} from '@/lib/workspace-installation';
import { resolvePrRepo } from '@/lib/repo-scope';
import { stampPrMergedOnAllRows } from '@/lib/pr-merge-stamp';
import { recordPrFact } from '@buildd/core/pr-facts';
import { factFunnelScope } from '@/lib/workflow/pr-fact-scope';
import { TERMINAL_PR_LIFECYCLE, isTerminalPrLifecycle } from '@/lib/dep-gate-contract';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';

const BATCH_CAP = 10;
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const RATE_LIMIT_MS = 200;

/**
 * In-process backoff for rows whose GitHub check just failed.
 *
 * A failure leaves prLastCheckedAt as it was, so the failed row stays among the
 * oldest-checked and heads the next batch. Without this, every render (Home is
 * awaited on this call) re-issued the same failing requests, RATE_LIMIT_MS
 * apart, until pr-reconcile eventually retired the row as `unresolvable`.
 *
 * Deliberately memory-only: no DB clock moves, so pr-reconcile's failure
 * counting and TTL are untouched. Per serverless instance, so it is a cost
 * bound, not a guarantee — the worst case is the old behaviour. The window
 * matches STALE_THRESHOLD_MS: a failed row is retried no more often than a
 * successful one is re-checked.
 */
export const FAILURE_BACKOFF_MS = STALE_THRESHOLD_MS;
const FAILURE_BACKOFF_MAX = 500;
const failedAt = new Map<string, number>();

function backedOffIds(now: number): string[] {
  const ids: string[] = [];
  for (const [id, at] of failedAt) {
    if (now - at < FAILURE_BACKOFF_MS) ids.push(id);
    else failedAt.delete(id);
  }
  return ids;
}

function recordFailure(id: string): void {
  failedAt.delete(id); // re-insert so Map order stays oldest-first for eviction
  failedAt.set(id, Date.now());
  if (failedAt.size > FAILURE_BACKOFF_MAX) {
    failedAt.delete(failedAt.keys().next().value!);
  }
}

/**
 * Whole-path pause after GitHub says we are rate limited.
 *
 * A rate limit is not the row's fault, and every further call in the batch (and
 * in the next renders) would hit the same wall while Home waits on it. So the
 * batch stops and the fast path skips entirely — no SELECT, no GitHub call —
 * until the cutoff. pr-reconcile keeps converging state on its own schedule.
 *
 * 429 always counts. 403 counts only when GitHub's body says rate limit (both
 * the primary and secondary limit messages do); a plain permission 403 is one
 * repo's problem and stays a per-row failure, so it cannot pause every
 * workspace's refresh.
 */
// GitHub's guidance for secondary limits is to wait at least a minute. If the
// primary limit is still exhausted after that, the next attempt costs one call
// and pauses again, so the cost stays at about one call a minute.
export const RATE_LIMIT_PAUSE_MS = 60 * 1000;
let rateLimitedUntil = 0;

export function isGithubRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /GitHub API error: (\d{3})\b/.exec(msg);
  if (!m) return false;
  if (m[1] === '429') return true;
  return m[1] === '403' && /rate limit/i.test(msg);
}

function rateLimited(now: number): boolean {
  return now < rateLimitedUntil;
}

/** Test hook: the backoff and pause are module state and would leak between cases. */
export function _resetFailureBackoffForTests(): void {
  failedAt.clear();
  rateLimitedUntil = 0;
}

const TERMINAL_STATUSES = [...TERMINAL_PR_LIFECYCLE];

export interface StalePrCandidate {
  id: string;
  prNumber: number | null;
  /**
   * The PR's own url — the authoritative source for which repo to query, since
   * a worker's PR is often not in its workspace's repo. Optional so existing
   * callers compile; omitting it falls back to the workspace repo.
   */
  prUrl?: string | null;
  workspaceId: string;
  taskId: string | null;
  prLifecycleStatus: string | null;
  prLastCheckedAt: Date | null;
}

/**
 * Refresh stale PR state by querying workers in the given workspaces from the
 * DB. Used by the task list route where workers are not already in memory.
 */
export async function refreshStaleWorkersForWorkspaces(workspaceIds: string[]): Promise<void> {
  if (workspaceIds.length === 0) return;
  if (rateLimited(Date.now())) return;

  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
  // Excluded in SQL, not filtered after: filtering after the LIMIT would let
  // backed-off rows fill the cap and starve every other stale row.
  const backedOff = backedOffIds(Date.now());

  const candidates = await db.query.workers.findMany({
    where: sqlWhere(and(
      inArray(workers.workspaceId, workspaceIds),
      backedOff.length > 0 ? notInArray(workers.id, backedOff) : undefined,
      isNotNull(workers.prNumber),
      or(
        isNull(workers.prLifecycleStatus),
        notInArray(workers.prLifecycleStatus, TERMINAL_STATUSES),
      ),
      or(
        isNull(workers.prLastCheckedAt),
        lt(workers.prLastCheckedAt, staleCutoff),
      ),
    )),
    columns: { id: true, prNumber: true, prUrl: true, workspaceId: true, taskId: true, prLifecycleStatus: true },
    // Least-recently-checked first. Without an ordering the cap made this an
    // arbitrary sample of the backlog, so a row could be passed over on every
    // single render — indefinitely.
    orderBy: sqlOrderBy(sql`${workers.prLastCheckedAt} ASC NULLS FIRST`),
    limit: BATCH_CAP,
  });

  await _processWorkerBatch(
    candidates.map(c => ({
      id: c.id,
      prNumber: c.prNumber!,
      prUrl: c.prUrl,
      workspaceId: c.workspaceId,
      taskId: c.taskId,
      prLifecycleStatus: c.prLifecycleStatus,
    })),
  );
}

/**
 * Refresh stale PR state from a pre-fetched list of workers (e.g. those
 * already returned by the mission detail query). Avoids a second DB round-trip.
 */
export async function refreshStaleWorkers(candidates: StalePrCandidate[]): Promise<void> {
  const now = Date.now();
  if (rateLimited(now)) return;
  const backedOff = new Set(backedOffIds(now));
  const stale = candidates
    .filter(w => {
      if (!w.prNumber) return false;
      if (backedOff.has(w.id)) return false;
      if (isTerminalPrLifecycle(w.prLifecycleStatus)) return false;
      const lastChecked = w.prLastCheckedAt?.getTime() ?? 0;
      return now - lastChecked >= STALE_THRESHOLD_MS;
    })
    // Same fairness rule as the DB-backed variant: the cap must take the
    // oldest-checked rows, never an arbitrary slice of the backlog.
    .sort((a, b) => (a.prLastCheckedAt?.getTime() ?? 0) - (b.prLastCheckedAt?.getTime() ?? 0))
    .slice(0, BATCH_CAP);

  await _processWorkerBatch(
    stale.map(w => ({
      id: w.id,
      prNumber: w.prNumber!,
      prUrl: w.prUrl,
      workspaceId: w.workspaceId,
      taskId: w.taskId,
      prLifecycleStatus: w.prLifecycleStatus,
    })),
  );
}

// ─── Internal ─────────────────────────────────────────────────────────────────

const CI_STATUSES = new Set(['ci_running', 'ci_failed', 'ci_green']);

interface _Candidate {
  id: string;
  prNumber: number;
  prUrl?: string | null;
  workspaceId: string;
  taskId: string | null;
  prLifecycleStatus: string | null;
}

const RENDER_FACT_SOURCE = 'render:pr-state-refresh';

/**
 * Which candidates are delivery-owned (pr-fact-scope.ts `kernelOwnedRowSql`: a kernel-authority
 * delivery, kill switch on, owns the row's PR). `'owned'` rows are read and record at most a fact;
 * `null` rows heal as before (no delivery, or one released to legacy). A failed read fails
 * closed: every row reads `'unknown'` and is left alone, so this render's heal falls to the
 * webhook, the fast heal and the floor.
 */
async function deliveryOwnership(workerIds: string[]): Promise<(id: string) => 'owned' | 'unknown' | null> {
  try {
    const { deliveryOwnedWorkers } = await import('@/lib/workflow/seam');
    const owned = await deliveryOwnedWorkers(workerIds);
    return (id) => (owned.has(id) ? 'owned' : null);
  } catch (err) {
    console.error('[pr-state-refresh] delivery ownership read failed; leaving every row to the healers:', err);
    return () => 'unknown';
  }
}

/** AC-3: a delivery-owned PR a read saw closed or merged becomes a fact, recorded and not applied. */
async function recordObservedClosure(p: { workspaceId: string; repo: string; prNumber: number; pull: unknown }): Promise<void> {
  try {
    const { recordPrStateObserved } = await import('@/lib/workflow/seam');
    await recordPrStateObserved({ workspaceId: p.workspaceId, repoFullName: p.repo, prNumber: p.prNumber, pull: p.pull, source: RENDER_FACT_SOURCE });
  } catch (err) {
    console.error(`[pr-state-refresh] fact record failed for PR #${p.prNumber}:`, err);
  }
}

/**
 * The task and mission pages' merge-state import (after the response). A row
 * with no delivery runs `refreshWorkerMergeStateIfStale` as before; a
 * delivery-owned row is read and, if GitHub says it closed, recorded as a fact
 * only (AC-3).
 *
 * Bounded (spec 3ef37387 R-12): each PR once, and at most
 * {@link RENDER_OBSERVE_MAX} per render, in the caller's order. The rest wait
 * for the next render or the hourly sweep.
 */
export const RENDER_OBSERVE_MAX = 5;

export async function observeMergeStateOnRender(
  rows: Array<{ id: string; prNumber: number; prUrl: string; workspaceId: string }>,
  installationId: number,
): Promise<void> {
  const seen = new Set<string>();
  const stale = rows.filter(w => !seen.has(w.prUrl) && !!seen.add(w.prUrl)).slice(0, RENDER_OBSERVE_MAX);
  if (stale.length === 0) return;
  const ownerOf = await deliveryOwnership(stale.map((w) => w.id));
  for (const w of stale) {
    const { workspaceId } = w;
    const owned = ownerOf(w.id);
    if (owned === 'unknown') continue;
    if (!owned) {
      // Its merge stamp reaches every row on the PR through the fact funnel, whose scope keeps
      // a delivery-owned sibling out (pr-fact-scope.ts), so it runs as before.
      // Lazy: pr-reconcile's graph is large and only the page imports need it.
      const { refreshWorkerMergeStateIfStale } = await import('@/lib/pr-reconcile');
      await refreshWorkerMergeStateIfStale({ id: w.id, prNumber: w.prNumber, prUrl: w.prUrl }, installationId, { workspaceId, observeOnly: true });
      continue;
    }
    const repo = resolvePrRepo({ prUrl: w.prUrl, workspaceRepo: null });
    if (!repo) continue;
    try {
      const pull = await githubApi(installationId, `/repos/${repo}/pulls/${w.prNumber}`) as { state?: string };
      if (pull?.state === 'closed') await recordObservedClosure({ workspaceId, repo, prNumber: w.prNumber, pull });
    } catch (err) {
      console.warn(`[pr-state-refresh] read of delivery-owned PR #${w.prNumber} failed:`, err);
    }
  }
}

async function _processWorkerBatch(candidates: _Candidate[]): Promise<void> {
  if (candidates.length === 0) return;

  const ownerOf = await deliveryOwnership(candidates.map((c) => c.id));

  /** The team's installation per repo, memoized for the batch. See pr-reconcile.ts. */
  const installations = createTeamInstallationResolver();

  // Group by workspace to share one installation token per workspace.
  const byWorkspace = new Map<string, _Candidate[]>();
  for (const w of candidates) {
    if (!byWorkspace.has(w.workspaceId)) byWorkspace.set(w.workspaceId, []);
    byWorkspace.get(w.workspaceId)!.push(w);
  }

  for (const [workspaceId, wsWorkers] of byWorkspace) {
    const ws = await db.query.workspaces.findFirst({
      where: sqlWhere(eq(workspaces.id, workspaceId)),
      columns: { repo: true, teamId: true },
      with: WORKSPACE_INSTALLATION_WITH,
    });

    // Repo identity from the linked github_repos row, not the free-text column.
    const wsIdentity = pickWorkspaceRepoIdentity(ws);
    const workspaceRepo = wsIdentity.fullName;
    const workspaceInstallationId = wsIdentity.installationId;

    for (let i = 0; i < wsWorkers.length; i++) {
      const worker = wsWorkers[i];

      // The PR's own repo first, the workspace only as a fallback — see
      // lib/repo-scope.ts. `workspaces.repo` holds a URL rather than a slug,
      // and the PR is often in a different repo than the workspace anyway.
      const repo = resolvePrRepo({ prUrl: worker.prUrl, workspaceRepo });
      if (!repo) continue;

      const { installationId } = await installations.resolve(
        repo,
        { teamId: ws?.teamId, fullName: workspaceRepo, installationId: workspaceInstallationId },
        { fallbackToWorkspace: true },
      );
      if (!installationId) continue;

      if (i > 0) {
        await new Promise<void>(r => setTimeout(r, RATE_LIMIT_MS));
      }

      try {
        const pr = await githubApi(
          installationId,
          `/repos/${repo}/pulls/${worker.prNumber}`,
        ) as { state: string; merged: boolean; merged_at: string | null; head: { sha: string } };

        const owned = ownerOf(worker.id);
        if (owned === 'unknown') continue;
        if (owned) {
          // AC-3: read, and record at most a fact. No lifecycle column, no
          // dependency wake, no event: the webhook and pr-reconcile heal it.
          let moved = pr.state === 'closed' || !!pr.merged;
          if (moved) {
            await recordObservedClosure({ workspaceId, repo, prNumber: worker.prNumber, pull: pr });
          } else if (CI_STATUSES.has(worker.prLifecycleStatus ?? '') && pr.head?.sha) {
            const liveStatus = await fetchCiLifecycleStatus(installationId, repo, pr.head.sha);
            moved = liveStatus !== null && liveStatus !== worker.prLifecycleStatus;
          }
          if (moved) {
            // Clocks stay put so pr-reconcile still finds the row stale; the
            // in-process backoff keeps renders from re-reading it meanwhile.
            recordFailure(worker.id);
          } else {
            const now = new Date();
            await db.update(workers)
              .set({ prLastCheckedAt: now, prLastVerifiedAt: now, prCheckFailureCount: 0, updatedAt: now })
              .where(eq(workers.id, worker.id));
            failedAt.delete(worker.id);
          }
          continue;
        }

        const now = new Date();
        // The PR resolved, so whatever failure streak this row had is over.
        // Reaching this line means the GitHub call above returned successfully
        // (a throw would have skipped straight to the catch), so this is
        // always a CONFIRMED state — prLastVerifiedAt advances alongside
        // prLastCheckedAt, unlike the catch branch below.
        const bookkeeping = {
          prLastCheckedAt: now,
          prLastVerifiedAt: now,
          prCheckFailureCount: 0,
        };
        let didMerge = false;
        let stamped: Array<{ id: string; taskId: string | null }> = [];

        if (pr.merged && pr.merged_at) {
          // The merge belongs to the PR: one fact stamps this row and every
          // other row carrying it (lib/pr-merge-stamp), GitHub's merged_at.
          await recordPrFact({ workerId: worker.id }, { kind: 'merged', mergedAt: pr.merged_at }, { scope: factFunnelScope });
          stamped = await stampPrMergedOnAllRows({ prUrl: worker.prUrl, prNumber: worker.prNumber, mergedAt: pr.merged_at }).catch(err => {
            console.error(`[pr-state-refresh] merge stamp failed for PR #${worker.prNumber}:`, err);
            return [] as Array<{ id: string; taskId: string | null }>;
          });
          didMerge = true;
        } else if (pr.state === 'closed') {
          await recordPrFact({ workerId: worker.id }, { kind: 'closed' }, { scope: factFunnelScope });
        } else if (pr.state === 'open' && CI_STATUSES.has(worker.prLifecycleStatus ?? '')) {
          // Reconcile CI state: fetch live check-suite verdict for open CI-tracked PRs.
          // This corrects stale ci_failed→ci_green and ci_green→ci_failed transitions
          // that webhooks may have missed or not yet delivered. The verdict is for
          // the live head, so it is never an old-SHA fact.
          const headSha = (pr as any).head?.sha as string | undefined;
          if (headSha) {
            const liveStatus = await fetchCiLifecycleStatus(installationId, repo, headSha);
            if (liveStatus !== null && liveStatus !== worker.prLifecycleStatus) {
              await recordPrFact({ workerId: worker.id }, { kind: 'ci', status: liveStatus, headSha, currentHeadSha: headSha });
            }
          }
        }

        // Clocks advance whatever the fact was (they are not guarded columns).
        await db.update(workers).set({ ...bookkeeping, updatedAt: now }).where(eq(workers.id, worker.id));
        if (pr.state === 'closed' && worker.prNumber != null) {
          // §11: a kernel-owned delivery imports the same close/merge from its own live read.
          await import('@/lib/workflow/kernel-client')
            .then(({ observePrState, systemPrincipal }) => observePrState({ workspaceId, repoFullName: repo, prNumber: worker.prNumber!, installationId, source: 'sweep:pr-state-refresh' }, { principal: systemPrincipal('system:sweep:pr-state-refresh') }))
            .catch((err) => console.error(`[pr-state-refresh] kernel close import failed for PR #${worker.prNumber}:`, err));
        }
        failedAt.delete(worker.id);

        await triggerEvent(channels.workspace(workspaceId), events.WORKER_PROGRESS, {
          taskId: worker.taskId,
        });

        if (didMerge && worker.taskId) {
          checkDependsOnResolved(worker.taskId, { observeOnly: true }).catch(err =>
            console.error(`[pr-state-refresh] checkDependsOnResolved failed for task ${worker.taskId}:`, err),
          );
        }

        if (didMerge) {
          // Same dedupe key as the webhook: a merge it already reported writes nothing.
          await emit({ type: 'pr.merged', repoFullName: repo, prNumber: worker.prNumber, url: worker.prUrl });
          const siblings = stamped.filter((r) => r.id !== worker.id);
          for (const s of siblings) {
            if (s.taskId && s.taskId !== worker.taskId) {
              checkDependsOnResolved(s.taskId, { observeOnly: true }).catch(err =>
                console.error(`[pr-state-refresh] checkDependsOnResolved failed for task ${s.taskId}:`, err),
              );
            }
          }
        }
      } catch (err) {
        if (isGithubRateLimitError(err)) {
          // Stop the whole batch: every remaining call would hit the same limit.
          rateLimitedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
          console.warn(`[pr-state-refresh] GitHub rate limited; pausing read-through refresh for ${RATE_LIMIT_PAUSE_MS / 1000}s`);
          return;
        }
        // Non-fatal: log, leave prLastCheckedAt alone (pr-reconcile owns the
        // attempt clock), and hold the row out of the fast path for a window.
        recordFailure(worker.id);
        console.error(`[pr-state-refresh] worker ${worker.id} PR #${worker.prNumber}:`, err);
      }
    }
  }
}

/**
 * `observeMergeStateOnRender` for a page that has not read the workspace's
 * GitHub installation: it is read here, after the response, so the render
 * reads nothing for the import. No installation, nothing to observe.
 */
export async function observeWorkspaceMergeStateOnRender(
  rows: Array<{ id: string; prNumber: number; prUrl: string; workspaceId: string }>,
  workspaceId: string,
): Promise<void> {
  const ws = await db.query.workspaces.findFirst({
    where: sqlWhere(eq(workspaces.id, workspaceId)),
    columns: {},
    with: { githubInstallation: { columns: { installationId: true } } },
  });
  const installId = ws?.githubInstallation?.installationId;
  if (installId) await observeMergeStateOnRender(rows, installId);
}
