// ── Operator recovery read model (GET /api/admin/operator ?recovery=1) ──────
// Contract: buildd-admin docs/specs/operator-recovery.md §7.1 and §10.2. The
// platform-owner view of failure causes across every team. Built by
// apps/web/src/lib/admin/recovery/*; buildd-admin mirrors these types.

export type OperatorMeasured = { value: number | null; basis: 'measured' | 'estimated' | 'unknown'; atLeast?: boolean };
export type OperatorNamedRef = { id: string; name: string; teamId: string | null };
export type OperatorFreshness = { observedAt: string | null; lagSeconds: number | null; state: 'fresh' | 'stale' | 'unknown' };

/**
 * FIR's recovery states. `needs_operator` (FIR §16) is a capability gap only
 * the platform owner can close: it ranks with `needs_decision`.
 */
export type OperatorRecoveryState =
  | 'observing' | 'recovering' | 'waiting' | 'needs_decision' | 'needs_operator' | 'inconclusive' | 'recovered';

/** Who acts next. `operator`: the platform owner (FIR §16). */
export type OperatorRecoveryOwner = 'buildd' | 'person' | 'operator';

/** The §10.4 inputs a cause's completeness is measured over. Closed. */
export type RecoveryEvidenceInput = 'assessment' | 'attempt_events' | 'subject_tasks' | 'cost_rows' | 'pr_projection';

/** §10.3 drill-down filters. Closed. */
export const RECOVERY_FILTERS = [
  'detection_to_recovery', 'auto_recovered', 'failed_auto_recovery', 'reopened', 'time_blocked',
  'unnecessary_escalation', 'stale_prompt', 'repair_effectiveness', 'cost_per_recovered_subject', 'queue_age', 'telemetry_lag',
] as const;
export type RecoveryFilter = (typeof RECOVERY_FILTERS)[number];

/** Owner capabilities (§8.1, `orq-cap-v1`). Offered by B2; B1 always returns `actions: []`. */
export type AdminRecoveryCapability =
  | 'run_repair' | 'retry_recovery' | 'decide' | 'link_fix' | 'queue_fix' | 'regroup'
  | 'set_priority' | 'pause_automation' | 'resume_automation' | 'set_policy';

export type AvailableAction = {
  capability: AdminRecoveryCapability;
  label: string;
  target: { causeKey: string } | { incidentId: string };
  generation: number | null;
  evidenceRevision: string;
  params?: Record<string, unknown>;
  effect: string;
};

export type RecoveryRankComponent = { key: string; value: number | null; weight: number; contribution: number; atLeast?: boolean };

export type RecoveryCauseRow = {
  causeKey: string;
  /** Hash of member (incidentId, version) pairs; the CAS token for cause-level actions. */
  revision: string;
  title: string;
  sentence: string;
  family: string;
  causeCode: string;
  grouping: { source: 'rule' | 'model' | 'operator'; confidence: number | null; decisionId: string | null; shadowSuggestion?: { mergeWith: string; confidence: number } };
  state: OperatorRecoveryState;
  owner: OperatorRecoveryOwner;
  rank: {
    position: number;
    tier: 0 | 1 | 2 | 3;
    tierReason: string;
    score: number;
    why: string;
    components: RecoveryRankComponent[];
    override: { mode: 'pin_top' | 'demote' | 'snooze'; until: string; by: string; reason: string; baselinePosition: number } | null;
    advice: { answer: 'raise' | 'keep' | 'lower'; confidence: number; rationale: string; decisionId: string } | null;
  };
  impact: {
    teams: OperatorNamedRef[];
    workspaces: OperatorNamedRef[];
    missions: OperatorNamedRef[];
    tasks: { count: number; sample: OperatorNamedRef[] };
    blockedNow: number;
    blockedTaskHours24h: OperatorMeasured;
    blockedTaskHours7d: OperatorMeasured;
    unblocks: { tasks: number; missions: number; teams: number };
    /** §5.3 step 5: hours of this cause's subjects attributed to a root cause upstream. */
    waitsBehind: { causeKey: string; tasks: number } | null;
  };
  timing: { firstSeenAt: string; lastProgressAt: string | null; lastObservedAt: string | null; nextCheckAt: string | null; oldestOpenAgeH: number };
  trend: { episodes24h: number; prior6dMeanDaily: number; reopens7d: number; direction: 'growing' | 'steady' | 'shrinking' | 'unknown' };
  repair: {
    attempts: { total: number; succeeded: number; failed: number; noEffect: number; inFlight: number };
    budget: { spent: number; limit: number; exhausted: boolean };
    fixTask: (OperatorNamedRef & { status: string }) | null;
    fixPr: { number: number; url: string; state: string; workspaceId: string } | null;
    wasteUsd7d: OperatorMeasured;
    modelUsd7d: OperatorMeasured;
    costPerRecoveredSubjectUsd: OperatorMeasured;
  };
  episodes: { open: number; total7d: number };
  telemetry: { completeness: number; missing: Array<RecoveryEvidenceInput | 'sweep_last_run'>; freshness: OperatorFreshness };
  actions: AvailableAction[];
};

export type RecoveryRate = { numerator: number | null; denominator: number | null; value: number | null };

export type RecoveryTelemetry = {
  window: '24h' | '7d' | '30d';
  detectionToRecoveryMin: { p50: number | null; p90: number | null; n: number };
  autoRecoverySuccess: RecoveryRate;
  autoRecoveryFailure: RecoveryRate;
  /** `tooRecent`: no cause resolved in the window is 7 days old yet. */
  reopenRate: RecoveryRate & { tooRecent: boolean };
  timeBlockedTaskHours: OperatorMeasured;
  unnecessaryEscalations: RecoveryRate;
  /** Not measured yet: delivered pushes are not joined to verdict generations. Always null with `missing` naming it. */
  stalePrompts: RecoveryRate;
  repairEffectiveness: Record<string, RecoveryRate>;
  costPerRecoveredSubjectUsd: OperatorMeasured;
  queueAgeH: { p50: number | null; max: number | null; n: number };
  telemetryLag: { seconds: number | null; lastRunAt: string | null; state: 'fresh' | 'stale' | 'unknown' };
  /** Metrics that could not be computed, by key. */
  missing: string[];
};

export type RecoveryPolicyView = {
  v: 1;
  source: 'default' | 'stored';
  perRule: Record<string, { budgetLimit: number; backoffMinutes: number[]; episodeDeadlineHours: number; autoRepair: 'off' | 'shadow' | 'on' }>;
  model: { dailyUsd: number; dailyCalls: number; timeoutMs: number };
};

export type RecentlyRecoveredCause = Pick<RecoveryCauseRow, 'causeKey' | 'title' | 'impact'> & { recoveredAt: string; detectionToRecoveryMin: number };

export type RecoveryPanel = {
  v: 1;
  generatedAt: string;
  rankingPolicy: { version: 'orq-rank-v1'; weights: Record<string, number> };
  automation: {
    paused: { platform: boolean; rules: string[]; causes: string[] };
    readError: boolean;
    policy: RecoveryPolicyView;
    model: { spentUsdToday: number; callsToday: number; breakerOpenUntil: string | null };
  };
  totals: { causes: number; needsDecision: number; blockedNow: number; blockedTaskHours24h: OperatorMeasured; evidenceMissing: number };
  causes: RecoveryCauseRow[];
  recentlyRecovered?: RecentlyRecoveredCause[];
  telemetry: RecoveryTelemetry;
  /** Set when `recoveryFilter` narrowed `causes`. */
  filter?: RecoveryFilter;
  truncated: boolean;
};

export type RecoveryAttemptOutcome = 'progressed' | 'no_effect' | 'failed' | 'refused' | 'in_flight';

export type RecoveryCauseDetail = {
  cause: RecoveryCauseRow;
  incidents: Array<{
    incidentId: string; workspace: OperatorNamedRef; team: OperatorNamedRef; status: string; version: number;
    recovery: unknown; verdict: { owner: 'buildd' | 'person'; generation: number | null } | null;
  }>;
  episodes: Array<{
    incidentId: string; generation: number; subject: { kind: string; id: string; name: string };
    blocker: { kind: string; id: string; state: string } | null;
    state: OperatorRecoveryState; firstSeenAt: string; endedAt: string | null; blockedHours: number; attributedTo: string;
  }>;
  attempts: Array<{
    actionKey: string; capability: string; actor: string; startedAt: string; endedAt: string | null;
    outcome: RecoveryAttemptOutcome; verify: { predicate: string; passed: boolean | null; evidenceRevision: string }; costUsd: number | null;
  }>;
  evidence: Array<{ ref: string; kind: string; label: string; observedAt: string; url?: string }>;
  decisions: Array<{
    decisionId: string; kind: string; mode: 'shadow' | 'gated' | 'live'; answer: string; confidence: number | null; rationale: string | null;
    model: string | null; promptVersion: string | null; policyVersion: string | null; outcome: string | null; costUsd: number | null;
  }>;
  audit: Array<{ at: string; actorAccountId: string; operatorLabel: string | null; action: string; before: unknown; after: unknown }>;
  notifications: { delivered: number; suppressed: number; lastDeliveredAt: string | null };
};
