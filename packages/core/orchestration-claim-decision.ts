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
 * A START, when one is ever applied (gated cohort, Jev only), relaxes only the
 * named advisory gate: every later gate still runs, and declared paths are
 * still acquired through the exclusive primitive (path-claim.ts) before the
 * claim. The definition ships in `shadow` with a zero applying fraction, so
 * `isGatedStartReachable()` is false and the claim route never even looks.
 *
 * Pure: no DB, no env. The stores live in ./orchestration-claim-source.ts.
 */
import { choice, type Decision } from '@builddai/ai-kit/decide';
import { definePromptedDecision } from './prompted-decision';
import { LIVE_WORKER_STATUSES } from '@buildd/shared';
import { candidateDigest } from './orchestration-decision';

// ── Definition ───────────────────────────────────────────────────────────────

export const CLAIM_HOLD_PROMPT_VERSION = 'ch1';

export const CLAIM_HOLD_QUESTIONS = {
  action: choice(
    {
      question: 'The deterministic claim rule is holding `candidate` because of `holder`. Should `candidate` keep waiting, or start now?',
      rule: 'Judge whether the two pieces of work are likely to edit the same lines. Follow the definitions. `gate` names the only rule a START would relax; every other rule still applies.',
    },
    {
      HOLD: 'Starting now would probably edit the same files or lines as `holder` and produce a merge conflict or a collision, or there is not enough information to tell. Not for work that is plainly unrelated.',
      START: 'The two pieces of work are about different things and would very probably touch different files or different parts of a file, so starting now is unlikely to conflict. Not for work that overlaps in purpose or in named files.',
    },
  ),
};

export type ClaimHoldLabel = 'HOLD' | 'START';
export const CLAIM_HOLD_LABELS: readonly ClaimHoldLabel[] = ['HOLD', 'START'];

/**
 * Shadow: suggestions are recorded, never applied. Moving it to `gated`
 * needs a minConfidence measured on held-out Jev outcomes (Step I) and a
 * prompt-version bump, which changes the fingerprint.
 */
export const CLAIM_HOLD_DECISION = definePromptedDecision({
  id: 'buildd.orchestration_claim_hold',
  promptVersion: CLAIM_HOLD_PROMPT_VERSION,
  questions: CLAIM_HOLD_QUESTIONS,
  mode: 'shadow',
});

/** Share of eligible tasks drawn into the applying arm. Zero until a readout justifies more. */
export const CLAIM_HOLD_APPLYING_FRACTION = 0;

/** How long an applied START stays usable for the same claim-time state. */
export const CLAIM_HOLD_START_TTL_MS = 10 * 60_000;

/** At most this many decisions are scheduled per claim response. */
export const CLAIM_HOLD_MAX_PER_CLAIM = 5;

/**
 * True only when a START could ever be applied: the definition is not
 * shadow AND the applying fraction is above zero. Both ship off, so the claim
 * route skips the ledger lookup entirely.
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

export type ClaimHoldGate = 'advisory_manifest' | 'open_pr_overlap';

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
 * Migration namespaces, matched without workspace config so an unconfigured
 * workspace is still protected. A configured sequence namespace is caught by
 * `serializedSurfaces` too.
 */
const MIGRATION_PATH_RE = /(^|\/)(drizzle|migrations?|prisma\/migrations)(\/|$)|\.sql$/i;

export function isMigrationPath(path: string): boolean {
  return MIGRATION_PATH_RE.test(path);
}

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
  retryKind: 'conflict' | 'reviewer' | 'ci' | null;
  holder: ClaimHoldHolder;
  /** Short task title for the model; never stored in the ledger. */
  title: string | null;
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
export function claimHoldStateDigest(c: Pick<ClaimHoldCandidate, 'gate' | 'scope' | 'concretePaths' | 'overlapPaths' | 'retryKind' | 'holder'>): string {
  return candidateDigest([
    `gate=${c.gate}`,
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
export function buildClaimHoldState(c: ClaimHoldCandidate, holder: ClaimHoldHolderState | null): Record<string, unknown> {
  return {
    gate: c.gate,
    rule: { verdict: 'HOLD', reason: c.gate },
    candidate: {
      title: clip(c.title, 200),
      scope: c.scope,
      declaredPaths: c.concretePaths.slice(0, MAX_STATE_PATHS),
      declaredPathCount: c.concretePaths.length,
      retryKind: c.retryKind,
      waitingMinutes: minutesBetween(c.taskCreatedAt, c.deferredAt),
    },
    holder: {
      kind: c.gate === 'advisory_manifest' ? 'in_flight_task_without_declared_scope' : 'open_pr_after_worker_ended',
      title: clip(holder?.title, 200),
      live: holder?.workerStatus ? LIVE_HOLDER_STATUSES.has(holder.workerStatus) : c.gate === 'advisory_manifest',
      workerStatus: holder?.workerStatus ?? c.holder.workerStatus,
      minutesSinceActivity: minutesBetween(holder?.lastActivityAt ?? null, c.deferredAt),
      prLifecycle: holder?.prLifecycle ?? c.holder.prLifecycle,
      overlappingPaths: c.overlapPaths.slice(0, MAX_STATE_PATHS),
      overlappingPathCount: c.overlapPaths.length,
    },
    baseFreshness: holder?.baseStale === true ? 'holder_conflicts_with_base' : holder?.baseStale === false ? 'holder_clean' : 'unknown',
    deterministicRails: {
      liveLease: 'clear',
      serializedSurfaceOrMigration: 'clear',
      dependencies: 'met',
      laterGates: 'still_apply',
    },
  };
}
