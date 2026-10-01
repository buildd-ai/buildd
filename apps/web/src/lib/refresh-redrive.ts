/**
 * Re-drive of deferred branch refreshes (base-refresh.ts) outside landing
 * `enforce`.
 *
 * A behind PR whose update-branch call failed operationally (rate limit,
 * transient, auth, unknown) is deferred by `refreshBehindPr`, and the legacy
 * auto-merge path returns quietly. Its head did not change, so no webhook is
 * coming, and the landing sweep re-drives only `enforce` workspaces. Without
 * this pass such a PR waits forever.
 *
 * This pass finds those PRs from the refresh state itself and re-enters the
 * normal merge door (`redriveSurfaceWaiter`: legacy auto-merge with the same
 * tier and review rules the check-suite handler applies). It decides nothing.
 * The door re-runs the refresh under its own lease and failure count, so the
 * existing `MAX_REFRESH_FAILURES` cap and its one diagnostic still bound it.
 * A door that refuses before it reaches the refresh (awaiting review, CI red
 * since) spends a separate `MAX_REFRESH_REDRIVES` budget per head; when that
 * runs out a person is told once and the PR leaves the candidate set.
 *
 * Cost: it rides the hourly merge-state tick, which already wakes Postgres.
 * Nothing runs on any merge door, and a PR with no refresh failure is never a
 * candidate. GitHub calls happen only for a candidate, capped per run.
 */

import { db } from '@buildd/core/db';
import { tasks, workers, workspaces } from '@buildd/core/db/schema';
import { and, eq, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
import {
  MAX_REFRESH_FAILURES,
  postRefreshDiagnostic,
  writeBaseRefreshState,
  type BaseRefreshState,
} from '@/lib/base-refresh';
import { TERMINAL_PR_LIFECYCLE } from '@/lib/dep-gate-contract';
import type { BranchUpdateFailure } from '@/lib/pr-branch-update';

/** Re-drives of one PR head whose door never reached the refresh, before a person is told. */
export const MAX_REFRESH_REDRIVES = 6;
/** PRs re-driven per run. Each re-entry of the door costs several GitHub calls. */
export const REFRESH_REDRIVE_BATCH_CAP = 10;
/** Candidates read per run. */
export const REFRESH_REDRIVE_ENUMERATION_CAP = 50;
/** Spacing between re-driven PRs. */
export const REFRESH_REDRIVE_RATE_LIMIT_MS = 300;
/** Wall-clock budget, under the route's maxDuration (shared with the other hourly sweeps). */
export const REFRESH_REDRIVE_TIME_BUDGET_MS = 30_000;

/** Operational failures `refreshBehindPr` defers. `refused` exhausts at once, so it never qualifies. */
const DEFERRED_FAILURES: ReadonlySet<BranchUpdateFailure> = new Set<BranchUpdateFailure>(['rate_limit', 'auth', 'transient', 'unknown']);

export interface RedriveCandidate {
  workspaceId: string;
  prNumber: number;
  taskId: string;
  missionId: string | null;
  /** The task's `context.baseRefresh`, as read. */
  state: unknown;
}

/**
 * The refresh state shows a deferred operational failure for this PR, under
 * the cap, not yet told to a person, and no refresh holds the lease.
 */
export function isRedrivableRefresh(state: unknown, prNumber: number, nowMs: number): state is BaseRefreshState {
  if (!state || typeof state !== 'object') return false;
  const s = state as Partial<BaseRefreshState>;
  if (s.prNumber !== prNumber || typeof s.headSha !== 'string' || typeof s.rev !== 'number') return false;
  if (typeof s.failures !== 'number' || s.failures < 1 || s.failures >= MAX_REFRESH_FAILURES) return false;
  if (s.diagnosedAt) return false;
  if (!s.lastFailure || !DEFERRED_FAILURES.has(s.lastFailure)) return false;
  if (s.inFlightUntil) {
    const until = Date.parse(s.inFlightUntil);
    if (!Number.isNaN(until) && until > nowMs) return false;
  }
  return true;
}

export interface RefreshRedriveDeps {
  listCandidates(limit: number): Promise<RedriveCandidate[]>;
  /** Count this re-drive on the state as read (CAS on `rev`). False: another writer got there first. */
  claim(c: RedriveCandidate): Promise<boolean>;
  /** Re-enter the merge door for this PR, only if its live head is still `expectHeadSha`. */
  redrive(c: RedriveCandidate, expectHeadSha: string): Promise<string>;
  /** The re-drive budget for this head is spent: tell a person once, and stop listing it. */
  exhaust(c: RedriveCandidate): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface RefreshRedriveResult {
  enumerated: number;
  redriven: number;
  merged: number;
  /** Re-drive budgets that ran out this run (a diagnostic each). */
  exhausted: number;
  /** Lost the claim to a concurrent writer. */
  raced: number;
  /** Listed by the query but not re-drivable on a closer look. */
  notRedrivable: number;
  errors: number;
  /** Left for the next tick (batch cap or time budget). */
  deferred: number;
  /** Door outcomes, by the door's own label. */
  outcomes: Record<string, number>;
}

export async function runRefreshRedrive(
  deps: RefreshRedriveDeps,
  opts: { batchCap?: number; timeBudgetMs?: number } = {},
): Promise<RefreshRedriveResult> {
  const batchCap = opts.batchCap ?? REFRESH_REDRIVE_BATCH_CAP;
  const timeBudgetMs = opts.timeBudgetMs ?? REFRESH_REDRIVE_TIME_BUDGET_MS;
  const startedAt = deps.now();
  const result: RefreshRedriveResult = {
    enumerated: 0, redriven: 0, merged: 0, exhausted: 0, raced: 0, notRedrivable: 0, errors: 0, deferred: 0, outcomes: {},
  };

  const seen = new Set<string>();
  const candidates: RedriveCandidate[] = [];
  for (const c of await deps.listCandidates(REFRESH_REDRIVE_ENUMERATION_CAP)) {
    const key = `${c.workspaceId}:${c.prNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(c);
  }
  result.enumerated = candidates.length;

  let i = 0;
  for (; i < candidates.length; i++) {
    if (result.redriven >= batchCap || deps.now() - startedAt >= timeBudgetMs) break;
    const c = candidates[i];
    try {
      if (!isRedrivableRefresh(c.state, c.prNumber, deps.now())) {
        result.notRedrivable++;
        continue;
      }
      if ((c.state.redrives ?? 0) >= MAX_REFRESH_REDRIVES) {
        await deps.exhaust(c);
        result.exhausted++;
        continue;
      }
      if (!(await deps.claim(c))) {
        result.raced++;
        continue;
      }
      if (result.redriven > 0) await deps.sleep(REFRESH_REDRIVE_RATE_LIMIT_MS);
      result.redriven++;
      const outcome = await deps.redrive(c, c.state.headSha);
      const label = outcome.startsWith('not_merged') ? 'not_merged' : outcome;
      result.outcomes[label] = (result.outcomes[label] ?? 0) + 1;
      if (outcome === 'merged') result.merged++;
    } catch (err) {
      console.error(`[refresh-redrive] PR #${c.prNumber} failed:`, err instanceof Error ? err.message : err);
      result.errors++;
    }
  }
  result.deferred = candidates.length - i;
  return result;
}

// ── DB and GitHub bindings ───────────────────────────────────────────────────

const TERMINAL_LIFECYCLE = [...TERMINAL_PR_LIFECYCLE];

/**
 * Open worker PRs whose task's refresh state records a failure, not yet
 * diagnosed, for that very PR, in a workspace whose landing mode is not
 * `enforce` (the landing sweep owns those). Fewest re-drives first, so a
 * backlog rotates. The rest of the rule is `isRedrivableRefresh`, in code.
 */
async function listCandidates(limit: number): Promise<RedriveCandidate[]> {
  const refresh = sql`${tasks.context}->'baseRefresh'`;
  const rows = await db
    .select({
      workspaceId: workers.workspaceId,
      prNumber: workers.prNumber,
      taskId: tasks.id,
      missionId: tasks.missionId,
      state: sql<unknown>`${refresh}`,
    })
    .from(workers)
    .innerJoin(tasks, and(eq(tasks.id, workers.taskId), eq(tasks.workspaceId, workers.workspaceId)))
    .where(
      and(
        isNotNull(workers.prNumber),
        isNull(workers.mergedAt),
        or(isNull(workers.prLifecycleStatus), notInArray(workers.prLifecycleStatus, TERMINAL_LIFECYCLE)),
        // CASE, not AND: Postgres does not promise to test the type before the cast.
        sql`(CASE WHEN jsonb_typeof(${refresh}->'failures') = 'number' THEN (${refresh}->>'failures')::numeric ELSE 0 END) > 0`,
        sql`${refresh}->>'diagnosedAt' IS NULL`,
        sql`${refresh}->>'prNumber' = ${workers.prNumber}::text`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${workspaces} w
          WHERE w.id = ${workers.workspaceId} AND w.git_config->'landing'->>'mode' = 'enforce'
        )`,
      ),
    )
    .orderBy(sql`CASE WHEN jsonb_typeof(${refresh}->'redrives') = 'number' THEN (${refresh}->>'redrives')::numeric ELSE 0 END`)
    .limit(limit);
  return rows.flatMap((r) => (r.prNumber === null ? [] : [{ ...r, prNumber: r.prNumber }]));
}

export function createRefreshRedriveDeps(): RefreshRedriveDeps {
  return {
    listCandidates,
    claim: async (c) => {
      const s = c.state as BaseRefreshState;
      return writeBaseRefreshState(c.taskId, s.rev, { ...s, redrives: (s.redrives ?? 0) + 1, rev: s.rev + 1 }).catch(() => false);
    },
    redrive: async (c, expectHeadSha) => {
      const { redriveSurfaceWaiter } = await import('@/lib/surface-ordering-wake');
      return redriveSurfaceWaiter(c.workspaceId, c.prNumber, { expectHeadSha });
    },
    exhaust: async (c) => {
      const s = c.state as BaseRefreshState;
      // Mark first (CAS), so two runs never both tell.
      const won = await writeBaseRefreshState(c.taskId, s.rev, {
        ...s, diagnosedAt: new Date().toISOString(), rev: s.rev + 1,
      }).catch(() => false);
      if (!won) return;
      const { resolveOpenWorkerPr } = await import('@/lib/surface-ordering-wake');
      const pr = await resolveOpenWorkerPr(c.workspaceId, c.prNumber);
      if (pr.skip) return;
      await postRefreshDiagnostic({
        kind: 'refresh_failed',
        taskId: c.taskId,
        missionId: c.missionId,
        installationId: pr.installationId,
        repoFullName: pr.repo,
        prNumber: c.prNumber,
        headSha: s.headSha,
        reason: `${s.lastFailure ?? 'unknown'}: update-branch failed, and ${MAX_REFRESH_REDRIVES} automatic retries could not get the PR back to it`,
      }).catch((err) => console.error('[refresh-redrive] diagnostic failed:', err));
    },
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

/** The pass as the cron route calls it. */
export function redriveDeferredRefreshes(): Promise<RefreshRedriveResult> {
  return runRefreshRedrive(createRefreshRedriveDeps());
}
