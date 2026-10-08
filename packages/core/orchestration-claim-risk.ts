/**
 * Claim-time overlap risk profile: which overlap deferrals need a model at all
 * (knowledge-base: buildd/design/conflict-aware-orchestration.md §5b; the
 * decision itself is ./orchestration-claim-decision.ts).
 *
 * An overlap warning is not proof that parallel work is unsafe. Most
 * overlapping pairs merge cleanly, and a pair that never ran together has no
 * observed outcome at all. So every advisory deferral gets a tier, decided in
 * code from facts code can compute, and the model is asked only about what is
 * genuinely ambiguous: whether two edits of the same file touch the same
 * logical region.
 *
 *  - `hard`: a deterministic rail (live lease, migration, serialized/generated
 *    surface, unknown state, live PR writer, forced). Deterministic HOLD; Jev
 *    never sees it.
 *  - `no_effective_overlap`: the holder has no edits in flight (never
 *    started), or its CURRENT effective scope (PR diff at head, live lease) is
 *    disjoint from the candidate's. Deterministic START: the candidate's
 *    paths are still acquired exclusively before the claim, so the holder
 *    then waits on a real lease instead of the candidate waiting on a guess.
 *  - `low`: only a directory is shared, or a fresh merge-tree probe of the
 *    pair came back clean or Mergiraf-resolvable. A directory-only overlap is
 *    a deterministic START unless file history proves the shared files risky.
 *  - `uncertain`: a same-file overlap without decisive evidence, a scope that
 *    is undeclared, an open PR whose effective scope is unknown. Jev judges.
 *  - `high`: a fresh probe of the pair found a real Git conflict, or the
 *    shared files' conflict rate is high with a sample that supports it (the
 *    Wilson lower bound clears `HIGH_FILE_CONFLICT_RATE`). Deterministic HOLD
 *    with no model call; the reason is recorded.
 *
 * Missing evidence is `uncertain`, never `high`: an ordinary non-hard surface
 * with no history is not proven risky. Stale evidence (older than its TTL, or
 * from a head that is no longer current) is treated as missing.
 *
 * What Jev is NOT asked: anything git or the lease table can answer (merge-tree
 * result, migration index, live lease). Model confidence is the concentration
 * of its answer distribution, not a calibrated probability of a clean merge,
 * so it is never compared to a conflict rate here.
 *
 * Pure: no DB, no env.
 */
import { intersectPaths, REPO_WIDE_SENTINEL } from './path-overlap';
import type { ClaimHoldGate, ClaimHoldRail, FileConflictHistory } from './orchestration-claim-decision';

export type ClaimRiskTier = 'no_effective_overlap' | 'low' | 'uncertain' | 'high' | 'hard';
export const CLAIM_RISK_TIERS: readonly ClaimRiskTier[] = ['no_effective_overlap', 'low', 'uncertain', 'high', 'hard'];

/** Who decides: code (START or HOLD) or the model. */
export type ClaimRiskRoute = 'deterministic_start' | 'deterministic_hold' | 'ask_model';

export type ClaimRiskReason =
  | 'hard_rail'
  | 'holder_not_started'
  | 'effective_scope_disjoint'
  | 'effective_scope_overlaps'
  | 'effective_scope_stale'
  | 'prefix_only'
  | 'same_file'
  | 'undeclared_scope'
  | 'open_pr_scope_unknown'
  | 'probe_conflict'
  | 'probe_clean'
  | 'probe_mergiraf_resolved'
  | 'probe_stale'
  | 'history_high'
  | 'history_low'
  | 'history_insufficient'
  | 'history_missing';

/** What would change the answer: the next time the claim loop should expect a different tier. */
export type ClaimRiskTrigger =
  | 'holder_lease_released'
  | 'holder_terminal'
  | 'holder_pr_head_changed'
  | 'holder_started'
  | 'state_readable'
  | 'model_answer'
  | 'start_ttl_expired';

/**
 * The holder's current effective scope. `pr_diff_at_head`: the files its PR
 * changes against its target at `headSha` (the source of truth for an open
 * PR; task c3785f15 supplies it). `live_lease`: the paths it holds in
 * path_claims right now. A declared manifest is NOT an effective scope: it is
 * what the holder said it might touch, often inherited from older branch
 * state, and is already the overlap this assessment starts from.
 */
export interface EffectiveScope {
  source: 'pr_diff_at_head' | 'live_lease';
  paths: string[];
  /** The PR head the diff was computed at; required for `pr_diff_at_head`. */
  headSha?: string | null;
  /** The holder's PR head right now. A diff from another head is stale. */
  currentHeadSha?: string | null;
  /** When the scope was read, ISO. */
  observedAt: string;
}

/** The newest live sibling probe of this pair (apps/web/src/lib/sibling-conflict-probe.ts). */
export interface PairProbeEvidence {
  outcome: 'clean' | 'conflict' | 'mergiraf_resolved' | 'error';
  conflictFiles: string[];
  probedAt: string;
  /** Both branch heads are still the ones probed. False or unknown = stale. */
  headsCurrent: boolean;
}

export interface ClaimRiskInput {
  gate: ClaimHoldGate;
  /** The eligibility rail that refused the model, if any (`classifyClaimHoldEligibility`). */
  rail: ClaimHoldRail | null;
  /** soft_overlap only. */
  overlapKind?: 'same_file' | 'prefix';
  /** The candidate's concrete declared paths. */
  candidatePaths: string[];
  /** The overlapping paths as classified at claim time. */
  overlapPaths: string[];
  /**
   * Where the holder is: never started (no worker yet), live (a worker is
   * editing), ended (its worker finished; it may have an open PR). Null = unknown.
   */
  holderState: 'not_started' | 'live' | 'ended' | null;
  holderScope?: EffectiveScope | null;
  history?: FileConflictHistory | null;
  probe?: PairProbeEvidence | null;
  /** Assessment time, ISO. */
  now: string;
}

export interface ClaimRiskAssessment {
  tier: ClaimRiskTier;
  route: ClaimRiskRoute;
  /** Machine reasons, most decisive first. */
  reasons: ClaimRiskReason[];
  /** One plain sentence for the dashboard and the deferral record. */
  rationale: string;
  /** The evidence the tier rests on, with its age. */
  evidence: {
    source: 'rail' | 'holder_state' | 'effective_scope' | 'probe' | 'history' | 'declared_overlap';
    ageMinutes: number | null;
  };
  /** What should make the claim loop expect a different answer. */
  reevaluateOn: ClaimRiskTrigger[];
}

/** A holder's effective scope older than this is treated as unknown. */
export const EFFECTIVE_SCOPE_MAX_AGE_MS = 30 * 60_000;
/** A pair probe older than this is treated as unknown (the probe re-runs every 20 min). */
export const PAIR_PROBE_MAX_AGE_MS = 45 * 60_000;
/** Fewer merged PRs than this on a file is not a sample: the tier stays uncertain. */
export const MIN_FILE_HISTORY_SAMPLE = 5;
/** The Wilson lower bound at or above this proves a file risky. Mirrors HIGH_FILE_CONFLICT_RATE. */
export const HIGH_CONFLICT_LOWER_BOUND = 0.25;
/** The Wilson upper bound at or below this (with a sample) calls a file low-risk. */
export const LOW_CONFLICT_UPPER_BOUND = 0.2;

/**
 * Rollback switch for the deterministic STARTs (holder not started, effective
 * scope disjoint, directory-only overlap). False: those tiers go back to the
 * model like any other advisory deferral; hard rails and the model path are
 * unchanged.
 */
export const CLAIM_RISK_DETERMINISTIC_START = true;

/**
 * Wilson score interval for k successes in n trials (95% by default). Null
 * for n = 0: there is no rate to bound.
 */
export function wilsonInterval(k: number, n: number, z = 1.96): { lower: number; upper: number } | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  const kk = Math.min(n, Math.max(0, k));
  const p = kk / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  const r = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 1000) / 1000;
  return { lower: r(centre - half), upper: r(centre + half) };
}

export type HistoryVerdict = 'high' | 'low' | 'insufficient' | 'missing';

/**
 * The shared files' history, judged on its interval rather than its point
 * rate: 1 conflict in 1 merged PR is not a 100% conflict rate, and 0 in 2 is
 * not a safe file. High if any file's lower bound proves it; low only when
 * every file with history has a sample and an upper bound under the cap.
 */
export function judgeFileHistory(history: FileConflictHistory | null | undefined): HistoryVerdict {
  if (!history || history.files.length === 0) return 'missing';
  const withHistory = history.files.filter(f => f.mergedPrs > 0);
  if (withHistory.length === 0) return 'missing';
  let allLow = true;
  for (const f of withHistory) {
    const ci = wilsonInterval(f.conflicted, f.mergedPrs);
    if (!ci) continue;
    if (f.mergedPrs >= MIN_FILE_HISTORY_SAMPLE && ci.lower >= HIGH_CONFLICT_LOWER_BOUND) return 'high';
    if (f.mergedPrs < MIN_FILE_HISTORY_SAMPLE || ci.upper > LOW_CONFLICT_UPPER_BOUND) allLow = false;
  }
  // Every shared file needs history for a "low": one unknown file can be the hot one.
  return allLow && withHistory.length === history.files.length ? 'low' : 'insufficient';
}

const ageMinutes = (from: string | null | undefined, now: string): number | null => {
  if (!from) return null;
  const ms = Date.parse(now) - Date.parse(from);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 60_000)) : null;
};

const isFresh = (at: string, now: string, maxMs: number): boolean => {
  const ms = Date.parse(now) - Date.parse(at);
  return Number.isFinite(ms) && ms >= 0 && ms <= maxMs;
};

/** Is this effective scope usable now? Fresh, and (for a PR diff) from the current head. */
export function effectiveScopeIsCurrent(scope: EffectiveScope, now: string): boolean {
  if (!isFresh(scope.observedAt, now, EFFECTIVE_SCOPE_MAX_AGE_MS)) return false;
  if (scope.source === 'pr_diff_at_head') {
    return !!scope.headSha && !!scope.currentHeadSha && scope.headSha === scope.currentHeadSha;
  }
  return true;
}

const HARD_TRIGGERS: Record<ClaimHoldRail, ClaimRiskTrigger[]> = {
  forced: [],
  state_unresolved: ['state_readable'],
  live_lease: ['holder_lease_released'],
  live_holder: ['holder_terminal'],
  serialized_surface: ['holder_terminal'],
  migration: ['holder_terminal'],
  no_overlap_data: ['state_readable'],
};

const RAIL_TEXT: Record<ClaimHoldRail, string> = {
  forced: 'a forced claim is decided by the person who forced it',
  state_unresolved: 'the lease table could not be read, so the overlap is unknown',
  live_lease: 'the holder holds a live lease on these files',
  live_holder: 'the open PR still has a live worker writing to it',
  serialized_surface: 'the files are a serialized, generated or hotspot surface',
  migration: 'the files are a migration or the schema',
  no_overlap_data: 'the overlap could not be computed',
};

function result(
  tier: ClaimRiskTier,
  route: ClaimRiskRoute,
  reasons: ClaimRiskReason[],
  rationale: string,
  evidence: ClaimRiskAssessment['evidence'],
  reevaluateOn: ClaimRiskTrigger[],
): ClaimRiskAssessment {
  return { tier, route, reasons, rationale, evidence, reevaluateOn };
}

/**
 * Tier one advisory deferral. Order is fixed so the recorded reason is stable:
 * rails, then what the holder is actually doing, then direct pair evidence
 * (probe), then the overlap's shape and file history.
 */
export function assessClaimOverlapRisk(input: ClaimRiskInput): ClaimRiskAssessment {
  const { now } = input;
  const shared = (input.overlapPaths.length ? input.overlapPaths : input.candidatePaths).slice(0, 3).join(', ');

  // 1. Hard rails. Jev never sees these and no evidence relaxes them.
  if (input.rail) {
    return result('hard', 'deterministic_hold', ['hard_rail'], `Held: ${RAIL_TEXT[input.rail]}.`,
      { source: 'rail', ageMinutes: 0 }, HARD_TRIGGERS[input.rail]);
  }

  const deterministicStart: ClaimRiskRoute = CLAIM_RISK_DETERMINISTIC_START ? 'deterministic_start' : 'ask_model';

  // 2. Nothing in flight to collide with: the holder never started. The
  //    candidate's exclusive acquisition makes the holder wait on a real lease.
  //    Not for the scope-undeclared gate: an undeclared candidate leases nothing up front.
  if (input.holderState === 'not_started' && input.gate !== 'advisory_manifest') {
    return result('no_effective_overlap', deterministicStart, ['holder_not_started'],
      'Starting: the overlapping task has not started, so there are no edits to collide with; this task takes the files first.',
      { source: 'holder_state', ageMinutes: 0 }, ['holder_started']);
  }

  const reasons: ClaimRiskReason[] = [];

  // 3. The holder's current effective scope, when known. Disjoint = START.
  const candidate = input.candidatePaths.filter(p => p !== REPO_WIDE_SENTINEL);
  if (input.holderScope && candidate.length > 0 && input.gate !== 'advisory_manifest') {
    if (effectiveScopeIsCurrent(input.holderScope, now)) {
      const effective = [...new Set([
        ...intersectPaths(candidate, input.holderScope.paths),
        ...intersectPaths(input.holderScope.paths, candidate),
      ])];
      if (effective.length === 0) {
        return result('no_effective_overlap', deterministicStart, ['effective_scope_disjoint'],
          `Starting: the holder's current changes (${input.holderScope.source === 'pr_diff_at_head' ? 'its PR diff at head' : 'its live leases'}) do not touch this task's files; the overlap came from an older or broader declaration.`,
          { source: 'effective_scope', ageMinutes: ageMinutes(input.holderScope.observedAt, now) },
          ['holder_pr_head_changed']);
      }
      reasons.push('effective_scope_overlaps');
    } else {
      reasons.push('effective_scope_stale');
    }
  }

  // 4. A fresh merge-tree probe of this exact pair is direct evidence.
  if (input.probe) {
    const fresh = input.probe.headsCurrent && isFresh(input.probe.probedAt, now, PAIR_PROBE_MAX_AGE_MS);
    if (!fresh) {
      reasons.push('probe_stale');
    } else if (input.probe.outcome === 'conflict') {
      const files = input.probe.conflictFiles.slice(0, 3).join(', ');
      return result('high', 'deterministic_hold', ['probe_conflict', ...reasons],
        `Held: a merge-tree probe of the two branches found a real conflict${files ? ` in ${files}` : ''}.`,
        { source: 'probe', ageMinutes: ageMinutes(input.probe.probedAt, now) },
        ['holder_pr_head_changed', 'holder_terminal']);
    } else if (input.probe.outcome === 'clean' || input.probe.outcome === 'mergiraf_resolved') {
      const reason: ClaimRiskReason = input.probe.outcome === 'clean' ? 'probe_clean' : 'probe_mergiraf_resolved';
      return result('low', 'ask_model', [reason, ...reasons],
        input.probe.outcome === 'clean'
          ? 'Low risk: a merge-tree probe of the two branches merged cleanly; the model judges what the candidate will add.'
          : 'Low risk: the two branches conflict only where Mergiraf resolves it structurally; the model judges what the candidate will add.',
        { source: 'probe', ageMinutes: ageMinutes(input.probe.probedAt, now) },
        ['model_answer', 'holder_pr_head_changed']);
    }
    // 'error' carries no evidence: fall through.
  }

  // 5. The overlap's shape and history.
  const history = judgeFileHistory(input.history);
  const historyReason: ClaimRiskReason = history === 'high' ? 'history_high'
    : history === 'low' ? 'history_low'
    : history === 'insufficient' ? 'history_insufficient' : 'history_missing';

  if (input.gate === 'advisory_manifest') {
    return result('uncertain', 'ask_model', ['undeclared_scope', ...reasons],
      'Uncertain: this task declared no scope, so overlap with the in-flight task cannot be computed; the model judges from what each is for.',
      { source: 'declared_overlap', ageMinutes: null }, ['model_answer', 'holder_terminal']);
  }

  if (history === 'high') {
    return result('high', 'deterministic_hold', ['history_high', ...reasons],
      `Held: merged work on ${shared} has conflicted often enough to be measurably risky.`,
      { source: 'history', ageMinutes: null }, ['holder_terminal']);
  }

  if (input.gate === 'soft_overlap' && input.overlapKind === 'prefix') {
    return result('low', deterministicStart, ['prefix_only', historyReason, ...reasons],
      `Starting: the two tasks share only a directory (${shared}), not a file; no live lease overlaps.`,
      { source: 'declared_overlap', ageMinutes: null }, ['holder_started']);
  }

  if (input.gate === 'soft_overlap') {
    const tier: ClaimRiskTier = history === 'low' ? 'low' : 'uncertain';
    return result(tier, 'ask_model', ['same_file', historyReason, ...reasons],
      tier === 'low'
        ? `Low risk: ${shared} rarely conflicts in merged work; the model judges whether the two edits touch the same part of it.`
        : `Uncertain: both tasks edit ${shared} and there is not enough history to call it; the model judges whether the edits touch the same part.`,
      { source: input.history ? 'history' : 'declared_overlap', ageMinutes: null }, ['model_answer', 'start_ttl_expired']);
  }

  // open_pr_overlap: the PR's worker ended; its current diff is the question.
  return result('uncertain', 'ask_model', ['open_pr_scope_unknown', historyReason, ...reasons],
    `Uncertain: an open PR declared ${shared}; its current diff was not available, so the model judges from what each is for.`,
    { source: 'declared_overlap', ageMinutes: null }, ['model_answer', 'holder_pr_head_changed']);
}

/** The short structured block the model sees: facts and tier, no prose it could be steered by. */
export function claimRiskForModel(a: ClaimRiskAssessment): Record<string, unknown> {
  return { tier: a.tier, reasons: a.reasons.slice(0, 4) };
}

/** Holder state from the holder's newest worker status (null = never started). */
export function holderStateOf(workerStatus: string | null | undefined, liveStatuses: ReadonlySet<string>): ClaimRiskInput['holderState'] {
  if (workerStatus === null || workerStatus === undefined) return 'not_started';
  return liveStatuses.has(workerStatus) ? 'live' : 'ended';
}
