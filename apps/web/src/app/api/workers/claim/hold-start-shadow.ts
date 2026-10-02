/**
 * Hold versus start at claim, claim-route half
 * (knowledge-base: buildd/design/conflict-aware-orchestration.md §5b; pure logic in
 * packages/core/orchestration-claim-decision.ts).
 *
 * Three pieces, each built so the hottest path in the system cannot slow
 * down or change behaviour by default:
 *
 *  1. `ClaimHoldCollector`: called synchronously at the two advisory
 *     deferrals in the dispatch loop (scope-undeclared serialization, layer 1
 *     open-PR overlap). It runs the deterministic rails and remembers eligible
 *     deferrals. No I/O, and the loop still `continue`s exactly as before.
 *  2. `scheduleClaimHoldShadow`: registers the decisions with `after()`, so
 *     they run once the response is sent. Never awaited by the route; a model
 *     call can never hold a claim response.
 *  3. `gatedStartApplies` / `acquireGatedStartPaths`: the gated START path.
 *     Wired, but `isGatedStartReachable()` is false as shipped (shadow
 *     definition, zero applying fraction), so the route never reaches the
 *     ledger lookup. When reached, START relaxes only the named advisory gate;
 *     declared paths are still acquired through the exclusive primitive
 *     before the claim, and every later gate still runs. A START that then
 *     loses the atomic claim gives back the leases it took
 *     (`releaseGatedStartPaths`).
 *
 * The applying fraction is never read raw: it goes through the promotion
 * guard (`resolveApplyingFraction`, packages/core/orchestration-promotion.ts),
 * which returns zero unless a readout found the exact measured definition
 * `eligible_for_gated` for the gate's candidate policy. No such evidence is
 * recorded, so a requested fraction alone cannot open the cohort.
 */
import { after } from 'next/server';
import { TASK_STATUSES, isTerminalTaskStatus } from '@buildd/shared';
import type { Decision } from '@builddai/ai-kit/decide';
import {
  CLAIM_HOLD_APPLYING_FRACTION,
  CLAIM_HOLD_DECISION,
  CLAIM_HOLD_LABELS,
  CLAIM_HOLD_MAX_PER_CLAIM,
  CLAIM_HOLD_QUESTIONS,
  CLAIM_HOLD_START_TTL_MS,
  buildClaimHoldState,
  claimHoldCandidatePolicyVersion,
  claimHoldStateDigest,
  classifyClaimHoldEligibility,
  isGatedStartReachable,
  type ClaimHoldCandidate,
  type ClaimHoldHolder,
  type ClaimHoldHolderState,
  type ClaimHoldRail,
} from '@buildd/core/orchestration-claim-decision';
import {
  runOrchestrationDecision,
  type OrchestrationDecisionDeps,
} from '@buildd/core/orchestration-decision';
import { resolveApplyingFraction, type PromotionEvidence } from '@buildd/core/orchestration-promotion';
import { intersectPaths, pathsOverlap, REPO_WIDE_SENTINEL } from '@buildd/core/path-overlap';
import type { AcquireInput, AcquireResult, LeaseRowsRelease, ReleaseResult } from '@buildd/core/path-claim';
import type { PathReleaseReason } from '@/lib/path-claim-release';
import type { ClaimDecisionKey } from '@buildd/core/orchestration-claim-source';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import { resolveSerializedSurfaces } from '@/lib/surface-ordering-config';

type ClaimHoldDecision = Decision<typeof CLAIM_HOLD_QUESTIONS>;

export interface ClaimHoldDeps {
  /** Override the definition (tests; Step I's readout of a candidate policy). */
  decision?: ClaimHoldDecision;
  /** The REQUESTED fraction. The promotion guard decides what is granted. */
  applyingFraction?: number;
  /** Default: the committed `ORCHESTRATION_PROMOTIONS` (empty). */
  promotions?: readonly PromotionEvidence[];
  decide?: typeof runOrchestrationDecision;
  decisionDeps?: OrchestrationDecisionDeps;
  hasRecent?: (k: ClaimDecisionKey) => Promise<boolean>;
  loadHolder?: (opts: { workspaceId: string; taskId: string | null; prNumber: number | null }) => Promise<ClaimHoldHolderState | null>;
  findAppliedStart?: (k: ClaimDecisionKey) => Promise<boolean>;
  acquire?: (input: AcquireInput) => Promise<AcquireResult>;
  /** Give back exactly the rows one acquisition inserted. Default `releaseLeaseRows`. */
  releaseRows?: (input: { workspaceId: string; taskId: string; leaseIds: string[]; keepStatuses: readonly string[] }) => Promise<LeaseRowsRelease>;
  /** Why the leases dropped, for the waiters. Default `resolveReleaseReasonForTask`. */
  releaseReason?: (taskId: string) => Promise<PathReleaseReason>;
  /** Waiter delivery. Default `deliverPathReleased`. */
  deliver?: (taskId: string, result: ReleaseResult, reason: PathReleaseReason) => Promise<void>;
  now?: () => number;
  /** How work is deferred past the response. Default `after()`, detached if out of scope. */
  schedule?: (fn: () => Promise<void>) => void;
}

/** What the route knows about the deferred task, all already in memory. */
export interface ClaimHoldTaskContext {
  teamId: string;
  workspaceId: string;
  missionId: string | null;
  taskId: string;
  accountId: string | null;
  title: string | null;
  taskCreatedAt: string | null;
  retryKind: 'conflict' | 'reviewer' | 'ci' | null;
  forced: boolean;
  /** The workspace's path_claims read failed this request. */
  leaseReadFailed: boolean;
  gitConfig: WorkspaceGitConfig | null | undefined;
  /** Claim time, ISO. */
  now: string;
}

export interface OpenPrHolderEntry {
  taskId: string | null;
  prNumber: number | null;
  pathManifest: string[] | null;
  workerStatus?: string | null;
  prLifecycle?: string | null;
}

export interface ClaimHoldNote {
  candidate: ClaimHoldCandidate;
  digest: string;
}

// ── 1. Collector (synchronous, no I/O) ───────────────────────────────────────

export class ClaimHoldCollector {
  readonly candidates: ClaimHoldNote[] = [];
  /**
   * Deferrals not asked about, by rail (diagnostics only). `error` counts a
   * note that threw (a malformed workspace gitConfig, say): it is swallowed,
   * because this bookkeeping runs inside the claim loop for every team and
   * must never turn a deferral into a failed claim.
   */
  readonly skipped: Partial<Record<ClaimHoldRail | 'error', number>> = {};

  private skip(rail: ClaimHoldRail | 'error'): null {
    this.skipped[rail] = (this.skipped[rail] ?? 0) + 1;
    return null;
  }

  private keep(candidate: ClaimHoldCandidate): ClaimHoldNote {
    const note = { candidate, digest: claimHoldStateDigest(candidate) };
    if (this.candidates.length < CLAIM_HOLD_MAX_PER_CLAIM) this.candidates.push(note);
    return note;
  }

  /** The mission's scope-undeclared serialization deferred this task behind `peerTaskId`. */
  noteAdvisoryManifest(ctx: ClaimHoldTaskContext, peerTaskId: string): ClaimHoldNote | null {
    try {
      return this.advisoryManifest(ctx, peerTaskId);
    } catch (err) {
      console.warn('[claim] hold/start note failed (skipped):', (err as Error)?.message ?? err);
      return this.skip('error');
    }
  }

  private advisoryManifest(ctx: ClaimHoldTaskContext, peerTaskId: string): ClaimHoldNote | null {
    const holder: ClaimHoldHolder = { taskId: peerTaskId, prNumber: null, workerStatus: null, prLifecycle: null };
    const verdict = classifyClaimHoldEligibility({
      gate: 'advisory_manifest',
      forced: ctx.forced,
      leaseReadFailed: ctx.leaseReadFailed,
      concretePaths: [],
      overlapPaths: [],
      overlapsLiveLease: false,
      serializedSurfaces: [],
      holder,
    });
    if (!verdict.eligible) return this.skip(verdict.rail);
    return this.keep(this.candidate(ctx, 'advisory_manifest', 'undeclared', [], [], holder));
  }

  /**
   * Layer 1 deferred this task: its manifest overlaps open PRs. Every
   * overlapping PR must clear the rails, not just the first one reported, and
   * the candidate must not overlap any live lease held by another task.
   */
  noteOpenPrOverlap(
    ctx: ClaimHoldTaskContext,
    manifest: string[],
    openPrs: OpenPrHolderEntry[],
    activeLeases: Map<string, string[]> | undefined,
  ): ClaimHoldNote | null {
    try {
      return this.openPrOverlap(ctx, manifest, openPrs, activeLeases);
    } catch (err) {
      console.warn('[claim] hold/start note failed (skipped):', (err as Error)?.message ?? err);
      return this.skip('error');
    }
  }

  private openPrOverlap(
    ctx: ClaimHoldTaskContext,
    manifest: string[],
    openPrs: OpenPrHolderEntry[],
    activeLeases: Map<string, string[]> | undefined,
  ): ClaimHoldNote | null {
    const concrete = manifest.filter(p => p !== REPO_WIDE_SENTINEL);
    const blockers = openPrs.filter(p => p.pathManifest?.length && intersectPaths(concrete, p.pathManifest).length > 0);
    if (blockers.length === 0) return this.skip('no_overlap_data');

    let overlapsLiveLease = false;
    for (const [holderTaskId, held] of activeLeases ?? []) {
      if (holderTaskId === ctx.taskId) continue;
      const heldConcrete = held.filter(p => p !== REPO_WIDE_SENTINEL);
      if (heldConcrete.length > 0 && pathsOverlap(concrete, heldConcrete)) { overlapsLiveLease = true; break; }
    }
    const overlap = [...new Set(blockers.flatMap(b => intersectPaths(concrete, b.pathManifest ?? [])))];
    const serializedSurfaces = resolveSerializedSurfaces([...concrete, ...overlap], ctx.gitConfig);

    for (const b of blockers) {
      const verdict = classifyClaimHoldEligibility({
        gate: 'open_pr_overlap',
        forced: ctx.forced,
        leaseReadFailed: ctx.leaseReadFailed,
        concretePaths: concrete,
        overlapPaths: intersectPaths(concrete, b.pathManifest ?? []),
        overlapsLiveLease,
        serializedSurfaces,
        holder: { taskId: b.taskId, prNumber: b.prNumber, workerStatus: b.workerStatus ?? null, prLifecycle: b.prLifecycle ?? null },
      });
      if (!verdict.eligible) return this.skip(verdict.rail);
    }
    const first = blockers[0];
    const holder: ClaimHoldHolder = { taskId: first.taskId, prNumber: first.prNumber, workerStatus: first.workerStatus ?? null, prLifecycle: first.prLifecycle ?? null };
    return this.keep(this.candidate(ctx, 'open_pr_overlap', 'declared', concrete, overlap, holder));
  }

  private candidate(
    ctx: ClaimHoldTaskContext,
    gate: ClaimHoldCandidate['gate'],
    scope: ClaimHoldCandidate['scope'],
    concretePaths: string[],
    overlapPaths: string[],
    holder: ClaimHoldHolder,
  ): ClaimHoldCandidate {
    return {
      gate,
      teamId: ctx.teamId,
      workspaceId: ctx.workspaceId,
      missionId: ctx.missionId,
      taskId: ctx.taskId,
      accountId: ctx.accountId,
      deferredAt: ctx.now,
      taskCreatedAt: ctx.taskCreatedAt,
      scope,
      concretePaths,
      overlapPaths,
      retryKind: ctx.retryKind,
      holder,
      title: ctx.title,
    };
  }
}

// ── 2. Shadow dispatch (after the response) ──────────────────────────────────

/** Per-instance memo: a team that has not opted in is not re-checked for this long. */
const DISABLED_TEAM_TTL_MS = 60_000;
/** Per-instance memo: the same task+state is not re-asked for this long. */
const RECENT_ASK_TTL_MS = CLAIM_HOLD_START_TTL_MS;
const MEMO_MAX = 2_000;

const disabledTeams = new Map<string, number>();
const recentAsks = new Map<string, number>();
const inFlight = new Set<Promise<void>>();

export function resetClaimHoldMemos(): void {
  disabledTeams.clear();
  recentAsks.clear();
}

const remember = (m: Map<string, number>, key: string, until: number) => {
  if (m.size >= MEMO_MAX) m.delete(m.keys().next().value as string);
  m.set(key, until);
};

/** Await every detached shadow run (tests, scripts). */
export async function settleClaimHoldShadow(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

function keyFor(note: ClaimHoldNote, decision: ClaimHoldDecision, since: Date): ClaimDecisionKey {
  return {
    workspaceId: note.candidate.workspaceId,
    taskId: note.candidate.taskId,
    decisionId: decision.id,
    fingerprint: decision.fingerprint,
    candidateDigest: note.digest,
    since,
  };
}

const defaultResolveAccess: NonNullable<OrchestrationDecisionDeps['resolveAccess']> = async (opts) =>
  (await import('@buildd/core/decision-client')).resolveDecisionAccess(opts);
const defaultHasRecent = async (k: ClaimDecisionKey) => (await import('@buildd/core/orchestration-claim-source')).hasRecentClaimDecision(k);
const defaultLoadHolder: NonNullable<ClaimHoldDeps['loadHolder']> = async (opts) =>
  (await import('@buildd/core/orchestration-claim-source')).loadClaimHolderState(opts);
const defaultFindAppliedStart = async (k: ClaimDecisionKey) => (await import('@buildd/core/orchestration-claim-source')).findAppliedStart(k);
const defaultAcquire = async (input: AcquireInput) => (await import('@buildd/core/path-claim')).acquirePathClaims(input);

/** Ask about each eligible deferral. Never throws. */
export async function runClaimHoldShadow(notes: readonly ClaimHoldNote[], deps: ClaimHoldDeps = {}): Promise<void> {
  const decision = deps.decision ?? CLAIM_HOLD_DECISION;
  const now = deps.now ?? (() => Date.now());
  const decide = deps.decide ?? runOrchestrationDecision;
  const resolveAccess = deps.decisionDeps?.resolveAccess ?? defaultResolveAccess;
  for (const note of notes) {
    try {
      const c = note.candidate;
      const t = now();
      if ((disabledTeams.get(c.teamId) ?? 0) > t) continue;
      const memoKey = `${c.taskId}:${note.digest}:${decision.fingerprint}`;
      if ((recentAsks.get(memoKey) ?? 0) > t) continue;
      // Opt-in first: a team that has not turned the capability on costs one
      // team read here and nothing else (no ledger read, no row).
      const access = await resolveAccess({
        capability: 'orchestration_claim',
        teamId: c.teamId,
        workspaceId: c.workspaceId,
        accountId: c.accountId,
        userId: null,
      });
      if (!access.ok && access.error.kind === 'capability_disabled') {
        remember(disabledTeams, c.teamId, now() + DISABLED_TEAM_TTL_MS);
        continue;
      }
      if (await (deps.hasRecent ?? defaultHasRecent)(keyFor(note, decision, new Date(t - RECENT_ASK_TTL_MS)))) {
        remember(recentAsks, memoKey, t + RECENT_ASK_TTL_MS);
        continue;
      }
      const outcome = await decide({
        decision,
        question: 'action',
        capability: 'orchestration_claim',
        scope: {
          teamId: c.teamId,
          workspaceId: c.workspaceId,
          missionId: c.missionId,
          taskId: c.taskId,
          accountId: c.accountId,
          // No prNumber: the outcome join must read the TASK's own PR, not the blocker's.
        },
        ruleVerdict: 'HOLD',
        candidatePolicy: { version: claimHoldCandidatePolicyVersion(c.gate), digest: note.digest, count: CLAIM_HOLD_LABELS.length },
        buildState: async () => buildClaimHoldState(c, await (deps.loadHolder ?? defaultLoadHolder)({
          workspaceId: c.workspaceId, taskId: c.holder.taskId, prNumber: c.holder.prNumber,
        })),
        isValidAnswer: (v) => v === 'HOLD' || v === 'START',
        cohort: { fraction: grantedFraction(deps, c.gate), unitId: c.taskId },
        // The access just resolved is reused, so the adapter does not read the team again.
        deps: { ...deps.decisionDeps, resolveAccess: async () => access },
      });
      if (outcome.reason === 'capability_disabled') {
        remember(disabledTeams, c.teamId, now() + DISABLED_TEAM_TTL_MS);
      } else {
        remember(recentAsks, memoKey, now() + RECENT_ASK_TTL_MS);
      }
    } catch (err) {
      console.warn('[claim] hold/start shadow failed (non-fatal):', (err as Error)?.message ?? err);
    }
  }
}

function detach(fn: () => Promise<void>): void {
  const p = Promise.resolve().then(fn).catch(() => {}).finally(() => { inFlight.delete(p); });
  inFlight.add(p);
}

/**
 * Register the shadow decisions to run after the response. Synchronous and
 * returns immediately; nothing here is awaited by the route.
 */
export function scheduleClaimHoldShadow(collector: ClaimHoldCollector, deps: ClaimHoldDeps = {}): void {
  if (!collector || collector.candidates.length === 0) return;
  const notes = [...collector.candidates];
  const run = () => runClaimHoldShadow(notes, deps);
  try {
    if (deps.schedule) { deps.schedule(run); return; }
    after(run);
  } catch {
    // Outside a request scope (a script, a test): still never block the caller.
    detach(run);
  }
}

// ── 3. Gated START (unreachable as shipped) ──────────────────────────────────

const GATES: readonly ClaimHoldCandidate['gate'][] = ['advisory_manifest', 'open_pr_overlap'];

/** The applying fraction the promotion guard grants for one gate's candidate policy. */
export function grantedFraction(deps: ClaimHoldDeps, gate: ClaimHoldCandidate['gate']): number {
  try {
    return resolveApplyingFraction({
      decision: deps.decision ?? CLAIM_HOLD_DECISION,
      question: 'action',
      candidatePolicyVersion: claimHoldCandidatePolicyVersion(gate),
      requestedFraction: deps.applyingFraction ?? CLAIM_HOLD_APPLYING_FRACTION,
      promotions: deps.promotions,
    }).fraction;
  } catch {
    return 0;
  }
}

/** Is the gated START path live at all? Cheap, synchronous, false as shipped. */
export function gatedStartReachable(deps: ClaimHoldDeps = {}): boolean {
  const decision = deps.decision ?? CLAIM_HOLD_DECISION;
  return GATES.some(g => isGatedStartReachable(decision, grantedFraction(deps, g)));
}

/**
 * Does an applied START (Jev, gated, in cohort; the adapter only writes
 * `applied` under all three) exist for this exact claim-time state? Returns
 * false without any I/O while unreachable, and on any error.
 */
export async function gatedStartApplies(note: ClaimHoldNote | null, deps: ClaimHoldDeps = {}): Promise<boolean> {
  if (!note) return false;
  const decision = deps.decision ?? CLAIM_HOLD_DECISION;
  if (!isGatedStartReachable(decision, grantedFraction(deps, note.candidate.gate))) return false;
  const now = (deps.now ?? (() => Date.now()))();
  try {
    return await (deps.findAppliedStart ?? defaultFindAppliedStart)(keyFor(note, decision, new Date(now - CLAIM_HOLD_START_TTL_MS)));
  } catch {
    return false;
  }
}

export interface GatedStartAcquisition {
  /** All declared paths are now this task's: the claim may proceed. */
  ok: boolean;
  /** Paths this acquisition newly leased. */
  inserted: string[];
  /** The lease rows it inserted: exactly what a lost claim race gives back. */
  insertedIds: string[];
}

/**
 * Acquire a gated START's declared paths through Section 1's exclusive
 * primitive, all-or-nothing, before the claim. Not ok (HOLD) on any conflict,
 * a closed task or an error. A scope-undeclared START has nothing to acquire
 * up front; its observed touches are leased by the same primitive later.
 */
export async function acquireGatedStartPaths(
  input: { workspaceId: string; taskId: string; paths: string[] },
  deps: Pick<ClaimHoldDeps, 'acquire'> = {},
): Promise<GatedStartAcquisition> {
  const none: GatedStartAcquisition = { ok: false, inserted: [], insertedIds: [] };
  const paths = input.paths.filter(p => p !== REPO_WIDE_SENTINEL);
  if (paths.length === 0) return { ok: true, inserted: [], insertedIds: [] };
  try {
    const res = await (deps.acquire ?? defaultAcquire)({ workspaceId: input.workspaceId, taskId: input.taskId, paths, declare: true });
    return res.kind === 'acquired' && res.blocked.length === 0
      ? { ok: true, inserted: [...res.inserted], insertedIds: [...(res.insertedIds ?? [])] }
      : none;
  } catch (err) {
    console.warn('[claim] gated START path acquisition failed (holding):', (err as Error)?.message ?? err);
    return none;
  }
}

/** A task in one of these is owned by a claim that won: its leases are that claim's. */
export const OWNED_BY_LIVE_CLAIM: readonly string[] = TASK_STATUSES.filter(s => s !== 'pending' && !isTerminalTaskStatus(s));

const defaultReleaseRows: NonNullable<ClaimHoldDeps['releaseRows']> = async (input) =>
  (await import('@buildd/core/path-claim')).releaseLeaseRows(input);
const defaultReleaseReason: NonNullable<ClaimHoldDeps['releaseReason']> = async (taskId) =>
  (await import('@/lib/path-claim-release')).resolveReleaseReasonForTask(taskId);
const defaultDeliver: NonNullable<ClaimHoldDeps['deliver']> = async (taskId, result, reason) =>
  (await import('@/lib/path-claim-release')).deliverPathReleased(taskId, result, reason);

export type GatedStartRelease = 'nothing_inserted' | 'kept_live_owner' | 'released' | 'error';

/**
 * The gated START acquired paths, then lost the atomic pending→assigned
 * claim. Give back exactly the lease rows that acquisition inserted, by id:
 * a concurrent attempt for the same task keeps its own rows, and the
 * manifest is untouched. If a winning claim now owns the task (checked inside
 * the locked statement), keep them. Waiters on a released path hear the
 * task's real release reason (`resolveReleaseReasonForTask`): a task that
 * already finished may have landed its work. Never throws; the path-claims
 * reaper is the backstop for a failed release.
 */
export async function releaseGatedStartPaths(
  input: { workspaceId: string; taskId: string; insertedIds: string[] },
  deps: Pick<ClaimHoldDeps, 'releaseRows' | 'releaseReason' | 'deliver'> = {},
): Promise<GatedStartRelease> {
  if (input.insertedIds.length === 0) return 'nothing_inserted';
  try {
    const out = await (deps.releaseRows ?? defaultReleaseRows)({
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      leaseIds: input.insertedIds,
      keepStatuses: OWNED_BY_LIVE_CLAIM,
    });
    if (out.kind === 'kept') return 'kept_live_owner';
    if (out.kind !== 'released') return 'released';
    if (out.result.notifiedWaiters.length > 0) {
      const reason = await (deps.releaseReason ?? defaultReleaseReason)(input.taskId);
      await (deps.deliver ?? defaultDeliver)(input.taskId, out.result, reason);
    }
    return 'released';
  } catch (err) {
    console.warn('[claim] gated START lease release after a lost claim failed (reaper will retry):', (err as Error)?.message ?? err);
    return 'error';
  }
}
