/**
 * Workflow state kernel vocabulary (docs/specs/workflow-state-kernel.md §4–§6).
 *
 * DARK: nothing outside apps/web/src/lib/workflow/ imports this yet. The seam
 * task wires routes to `ingestFact` / `applyCommand`; until then these types
 * describe the contract the reducer and the CAS statement builder implement.
 */

// ── §4 State vocabulary ─────────────────────────────────────────────────────

export const DELIVERY_STATES = [
  'WORKING',
  'AWAITING_PUSH',
  'AWAITING_REVIEW',
  'CHANGES_REQUESTED',
  'FIXING',
  'REPAIRING',
  'BLOCKED_ON_TRUNK',
  'APPROVED',
  'LANDING',
  'ESCALATED',
  'MERGED',
  'CLOSED_UNMERGED',
  'SUPERSEDED',
  'ABANDONED',
  'FAILED',
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

/** Rule 1 of §4: terminal states win over any later non-terminal fact. */
export const TERMINAL_STATES: ReadonlySet<DeliveryState> = new Set(['MERGED', 'SUPERSEDED', 'ABANDONED', 'FAILED']);
export const isTerminal = (s: DeliveryState): boolean => TERMINAL_STATES.has(s);

export type RepairKind = 'ci' | 'conflict' | 'behind' | 'migration';
export type EscalationReason =
  | 'review_escalated'
  | 'review_exhausted'
  | 'review_unavailable'
  | 'ci_exhausted'
  | 'conflict_exhausted'
  | 'push_undeliverable'
  | 'landing_needs_human'
  | 'policy_human'
  | 'unsafe_to_merge';
export type CloseCause = 'manual' | 'base_deleted' | 'superseded_by_policy' | 'unknown';

/** What a standing approval rests on. `composition` is never a verdict at the head. */
export type ApprovalBasis = 'verdict' | 'human' | 'composition';

export type Verdict = 'approve' | 'request_changes' | 'escalate';
export type RoundStatus = 'queued' | 'reviewing' | 'decided' | 'failed' | 'superseded';
export type RoundKind = 'full' | 'delta';

export type AttemptFamily = 'review_fix' | 'ci' | 'conflict' | 'migration' | 'trunk';
export type AttemptMode = 'mechanical' | 'agent';
export type AttemptStatus = 'queued' | 'running' | 'ended' | 'skipped' | 'cancelled';
export type AttemptOutcome = 'delivered' | 'unproven' | 'failed' | 'noop';

// ── Snapshots the reducer reads ─────────────────────────────────────────────

export interface DeliverySnapshot {
  id: string;
  workspaceId: string;
  ownerTaskId: string;
  repoFullName: string | null;
  prNumber: number | null;
  baseRef: string | null;
  state: DeliveryState;
  stateReason: string | null;
  version: number;
  currentHeadSha: string | null;
  currentRound: number;
  maxRounds: number;
  boundAttemptId: string | null;
  resumeState: DeliveryState | null;
  trunkIncidentId: string | null;
  approvedHeads: string[];
  approvalBasis: ApprovalBasis | null;
  compositionHeads: string[];
  ci: string | null;
  ciHeadSha: string | null;
  mergeable: string | null;
  mergeableHeadSha: string | null;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  supersededByPr: number | null;
}

export interface RoundSnapshot {
  id: string;
  round: number;
  headSha: string;
  kind: RoundKind;
  status: RoundStatus;
  verdict: Verdict | null;
  effectiveVerdict: Verdict | null;
  failureCount: number;
}

export interface AttemptSnapshot {
  id: string;
  family: AttemptFamily;
  attemptNo: number;
  mode: AttemptMode;
  boundHeadSha: string | null;
  triggerReason: string | null;
  taskId: string | null;
  status: AttemptStatus;
  outcome: AttemptOutcome | null;
  maxAttempts: number;
  reportedShas: string[];
}

export interface KernelView {
  delivery: DeliverySnapshot | null;
  rounds: RoundSnapshot[];
  attempts: AttemptSnapshot[];
}

// ── Actors ──────────────────────────────────────────────────────────────────

/** `runner`, `reviewer`, `webhook`, `sweep:<name>`, `human:<user>`, `agent:<task>`, `kernel`. */
export type Actor = string;
export const isHumanActor = (a: Actor): boolean => a.startsWith('human:');

// ── §6.6 Release / integration composition attestation ─────────────────────

/**
 * One already-reviewed change a composed PR (a release PR, a mission
 * integration PR) is built from. The verdict it cites stays bound to the head
 * it was made on (`reviewedHeadSha`); `landedSha` is where that change sits in
 * the composed history, and must be the reviewed head itself or a head that
 * delivery recorded as content-equivalent (`equivalentHeadShas`).
 */
export interface CompositionConstituent {
  deliveryId: string;
  roundId: string;
  prNumber: number;
  reviewedHeadSha: string;
  equivalentHeadShas: string[];
  landedSha: string;
}

/**
 * How the aggregate head was checked against its constituents. Every method is
 * mechanical (a tree or patch comparison a machine re-ran), never a judgement.
 *  - `tree_equal`: base + constituents replayed reproduces the aggregate tree.
 *  - `patch_set_equal`: the aggregate's patch-id set equals the constituents'.
 */
export type CompositionMethod = 'tree_equal' | 'patch_set_equal';

/**
 * The novel-delta result, stated explicitly: `none` (the aggregate adds
 * nothing beyond the constituents), `present` (it does: these paths need their
 * own review), or `unverifiable` (the check could not decide; a full review is
 * owed and nothing is claimed).
 */
export type NovelDelta =
  | { result: 'none' }
  | { result: 'present'; paths: string[] }
  | { result: 'unverifiable'; reason: string };

export interface CompositionAttestation {
  repoFullName: string;
  prNumber: number;
  baseSha: string;
  aggregateHeadSha: string;
  method: CompositionMethod;
  verifiedAt: string;
  verifier: Actor;
  constituents: CompositionConstituent[];
  novelDelta: NovelDelta;
}

/** What the caller resolved for each constituent (the reducer stays pure). */
export interface ConstituentEvidence {
  roundId: string;
  roundHeadSha: string | null;
  roundStatus: RoundStatus | null;
  effectiveVerdict: Verdict | null;
  /** That delivery's own approved_heads (verdict + carry-forward), never its composition heads. */
  deliveryApprovedHeads: string[];
}
