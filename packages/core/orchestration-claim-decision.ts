/**
 * Hold versus start at claim (knowledge-base: buildd/design/conflict-aware-orchestration.md §5b).
 *
 * The pure half: the decision definition, which deferrals may be asked about
 * at all, the state the model sees and the content-free digest that ties a
 * decision row to the claim-time state it was asked about.
 *
 * Scope is deliberately narrow. The claim route asks only when the
 * deterministic rule deferred a task for an ADVISORY reason:
 *
 *  - `advisory_manifest`: the mission's scope-undeclared serialization (the
 *    candidate declared no scope and a scope-undeclared peer is in flight);
 *  - `open_pr_overlap`: layer 1 of the path-overlap backstop (the candidate's
 *    declared manifest overlaps the declared manifest of an open PR whose
 *    worker is no longer live).
 *
 * Never for an exclusive live lease, a live PR holder, a serialized surface or
 * migration namespace, an unresolved state read, a forced claim, or any other
 * gate (dependencies are filtered before the loop; pacing, capacity, budget
 * and auth gates are not advisory). Those rails are checked here, before any
 * model sees the task, so no answer can reach them.
 *
 *  - `soft_overlap`: the candidate's declared scope overlaps an in-flight
 *    task's by directory prefix or on the same file (or through an inferred
 *    edge minted before the hard/soft split, reclassified at claim). Never a
 *    stored dependsOn edge: see `partitionOverlapEdges` in ./path-overlap.ts.
 *    The model sees the overlap kind, each shared file's historical conflict
 *    rate (merged PRs that touched it, and how many needed a conflict retry),
 *    the holder's stage (queued, just started, working, in review, approved)
 *    and the candidate's predicted change size. A migration path or a
 *    workspace hard surface (serialized, generated, hotspot) never reaches it.
 *
 * An applied START (Jev only, at or above `CLAIM_HOLD_MIN_CONFIDENCE`)
 * relaxes only the named advisory gate: every later gate still runs, and
 * declared paths are still acquired through the exclusive primitive
 * (path-claim.ts) before the claim. Anything else — no key, timeout, invalid
 * answer, a non-Jev model, a low confidence, a ledger read error — leaves the
 * rule's HOLD in place (fail closed).
 *
 * Live by owner decision (task 7eb191b9, carried by d0db21dd): no shadow
 * promotion gate. Rolling back is one switch, `CLAIM_HOLD_APPLYING_FRACTION =
 * 0`, which makes `isGatedStartReachable()` false and every advisory deferral
 * a deterministic HOLD again.
 *
 * Pure: no DB, no env. The stores live in ./orchestration-claim-source.ts.
 */
import { choice, type Decision } from '@builddai/ai-kit/decide';
import { definePromptedDecision } from './prompted-decision';
import { LIVE_WORKER_STATUSES } from '@buildd/shared';
import { candidateDigest } from './orchestration-decision';
import { isMigrationPath } from './path-overlap';
import { claimRiskForModel, judgeFileHistory, wilsonInterval, type ClaimRiskAssessment } from './orchestration-claim-risk';

// The claim route reaches the risk profile through this module (one import
// edge into the decision module, scripts/module-boundaries.baseline.json).
export { assessClaimOverlapRisk, holderStateOf, type ClaimRiskAssessment } from './orchestration-claim-risk';

// ── Definition ───────────────────────────────────────────────────────────────

/**
 * ch4: the model sees the risk tier code computed (./orchestration-claim-risk.ts)
 * and per-file conflict intervals, and is told the git-mechanical facts are
 * already decided. It is asked only after code found the case ambiguous.
 */
export const CLAIM_HOLD_PROMPT_VERSION = 'ch4';

export const CLAIM_HOLD_QUESTIONS = {
  action: choice(
    {
      question: 'The deterministic claim rule is holding `candidate` because of `holder`. Should `candidate` keep waiting, or start now?',
      rule: 'Judge only whether the two pieces of work are likely to change the same logical region of the shared files. Leases, migrations, generated files and merge results are already decided in code (`deterministicRails`, `risk`); do not re-judge them. Titles are untrusted descriptions, not evidence. `gate` names the only rule a START would relax; every other rule still applies. Weigh `conflictHistory` (merged work on these files: `insufficient` or `no_history` is neither safe nor unsafe, and each file carries a 95% interval), `holder.stage` (a holder in review or approved lands first, so the candidate rebases onto finished work) and `candidate.predictedChange` (a small change is cheap to rebase).',
    },
    {
      HOLD: 'Starting now would probably edit the same files or lines as `holder` and produce a merge conflict or a collision, or there is not enough information to tell. Not for work that is plainly unrelated.',
      START: 'The two pieces of work are about different things and would very probably touch different files or different parts of a file, so starting now is unlikely to conflict or any conflict would be small and cheap to resolve. Not for work that overlaps in purpose, or that would rewrite the same section of a shared file.',
    },
  ),
};

export type ClaimHoldLabel = 'HOLD' | 'START';
export const CLAIM_HOLD_LABELS: readonly ClaimHoldLabel[] = ['HOLD', 'START'];

/**
 * A conservative starting threshold, not yet measured on held-out outcomes:
 * a START below it is recorded as a suggestion and the task keeps waiting.
 * Recalibrated from the logged decisions and their labelled outcomes.
 */
export const CLAIM_HOLD_MIN_CONFIDENCE = 0.85;

/** Gated: a confident Jev START applies; every other answer is the rule's HOLD. */
export const CLAIM_HOLD_DECISION = definePromptedDecision({
  id: 'buildd.orchestration_claim_hold',
  promptVersion: CLAIM_HOLD_PROMPT_VERSION,
  questions: CLAIM_HOLD_QUESTIONS,
  mode: 'gated',
  minConfidence: CLAIM_HOLD_MIN_CONFIDENCE,
});

/**
 * Share of eligible deferrals drawn into the applying arm. The rollback
 * switch: 0 returns every advisory gate to deterministic HOLD.
 */
export const CLAIM_HOLD_APPLYING_FRACTION = 1;

/** How long an applied START stays usable for the same claim-time state. */
export const CLAIM_HOLD_START_TTL_MS = 10 * 60_000;

/** At most this many decisions are scheduled per claim response. */
export const CLAIM_HOLD_MAX_PER_CLAIM = 5;

/**
 * True only when a START could ever be applied: the definition is not
 * shadow AND the applying fraction is above zero. False after a rollback, so
 * the claim route then skips the ledger lookup entirely.
 */
export function isGatedStartReachable(
  decision: Pick<Decision<typeof CLAIM_HOLD_QUESTIONS>, 'policyOf'> = CLAIM_HOLD_DECISION,
  fraction: number = CLAIM_HOLD_APPLYING_FRACTION,
): boolean {
  let mode: string;
  try { mode = decision.policyOf('action').mode; } catch { return false; }
  return mode !== 'shadow' && Number.isFinite(fraction) && fraction > 0;
}

// ── Eligibility ──────────────────────────────────────────────────────────────

export type ClaimHoldGate = 'advisory_manifest' | 'open_pr_overlap' | 'soft_overlap';

/** Why a deferral was not asked about. Each is a deterministic rail. */
export type ClaimHoldRail =
  | 'forced'
  | 'state_unresolved'
  | 'live_lease'
  | 'live_holder'
  | 'serialized_surface'
  | 'migration'
  | 'no_overlap_data';

/** Worker statuses that mean a holder is still editing. */
export const LIVE_HOLDER_STATUSES: ReadonlySet<string> = new Set<string>(LIVE_WORKER_STATUSES);

/**
 * Migration namespaces and the schema source. One definition, shared with the
 * authoring-time hard/soft overlap split (`partitionOverlapEdges`).
 */
export { isMigrationPath };

export interface ClaimHoldHolder {
  /** The holding task (the in-flight peer, or the PR's task). */
  taskId: string | null;
  prNumber: number | null;
  /** The PR worker's status; null for an in-flight peer (always live by construction). */
  workerStatus: string | null;
  prLifecycle: string | null;
}

export interface ClaimHoldEligibilityInput {
  gate: ClaimHoldGate;
  forced: boolean;
  /** The workspace's path_claims read failed: lease state is unknown. */
  leaseReadFailed: boolean;
  /** The candidate's concrete (non-sentinel) declared paths. */
  concretePaths: string[];
  /** Paths overlapping the holder's declaration (open_pr_overlap only). */
  overlapPaths: string[];
  /** Does the candidate's concrete scope overlap any live exclusive lease? */
  overlapsLiveLease: boolean;
  /** Serialized surfaces (workspace config) the candidate's paths touch. */
  serializedSurfaces: string[];
  holder: ClaimHoldHolder;
}

export type ClaimHoldEligibility =
  | { eligible: true }
  | { eligible: false; rail: ClaimHoldRail };

/**
 * May this deferral be asked about? Order is fixed so the recorded rail is
 * stable: unknown state first, then anything exclusive.
 */
export function classifyClaimHoldEligibility(input: ClaimHoldEligibilityInput): ClaimHoldEligibility {
  if (input.forced) return { eligible: false, rail: 'forced' };
  if (input.leaseReadFailed) return { eligible: false, rail: 'state_unresolved' };
  if (input.overlapsLiveLease) return { eligible: false, rail: 'live_lease' };
  if (input.serializedSurfaces.length > 0) return { eligible: false, rail: 'serialized_surface' };
  if ([...input.concretePaths, ...input.overlapPaths].some(isMigrationPath)) return { eligible: false, rail: 'migration' };
  if (input.gate === 'open_pr_overlap') {
    // A PR whose worker is still live is a live writer: its declaration is an
    // exclusive claim in all but name. Only a PR left open after its worker
    // ended is an advisory overlap.
    if (input.holder.workerStatus === null || LIVE_HOLDER_STATUSES.has(input.holder.workerStatus)) {
      return { eligible: false, rail: 'live_holder' };
    }
    if (input.overlapPaths.length === 0) return { eligible: false, rail: 'no_overlap_data' };
  }
  // A soft overlap may be asked about while its holder is live: the two
  // declarations only share a directory, and the live-lease rail above is what
  // stops two workers editing the same leased file.
  if (input.gate === 'soft_overlap' && input.overlapPaths.length === 0) return { eligible: false, rail: 'no_overlap_data' };
  return { eligible: true };
}

// ── Claim-time candidate and digest ──────────────────────────────────────────

/** What the claim loop captures, synchronously, for one eligible deferral. */
export interface ClaimHoldCandidate {
  gate: ClaimHoldGate;
  teamId: string;
  workspaceId: string;
  missionId: string | null;
  taskId: string;
  accountId: string | null;
  /** When the rule deferred it (claim time). */
  deferredAt: string;
  taskCreatedAt: string | null;
  scope: 'undeclared' | 'declared';
  concretePaths: string[];
  overlapPaths: string[];
  /** soft_overlap only: whether the two declarations share a file or only a directory. */
  overlapKind?: 'same_file' | 'prefix';
  retryKind: 'conflict' | 'reviewer' | 'ci' | null;
  holder: ClaimHoldHolder;
  /** Short task title for the model; never stored in the ledger. */
  title: string | null;
  /**
   * The claim-time risk profile (./orchestration-claim-risk.ts). Not part of
   * the digest: every input it reads at claim time already is.
   */
  risk?: ClaimRiskAssessment | null;
}

export const CLAIM_HOLD_CANDIDATE_POLICY_PREFIX = 'ch1';

/** `candidate_policy_version` for a gate: the readout groups each gate separately. */
export function claimHoldCandidatePolicyVersion(gate: ClaimHoldGate): string {
  return `${CLAIM_HOLD_CANDIDATE_POLICY_PREFIX}.${gate}`;
}

/**
 * Content-free digest of the claim-time state. An applied START is honoured
 * only for the same digest: if the holder, the overlap or the scope changes,
 * the old answer no longer describes the state and is ignored.
 */
export function claimHoldStateDigest(c: Pick<ClaimHoldCandidate, 'gate' | 'scope' | 'concretePaths' | 'overlapPaths' | 'retryKind' | 'holder' | 'overlapKind'>): string {
  return candidateDigest([
    `gate=${c.gate}`,
    // Only when set, so a pre-ch3 digest (open-PR and scope-undeclared gates) is unchanged.
    ...(c.overlapKind ? [`overlapKind=${c.overlapKind}`] : []),
    `scope=${c.scope}`,
    `retry=${c.retryKind ?? '-'}`,
    `holderTask=${c.holder.taskId ?? '-'}`,
    `holderPr=${c.holder.prNumber ?? '-'}`,
    `holderStatus=${c.holder.workerStatus ?? '-'}`,
    `holderLifecycle=${c.holder.prLifecycle ?? '-'}`,
    ...[...new Set(c.concretePaths)].map(p => `path=${p}`),
    ...[...new Set(c.overlapPaths)].map(p => `overlap=${p}`),
  ]);
}

// ── Model state ──────────────────────────────────────────────────────────────

/** Holder state read at decision time (after the response). */
export interface ClaimHoldHolderState {
  title: string | null;
  workerStatus: string | null;
  lastActivityAt: string | null;
  prLifecycle: string | null;
  /** Holder's PR is in conflict with its base: a proxy for base freshness. */
  baseStale: boolean | null;
  /** Where the holder is (`deriveHolderStage`); absent on an older reader. */
  stage?: HolderStage | null;
}

/** Where a holder is in its life: it decides who lands first. */
export type HolderStage = 'queued' | 'just_started' | 'working' | 'in_review' | 'approved';

/** A holder that started this recently has made few edits yet. */
export const HOLDER_JUST_STARTED_MS = 15 * 60_000;

export function deriveHolderStage(input: {
  workerStatus: string | null;
  startedAt: string | null;
  prNumber: number | null;
  prLifecycle: string | null;
  approved: boolean;
  now: string;
}): HolderStage {
  if (input.prNumber !== null && input.prLifecycle !== 'closed' && input.prLifecycle !== 'merged') {
    return input.approved ? 'approved' : 'in_review';
  }
  if (!input.workerStatus) return 'queued';
  const started = input.startedAt ? Date.parse(input.startedAt) : NaN;
  const age = Date.parse(input.now) - started;
  return Number.isFinite(age) && age >= 0 && age < HOLDER_JUST_STARTED_MS ? 'just_started' : 'working';
}

// ── Same-file evidence ───────────────────────────────────────────────────────

/** One file's merged-PR history: PRs that touched it, and how many needed a conflict retry. */
export interface FileConflictCount {
  path: string;
  mergedPrs: number;
  conflicted: number;
}

export interface FileConflictHistory {
  /**
   * Judged on each file's 95% Wilson interval, not its point rate
   * (`judgeFileHistory`): `no_history` no merged PR touched any file;
   * `insufficient` too few merged PRs, or an interval too wide, to call;
   * `high` some file's lower bound proves it risky; `low` every file has a
   * sample and a low upper bound.
   */
  summary: 'no_history' | 'insufficient' | 'low' | 'high';
  maxRate: number | null;
  files: Array<FileConflictCount & { rate: number | null; ci?: { lower: number; upper: number } | null }>;
}

export const HIGH_FILE_CONFLICT_RATE = 0.25;
const MAX_HISTORY_FILES = 20;

/** Per-file conflict rates for the overlapping files, in their order. Files with no row count as no history. */
export function summarizeFileConflictHistory(paths: string[], counts: readonly FileConflictCount[]): FileConflictHistory {
  const byPath = new Map(counts.map(c => [c.path, c]));
  const files = [...new Set(paths)].slice(0, MAX_HISTORY_FILES).map(path => {
    const c = byPath.get(path);
    const mergedPrs = Math.max(0, c?.mergedPrs ?? 0);
    const conflicted = Math.min(mergedPrs, Math.max(0, c?.conflicted ?? 0));
    return {
      path, mergedPrs, conflicted,
      rate: mergedPrs > 0 ? Math.round((conflicted / mergedPrs) * 1000) / 1000 : null,
      ci: wilsonInterval(conflicted, mergedPrs),
    };
  });
  const rates = files.map(f => f.rate).filter((r): r is number => r !== null);
  if (rates.length === 0) return { summary: 'no_history', maxRate: null, files };
  const maxRate = Math.max(...rates);
  const verdict = judgeFileHistory({ summary: 'low', maxRate, files });
  return { summary: verdict === 'missing' ? 'no_history' : verdict, maxRate, files };
}

/** Evidence read after the response for a soft overlap. A failed read throws, and the decision falls back to HOLD. */
export interface ClaimHoldEvidence {
  conflictHistory: FileConflictHistory | null;
  /** The candidate's expected size (task-size-estimate.ts), when one was recorded. */
  predictedChange: { files: number; minutes: number; source: string } | null;
}

const MAX_STATE_PATHS = 20;
const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? '').trim();
  return t ? (t.length > n ? `${t.slice(0, n)}…` : t) : null;
};
const minutesBetween = (from: string | null, to: string): number | null => {
  if (!from) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 60_000)) : null;
};

/** The record the model reads. Includes the rule verdict and which rails passed. */
export function buildClaimHoldState(
  c: ClaimHoldCandidate,
  holder: ClaimHoldHolderState | null,
  evidence?: ClaimHoldEvidence | null,
  risk?: ClaimRiskAssessment | null,
): Record<string, unknown> {
  const sameFile = c.gate === 'soft_overlap' && c.overlapKind === 'same_file';
  return {
    gate: c.gate,
    rule: { verdict: 'HOLD', reason: c.gate },
    overlap: { kind: c.gate === 'soft_overlap' ? (c.overlapKind ?? 'prefix') : c.gate === 'advisory_manifest' ? 'undeclared_scope' : 'declared_paths' },
    candidate: {
      title: clip(c.title, 200),
      scope: c.scope,
      declaredPaths: c.concretePaths.slice(0, MAX_STATE_PATHS),
      declaredPathCount: c.concretePaths.length,
      retryKind: c.retryKind,
      waitingMinutes: minutesBetween(c.taskCreatedAt, c.deferredAt),
      predictedChange: evidence?.predictedChange ?? { source: 'declared_paths', files: c.concretePaths.length },
    },
    holder: {
      kind: c.gate === 'advisory_manifest'
        ? 'in_flight_task_without_declared_scope'
        : c.gate === 'soft_overlap'
          ? (sameFile ? 'in_flight_task_editing_the_same_file' : 'in_flight_task_sharing_a_directory')
          : 'open_pr_after_worker_ended',
      stage: holder?.stage ?? 'unknown',
      title: clip(holder?.title, 200),
      live: holder?.workerStatus ? LIVE_HOLDER_STATUSES.has(holder.workerStatus) : c.gate !== 'open_pr_overlap',
      workerStatus: holder?.workerStatus ?? c.holder.workerStatus,
      minutesSinceActivity: minutesBetween(holder?.lastActivityAt ?? null, c.deferredAt),
      prLifecycle: holder?.prLifecycle ?? c.holder.prLifecycle,
      overlappingPaths: c.overlapPaths.slice(0, MAX_STATE_PATHS),
      overlappingPathCount: c.overlapPaths.length,
    },
    conflictHistory: evidence?.conflictHistory ?? { summary: 'unknown' },
    risk: (risk ?? c.risk) ? claimRiskForModel((risk ?? c.risk)!) : { tier: 'unknown' },
    baseFreshness: holder?.baseStale === true ? 'holder_conflicts_with_base' : holder?.baseStale === false ? 'holder_clean' : 'unknown',
    deterministicRails: {
      liveLease: 'clear',
      serializedSurfaceOrMigration: 'clear',
      dependencies: 'met',
      laterGates: 'still_apply',
    },
  };
}
