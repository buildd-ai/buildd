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
 * the PR is held until that re-check clears it. The record and its budget are
 * keyed to a head: a push by anyone else supersedes it, and the pushed head is
 * verified on its own with a fresh budget — so pushing a fix clears a hold.
 * The exception is a push on top of buildd's update merge before anyone was
 * told about it: the base range that merge brought in stays in scope (checked
 * first, on the record's own budget) while the head still contains the merge.
 * The record is written together with the lease (provisional until the
 * verdict is in), so a lost release write leaves a re-check, never a pass.
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
import { GATE_SLUGS, fireGateEvent, fireDeferralEvent, fireRepeatGateEvent } from '@/lib/gate-ledger';
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
 * An outstanding semantic verification, keyed to ONE head.
 *
 *  - `refresh`: a refresh merged (or is merging) the base into `headSha`. It
 *    applies to `headSha` (update not landed yet: passes) and to buildd's own
 *    update merge of it — the commit whose first parent is `headSha` — which
 *    is re-verified: `checkHeadSha` (the PR side) against the base actually
 *    merged in, unless that base is `verifiedBaseSha`. `verifiedBaseSha` null
 *    means no verdict was recorded (e.g. the refresh never finished): the
 *    whole arrived range is re-checked, never assumed clear.
 *  - `head`: a hold on exactly `headSha`, re-checked against the live base.
 *
 * Any other head — someone pushed — makes the record stale: the new head gets
 * a fresh, bounded verification of its own. So a pushed fix is what clears a
 * hold, and toggling the check off and on cannot bring back a hold for a head
 * that has since changed.
 */
export interface PendingBaseVerify {
  /** Identity for compare-and-set: a mutation applies only to the record it read. */
  id: string;
  kind: 'refresh' | 'head';
  headSha: string;
  /** refresh: buildd's update merge, once observed, and the base parent it merged in. */
  mergeHeadSha?: string | null;
  arrivedBaseSha?: string | null;
  /** refresh: the PR side of the pinned re-check. */
  checkHeadSha: string;
  verifiedBaseSha: string | null;
  mode: 'shadow' | 'enforce';
  rechecks: number;
  diagnosedAt?: string | null;
  /** The head a person was told about. A later push is their answer; the same head is not. */
  diagnosedHeadSha?: string | null;
  /**
   * refresh: this record carries an unresolved range onto `headSha` itself (a
   * refresh of buildd's earlier update merge, or of a held head), so `headSha`
   * is NOT a clean pre-update head. Normally the refresh's release replaces it;
   * if that write is lost, the hold re-checks the carried range here.
   */
  carried?: boolean;
  /** carried: the base commit the carried range ends at; null = check `headSha` against the live base. */
  carriedArrivedBaseSha?: string | null;
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
  /** Identifies the refresh holding the lease, so only it releases the lease. */
  leaseId?: string | null;
  /**
   * Times the deferred-refresh re-drive (lib/refresh-redrive.ts) re-entered the
   * merge door for this head. Bounded; a new head starts at zero.
   */
  redrives?: number;
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
  kind: 'refresh_failed' | 'semantic_unverified' | 'semantic_conflict' | 'state_unreadable';
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

/** The DB-bound CAS write, for the deferred-refresh re-drive (lib/refresh-redrive.ts). */
export const writeBaseRefreshState = writeStateToDb;

const DIAGNOSTIC_TITLE: Record<DiagnosticInput['kind'], (pr: number) => string> = {
  refresh_failed: (pr) => `PR #${pr} — could not refresh from base`,
  semantic_unverified: (pr) => `PR #${pr} — semantic overlap unverified`,
  semantic_conflict: (pr) => `PR #${pr} — same symbol edited by the PR and a base commit merged in`,
  state_unreadable: (pr) => `PR #${pr} — merges held: the semantic-refresh state cannot be read`,
};

function diagnosticBody(input: DiagnosticInput): string {
  const prUrl = `https://github.com/${input.repoFullName}/pull/${input.prNumber}`;
  switch (input.kind) {
    case 'refresh_failed':
      return `GitHub's update-branch failed for a reason that is not a merge conflict, so no conflict agent was dispatched.\n\nLast failure: ${input.reason}\n\nCheck the GitHub App's access and rate limits, then update the branch or retry the merge.\n\nPR: ${prUrl}`;
    case 'semantic_unverified':
      return `The PR and the newly arrived base change the same files, and no revision-pinned symbol index could confirm they edit different symbols. Semantic clearance stays withheld rather than assumed.\n\nLast check: ${input.reason}\n\nReview the overlap and merge by hand, or turn the semantic check off for this workspace.\n\nPR: ${prUrl}`;
    case 'state_unreadable':
      return `The semantic merge check (enforce) could not read its refresh state, so it holds merges rather than assume nothing is outstanding. Every PR in this workspace under enforce waits the same way until reads succeed.\n\nLast failure: ${input.reason}\n\nCheck the database connection, or switch the semantic check to shadow to stop holding.\n\nPR: ${prUrl}`;
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

// ── Compare-and-set with retry ───────────────────────────────────────────────

/**
 * Apply `mutate` under the `rev` CAS, re-reading and re-applying on a lost
 * write. `mutate` returns null to abandon (the record it needed is gone).
 * Returns the written state, or null when nothing was written.
 */
async function casMutate(
  taskId: string,
  readState: (taskId: string) => Promise<BaseRefreshState | null>,
  writeState: (taskId: string, priorRev: number, next: BaseRefreshState) => Promise<boolean>,
  current: BaseRefreshState | null,
  mutate: (latest: BaseRefreshState) => BaseRefreshState | null,
  tries = 3,
): Promise<BaseRefreshState | null> {
  let base = current;
  for (let i = 0; i < tries; i++) {
    if (!base) base = await readState(taskId).catch(() => null);
    if (!base) return null;
    const next = mutate(base);
    if (!next) return null;
    const written: BaseRefreshState = { ...next, rev: base.rev + 1 };
    if (await writeState(taskId, base.rev, written).catch(() => false)) return written;
    base = null;
  }
  return null;
}

function newId(now: number): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

type Parents = { kind: 'parents'; parents: string[] } | { kind: 'unreadable'; reason: string };

async function readParents(api: Api, installationId: number, repoFullName: string, sha: string): Promise<Parents> {
  try {
    const commit = (await api(installationId, `/repos/${repoFullName}/commits/${sha}`)) as { parents?: Array<{ sha?: string }> } | null;
    return { kind: 'parents', parents: (commit?.parents ?? []).map((p) => p?.sha ?? '').filter(Boolean) };
  } catch (err) {
    return { kind: 'unreadable', reason: err instanceof Error ? err.message : String(err) };
  }
}

/** buildd's update merge of `from`: a two-parent commit whose first parent is `from`. */
function isUpdateMergeOf(parents: string[], from: string): boolean {
  return parents.length === 2 && parents[0] === from;
}

/**
 * A push on a refresh record's branch keeps the record's merged-in base range
 * in scope while nobody has been told about it on another head: until then
 * the pushed commits cannot be anyone's answer to it. Once a person was told,
 * a push of a different head is their answer and is judged on its own.
 */
function rangeStillInScope(p: PendingBaseVerify, headSha: string): boolean {
  return p.kind === 'refresh' && (!p.diagnosedAt || p.diagnosedHeadSha === headSha);
}

type Descent =
  /** mergeSha: the update merge found under the head; null when the range is carried by the record's own head. */
  | { kind: 'descends'; mergeSha: string | null; arrivedBaseSha: string | null }
  | { kind: 'no' }
  | { kind: 'unreadable'; reason: string };

/**
 * The record carries an unverified range on its own head (a refresh of
 * buildd's earlier update merge), as opposed to a hold on a head that is
 * judged against the live base (`checkHeadSha === headSha`).
 */
function carriesRange(p: PendingBaseVerify): boolean {
  return p.kind === 'refresh' && !!p.carried && p.checkHeadSha !== p.headSha;
}

/**
 * Does `headSha` still contain an unverified base range of `p`? One compare
 * read:
 *  - from the known update merge: `ahead` means it is contained;
 *  - from a head that itself carries a range (see `carriesRange`): `ahead`
 *    means that range is contained — nothing else needs finding. A newer
 *    update merge of that head in the list ends the range later and wins;
 *  - otherwise from the pre-update head: the update merge is the commit in
 *    that range whose first parent is the pre-update head. A truncated list
 *    that does not show it is unreadable, never "no".
 * A contained range whose end is unknown comes back with a null base: the
 * caller's bounded unknown path, never a pass.
 */
async function descendsFromUpdateMerge(api: Api, installationId: number, repoFullName: string, p: PendingBaseVerify, headSha: string): Promise<Descent> {
  type Compare = { status?: string; total_commits?: number; commits?: Array<{ sha?: string; parents?: Array<{ sha?: string }> }> } | null;
  try {
    const from = p.mergeHeadSha ?? p.headSha;
    const c = (await api(installationId, `/repos/${repoFullName}/compare/${from}...${headSha}`)) as Compare;
    if (!c || typeof c.status !== 'string') return { kind: 'unreadable', reason: 'GitHub returned no comparison status' };
    if (c.status !== 'ahead') return { kind: 'no' };
    if (p.mergeHeadSha) return { kind: 'descends', mergeSha: p.mergeHeadSha, arrivedBaseSha: p.arrivedBaseSha ?? null };
    const commits = Array.isArray(c.commits) ? c.commits : [];
    for (const commit of commits) {
      const parents = (commit?.parents ?? []).map((x) => x?.sha ?? '').filter(Boolean);
      if (commit?.sha && isUpdateMergeOf(parents, p.headSha)) return { kind: 'descends', mergeSha: commit.sha, arrivedBaseSha: parents[1] };
    }
    if (carriesRange(p)) return { kind: 'descends', mergeSha: null, arrivedBaseSha: p.carriedArrivedBaseSha ?? null };
    if (typeof c.total_commits !== 'number' || c.total_commits > commits.length) {
      return { kind: 'unreadable', reason: `the comparison lists ${commits.length} of ${c.total_commits ?? '?'} commits` };
    }
    return { kind: 'no' };
  } catch (err) {
    return { kind: 'unreadable', reason: err instanceof Error ? err.message : String(err) };
  }
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
    leaseId: null,
    diagnosedAt: null,
    semanticDiagnosedAt: null,
    // Keyed by its own head (see PendingBaseVerify), so it is carried here and
    // judged stale or live against the head that is actually merged.
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
  const api = deps.api ?? (githubApi as Api);
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

  // The verification this refresh leaves behind, written WITH the lease so it
  // cannot be lost: provisional (no verified base) until the verdict is in. An
  // unresolved record for this very head — the head is buildd's earlier update
  // merge, or a hold on it — is carried, so its unverified range stays covered.
  const priorPending = state.pendingBaseVerify ?? null;
  let provisional: PendingBaseVerify | null = null;
  let carry = false;
  // Where the carried range ends, so the hold can re-check it on this head if
  // the release below is lost. Null: check against the live base (a held head)
  // or, when nothing is known, an unverifiable range.
  let carriedArrived: string | null = null;
  if (mode !== 'off') {
    if (priorPending) {
      if (priorPending.kind === 'head') carry = priorPending.headSha === headSha;
      else if (priorPending.headSha === headSha) {
        // A pre-update head carries nothing — unless this record already
        // carried a range onto it (an earlier refresh whose release was lost).
        carry = !!priorPending.carried;
        carriedArrived = priorPending.carriedArrivedBaseSha ?? null;
      } else if (priorPending.mergeHeadSha === headSha) {
        carry = true;
        carriedArrived = priorPending.arrivedBaseSha ?? null;
      } else {
        const p = await readParents(api, installationId, repoFullName, headSha);
        if (p.kind === 'unreadable') carry = true; // keeping a hold is the safe side
        else if (isUpdateMergeOf(p.parents, priorPending.headSha)) {
          carry = true;
          carriedArrived = p.parents[1];
        } else if (rangeStillInScope(priorPending, headSha)) {
          // A push on top of buildd's unverified update merge keeps its range.
          const d = await descendsFromUpdateMerge(api, installationId, repoFullName, priorPending, headSha);
          if (d.kind !== 'no') carry = true;
          if (d.kind === 'descends') carriedArrived = d.arrivedBaseSha;
        }
      }
    }
    const base = { id: newId(now()), kind: 'refresh' as const, headSha, mergeHeadSha: null, arrivedBaseSha: null, mode, at: new Date(now()).toISOString() };
    provisional = carry && priorPending
      ? {
          ...base,
          checkHeadSha: priorPending.kind === 'head' ? priorPending.headSha : priorPending.checkHeadSha,
          // A carried hold was never cleared: nothing on its range is verified.
          verifiedBaseSha: priorPending.kind === 'head' ? null : priorPending.verifiedBaseSha,
          rechecks: priorPending.rechecks,
          diagnosedAt: priorPending.diagnosedAt ?? null,
          diagnosedHeadSha: priorPending.diagnosedHeadSha ?? null,
          carried: true,
          carriedArrivedBaseSha: carriedArrived,
        }
      : { ...base, checkHeadSha: headSha, verifiedBaseSha: null, rechecks: 0, diagnosedAt: null };
  }

  // Reserve the PR's one mutation slot. Under enforce the semantic attempt is
  // counted here, before the check starts, so a request that dies mid-check
  // still spends budget.
  const leaseId = newId(now());
  const countedRechecks = mode === 'enforce' ? state.semanticRechecks + 1 : state.semanticRechecks;
  const reserved: BaseRefreshState = {
    ...state,
    inFlightUntil: new Date(now() + refreshLeaseMs(mode)).toISOString(),
    leaseId,
    semanticRechecks: countedRechecks,
    pendingBaseVerify: provisional ?? priorPending,
    rev: state.rev + 1,
  };
  if (!(await writeState(taskId, state.rev, reserved).catch(() => false))) return { kind: 'in_flight' };
  state = reserved;

  /**
   * Release the lease with these changes, retrying a lost CAS on the latest
   * record (a hold in another door may have written meanwhile). `pending`
   * decides the verification record from the latest one; it only touches the
   * record this refresh wrote. If every retry loses, the provisional record
   * stays — which re-checks, never passes.
   */
  const release = async (changes: Partial<BaseRefreshState>, pending?: (ours: PendingBaseVerify) => PendingBaseVerify | null) => {
    const written = await casMutate(taskId, readState, writeState, state, (latest) => {
      if (latest.leaseId !== leaseId) return null;
      const next: BaseRefreshState = { ...latest, ...changes, inFlightUntil: null, leaseId: null };
      if (pending && provisional && latest.pendingBaseVerify?.id === provisional.id) {
        next.pendingBaseVerify = pending(latest.pendingBaseVerify);
      }
      return next;
    });
    if (written) state = written;
    else console.warn(`[base-refresh] could not release the lease on ${repoFullName}#${prNumber}; it expires on its own`);
  };
  /** Not refreshed: the prior verification record stands. */
  const restore = () => priorPending;
  /** The attempt did not end unknown, so it does not spend the unknown budget. */
  const uncounted = { semanticRechecks: countedRechecks - (mode === 'enforce' ? 1 : 0) };

  // Semantic check, opt-in only.
  let assessment: SemanticAssessment | undefined;
  if (mode !== 'off') {
    // Earlier attempts on this head spent the budget without finishing (e.g.
    // timed out mid-check): no more checks, tell a person.
    const spentUnfinished = mode === 'enforce' && countedRechecks > MAX_SEMANTIC_RECHECKS;
    assessment = spentUnfinished
      ? { verdict: 'unknown' as const, reason: `the last ${MAX_SEMANTIC_RECHECKS} semantic checks on this head did not finish` }
      : await assess({ installationId, repoFullName, prNumber, headSha }).catch((err) => ({
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
      await release(uncounted, restore);
      ledger('warned', `head moved before refresh: ${assessment.reason}`, detail);
      return { kind: 'head_changed', reason: assessment.reason };
    }

    if (mode === 'shadow') {
      if (verdict === 'same_symbol' || verdict === 'unknown') {
        ledger('warned', `shadow: semantic check ${verdict}: ${assessment.reason}`, detail);
      }
    } else if (verdict === 'same_symbol') {
      await release({ ...uncounted, baseSha: assessment.baseSha ?? null }, restore);
      ledger('deferred', `same-symbol edit on both sides: ${assessment.reason}`, detail);
      return { kind: 'semantic_conflict', assessment };
    } else if (verdict === 'unknown') {
      // Bounded per head, whatever the base does (see the header).
      const baseSha = assessment.baseSha ?? null;
      const rechecks = Math.min(countedRechecks, MAX_SEMANTIC_RECHECKS);
      if (rechecks >= MAX_SEMANTIC_RECHECKS) {
        const firstTime = !state.semanticDiagnosedAt;
        await release({ baseSha, semanticRechecks: rechecks, semanticDiagnosedAt: state.semanticDiagnosedAt ?? new Date(now()).toISOString() }, restore);
        if (firstTime) {
          ledger('rejected', `semantic overlap unverified after ${rechecks} checks: ${assessment.reason}`, detail);
          await diagnose({
            kind: 'semantic_unverified', taskId, missionId: params.missionId ?? null, installationId, repoFullName, prNumber, headSha, reason: assessment.reason,
          }).catch((err) => console.error('[base-refresh] diagnostic failed:', err));
        }
        return { kind: 'semantic_unverified', rechecks, reason: assessment.reason };
      }
      await release({ baseSha, semanticRechecks: rechecks }, restore);
      ledger('deferred', `semantic overlap unknown (check ${rechecks}/${MAX_SEMANTIC_RECHECKS}): ${assessment.reason}`, detail);
      return { kind: 'semantic_deferred', rechecks, reason: assessment.reason };
    }
  }

  const res = await update({ installationId, repoFullName, prNumber, headSha });
  if (res.updated) {
    // Record what the verdict was computed against, so a base that moved
    // before GitHub ran the merge is re-verified before anything merges. A
    // carried record keeps its own (older) verified base.
    const verifiedBaseSha = assessment?.baseSha ?? null;
    await release(
      { ...uncounted, failures: 0, lastFailure: null, baseSha: verifiedBaseSha ?? state.baseSha },
      // A carried record keeps its marker even once the update landed: if the
      // branch is pushed back to (or on top of) `headSha`, its range is still
      // unverified. Only a re-verification clears it.
      (ours) => (carry ? ours : { ...ours, verifiedBaseSha }),
    );
    ledger('accepted', 'branch updated from base via GitHub; CI re-runs on the new head', {
      verdict: assessment?.verdict ?? null,
    });
    return { kind: 'updated', ...(assessment ? { assessment } : {}) };
  }

  const failure: BranchUpdateFailure = res.failure ?? 'unknown';
  const reason = res.reason ?? 'update-branch failed';
  if (failure === 'conflict') {
    await release(uncounted, restore);
    return { kind: 'conflict', reason };
  }
  if (failure === 'head_changed') {
    await release(uncounted, restore);
    ledger('warned', `head moved during refresh: ${reason}`, { failure });
    return { kind: 'head_changed', reason };
  }
  if (failure === 'up_to_date') {
    await release(uncounted, restore);
    ledger('warned', `nothing to refresh, the branch already has its base: ${reason}`, { failure });
    return { kind: 'up_to_date', reason };
  }

  // A 422 refusal is deterministic: retrying cannot change it, so it does not
  // spend the operational cap — it reaches it.
  const attempts = failure === 'refused' ? MAX_REFRESH_FAILURES : state.failures + 1;
  if (attempts >= MAX_REFRESH_FAILURES) {
    const firstTime = !state.diagnosedAt;
    await release({ ...uncounted, failures: attempts, lastFailure: failure, diagnosedAt: state.diagnosedAt ?? new Date(now()).toISOString() }, restore);
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
  await release({ ...uncounted, failures: attempts, lastFailure: failure }, restore);
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

/** Consecutive failed state reads (per workspace, this process) before a person is told, once. */
export const STATE_READ_FAILURES_BEFORE_DIAGNOSTIC = 5;
const stateReadFailures = new Map<string, { count: number; told: boolean }>();
/** Test seam: forget the in-process read-failure counts. */
export function resetStateReadFailures(): void {
  stateReadFailures.clear();
}

/** A repeated hold-wait ledger row collapses into one per PR head inside this window (as surface-ordering waits do). */
const HOLD_WAIT_COALESCE_MS = 6 * 60 * 60_000;

/**
 * Before a merge: is there an outstanding semantic verification for THIS head
 * (see PendingBaseVerify)? Under enforce the PR is held until it passes, with
 * a bounded budget per head. Reasons start `semantic hold (rechecking)` or
 * `semantic hold (needs a person)` so callers can tell a wait from an
 * escalation. A push of any other head supersedes the record: the new head is
 * verified on its own with a fresh budget, so a pushed fix clears a hold —
 * except that a push on top of buildd's still-unverified update merge first
 * re-checks the base range that merge brought in (nobody has seen it yet).
 *
 * Shadow only records: it never blocks. A state read that fails holds under
 * enforce (a wait, re-tried by the next merge attempt) and passes under shadow.
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

  let state: BaseRefreshState | null = null;
  let pending: PendingBaseVerify | null = null;
  let pinnedBase: string | null = null;

  const ledger = (outcome: 'accepted' | 'deferred' | 'warned' | 'rejected', reason: string, detail: Record<string, unknown> = {}, opts: { coalesce?: boolean } = {}) => {
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
      detail: { prNumber, headSha, repoFullName, semanticMode: mode, pendingKind: pending?.kind, pendingHeadSha: pending?.headSha, verifiedBaseSha: pending?.verifiedBaseSha ?? null, ...detail },
    };
    if (outcome === 'deferred') fireDeferralEvent(input);
    else if (opts.coalesce) fireRepeatGateEvent(input, { key: { pr: String(prNumber), head: headSha, repo: repoFullName }, windowMs: HOLD_WAIT_COALESCE_MS });
    else fireGateEvent(input);
  };
  const hold = (needsPerson: boolean, why: string): HoldVerdict => ({
    blocks: true,
    needsPerson,
    reason: `semantic hold (${needsPerson ? 'needs a person' : 'rechecking'}): ${why}`,
  });

  // Fail closed under enforce: no state means no proof that nothing is
  // outstanding. One retry for a blip; the merge door re-tries on its next
  // attempt and the ledger records each refusal. The per-head markers live in
  // the state that could not be read, so a persistent failure is counted in
  // process per workspace instead, and a person is told once.
  const failureKey = params.workspaceId ?? repoFullName;
  try {
    state = await readState(taskId).catch(() => readState(taskId));
    stateReadFailures.delete(failureKey);
  } catch (err) {
    const why = `could not read the refresh state: ${err instanceof Error ? err.message : String(err)}`;
    if (mode !== 'enforce') {
      ledger('warned', `shadow: ${why}`);
      return OK;
    }
    ledger('deferred', why);
    const seen = stateReadFailures.get(failureKey) ?? { count: 0, told: false };
    if (!stateReadFailures.has(failureKey) && stateReadFailures.size >= 1000) stateReadFailures.clear();
    seen.count++;
    stateReadFailures.set(failureKey, seen);
    if (seen.count >= STATE_READ_FAILURES_BEFORE_DIAGNOSTIC && !seen.told) {
      seen.told = true;
      // Routed to the PR's GitHub activity comment, not a mission note: a
      // mission note (and the mission lookup) would hit the failing store.
      await diagnose({ kind: 'state_unreadable', taskId, missionId: null, installationId, repoFullName, prNumber, headSha, reason: `${seen.count} consecutive failed reads; last: ${why}` })
        .catch((e) => console.error('[base-refresh] diagnostic failed:', e));
    }
    return hold(false, why);
  }
  pending = state?.prNumber === prNumber ? state.pendingBaseVerify ?? null : null;
  if (!state || !pending) return OK;
  const enforcing = mode === 'enforce' && pending.mode === 'enforce';

  /** Replace the record we read (by id) with `next`; retried on a lost CAS. */
  const writePending = async (next: PendingBaseVerify | null): Promise<void> => {
    const ours = pending!.id;
    const written = await casMutate(taskId, readState, writeState, state, (latest) =>
      latest.pendingBaseVerify?.id === ours ? { ...latest, pendingBaseVerify: next } : null);
    if (written) state = written;
    if (next) pending = next;
  };
  /**
   * Shadow only records. It drops a record that shadow wrote; a record written
   * under enforce (the workspace switched since) keeps its unverified range for
   * when enforce is back.
   */
  const dropUnlessEnforced = async (): Promise<void> => {
    if (pending!.mode !== 'enforce') await writePending(null);
  };
  const missionId = async () => (params.missionId !== undefined
    ? params.missionId
    : await (deps.missionOf ?? missionOfFromDb)(taskId).catch(() => null));
  const rekeyToHead = async (): Promise<void> => {
    await writePending({
      id: newId(now()), kind: 'head', headSha, mergeHeadSha: null, arrivedBaseSha: null, checkHeadSha: headSha,
      verifiedBaseSha: null, mode: 'enforce', rechecks: 0, diagnosedAt: null, at: new Date(now()).toISOString(),
    });
  };
  const unknown = (reason: string) => async (): Promise<SemanticAssessment> => ({ verdict: 'unknown', reason });
  const live = () => assess({ installationId, repoFullName, prNumber, headSha });

  // A person was already told about this very head and its budget is spent:
  // nothing a re-read could change. No GitHub reads until the head moves.
  if (enforcing && pending.diagnosedAt && pending.diagnosedHeadSha === headSha && pending.rechecks >= MAX_SEMANTIC_RECHECKS) {
    return hold(true, `a person was told about this head; push a fix to the branch or merge by hand`);
  }

  // ── Which head is this, relative to the record? ──
  /** The head contains buildd's unverified update merge under a push. */
  let descendant = false;
  if (pending.kind === 'refresh' && headSha === pending.headSha) {
    // The update has not landed on this head: nothing unchecked was merged in…
    if (!pending.carried) return OK;
    // …unless the record carries a range onto this head (its refresh has not
    // released, or its release was lost): that range is still unverified.
    if (!enforcing) {
      ledger('warned', 'shadow: this head carries a base range that was never re-verified');
      return OK;
    }
    if (state.leaseId && state.inFlightUntil && Date.parse(state.inFlightUntil) > now()) {
      return hold(false, 'a refresh of this head is in flight; the base range it carries is not verified yet');
    }
    return verifyCarried();
  }
  if (pending.kind === 'refresh') {
    let isOurMerge = headSha === pending.mergeHeadSha;
    if (isOurMerge) {
      pinnedBase = pending.arrivedBaseSha ?? null;
    } else {
      const p = await readParents(api, installationId, repoFullName, headSha);
      if (p.kind === 'unreadable') {
        if (!enforcing) {
          await dropUnlessEnforced();
          ledger('warned', `shadow: could not read the head commit: ${p.reason}`);
          return OK;
        }
        // Fail closed; spend budget on the record as it stands.
        return bounded(unknown(`could not read the head commit: ${p.reason}`));
      }
      isOurMerge = isUpdateMergeOf(p.parents, pending.headSha);
      if (isOurMerge) {
        pinnedBase = p.parents[1];
        await writePending({ ...pending, mergeHeadSha: headSha, arrivedBaseSha: pinnedBase });
      }
    }
    if (!isOurMerge && rangeStillInScope(pending, headSha)) {
      // A push. If it sits on top of buildd's update merge, the base range that
      // merge brought in is still unverified, and the push is not an answer to
      // it — nobody has been shown it. Keep it in scope.
      const d = await descendsFromUpdateMerge(api, installationId, repoFullName, pending, headSha);
      if (d.kind === 'unreadable') {
        if (!enforcing) {
          await dropUnlessEnforced();
          ledger('warned', `shadow: could not tell whether the pushed head contains the unverified update merge: ${d.reason}`);
          return OK;
        }
        return bounded(unknown(`could not tell whether the pushed head contains buildd's unverified update merge: ${d.reason}`));
      }
      if (d.kind === 'descends') {
        if (!enforcing) {
          await dropUnlessEnforced();
          ledger('warned', 'shadow: a push on top of the unverified update merge; enforce keeps the merged-in base range in scope');
          return OK;
        }
        descendant = true;
        pinnedBase = d.arrivedBaseSha;
        if (!pending.mergeHeadSha && d.mergeSha) await writePending({ ...pending, mergeHeadSha: d.mergeSha, arrivedBaseSha: d.arrivedBaseSha });
        // Repeats on every merge attempt while the range is re-checked: one row per PR head.
        ledger('warned', 'a push on top of the unverified update merge; its merged-in base range stays in scope', {}, { coalesce: true });
      }
    }
    if (!isOurMerge && !descendant) {
      // Someone pushed: the record is about a head that is no longer merged.
      if (!enforcing) {
        await dropUnlessEnforced();
        ledger('warned', 'shadow: a push superseded the refresh before it was verified');
        return OK;
      }
      ledger('warned', 'a push superseded the refresh record; verifying the new head on its own');
      await rekeyToHead();
    }
  } else if (pending.headSha !== headSha) {
    if (!enforcing) {
      await dropUnlessEnforced();
      return OK;
    }
    ledger('warned', 'a push superseded the held head; verifying the new head on its own');
    await rekeyToHead();
  }

  // ── Verify ──
  if (pending.kind === 'refresh') {
    /** The pushed head, once the range under it is verified: judged on its own, as any push. */
    const thenPushedHead = descendant
      ? async (): Promise<HoldVerdict> => {
          ledger('accepted', 're-verified the base range under the push; verifying the pushed head on its own');
          await rekeyToHead();
          pinnedBase = null;
          return bounded(live);
        }
      : undefined;
    if (pinnedBase && pending.verifiedBaseSha && pinnedBase === pending.verifiedBaseSha) {
      if (thenPushedHead) return thenPushedHead();
      await writePending(null);
      ledger('accepted', 'the base merged in is the base the semantic verdict covered');
      return OK;
    }
    if (!enforcing) {
      await dropUnlessEnforced();
      ledger('warned', `shadow: base moved between the semantic check and the update (${pending.verifiedBaseSha?.slice(0, 7) ?? 'unrecorded'} -> ${pinnedBase?.slice(0, 7) ?? 'unknown'}); not re-verified`);
      return OK;
    }
    const pr = pending.checkHeadSha;
    const base = pinnedBase;
    return bounded(base
      ? () => assess({ installationId, repoFullName, prNumber, headSha: pr, pinnedBaseSha: base })
      : unknown('could not tell which base commit the update merge brought in'), thenPushedHead);
  }
  // A hold on exactly this head, against the live base.
  return bounded(live);

  /**
   * The record carries an unverified range onto this very head. Re-check it;
   * if it clears, keep the record as verified up to that base (not deleted:
   * a refresh of this head may still land and must be judged against it).
   */
  async function verifyCarried(): Promise<HoldVerdict> {
    const p = pending!;
    const settle = (verified: string | null) => async (): Promise<HoldVerdict> => {
      await writePending({ ...pending!, carried: false, carriedArrivedBaseSha: null, verifiedBaseSha: verified, rechecks: 0 });
      ledger('accepted', 're-verified the base range carried onto this head');
      return OK;
    };
    if (p.carriedArrivedBaseSha) {
      const base = p.carriedArrivedBaseSha;
      pinnedBase = base;
      if (base === p.verifiedBaseSha) return settle(base)();
      return bounded(() => assess({ installationId, repoFullName, prNumber, headSha: p.checkHeadSha, pinnedBaseSha: base }), settle(base));
    }
    if (p.checkHeadSha === headSha) {
      return bounded(live, (a) => settle(a.baseSha ?? null)());
    }
    return bounded(unknown('the range carried onto this head has no recorded base commit'));
  }

  /**
   * One bounded verification of the record, counted before it starts. Under
   * shadow it never runs and never blocks: shadow only records.
   */
  async function bounded(run: () => Promise<SemanticAssessment>, onClear?: (a: SemanticAssessment) => Promise<HoldVerdict>): Promise<HoldVerdict> {
    const p = pending!;
    if (!enforcing) {
      ledger('warned', 'shadow: enforce would re-verify this head before merging; not blocking');
      return OK;
    }
    const diagnosticBase = { taskId, installationId, repoFullName, prNumber, headSha };
    const tellOnce = async (kind: 'semantic_conflict' | 'semantic_unverified', why: string, detail: Record<string, unknown>) => {
      if (p.diagnosedAt) return;
      await writePending({ ...pending!, rechecks: Math.max(pending!.rechecks, MAX_SEMANTIC_RECHECKS), diagnosedAt: new Date(now()).toISOString(), diagnosedHeadSha: headSha });
      ledger('rejected', why, detail);
      await diagnose({ kind, ...diagnosticBase, missionId: await missionId(), reason: why })
        .catch((err) => console.error('[base-refresh] diagnostic failed:', err));
    };

    if (p.rechecks >= MAX_SEMANTIC_RECHECKS) {
      // Spent: either a person was told, or earlier checks died mid-run.
      await tellOnce('semantic_unverified', `the last ${MAX_SEMANTIC_RECHECKS} semantic checks on this head did not clear it`, {});
      return hold(true, `semantic overlap on this head could not be verified after ${p.rechecks} checks`);
    }
    const attempt = p.rechecks + 1;
    await writePending({ ...p, rechecks: attempt });
    const a = await run().catch((err) => ({
      verdict: 'unknown' as const,
      reason: `semantic re-check failed: ${err instanceof Error ? err.message : String(err)}`,
    })) as SemanticAssessment;
    const detail = { pinnedBaseSha: pinnedBase, verdict: a.verdict, sharedPaths: a.sharedPaths ?? [], evidence: a.evidence ?? [] };
    if (a.verdict === 'disjoint_paths' || a.verdict === 'disjoint_symbols') {
      if (onClear) return onClear(a);
      await writePending(null);
      ledger('accepted', `re-verified: ${a.reason}`, detail);
      return OK;
    }
    if (a.verdict === 'same_symbol') {
      await tellOnce('semantic_conflict', a.reason, detail);
      return hold(true, `the same symbols are edited on both sides (${a.reason}); push a fix to the branch to re-check`);
    }
    if (attempt >= MAX_SEMANTIC_RECHECKS) {
      await tellOnce('semantic_unverified', a.reason, detail);
      return hold(true, `semantic overlap could not be verified (${a.reason})`);
    }
    ledger('deferred', `re-check ${attempt}/${MAX_SEMANTIC_RECHECKS} unverified: ${a.reason}`, detail);
    return hold(false, `not yet verified, check ${attempt}/${MAX_SEMANTIC_RECHECKS} (${a.reason})`);
  }
}
