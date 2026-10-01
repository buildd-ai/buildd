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
 *  - `up_to_date`         GitHub's 422 "no new commits": nothing to merge in.
 *
 * Any other 422 is `refused` — deterministic, so it exhausts at once with one
 * diagnostic instead of burning the operational retry cap.
 *
 * State lives on the owning task's `context.baseRefresh`, written by a
 * compare-and-set on its `rev` (neon-http: no interactive transactions). It is
 * keyed by PR + head. The semantic recheck budget is per head and does NOT
 * restart when the base tip moves: on a busy base the tip moves between every
 * check, and a budget that reset on it could hold a PR forever with no
 * diagnostic.
 *
 * Base race. update-branch pins only the head, so base commits that land
 * between the semantic check and the update are merged in unchecked — and a
 * merged commit cannot be un-merged. So a cleared refresh records the base SHA
 * its verdict was computed against (`pendingBaseVerify`), and every merge door
 * consults `checkBaseRefreshHold` (via `evaluateAutoMergeSafety`) before
 * merging: it reads the update merge's base parent and, if the base moved,
 * re-runs the check on the pre-update head against that base. Under enforce
 * the PR is held until that re-check clears it.
 *
 * The semantic check runs only when the workspace opts in (`gitConfig.
 * semanticRefresh`); off by default, so the default path makes no extra reads
 * and writes no hold.
 */

import { db } from '@buildd/core/db';
import { tasks, missionNotes } from '@buildd/core/db/schema';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { updateBehindPrBranch, type BranchUpdateFailure } from '@/lib/pr-branch-update';
import {
  assessSemanticOverlap,
  resolveSemanticRefreshMode,
  SEMANTIC_CHECK_WORST_CASE_MS,
  type SemanticAssessment,
  type SemanticRefreshMode,
} from '@/lib/semantic-refresh';
import { GATE_SLUGS, fireGateEvent, fireDeferralEvent } from '@/lib/gate-ledger';
import { appendPrActivity } from '@/lib/pr-activity-comment';

/** Operational update failures per PR head before a person is told. */
export const MAX_REFRESH_FAILURES = 3;
/** Unknown-coverage semantic rechecks per PR head (any base) before a person is told. */
export const MAX_SEMANTIC_RECHECKS = 3;
/** How long one refresh holds the PR's single-flight lease when no semantic check runs. */
export const REFRESH_LEASE_MS = 60_000;

/**
 * Lease length for a refresh in this mode. With the semantic check on, the
 * lease must outlive a worst-case check (every lookup timing out) plus the
 * update itself, or a second refresh could start while the first still runs.
 */
export function refreshLeaseMs(mode: SemanticRefreshMode): number {
  return mode === 'off' ? REFRESH_LEASE_MS : SEMANTIC_CHECK_WORST_CASE_MS + REFRESH_LEASE_MS;
}

/**
 * A refresh whose clearance was computed against `verifiedBaseSha`. Written
 * when a shadow/enforce refresh merges the base in; cleared once the merged-in
 * base parent is shown equal to it, or re-verified. PR-scoped, not head-scoped:
 * the update itself moves the head.
 */
export interface PendingBaseVerify {
  preUpdateHeadSha: string;
  verifiedBaseSha: string;
  mode: 'shadow' | 'enforce';
  rechecks: number;
  diagnosedAt?: string | null;
  at: string;
}

export interface BaseRefreshState {
  prNumber: number;
  headSha: string;
  baseSha: string | null;
  failures: number;
  lastFailure?: BranchUpdateFailure | null;
  semanticRechecks: number;
  inFlightUntil: string | null;
  /** Operational-failure diagnostic posted for this head. */
  diagnosedAt?: string | null;
  /** Semantic-unverified diagnostic posted for this head. */
  semanticDiagnosedAt?: string | null;
  pendingBaseVerify?: PendingBaseVerify | null;
  rev: number;
}

export type RefreshOutcome =
  | { kind: 'updated'; assessment?: SemanticAssessment }
  | { kind: 'conflict'; reason: string }
  | { kind: 'head_changed'; reason: string }
  | { kind: 'up_to_date'; reason: string }
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
  /** `semantic_conflict`: a re-verification after a refresh found a same-symbol edit. */
  kind: 'refresh_failed' | 'semantic_unverified' | 'semantic_conflict';
  taskId: string;
  missionId: string | null;
  installationId: number;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  reason: string;
}

type Api = (installationId: number, path: string, init?: RequestInit) => Promise<unknown>;

export interface BaseRefreshDeps {
  now?: () => number;
  update?: typeof updateBehindPrBranch;
  assess?: (p: { installationId: number; repoFullName: string; prNumber: number; headSha: string; pinnedBaseSha?: string }) => Promise<SemanticAssessment>;
  /** GitHub reads for the post-refresh hold. */
  api?: Api;
  /** The owning task's mission, when the caller did not say (diagnostic routing only). */
  missionOf?: (taskId: string) => Promise<string | null>;
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

async function missionOfFromDb(taskId: string): Promise<string | null> {
  const row = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId), columns: { missionId: true } });
  return row?.missionId ?? null;
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

const DIAGNOSTIC_TITLE: Record<DiagnosticInput['kind'], (pr: number) => string> = {
  refresh_failed: (pr) => `PR #${pr} — could not refresh from base`,
  semantic_unverified: (pr) => `PR #${pr} — semantic overlap unverified`,
  semantic_conflict: (pr) => `PR #${pr} — same symbol edited by the PR and a base commit merged in`,
};

function diagnosticBody(input: DiagnosticInput): string {
  const prUrl = `https://github.com/${input.repoFullName}/pull/${input.prNumber}`;
  switch (input.kind) {
    case 'refresh_failed':
      return `GitHub's update-branch failed for a reason that is not a merge conflict, so no conflict agent was dispatched.\n\nLast failure: ${input.reason}\n\nCheck the GitHub App's access and rate limits, then update the branch or retry the merge.\n\nPR: ${prUrl}`;
    case 'semantic_unverified':
      return `The PR and the newly arrived base change the same files, and no revision-pinned symbol index could confirm they edit different symbols. Semantic clearance stays withheld rather than assumed.\n\nLast check: ${input.reason}\n\nReview the overlap and merge by hand, or turn the semantic check off for this workspace.\n\nPR: ${prUrl}`;
    case 'semantic_conflict':
      return `Base commits that landed between the semantic check and the branch update were merged in, and they edit the same symbols as this PR. Auto-merge is held.\n\nEvidence: ${input.reason}\n\nReconcile the named symbols on the branch, or review and merge by hand.\n\nPR: ${prUrl}`;
  }
}

export interface DiagnosticDeps {
  insertMissionNote?: (note: typeof missionNotes.$inferInsert) => Promise<void>;
  appendActivity?: typeof appendPrActivity;
}

/**
 * Tell a person. A mission PR gets a mission note (the organizer's feed); a PR
 * with no mission gets an entry on its PR activity comment, the one surface a
 * non-mission PR already has — never silence.
 */
export async function postRefreshDiagnostic(input: DiagnosticInput, deps: DiagnosticDeps = {}): Promise<void> {
  console.warn(`[base-refresh] ${input.kind} for ${input.repoFullName}#${input.prNumber}@${input.headSha.slice(0, 7)}: ${input.reason}`);
  const title = DIAGNOSTIC_TITLE[input.kind](input.prNumber);
  const body = diagnosticBody(input);
  if (input.missionId) {
    const insert = deps.insertMissionNote ?? (async (note) => { await db.insert(missionNotes).values(note); });
    await insert({
      missionId: input.missionId,
      taskId: input.taskId,
      authorType: 'system',
      type: 'warning',
      title,
      body,
      status: 'open',
    });
    return;
  }
  const append = deps.appendActivity ?? appendPrActivity;
  await append({
    installationId: input.installationId,
    repoFullName: input.repoFullName,
    prNumber: input.prNumber,
    entry: { kind: 'human_review_required', note: `${title}\n\n${body}` },
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
    semanticDiagnosedAt: null,
    // PR-scoped: the update that wrote it is what moved the head.
    pendingBaseVerify: prior && prior.prNumber === prNumber ? prior.pendingBaseVerify ?? null : null,
    rev: prior?.rev ?? 0,
  };
}

export async function refreshBehindPr(params: RefreshParams, deps: BaseRefreshDeps = {}): Promise<RefreshOutcome> {
  const now = deps.now ?? Date.now;
  const update = deps.update ?? updateBehindPrBranch;
  const assess = deps.assess ?? ((p) => assessSemanticOverlap(p));
  const readState = deps.readState ?? readStateFromDb;
  const writeState = deps.writeState ?? writeStateToDb;
  const diagnose = deps.diagnose ?? ((input: DiagnosticInput) => postRefreshDiagnostic(input));
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

  // The unknown-coverage budget is spent for this head: a person has been told.
  // No more GitHub reads until the head changes (or the check is turned off).
  if (mode === 'enforce' && state.semanticRechecks >= MAX_SEMANTIC_RECHECKS && state.semanticDiagnosedAt) {
    return {
      kind: 'semantic_unverified',
      rechecks: state.semanticRechecks,
      reason: `semantic overlap unverified after ${state.semanticRechecks} checks on this head`,
    };
  }

  // Reserve the PR's one mutation slot.
  const reserved: BaseRefreshState = { ...state, inFlightUntil: new Date(now() + refreshLeaseMs(mode)).toISOString(), rev: state.rev + 1 };
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
      // Bounded per head, whatever the base does (see the header).
      const baseSha = assessment.baseSha ?? null;
      const rechecks = Math.min(state.semanticRechecks + 1, MAX_SEMANTIC_RECHECKS);
      if (rechecks >= MAX_SEMANTIC_RECHECKS) {
        const firstTime = !state.semanticDiagnosedAt;
        await release({ baseSha, semanticRechecks: rechecks, semanticDiagnosedAt: state.semanticDiagnosedAt ?? new Date(now()).toISOString() });
        if (firstTime) {
          ledger('rejected', `semantic overlap unverified after ${rechecks} checks: ${assessment.reason}`, detail);
          await diagnose({
            kind: 'semantic_unverified', taskId, missionId: params.missionId ?? null, installationId, repoFullName, prNumber, headSha, reason: assessment.reason,
          }).catch((err) => console.error('[base-refresh] diagnostic failed:', err));
        }
        return { kind: 'semantic_unverified', rechecks, reason: assessment.reason };
      }
      await release({ baseSha, semanticRechecks: rechecks });
      ledger('deferred', `semantic overlap unknown (check ${rechecks}/${MAX_SEMANTIC_RECHECKS}): ${assessment.reason}`, detail);
      return { kind: 'semantic_deferred', rechecks, reason: assessment.reason };
    }
  }

  const res = await update({ installationId, repoFullName, prNumber, headSha });
  if (res.updated) {
    // Record what the verdict was computed against, so a base that moved
    // before GitHub ran the merge is re-verified before anything merges. An
    // earlier unresolved record is kept: its range is still unverified.
    const verifiedBaseSha = assessment?.baseSha ?? null;
    const pendingBaseVerify: PendingBaseVerify | null = state.pendingBaseVerify
      ?? (mode !== 'off' && verifiedBaseSha
        ? { preUpdateHeadSha: headSha, verifiedBaseSha, mode, rechecks: 0, diagnosedAt: null, at: new Date(now()).toISOString() }
        : null);
    await release({ failures: 0, lastFailure: null, baseSha: verifiedBaseSha ?? state.baseSha, pendingBaseVerify });
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
  if (failure === 'up_to_date') {
    await release({});
    ledger('warned', `nothing to refresh, the branch already has its base: ${reason}`, { failure });
    return { kind: 'up_to_date', reason };
  }

  // A 422 refusal is deterministic: retrying cannot change it, so it does not
  // spend the operational cap — it reaches it.
  const attempts = failure === 'refused' ? MAX_REFRESH_FAILURES : state.failures + 1;
  if (attempts >= MAX_REFRESH_FAILURES) {
    const firstTime = !state.diagnosedAt;
    await release({ failures: attempts, lastFailure: failure, diagnosedAt: state.diagnosedAt ?? new Date(now()).toISOString() });
    if (firstTime) {
      ledger('rejected', failure === 'refused'
        ? `update-branch refused by GitHub (not retried): ${reason}`
        : `update-branch failed ${attempts} times (${failure}): ${reason}`, { failure, attempts });
      await diagnose({
        kind: 'refresh_failed', taskId, missionId: params.missionId ?? null, installationId, repoFullName, prNumber, headSha, reason: `${failure}: ${reason}`,
      }).catch((err) => console.error('[base-refresh] diagnostic failed:', err));
    }
    return { kind: 'exhausted', failure, attempts, reason };
  }
  await release({ failures: attempts, lastFailure: failure });
  ledger('deferred', `update-branch ${failure} (attempt ${attempts}/${MAX_REFRESH_FAILURES}): ${reason}`, { failure, attempts });
  return { kind: 'deferred', failure, attempts, reason };
}

// ── Post-refresh hold (the base race) ────────────────────────────────────────

export interface HoldParams {
  installationId: number;
  repoFullName: string;
  prNumber: number;
  /** The head about to be merged. */
  headSha: string;
  taskId: string | null | undefined;
  workspaceId?: string | null;
  workerId?: string | null;
  missionId?: string | null;
  /**
   * The workspace gitConfig. Every merge door passes it; omitted or with the
   * check off, the hold is not consulted at all (no read) — the default path.
   */
  gitConfig: WorkspaceGitConfig | null | undefined;
}

export type HoldVerdict = { blocks: false } | { blocks: true; reason: string; needsPerson: boolean };

const OK: HoldVerdict = { blocks: false };

/**
 * Before a merge: if a refresh merged the base in after a semantic verdict,
 * show that the base commit actually merged in is the one the verdict covered,
 * or re-verify the range that arrived since. Under enforce the PR is held until
 * that passes. Reasons start `semantic hold (rechecking)` or `semantic hold
 * (needs a person)` so callers can tell a wait from an escalation.
 *
 * The base parent comes from the head commit when it is the update merge
 * (first parent = the pre-update head). If the head has moved past it, the live
 * base tip stands in: it contains every base commit merged so far, so checking
 * against it is a superset, never a gap.
 */
export async function checkBaseRefreshHold(params: HoldParams, deps: BaseRefreshDeps = {}): Promise<HoldVerdict> {
  if (params.gitConfig === undefined || !params.taskId) return OK;
  const mode = resolveSemanticRefreshMode(params.gitConfig);
  if (mode === 'off') return OK;

  const now = deps.now ?? Date.now;
  const readState = deps.readState ?? readStateFromDb;
  const writeState = deps.writeState ?? writeStateToDb;
  const assess = deps.assess ?? ((p) => assessSemanticOverlap(p));
  const api = deps.api ?? (githubApi as Api);
  const diagnose = deps.diagnose ?? ((input: DiagnosticInput) => postRefreshDiagnostic(input));
  const { installationId, repoFullName, prNumber, headSha } = params;
  const taskId = params.taskId;

  const state = await readState(taskId).catch(() => null);
  const pending = state?.prNumber === prNumber ? state.pendingBaseVerify ?? null : null;
  if (!state || !pending) return OK;
  // The update has not landed on this head: nothing unchecked was merged in.
  if (headSha === pending.preUpdateHeadSha) return OK;

  const ledger = (outcome: 'accepted' | 'deferred' | 'warned' | 'rejected', reason: string, detail: Record<string, unknown> = {}) => {
    const input = {
      gate: GATE_SLUGS.BASE_REFRESH,
      surface: 'base-refresh-hold',
      outcome,
      reason,
      workspaceId: params.workspaceId ?? null,
      missionId: params.missionId ?? null,
      taskId,
      workerId: params.workerId ?? null,
      callerOrigin: 'system' as const,
      detail: { prNumber, headSha, repoFullName, semanticMode: mode, preUpdateHeadSha: pending.preUpdateHeadSha, verifiedBaseSha: pending.verifiedBaseSha, ...detail },
    };
    if (outcome === 'deferred') fireDeferralEvent(input);
    else fireGateEvent(input);
  };
  const write = async (next: PendingBaseVerify | null) => {
    await writeState(taskId, state.rev, { ...state, pendingBaseVerify: next, rev: state.rev + 1 }).catch(() => false);
  };
  const hold = (needsPerson: boolean, why: string): HoldVerdict => ({
    blocks: true,
    needsPerson,
    reason: `semantic hold (${needsPerson ? 'needs a person' : 'rechecking'}): ${why}`,
  });

  const enforcing = mode === 'enforce' && pending.mode === 'enforce';
  if (enforcing && pending.rechecks >= MAX_SEMANTIC_RECHECKS && pending.diagnosedAt) {
    return hold(true, `base commits merged in after the semantic check could not be verified after ${pending.rechecks} checks`);
  }

  // Which base commit did the update merge in?
  let arrivedBase: string | null = null;
  try {
    const commit = (await api(installationId, `/repos/${repoFullName}/commits/${headSha}`)) as { parents?: Array<{ sha?: string }> } | null;
    const parents = (commit?.parents ?? []).map((p) => p?.sha ?? null);
    if (parents.length === 2 && parents[0] === pending.preUpdateHeadSha && parents[1]) {
      arrivedBase = parents[1];
    } else {
      const pr = (await api(installationId, `/repos/${repoFullName}/pulls/${prNumber}`)) as { base?: { ref?: string } } | null;
      const ref = pr?.base?.ref;
      const tip = ref ? ((await api(installationId, `/repos/${repoFullName}/commits/${encodeURIComponent(ref)}`)) as { sha?: string } | null) : null;
      arrivedBase = typeof tip?.sha === 'string' ? tip.sha : null;
    }
  } catch (err) {
    arrivedBase = null;
    if (!enforcing) {
      await write(null);
      ledger('warned', `shadow: could not read the merged-in base: ${err instanceof Error ? err.message : String(err)}`);
      return OK;
    }
  }

  if (arrivedBase === pending.verifiedBaseSha) {
    await write(null);
    ledger('accepted', 'the base merged in is the base the semantic verdict covered');
    return OK;
  }

  if (!enforcing) {
    await write(null);
    ledger('warned', `shadow: base moved between the semantic check and the update (${pending.verifiedBaseSha.slice(0, 7)} -> ${arrivedBase?.slice(0, 7) ?? 'unknown'}); not re-verified`);
    return OK;
  }

  let assessment: SemanticAssessment;
  if (!arrivedBase) {
    assessment = { verdict: 'unknown', reason: 'could not read which base commit the update merged in' };
  } else {
    assessment = await assess({ installationId, repoFullName, prNumber, headSha: pending.preUpdateHeadSha, pinnedBaseSha: arrivedBase }).catch((err) => ({
      verdict: 'unknown' as const,
      reason: `semantic re-check failed: ${err instanceof Error ? err.message : String(err)}`,
    }));
  }
  const detail = { arrivedBaseSha: arrivedBase, verdict: assessment.verdict, sharedPaths: assessment.sharedPaths ?? [], evidence: assessment.evidence ?? [] };
  const missionId = async () => (params.missionId !== undefined
    ? params.missionId
    : await (deps.missionOf ?? missionOfFromDb)(taskId).catch(() => null));
  const diagnosticBase = { taskId, installationId, repoFullName, prNumber, headSha };

  if (assessment.verdict === 'disjoint_paths' || assessment.verdict === 'disjoint_symbols') {
    await write(null);
    ledger('accepted', `base moved before the update; the arrived range re-verified: ${assessment.reason}`, detail);
    return OK;
  }

  if (assessment.verdict === 'same_symbol') {
    const firstTime = !pending.diagnosedAt;
    const stamp = pending.diagnosedAt ?? new Date(now()).toISOString();
    await write({ ...pending, rechecks: MAX_SEMANTIC_RECHECKS, diagnosedAt: stamp });
    if (firstTime) {
      ledger('rejected', `base commits merged in after the check edit the same symbols: ${assessment.reason}`, detail);
      await diagnose({ kind: 'semantic_conflict', ...diagnosticBase, missionId: await missionId(), reason: assessment.reason })
        .catch((err) => console.error('[base-refresh] diagnostic failed:', err));
    }
    return hold(true, `base commits merged in after the check edit the same symbols as this PR (${assessment.reason})`);
  }

  // unknown (or a re-read that saw a moved head — never a clearance).
  const rechecks = Math.min(pending.rechecks + 1, MAX_SEMANTIC_RECHECKS);
  if (rechecks >= MAX_SEMANTIC_RECHECKS) {
    const firstTime = !pending.diagnosedAt;
    await write({ ...pending, rechecks, diagnosedAt: pending.diagnosedAt ?? new Date(now()).toISOString() });
    if (firstTime) {
      ledger('rejected', `base commits merged in after the check unverified after ${rechecks} checks: ${assessment.reason}`, detail);
      await diagnose({ kind: 'semantic_unverified', ...diagnosticBase, missionId: await missionId(), reason: assessment.reason })
        .catch((err) => console.error('[base-refresh] diagnostic failed:', err));
    }
    return hold(true, `base commits merged in after the semantic check could not be verified (${assessment.reason})`);
  }
  await write({ ...pending, rechecks });
  ledger('deferred', `base moved before the update; re-check ${rechecks}/${MAX_SEMANTIC_RECHECKS} unverified: ${assessment.reason}`, detail);
  return hold(false, `base commits merged in after the semantic check are not yet verified, check ${rechecks}/${MAX_SEMANTIC_RECHECKS} (${assessment.reason})`);
}
