/**
 * Quality Scout — the Scout-specific policy objects (artifact
 * workspace-quality-scout-spec §3, §6, §9–§12).
 *
 * Everything about a *check* — invariant, executor/capability matching,
 * evidence requirements and refs, the pass|fail|inconclusive|unsupported
 * verdict, severity/confidence, signature/recurrence key and provenance — is
 * the shared substrate in `../verification-check` (ADR
 * `adr-shared-verification-check-substrate`). This file does not restate any
 * of it; a probe's result IS a `VerificationResult`.
 *
 * What lives here is only what Scout decides on its own: what a run is (which
 * ref/SHA it exercised, its budget and mode), which candidates it considered
 * and why it picked some, and what state a finding and its follow-up are in.
 *
 * No release-blocking authority exists in v1: there is no mode, action or
 * state here that blocks anything, and `SCOUT_AUTHORITY` says so in code.
 */

import type { ScoutCapabilityProfile } from '../scout-capabilities';
import type {
  EvidenceRequirement,
  VerificationEvidenceRef,
  VerificationResult,
  VerificationSeverity,
  VerificationVerdict,
} from '../verification-check';

/** Provenance flavor on every Scout check. */
export const SCOUT_FLAVOR = 'quality-scout';

/** Bumped when the meaning of a stored run/probe/finding row changes. */
export const SCOUT_POLICY_VERSION = 'scout-v1';

/**
 * v1 Scout is advisory. A future release gate may read verified
 * deterministic high/critical findings, but nothing in this module can block.
 */
export const SCOUT_AUTHORITY = 'advisory' as const;

// ── Mode ────────────────────────────────────────────────────────────────────

/**
 * `off`: no runs. `shadow`: run and record, never file follow-ups.
 * `propose`: apply the deduped action policy. There is no blocking mode.
 */
export const SCOUT_MODES = ['off', 'shadow', 'propose'] as const;
export type ScoutMode = (typeof SCOUT_MODES)[number];

// ── Run ─────────────────────────────────────────────────────────────────────

export const SCOUT_RUN_TRIGGERS = ['manual', 'mission-candidate', 'periodic', 'pre-release'] as const;
export type ScoutRunTrigger = (typeof SCOUT_RUN_TRIGGERS)[number];

/**
 * `awaiting_host`: the server ran its own probes and parked the run for a
 * runner to execute the ones only a runner can host (command, capture,
 * app-boot). A parked run is live: a re-trigger on its SHA is a duplicate. It
 * ends `completed` either way, when the runner reports or when the expiry
 * sweep finalizes its unexecuted probes `unsupported`.
 */
export const SCOUT_RUN_STATUSES = ['running', 'awaiting_host', 'completed', 'failed'] as const;
export type ScoutRunStatus = (typeof SCOUT_RUN_STATUSES)[number];

// ── Hosts ───────────────────────────────────────────────────────────────────

/**
 * Where a probe runs. `server`: the trigger's own host (readiness, spec, HTTP
 * to a declared test environment). `runner`: a team runner that advertised
 * `environment.scoutHost` for the repo.
 */
export const SCOUT_PROBE_HOSTS = ['server', 'runner'] as const;
export type ScoutProbeHost = (typeof SCOUT_PROBE_HOSTS)[number];

/** What a probe needs from its host. `app-boot` is HTTP to an app the host booted. */
export const SCOUT_HOST_NEEDS = ['command', 'capture', 'http', 'app-boot', 'spec', 'readiness'] as const;
export type ScoutHostNeed = (typeof SCOUT_HOST_NEEDS)[number];

/** The needs only a runner can ever serve: the server has no sandbox, no browser and boots nothing. */
export const SCOUT_RUNNER_NEEDS: readonly ScoutHostNeed[] = ['command', 'capture', 'app-boot'];

/**
 * `gitConfig.qualityScout.host`. `auto` (default): probes only a runner can
 * host go to one when a runner advertised it recently. `server`: today's
 * behaviour exactly; nothing ever parks.
 */
export const SCOUT_HOST_MODES = ['auto', 'server'] as const;
export type ScoutHostMode = (typeof SCOUT_HOST_MODES)[number];

/** What a runner advertises on its heartbeat (`environment.scoutHost`). */
export interface ScoutRunnerHostAdvert {
  /** `owner/name` of the clones it can check a SHA out of. */
  repos: string[];
  command?: boolean;
  capture?: boolean;
  appBoot?: boolean;
}

/** Why a runner-assigned probe ended without a runner result. Never a pass. */
export const SCOUT_HOST_EXPIRY_REASONS = ['no_runner_claimed', 'runner_host_lost'] as const;
export type ScoutHostExpiryReason = (typeof SCOUT_HOST_EXPIRY_REASONS)[number];

/** Runner-hosted runs: execution bound and how long a parked run waits for a runner. */
export const DEFAULT_SCOUT_RUNNER_MAX_DURATION_MS = 20 * 60_000;
export const DEFAULT_SCOUT_HOST_DEADLINE_MS = 30 * 60_000;
export const MAX_SCOUT_HOST_DEADLINE_MS = 6 * 60 * 60_000;

/**
 * What the plan step learned that finalize needs, frozen when a run parks so a
 * later finalize (runner result or expiry, possibly another instance) reports
 * the same run the server planned.
 */
export interface ScoutPlanSummary {
  candidatesGenerated: number;
  candidatesTruncated: number;
  decisionsAsked: number;
  decisionFailures: number;
  costCapHit: boolean;
  stages: Record<ScoutStage, ScoutStageMetric>;
  warnings: string[];
  /** The server's own execution hit the run's time bound. */
  deadlineHit: boolean;
  /** Per executed probe (candidate id): failed the same way twice, or not. */
  reproducibility: Record<string, ScoutReproducibility>;
}

/** A parked run's host state (`awaiting_host`). */
export interface ScoutRunParking {
  parkedAt: string;
  /** Past this, the expiry sweep finalizes the run's unexecuted runner probes `unsupported`. */
  hostDeadline: string;
  /** Wall-clock bound for the runner's execution of this run. */
  runnerMaxDurationMs: number;
  /** The profile the server planned against; a runner judges against this, never its own. */
  profile: ScoutCapabilityProfile;
  plan: ScoutPlanSummary;
  /** Null until a runner claims the run. */
  lease: { holder: string; expiresAt: string } | null;
  /** Leases that expired without the holder reporting. Two lapses finalize the run. */
  leaseLapses: number;
}

/** Spec §3: a run normally executes 3–5 probes. */
export const DEFAULT_SCOUT_MAX_PROBES = 4;
export const MAX_SCOUT_MAX_PROBES = 10;

export interface ScoutBudget {
  maxProbes: number;
  /** Null: no dollar cap beyond the probe count. */
  maxCostUsd: number | null;
}

/** The exact state a run exercised. `sha` is what staleness is computed from. */
export interface ScoutCandidate {
  /** Branch or tag name, e.g. a mission integration branch or trunk. */
  ref: string;
  /** Full 40-hex commit SHA, lower-case. */
  sha: string;
}

export interface ScoutRun {
  id: string;
  workspaceId: string;
  missionId: string | null;
  trigger: ScoutRunTrigger;
  /** The mode in effect when the run started; a later change never reinterprets it. */
  mode: Exclude<ScoutMode, 'off'>;
  status: ScoutRunStatus;
  candidate: ScoutCandidate;
  /** The run this one is compared against for "what changed since". */
  prior: { runId: string; sha: string } | null;
  budget: ScoutBudget;
  policyVersion: string;
  startedAt: string;
  completedAt: string | null;
  /** Bounded, machine-readable. Set only on `failed`. */
  error: string | null;
  /** Set when the run parked for a runner host; kept after it completes, for the readout. */
  parking?: ScoutRunParking | null;
}

/** Readout counters written when a run ends (spec §16). */
export interface ScoutRunTotals {
  candidatesGenerated: number;
  probesSelected: number;
  probesSkipped: number;
  verdicts: Record<VerificationVerdict | 'total', number>;
  costUsd: number | null;
}

/** Stages a run passes through, in order; each is timed and costed in the readout. */
export const SCOUT_STAGES = ['profile', 'signals', 'generate', 'select', 'execute', 'act'] as const;
export type ScoutStage = (typeof SCOUT_STAGES)[number];

/** `costUsd` is null when nothing in the stage reported a cost — never a guessed zero. */
export interface ScoutStageMetric {
  ms: number;
  costUsd: number | null;
}

/**
 * What the action policy did with one finding in one run. `cancelled` /
 * `annotated`: a pass resolved the finding, so its still-pending follow-up was
 * cancelled, or its already-claimed one was marked resolved and deprioritised.
 * `dismissed`: the finding's follow-up had been cancelled by someone other than
 * the Scout, so the finding was dismissed instead of re-filed.
 */
export const SCOUT_ACTION_OUTCOMES = ['filed', 'updated', 'proposed', 'aggregated', 'retained', 'suppressed', 'cancelled', 'annotated', 'dismissed', 'noop', 'failed'] as const;
export type ScoutActionOutcome = (typeof SCOUT_ACTION_OUTCOMES)[number];

/**
 * The operational readout of one run (spec §16), written when it ends. Every
 * count is of this run only; staleness is against the ref's head as read when
 * the run ended.
 */
export interface ScoutRunMetrics {
  candidatesGenerated: number;
  /** Generated but cut by the candidate cap. */
  candidatesTruncated: number;
  probesSelected: number;
  /** Selected probes that were actually exercised (a refusal counts: it was judged). */
  probesRun: number;
  /** Selected probes the run's time bound cut off; each is `inconclusive`/`not_executed`. */
  probesNotExecuted: number;
  decisionsAsked: number;
  decisionFailures: number;
  /** `budget.maxCostUsd` stopped at least one selection decision; the fallback rule answered the rest. */
  costCapHit: boolean;
  verdicts: ScoutRunTotals['verdicts'];
  stages: Record<ScoutStage, ScoutStageMetric>;
  costUsd: number | null;
  findings: { created: number; recurred: number; regressed: number; resolved: number; writeFailures: number };
  /** Findings the policy wanted acted on (filed, updated or — in shadow — proposed). */
  actionable: number;
  actions: Record<ScoutActionOutcome, number>;
  /** Follow-ups that were NOT filed because one already covers the finding. */
  dedupeSuppressed: number;
  exercised: ScoutCandidate;
  prior: { runId: string; sha: string } | null;
  /** The ref's head when the run ended; null when it could not be read. */
  headSha: string | null;
  staleness: 'fresh' | 'stale' | 'unknown';
  /** The run's time bound cut execution short. */
  deadlineHit: boolean;
  warnings: string[];
  /** Present when the run had runner-assigned probes. */
  hosts?: {
    runnerProbes: number;
    /** Runner probes that ended `unsupported` because no runner reported. */
    runnerExpired: number;
    expiryReason: ScoutHostExpiryReason | null;
    /** Time spent parked in `awaiting_host`. */
    awaitingHostMs: number | null;
  };
}

// ── Probe ───────────────────────────────────────────────────────────────────

export const SCOUT_PROBE_FAMILIES = ['state-transition', 'surface', 'contract', 'persistence', 'release'] as const;
export type ScoutProbeFamily = (typeof SCOUT_PROBE_FAMILIES)[number];

export const SCOUT_COSTS = ['low', 'medium', 'high'] as const;
export type ScoutCost = (typeof SCOUT_COSTS)[number];

/** Where a candidate came from — ids and kinds only, never the signal's body. */
export interface ScoutSourceSignal {
  type: string;
  ref: string;
}

/** How a candidate was picked (or why not). Selection itself is the selector's job. */
export type ScoutProbeSelection =
  | { status: 'selected'; via: 'must_run' | 'decision'; reasonCode: string; decisionSource: string | null }
  | { status: 'skipped'; reason: string; reasonCode: string | null };

/**
 * One candidate as the ledger stores it: the probe contract (spec §6) plus how
 * it was selected and, once executed, its substrate result. The invariant and
 * evidence requirements are frozen at record time — before execution.
 */
export interface ScoutProbeRecord {
  /** Stable across runs (the generator's hash). */
  candidateId: string;
  family: ScoutProbeFamily;
  probeKind: string;
  title: string;
  invariant: string;
  sourceSignals: ScoutSourceSignal[];
  /** Capability kinds that could execute it. */
  preconditions: string[];
  /** The capability id chosen to execute it; null when nothing usable matched. */
  executor: string | null;
  estimatedCost: ScoutCost;
  /** Severity if the invariant is broken — the probe's risk. */
  risk: VerificationSeverity;
  /** Exercising it may write somewhere other than a throwaway checkout. */
  mutates: boolean;
  evidenceRequirements: EvidenceRequirement[];
  /** Why the generator could not match an executor, when it could not. */
  unsupportedReason: string | null;
  selection: ScoutProbeSelection;
  /** Where it runs; absent when the run assigned no hosts (a single-host run). */
  host?: ScoutProbeHost;
  /** Null until executed (or finalized as not executed). */
  result: VerificationResult | null;
}

// ── Finding ─────────────────────────────────────────────────────────────────

/**
 * `open`: the invariant is broken as of `lastSeenSha`. `resolved`: a later run
 * passed the same check. `dismissed`: a person said it is not a defect — a
 * dismissed finding stays dismissed when it recurs, it only counts, and it is
 * never acted on again. Set by the dismiss action (with a reason), or when a
 * follow-up the Scout filed is cancelled by anyone but the Scout.
 */
export const SCOUT_FINDING_STATES = ['open', 'resolved', 'dismissed'] as const;
export type ScoutFindingState = (typeof SCOUT_FINDING_STATES)[number];

/**
 * Follow-up state. `none`: nothing decided yet. `retained`: kept, no action
 * (low). `aggregated`: waiting on recurrence (medium). `proposed`: a follow-up
 * would be filed but the mode is shadow. `filed`: one follow-up task exists —
 * recurrences update it rather than file another. Deliberately no `blocked`.
 */
export const SCOUT_ACTION_STATES = ['none', 'retained', 'aggregated', 'proposed', 'filed'] as const;
export type ScoutActionState = (typeof SCOUT_ACTION_STATES)[number];

export const SCOUT_REPRODUCIBILITY = ['deterministic', 'intermittent', 'unknown'] as const;
export type ScoutReproducibility = (typeof SCOUT_REPRODUCIBILITY)[number];

/** One deduped defect across runs, keyed by (workspace, signature). */
export interface ScoutFinding {
  workspaceId: string;
  signature: string;
  recurrenceKey: string;
  checkId: string;
  family: ScoutProbeFamily;
  invariant: string;
  /** Highest seen. */
  severity: VerificationSeverity;
  /** Highest seen; null when no executor gave one. */
  confidence: number | null;
  observed: string | null;
  evidenceRefs: VerificationEvidenceRef[];
  reproducibility: ScoutReproducibility;
  state: ScoutFindingState;
  actionState: ScoutActionState;
  actionTaskId: string | null;
  occurrenceCount: number;
  /** Times it failed again after being resolved. */
  regressionCount: number;
  firstSeenRunId: string;
  firstSeenSha: string;
  lastSeenRunId: string;
  lastSeenSha: string;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedRunId: string | null;
  resolvedSha: string | null;
  resolvedAt: string | null;
  /** Why it was dismissed; null unless `state` is `dismissed`. */
  dismissedReason: string | null;
  dismissedAt: string | null;
  /** Who dismissed it: `user:<id>`, `account:<id>`, or `follow-up-cancelled:<taskId>`. */
  dismissedBy: string | null;
}

/** Longest dismissal reason kept; a longer one is clipped, never refused. */
export const MAX_SCOUT_DISMISS_REASON = 500;
