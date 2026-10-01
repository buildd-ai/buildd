/**
 * Deterministic base refresh for a behind-only PR
 * (conflict-aware-orchestration.md §4).
 *
 * Keeps GitHub's `expected_head_sha` update-branch merge as the clean path — no
 * agent, no history rewrite, and no model call — and makes every other outcome
 * explicit instead of letting any update failure fall through to an agent:
 *
 *  - `updated`            the base was merged in. CI on the new head and the
 *                         ordinary merge policy (surface ordering, verdict
 *                         carry-forward) decide the merge later; nothing here merges.
 *  - `conflict`           GitHub's own 422 merge-conflict: the caller dispatches
 *                         the existing conflict agent.
 *  - `head_changed`       the PR moved; re-read on the new head's event.
 *  - `deferred`/`exhausted`  operational failures (rate limit, auth, transient,
 *                         unknown) — bounded per PR head, then one diagnostic.
 *                         Never an agent: an API error is not conflict evidence.
 *  - `in_flight`          another refresh holds this PR's single-flight lease.
 *  - `semantic_conflict`  (enforce) a verified same-symbol edit on both sides:
 *                         the caller dispatches a semantic conflict review.
 *  - `semantic_deferred`/`semantic_unverified`  (enforce) symbol coverage is
 *                         unknown: bounded rechecks, then a diagnostic. Never
 *                         a clearance and never a textual-conflict agent.
 *
 * State lives on the owning task's `context.baseRefresh`, written by a
 * compare-and-set on its `rev` (neon-http: no interactive transactions). It is
 * keyed by PR + head; the semantic recheck budget also restarts when the base
 * tip moves, since that is new evidence.
 *
 * The semantic check runs only when the workspace opts in (`gitConfig.
 * semanticRefresh`); off by default, so the default path makes no extra reads.
 */

import { db } from '@buildd/core/db';
import { tasks, missionNotes } from '@buildd/core/db/schema';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { updateBehindPrBranch, type BranchUpdateFailure } from '@/lib/pr-branch-update';
import { assessSemanticOverlap, resolveSemanticRefreshMode, type SemanticAssessment } from '@/lib/semantic-refresh';
import { GATE_SLUGS, fireGateEvent, fireDeferralEvent } from '@/lib/gate-ledger';

/** Operational update failures per PR head before a person is told. */
export const MAX_REFRESH_FAILURES = 3;
/** Unknown-coverage semantic rechecks per PR head + base before a person is told. */
export const MAX_SEMANTIC_RECHECKS = 3;
/** How long one refresh holds the PR's single-flight lease. */
export const REFRESH_LEASE_MS = 60_000;

export interface BaseRefreshState {
  prNumber: number;
  headSha: string;
  baseSha: string | null;
  failures: number;
  lastFailure?: BranchUpdateFailure | null;
  semanticRechecks: number;
  inFlightUntil: string | null;
  diagnosedAt?: string | null;
  rev: number;
}

export type RefreshOutcome =
  | { kind: 'updated'; assessment?: SemanticAssessment }
  | { kind: 'conflict'; reason: string }
  | { kind: 'head_changed'; reason: string }
  | { kind: 'in_flight' }
  | { kind: 'deferred'; failure: BranchUpdateFailure; attempts: number; reason: string }
  | { kind: 'exhausted'; failure: BranchUpdateFailure | null; attempts: number; reason: string }
  | { kind: 'semantic_conflict'; assessment: SemanticAssessment }
  | { kind: 'semantic_deferred'; rechecks: number; reason: string }
  | { kind: 'semantic_unverified'; rechecks: number; reason: string };

export interface RefreshParams {
  installationId: number;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  workspaceId: string;
  taskId: string;
  workerId?: string | null;
  missionId?: string | null;
  gitConfig: WorkspaceGitConfig | null | undefined;
}

export interface DiagnosticInput {
  kind: 'refresh_failed' | 'semantic_unverified';
  taskId: string;
  missionId: string | null;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  reason: string;
}

export interface BaseRefreshDeps {
  now?: () => number;
  update?: typeof updateBehindPrBranch;
  assess?: (p: { installationId: number; repoFullName: string; prNumber: number; headSha: string }) => Promise<SemanticAssessment>;
  readState?: (taskId: string) => Promise<BaseRefreshState | null>;
  /** CAS on `rev`: true when this write won. */
  writeState?: (taskId: string, priorRev: number, next: BaseRefreshState) => Promise<boolean>;
  diagnose?: (input: DiagnosticInput) => Promise<void>;
}

// ── DB-bound defaults ─────────────────────────────────────────────────────────

async function readStateFromDb(taskId: string): Promise<BaseRefreshState | null> {
  const row = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId), columns: { context: true } });
  const raw = (row?.context as Record<string, unknown> | null)?.baseRefresh;
  return raw && typeof raw === 'object' ? (raw as BaseRefreshState) : null;
}

async function writeStateToDb(taskId: string, priorRev: number, next: BaseRefreshState): Promise<boolean> {
  const [won] = await db
    .update(tasks)
    .set({
      context: sql`COALESCE(context, '{}'::jsonb) || jsonb_build_object('baseRefresh', ${JSON.stringify(next)}::jsonb)`,
    })
    .where(and(eq(tasks.id, taskId), sql`COALESCE((context->'baseRefresh'->>'rev')::int, 0) = ${priorRev}`))
    .returning({ id: tasks.id });
  return !!won;
}

async function diagnoseToMission(input: DiagnosticInput): Promise<void> {
  console.warn(`[base-refresh] ${input.kind} for ${input.repoFullName}#${input.prNumber}@${input.headSha.slice(0, 7)}: ${input.reason}`);
  if (!input.missionId) return;
  const prUrl = `https://github.com/${input.repoFullName}/pull/${input.prNumber}`;
  const title = input.kind === 'refresh_failed'
    ? `PR #${input.prNumber} — could not refresh from base`
    : `PR #${input.prNumber} — semantic overlap unverified`;
  const body = input.kind === 'refresh_failed'
    ? `GitHub's update-branch kept failing for an operational reason (not a merge conflict), so no conflict agent was dispatched.\n\nLast failure: ${input.reason}\n\nCheck the GitHub App's access and rate limits, then update the branch or retry the merge.\n\nPR: ${prUrl}`
    : `The PR and the newly arrived base change the same files, and no revision-pinned symbol index could confirm they edit different symbols. Semantic clearance stays withheld rather than assumed.\n\nLast check: ${input.reason}\n\nReview the overlap and merge the base in by hand, or turn the semantic check off for this workspace.\n\nPR: ${prUrl}`;
  await db.insert(missionNotes).values({
    missionId: input.missionId,
    taskId: input.taskId,
    authorType: 'system',
    type: 'warning',
    title,
    body,
    status: 'open',
  });
}

// ── Orchestration ────────────────────────────────────────────────────────────

function freshFor(prior: BaseRefreshState | null, prNumber: number, headSha: string): BaseRefreshState {
  if (prior && prior.prNumber === prNumber && prior.headSha === headSha) return prior;
  return {
    prNumber,
    headSha,
    baseSha: null,
    failures: 0,
    lastFailure: null,
    semanticRechecks: 0,
    inFlightUntil: null,
    diagnosedAt: null,
    rev: prior?.rev ?? 0,
  };
}

export async function refreshBehindPr(params: RefreshParams, deps: BaseRefreshDeps = {}): Promise<RefreshOutcome> {
  const now = deps.now ?? Date.now;
  const update = deps.update ?? updateBehindPrBranch;
  const assess = deps.assess ?? ((p) => assessSemanticOverlap(p));
  const readState = deps.readState ?? readStateFromDb;
  const writeState = deps.writeState ?? writeStateToDb;
  const diagnose = deps.diagnose ?? diagnoseToMission;
  const { installationId, repoFullName, prNumber, headSha, workspaceId, taskId } = params;
  const mode = resolveSemanticRefreshMode(params.gitConfig);

  const ledger = (outcome: 'accepted' | 'deferred' | 'warned' | 'rejected', reason: string, detail: Record<string, unknown>) => {
    const input = {
      gate: GATE_SLUGS.BASE_REFRESH,
      surface: 'base-refresh',
      outcome,
      reason,
      workspaceId,
      missionId: params.missionId ?? null,
      taskId,
      workerId: params.workerId ?? null,
      callerOrigin: 'system' as const,
      detail: { prNumber, headSha, repoFullName, semanticMode: mode, ...detail },
    };
    if (outcome === 'deferred') fireDeferralEvent(input);
    else fireGateEvent(input);
  };

  const prior = await readState(taskId);
  let state = freshFor(prior, prNumber, headSha);

  if (state.inFlightUntil && Date.parse(state.inFlightUntil) > now()) return { kind: 'in_flight' };
  if (state.failures >= MAX_REFRESH_FAILURES) {
    return {
      kind: 'exhausted',
      failure: state.lastFailure ?? null,
      attempts: state.failures,
      reason: `update-branch failed ${state.failures} times on this head`,
    };
  }

  // Reserve the PR's one mutation slot.
  const reserved: BaseRefreshState = { ...state, inFlightUntil: new Date(now() + REFRESH_LEASE_MS).toISOString(), rev: state.rev + 1 };
  if (!(await writeState(taskId, state.rev, reserved).catch(() => false))) return { kind: 'in_flight' };
  state = reserved;

  /** Release the lease with the given changes; a lost CAS only means someone else wrote. */
  const release = async (changes: Partial<BaseRefreshState>) => {
    const next: BaseRefreshState = { ...state, ...changes, inFlightUntil: null, rev: state.rev + 1 };
    if (await writeState(taskId, state.rev, next).catch(() => false)) state = next;
  };

  // Semantic check, opt-in only.
  let assessment: SemanticAssessment | undefined;
  if (mode !== 'off') {
    assessment = await assess({ installationId, repoFullName, prNumber, headSha }).catch((err) => ({
      verdict: 'unknown' as const,
      reason: `semantic check failed: ${err instanceof Error ? err.message : String(err)}`,
    }));
    const verdict = assessment.verdict;
    const detail = {
      verdict,
      baseSha: assessment.baseSha ?? null,
      mergeBaseSha: assessment.mergeBaseSha ?? null,
      sharedPaths: assessment.sharedPaths ?? [],
      evidence: assessment.evidence ?? [],
    };

    if (verdict === 'head_changed') {
      await release({});
      ledger('warned', `head moved before refresh: ${assessment.reason}`, detail);
      return { kind: 'head_changed', reason: assessment.reason };
    }

    if (mode === 'shadow') {
      if (verdict === 'same_symbol' || verdict === 'unknown') {
        ledger('warned', `shadow: semantic check ${verdict}: ${assessment.reason}`, detail);
      }
    } else if (verdict === 'same_symbol') {
      await release({ baseSha: assessment.baseSha ?? null });
      ledger('deferred', `same-symbol edit on both sides: ${assessment.reason}`, detail);
      return { kind: 'semantic_conflict', assessment };
    } else if (verdict === 'unknown') {
      const baseSha = assessment.baseSha ?? null;
      const sameBase = baseSha !== null && state.baseSha === baseSha;
      const prev = sameBase ? state.semanticRechecks : 0;
      const rechecks = Math.min(prev + 1, MAX_SEMANTIC_RECHECKS);
      if (rechecks >= MAX_SEMANTIC_RECHECKS) {
        const firstTime = !(sameBase && state.diagnosedAt);
        await release({ baseSha, semanticRechecks: rechecks, diagnosedAt: firstTime ? new Date(now()).toISOString() : state.diagnosedAt ?? null });
        if (firstTime) {
          ledger('rejected', `semantic overlap unverified after ${rechecks} checks: ${assessment.reason}`, detail);
          await diagnose({
            kind: 'semantic_unverified', taskId, missionId: params.missionId ?? null, repoFullName, prNumber, headSha, reason: assessment.reason,
          }).catch((err) => console.error('[base-refresh] diagnostic failed:', err));
        }
        return { kind: 'semantic_unverified', rechecks, reason: assessment.reason };
      }
      await release({ baseSha, semanticRechecks: rechecks, ...(sameBase ? {} : { diagnosedAt: null }) });
      ledger('deferred', `semantic overlap unknown (check ${rechecks}/${MAX_SEMANTIC_RECHECKS}): ${assessment.reason}`, detail);
      return { kind: 'semantic_deferred', rechecks, reason: assessment.reason };
    }
  }

  const res = await update({ installationId, repoFullName, prNumber, headSha });
  if (res.updated) {
    await release({ failures: 0, lastFailure: null, baseSha: assessment?.baseSha ?? state.baseSha });
    ledger('accepted', 'branch updated from base via GitHub; CI re-runs on the new head', {
      verdict: assessment?.verdict ?? null,
    });
    return { kind: 'updated', ...(assessment ? { assessment } : {}) };
  }

  const failure: BranchUpdateFailure = res.failure ?? 'unknown';
  const reason = res.reason ?? 'update-branch failed';
  if (failure === 'conflict') {
    await release({});
    return { kind: 'conflict', reason };
  }
  if (failure === 'head_changed') {
    await release({});
    ledger('warned', `head moved during refresh: ${reason}`, { failure });
    return { kind: 'head_changed', reason };
  }

  const attempts = state.failures + 1;
  if (attempts >= MAX_REFRESH_FAILURES) {
    const firstTime = !state.diagnosedAt;
    await release({ failures: attempts, lastFailure: failure, diagnosedAt: state.diagnosedAt ?? new Date(now()).toISOString() });
    if (firstTime) {
      ledger('rejected', `update-branch failed ${attempts} times (${failure}): ${reason}`, { failure, attempts });
      await diagnose({
        kind: 'refresh_failed', taskId, missionId: params.missionId ?? null, repoFullName, prNumber, headSha, reason: `${failure}: ${reason}`,
      }).catch((err) => console.error('[base-refresh] diagnostic failed:', err));
    }
    return { kind: 'exhausted', failure, attempts, reason };
  }
  await release({ failures: attempts, lastFailure: failure });
  ledger('deferred', `update-branch ${failure} (attempt ${attempts}/${MAX_REFRESH_FAILURES}): ${reason}`, { failure, attempts });
  return { kind: 'deferred', failure, attempts, reason };
}
