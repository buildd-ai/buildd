/**
 * Post-session quality loop — the shared vocabulary and the Stage A fact builder.
 *
 * A **session** is one worker attempt at one task; **post-session** means after
 * that worker reached a terminal state. The loop runs out of band: task
 * completion, PR review, merge and release never wait for it, and nothing in it
 * may change the original worker or task. Spec: artifact
 * `post-session-quality-loop-spec` (§4–§5, §8–§9, §11–§12).
 *
 * Stage A is the cheap, deterministic half: a compact structured record of what
 * happened in a finished session, assembled from rows that already exist. It is
 * the ONLY input the Stage B triage decision receives, so two rules hold:
 *
 *  - **Bounded.** Every list is capped and every string is an enum, a slug, an
 *    id or a clipped tool name. `MAX_STAGE_A_FACTS_BYTES` is a hard ceiling.
 *  - **No free text.** No summary, error message, PR body or transcript content
 *    — only whether such a thing exists. A worker's `error` can carry a stack
 *    trace with a credential in it; a decision request is the wrong place for it.
 *
 * Missing evidence is not negative evidence: a source that could not be read is
 * `null` and is named in `unavailable`, never reported as zero.
 *
 * Pure: no DB, no network. The DB-backed collector is
 * `apps/web/src/lib/post-session-run.ts`.
 */

import { isTerminalWorkerStatus } from '@buildd/shared';
import type { ResultMeta } from './db/schema';

// ── Modes & policy ──────────────────────────────────────────────────────────

/**
 * `off`: no rows, no triage. `shadow` (absent ⇒ shadow): collect, triage,
 * analyse and record findings, but file nothing. `propose`: apply the action
 * policy (deduped follow-up tasks / correction proposals).
 */
export const POST_SESSION_QUALITY_MODES = ['off', 'shadow', 'propose'] as const;
export type PostSessionQualityMode = (typeof POST_SESSION_QUALITY_MODES)[number];

/** `WorkspaceGitConfig.postSessionQuality` — runtime config, not a deploy constant. */
export interface PostSessionQualityConfig {
  mode?: PostSessionQualityMode;
  /** §9 action-policy thresholds. Read only through `resolveFindingActionPolicy`. */
  findingPolicy?: {
    highConfidenceThreshold?: number;
    mediumRecurrence?: { count?: number; windowDays?: number };
  };
}

/**
 * The one place a workspace's mode is read. An unrecognised value resolves to
 * `shadow`, never `propose`: a typo must not start filing tasks.
 */
export function resolvePostSessionQualityMode(
  gitConfig: { postSessionQuality?: PostSessionQualityConfig | null } | null | undefined,
): PostSessionQualityMode {
  const cfg = gitConfig?.postSessionQuality;
  const mode = cfg && typeof cfg === 'object' ? cfg.mode : undefined;
  return mode === 'off' || mode === 'propose' ? mode : 'shadow';
}

/**
 * Runs are keyed by (worker, policy version): each worker attempt is evaluated
 * once per version, and bumping this re-evaluates without touching old rows.
 */
export const POST_SESSION_POLICY_VERSION = 'psq-v1';

/** A failed collection is retried by the sweep this many times, then left as evidence. */
export const MAX_POST_SESSION_ATTEMPTS = 3;

/** A run stuck in `collecting` this long is presumed crashed and may be reclaimed. */
export const POST_SESSION_STALE_COLLECTING_MS = 10 * 60 * 1000;

// ── Ledger vocabularies (shared by later stages) ────────────────────────────

/**
 * Processing state of one run. Stage A writes `collecting` → `collected` |
 * `failed`; later stages advance `collected` → `triaged` → `analysing` →
 * `analysed` (or `skipped` when triage and hard triggers both pass).
 */
export const POST_SESSION_RUN_STATES = [
  'collecting', 'collected', 'triaged', 'skipped', 'analysing', 'analysed', 'failed',
] as const;
export type PostSessionRunState = (typeof POST_SESSION_RUN_STATES)[number];

/** Which stage a recorded failure happened in. */
export const POST_SESSION_FAILURE_STAGES = ['collect', 'triage', 'analyse', 'act'] as const;
export type PostSessionFailureStage = (typeof POST_SESSION_FAILURE_STAGES)[number];

/** §12 coverage truth for an analysed run's ordered trace. */
export const TRACE_AVAILABILITY = ['full', 'truncated', 'absent'] as const;
export type TraceAvailability = (typeof TRACE_AVAILABILITY)[number];

/** Stage B typed output (§6). Stored on the run; defined here so the column type is stable. */
export const TRIAGE_DECISIONS = ['skip', 'analyse'] as const;
export type TriageDecision = (typeof TRIAGE_DECISIONS)[number];
export const TRIAGE_FOCUSES = ['general', 'retrieval', 'knowledge', 'orchestration', 'review_merge', 'runtime'] as const;
export type TriageFocus = (typeof TRIAGE_FOCUSES)[number];

export interface PostSessionTriageRecord {
  /** `unavailable` = the decision call timed out / failed / was malformed (fail-open). */
  status: 'ok' | 'unavailable';
  decision: TriageDecision | null;
  focus: TriageFocus | null;
  reasonCode: string | null;
  confidence: number | null;
  /** Provenance: which model/policy produced it, for later inspection. */
  provenance?: Record<string, string | number | boolean | null>;
}

/** §7 finding classes. */
export const FINDING_CLASSES = [
  'platform', 'retrieval', 'knowledge', 'agent_use', 'environment', 'task_spec', 'no_action',
] as const;
export type FindingClass = (typeof FINDING_CLASSES)[number];
export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
export const FINDING_PROPOSED_ACTIONS = [
  'file_task', 'propose_memory_correction', 'investigate_retrieval', 'adjust_guidance', 'observe_only',
] as const;
export type FindingProposedAction = (typeof FINDING_PROPOSED_ACTIONS)[number];
/** Where a deduped finding stands in the §9 action policy. */
export const FINDING_ACTION_STATES = ['observed', 'promoted', 'task_filed', 'proposal_filed', 'suppressed'] as const;
export type FindingActionState = (typeof FINDING_ACTION_STATES)[number];

/** One session that exhibited a finding. Capped list on the finding row. */
export interface FindingAffectedRef {
  runId: string;
  workerId: string;
  taskId: string | null;
  seenAt: string;
}

/** Pointer to evidence — never the evidence itself. */
export interface FindingEvidenceRef {
  kind: string;
  ref: string;
}

// ── Eligibility ─────────────────────────────────────────────────────────────

export type IneligibleReason = 'not_terminal' | 'never_started' | 'no_task';

/** A worker is evaluated only once it is terminal and a session actually ran for a task. */
export function isEligibleTerminalWorker(w: {
  status: string;
  startedAt: Date | null;
  exitCause: string | null;
  taskId: string | null;
}): { eligible: true } | { eligible: false; reason: IneligibleReason } {
  if (!isTerminalWorkerStatus(w.status)) return { eligible: false, reason: 'not_terminal' };
  if (!w.startedAt || w.exitCause === 'never_started') return { eligible: false, reason: 'never_started' };
  if (!w.taskId) return { eligible: false, reason: 'no_task' };
  return { eligible: true };
}

// ── Stage A facts ───────────────────────────────────────────────────────────

export const STAGE_A_FACTS_SCHEMA_VERSION = 1;
/** Hard ceiling on the serialized fact record. */
export const MAX_STAGE_A_FACTS_BYTES = 8 * 1024;
export const MAX_TOP_TOOLS = 20;
const MAX_TOOL_NAME = 80;
const MAX_SLUG = 64;
const MAX_ERROR_PATTERNS = 10;
const MAX_UNAVAILABLE = 16;

/** Raw inputs, read by the collector. Lists are `null` when the source could not be read. */
export interface StageASource {
  worker: {
    id: string;
    status: string;
    exitCause: string | null;
    /** Read only for presence — its text never reaches the facts. */
    error: string | null;
    turns: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: string | number | null;
    startedAt: Date | null;
    completedAt: Date | null;
    prNumber: number | null;
    prLifecycleStatus: string | null;
    mergedAt: Date | null;
    supersededByPrNumber: number | null;
    abandonedAt: Date | null;
    /** Read only for presence. */
    rejectedCompletionPayload: unknown;
    dirtyWorktree: boolean;
    mcpCallCount: number | null;
    resultMeta: ResultMeta | null;
  };
  task: {
    id: string;
    status: string;
    kind: string | null;
    category: string | null;
    roleSlug: string | null;
    missionId: string | null;
    outputRequirement: string | null;
    creationSource: string | null;
    parentTaskId: string | null;
    /** Read only for `summarySource`. */
    result: unknown;
  };
  workspace: {
    id: string;
    mergePolicyTier: string | null;
    dataClass: string | null;
  };
  mode: PostSessionQualityMode;
  /** This worker's position among the task's workers, by creation order. */
  attempts: { attemptNumber: number; totalAttempts: number } | null;
  /** Every reviewer round on this worker's PR, oldest first. [] = none; null = unread. */
  reviews: Array<{ status: string; verdict: string | null; confidence: number | null }> | null;
  /** CI-fix tasks dispatched against this worker's PR. */
  ciFixAttempts: number | null;
  /** Error-trace pattern slugs observed in this session, with counts. */
  errorTraces: Array<{ pattern: string; count: number }> | null;
  transcript: {
    availability: TranscriptAvailability;
    sizeBytes: number | null;
  };
  corpora: { code: CorpusAvailability; docs: CorpusAvailability } | null;
  /** Names of sources that failed to read. */
  unavailable: string[];
}

/**
 * Whether a session transcript object exists — metadata only. Whether it is
 * complete is the transcript reader's call (`TraceAvailability`), not this one.
 * `excluded`: sensitive workspace, never uploaded. `unknown`: storage not
 * configured or the probe failed.
 */
export type TranscriptAvailability = 'present' | 'absent' | 'excluded' | 'unknown';
export type CorpusAvailability = 'indexed' | 'not_indexed' | 'unknown';

export type CiState =
  | 'no_pr' | 'unknown' | 'open' | 'running' | 'green' | 'failed' | 'merged' | 'conflict' | 'closed' | 'unresolvable';

export interface ToolCountSummary {
  /** false when the runner recorded no histogram — every count below is then null, not 0. */
  known: boolean;
  total: number | null;
  distinct: number | null;
  recall: number | null;
  learn: number | null;
  cbm: number | null;
  buildd: number | null;
  top: Array<{ tool: string; count: number }>;
}

export interface StageAFacts {
  schemaVersion: typeof STAGE_A_FACTS_SCHEMA_VERSION;
  outcome: {
    workerStatus: string;
    exitCause: string | null;
    hasError: boolean;
    taskStatus: string;
    attemptNumber: number | null;
    totalAttempts: number | null;
    retried: boolean | null;
    prCreated: boolean;
    prNumber: number | null;
    ciState: CiState;
    ciFixAttempts: number | null;
    merged: boolean;
    prSuperseded: boolean;
    prAbandoned: boolean;
    review: {
      rounds: number;
      requestChangesCount: number;
      escalated: boolean;
      failedRounds: number;
      latestVerdict: string | null;
      latestConfidence: number | null;
    } | null;
    outputGateRefused: boolean;
    outputRequirement: string | null;
    summarySource: 'agent' | 'fallback' | null;
    closingTurnOutcome: string | null;
    dirtyWorktree: boolean;
  };
  behaviour: {
    turns: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
    durationMs: number | null;
    mcpCallCount: number | null;
    tools: ToolCountSummary;
    permissionDenials: number | null;
  };
  context: {
    taskId: string;
    workerId: string;
    workspaceId: string;
    missionId: string | null;
    parentTaskId: string | null;
    roleSlug: string | null;
    taskKind: string | null;
    taskCategory: string | null;
    creationSource: string | null;
    mergePolicyTier: string | null;
    dataClass: string | null;
    qualityMode: PostSessionQualityMode;
  };
  knowledge: {
    codeGraph: { outcome: string; disableReason: string | null; bootstrapResult: string | null } | null;
    corpora: { code: CorpusAvailability; docs: CorpusAvailability } | null;
  };
  trace: {
    transcript: TranscriptAvailability;
    transcriptSizeBytes: number | null;
    /**
     * Whether an exact ordered tool trace is available to Stage A. Always
     * false today — only the transcript reader can establish it, and Stage A
     * never reads transcript content.
     */
    orderedTraceAvailable: boolean;
  };
  errors: { total: number; patterns: Array<{ pattern: string; count: number }> } | null;
  unavailable: string[];
}

function clip(value: string | null | undefined, max = MAX_SLUG): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function finiteOrNull(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

const RECALL_TOOL = /(^|__)(recall|query_knowledge)$/;
const LEARN_TOOL = /(^|__)(learn|buildd_memory)$/;
const CBM_PREFIX = 'mcp__codebase-memory__';
const BUILDD_PREFIX = 'mcp__buildd__';

/** Collapse the runner's per-tool histogram into the families triage cares about. */
export function classifyToolCounts(toolCounts: Record<string, number> | null | undefined): ToolCountSummary {
  if (!toolCounts || typeof toolCounts !== 'object') {
    return { known: false, total: null, distinct: null, recall: null, learn: null, cbm: null, buildd: null, top: [] };
  }
  let total = 0, distinct = 0, recall = 0, learn = 0, cbm = 0, buildd = 0;
  const entries: Array<{ tool: string; count: number }> = [];
  for (const [tool, raw] of Object.entries(toolCounts)) {
    const count = finiteOrNull(raw);
    if (count === null || count < 0) continue;
    distinct++;
    total += count;
    if (RECALL_TOOL.test(tool)) recall += count;
    if (LEARN_TOOL.test(tool)) learn += count;
    if (tool.startsWith(CBM_PREFIX)) cbm += count;
    if (tool.startsWith(BUILDD_PREFIX)) buildd += count;
    entries.push({ tool: tool.slice(0, MAX_TOOL_NAME), count });
  }
  entries.sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
  return { known: true, total, distinct, recall, learn, cbm, buildd, top: entries.slice(0, MAX_TOP_TOOLS) };
}

const CI_STATE: Record<string, CiState> = {
  pr_open: 'open',
  ci_running: 'running',
  ci_green: 'green',
  ci_failed: 'failed',
  merged: 'merged',
  conflict: 'conflict',
  closed: 'closed',
  unresolvable: 'unresolvable',
};

function summarizeReviews(reviews: StageASource['reviews']): StageAFacts['outcome']['review'] {
  if (!reviews) return null;
  let requestChangesCount = 0, failedRounds = 0, escalated = false;
  for (const r of reviews) {
    if (r.verdict === 'request-changes') requestChangesCount++;
    if (r.verdict === 'escalate') escalated = true;
    if ((r.status === 'failed' || r.status === 'cancelled' || r.status === 'completed') && !r.verdict) failedRounds++;
  }
  const latest = reviews[reviews.length - 1];
  return {
    rounds: reviews.length,
    requestChangesCount,
    escalated,
    failedRounds,
    latestVerdict: clip(latest?.verdict ?? null, 32),
    latestConfidence: finiteOrNull(latest?.confidence ?? null),
  };
}

/** Assemble the bounded Stage A record. Deterministic: same source, same facts. */
export function buildStageAFacts(src: StageASource): StageAFacts {
  const { worker, task, workspace } = src;
  const meta = worker.resultMeta;
  const result = task.result && typeof task.result === 'object' ? (task.result as Record<string, unknown>) : {};
  const summarySource = result.summarySource === 'agent' || result.summarySource === 'fallback'
    ? result.summarySource
    : null;
  const merged = worker.prLifecycleStatus === 'merged' || worker.mergedAt !== null;
  const ciState: CiState = worker.prNumber === null
    ? 'no_pr'
    : merged ? 'merged' : CI_STATE[worker.prLifecycleStatus ?? ''] ?? 'unknown';
  const durationMs = worker.startedAt && worker.completedAt
    ? Math.max(0, worker.completedAt.getTime() - worker.startedAt.getTime())
    : null;

  const cbm = meta?.cbm;
  const errors = src.errorTraces
    ? {
        total: src.errorTraces.reduce((n, e) => n + (finiteOrNull(e.count) ?? 0), 0),
        patterns: [...src.errorTraces]
          .sort((a, b) => b.count - a.count)
          .slice(0, MAX_ERROR_PATTERNS)
          .map(e => ({ pattern: clip(e.pattern) ?? 'unknown', count: finiteOrNull(e.count) ?? 0 })),
      }
    : null;

  const facts: StageAFacts = {
    schemaVersion: STAGE_A_FACTS_SCHEMA_VERSION,
    outcome: {
      workerStatus: clip(worker.status, 32) ?? 'unknown',
      exitCause: clip(worker.exitCause, 32),
      hasError: Boolean(worker.error),
      taskStatus: clip(task.status, 32) ?? 'unknown',
      attemptNumber: src.attempts?.attemptNumber ?? null,
      totalAttempts: src.attempts?.totalAttempts ?? null,
      retried: src.attempts ? src.attempts.totalAttempts > 1 : null,
      prCreated: worker.prNumber !== null,
      prNumber: worker.prNumber,
      ciState,
      ciFixAttempts: src.ciFixAttempts,
      merged,
      prSuperseded: worker.supersededByPrNumber !== null,
      prAbandoned: worker.abandonedAt !== null,
      review: summarizeReviews(src.reviews),
      outputGateRefused: worker.rejectedCompletionPayload != null || worker.exitCause === 'output_unmet',
      outputRequirement: clip(task.outputRequirement, 32),
      summarySource,
      closingTurnOutcome: clip(meta?.closingTurnOutcome ?? null, 48),
      dirtyWorktree: worker.dirtyWorktree,
    },
    behaviour: {
      turns: worker.turns,
      inputTokens: worker.inputTokens,
      outputTokens: worker.outputTokens,
      costUsd: finiteOrNull(worker.costUsd),
      durationMs,
      mcpCallCount: worker.mcpCallCount,
      tools: classifyToolCounts(meta?.toolCounts),
      permissionDenials: meta ? (meta.permissionDenials?.length ?? 0) : null,
    },
    context: {
      taskId: task.id,
      workerId: worker.id,
      workspaceId: workspace.id,
      missionId: task.missionId,
      parentTaskId: task.parentTaskId,
      roleSlug: clip(task.roleSlug),
      taskKind: clip(task.kind, 32),
      taskCategory: clip(task.category, 32),
      creationSource: clip(task.creationSource, 32),
      mergePolicyTier: clip(workspace.mergePolicyTier, 32),
      dataClass: clip(workspace.dataClass, 32),
      qualityMode: src.mode,
    },
    knowledge: {
      codeGraph: cbm
        ? {
            outcome: clip(cbm.outcome, 32) ?? 'unknown',
            disableReason: clip(cbm.disableReason ?? null, 32),
            bootstrapResult: clip(cbm.bootstrapResult ?? null, 32),
          }
        : null,
      corpora: src.corpora,
    },
    trace: {
      transcript: src.transcript.availability,
      transcriptSizeBytes: src.transcript.sizeBytes,
      orderedTraceAvailable: false,
    },
    errors,
    unavailable: src.unavailable.slice(0, MAX_UNAVAILABLE).map(s => clip(s, 32) ?? 'unknown'),
  };

  // Belt and braces: every field above is individually capped, so this only
  // trims the one open-ended list if a future field pushes the record over.
  while (Buffer.byteLength(JSON.stringify(facts)) > MAX_STAGE_A_FACTS_BYTES && facts.behaviour.tools.top.length > 0) {
    facts.behaviour.tools.top.pop();
  }
  return facts;
}
