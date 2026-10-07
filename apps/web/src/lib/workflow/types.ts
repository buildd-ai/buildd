/**
 * Workflow state kernel vocabulary (docs/specs/workflow-state-kernel.md §4–§6).
 *
 * Routes reach the kernel only through `seam.ts`; these types describe the
 * contract the reducer and the CAS statement builder implement.
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

/**
 * What a standing approval rests on. `composition` and `policy` are never a
 * verdict at the head: `policy` means the workspace's merge policy requires no
 * review (auto-threshold), so only T15's landing rails gate the merge.
 */
export type ApprovalBasis = 'verdict' | 'human' | 'composition' | 'policy';

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
  /** T20/T21's record (Slice D): projected onto `workers.supersededBy*` / `abandoned*`. */
  supersededByUrl?: string | null;
  supersededReason?: string | null;
  recordedBy?: string | null;
  /** §14 cutover: who decides for this delivery. Absent in fixtures = 'kernel'. */
  authority?: 'kernel' | 'legacy';
  /**
   * §9: the local head the attempt reported when the delivery last entered
   * AWAITING_PUSH (from that transition's evidence). An owner attempt has no
   * ledger row, so this is the `L` its proof is checked against.
   */
  pushPendingLocalHead?: string | null;
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
  reviewerTaskId?: string | null;
  /** What a delta round is scoped to, e.g. a composition's novel paths (§5.9). */
  scope?: Record<string, unknown> | null;
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
  /** `human`: a manual retry ("Fix CI"); one past the cap is a BudgetExtended row. Absent = automatic. */
  trigger?: 'automatic' | 'human';
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
 * it was made on (`reviewedHeadSha`). `mergedHeadSha` is the PR head GitHub
 * merged, and must be the reviewed head itself or a head that delivery
 * recorded as content-equivalent (`equivalentHeadShas`). `landedSha` is the
 * composed commit in the aggregate's own history that carries the change (the
 * squash commit), never the PR head.
 *
 * The proof is two patch-ids computed from two independent reads: the landed
 * commit's own diff against its parent (`landedPatchId`), and the reviewed
 * head's diff against that same parent's merge base (`reviewedPatchId`). They
 * must be equal; a squash that differs from what was reviewed (a conflict
 * resolved while merging) is a novel delta, never a constituent.
 */
export interface CompositionConstituent {
  deliveryId: string;
  roundId: string;
  prNumber: number;
  reviewedHeadSha: string;
  equivalentHeadShas: string[];
  mergedHeadSha: string;
  landedSha: string;
  landedPatchId: string;
  reviewedPatchId: string;
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
  /** The delivery, PR and repo the round actually belongs to (a round cited for another PR proves nothing). */
  deliveryId: string | null;
  prNumber: number | null;
  repoFullName: string | null;
  roundHeadSha: string | null;
  roundStatus: RoundStatus | null;
  effectiveVerdict: Verdict | null;
  /** That delivery's own approved_heads (verdict + carry-forward), never its composition heads. */
  deliveryApprovedHeads: string[];
}
