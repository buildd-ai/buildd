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

export const SCOUT_RUN_STATUSES = ['running', 'completed', 'failed'] as const;
export type ScoutRunStatus = (typeof SCOUT_RUN_STATUSES)[number];

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
}

/** Readout counters written when a run ends (spec §16). */
export interface ScoutRunTotals {
  candidatesGenerated: number;
  probesSelected: number;
  probesSkipped: number;
  verdicts: Record<VerificationVerdict | 'total', number>;
  costUsd: number | null;
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
  /** Null until executed (or finalized as not executed). */
  result: VerificationResult | null;
}

// ── Finding ─────────────────────────────────────────────────────────────────

/**
 * `open`: the invariant is broken as of `lastSeenSha`. `resolved`: a later run
 * passed the same check. `dismissed`: a person said it is not a defect — a
 * dismissed finding stays dismissed when it recurs, it only counts.
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
}
