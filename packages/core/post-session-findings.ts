/**
 * Post-session quality loop — finding aggregation and the §9 action policy
 * (artifact `post-session-quality-loop-spec` §8–§9).
 *
 * The analyser emits findings per session; this module decides what a finding
 * MEANS once it has been seen across sessions:
 *
 *  - **Aggregation.** One ledger row per (workspace, signature, policy
 *    version). An occurrence is keyed by its run id, so reprocessing the same
 *    incident is a no-op (`counted: false`) rather than a second count.
 *  - **Policy.** critical acts immediately and warns; high acts when its
 *    confidence clears the configured threshold; medium acts once it recurs
 *    (default 2 in 7 days); low only aggregates.
 *  - **Knowledge defects** become a correction PROPOSAL, never a memory
 *    write: nothing in this loop calls learn or mutates durable memory.
 *
 * Pure: no DB. The DB-backed recorder is
 * `apps/web/src/lib/post-session-findings.ts`; it owns the atomic claims that
 * make "promote exactly once" hold under concurrent sweeps.
 */

import type {
  FindingActionState,
  FindingAffectedRef,
  FindingClass,
  FindingEvidenceRef,
  FindingProposedAction,
  FindingSeverity,
  PostSessionQualityConfig,
} from './post-session-quality';
import { maxSeverity, severityRank } from './verification-check';

// ── Policy config ───────────────────────────────────────────────────────────

export interface FindingActionPolicy {
  /** A high finding files only at or above this confidence. */
  highConfidenceThreshold: number;
  /** A medium finding files once seen `count` times inside `windowDays`. */
  mediumRecurrence: { count: number; windowDays: number };
}

export const DEFAULT_FINDING_ACTION_POLICY: FindingActionPolicy = {
  highConfidenceThreshold: 0.7,
  mediumRecurrence: { count: 2, windowDays: 7 },
};

/** Sessions kept on a finding row. occurrenceCount stays exact past it. */
export const MAX_LEDGER_AFFECTED_REFS = 20;
export const MAX_LEDGER_EVIDENCE_REFS = 20;
const MAX_WINDOW_DAYS = 90;

function inRange(n: unknown, lo: number, hi: number): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
}

/**
 * The one place the thresholds are read. Each field falls back to its default
 * independently; an out-of-range value is ignored rather than clamped, so a
 * typo cannot quietly make the policy more eager. The recurrence count is
 * bounded by the affected refs the ledger keeps — it cannot count past them.
 */
export function resolveFindingActionPolicy(
  gitConfig: { postSessionQuality?: PostSessionQualityConfig | null } | null | undefined,
): FindingActionPolicy {
  const raw = gitConfig?.postSessionQuality?.findingPolicy;
  const d = DEFAULT_FINDING_ACTION_POLICY;
  if (!raw || typeof raw !== 'object') return { ...d, mediumRecurrence: { ...d.mediumRecurrence } };
  const rec = raw.mediumRecurrence && typeof raw.mediumRecurrence === 'object' ? raw.mediumRecurrence : {};
  return {
    highConfidenceThreshold: inRange(raw.highConfidenceThreshold, 0, 1) ? raw.highConfidenceThreshold : d.highConfidenceThreshold,
    mediumRecurrence: {
      count: inRange(rec.count, 1, MAX_LEDGER_AFFECTED_REFS) && Number.isInteger(rec.count) ? rec.count : d.mediumRecurrence.count,
      windowDays: inRange(rec.windowDays, 1, MAX_WINDOW_DAYS) ? rec.windowDays : d.mediumRecurrence.windowDays,
    },
  };
}

// ── Aggregation ─────────────────────────────────────────────────────────────

/** The §8 fields of one analysed finding the ledger keeps. */
export interface LedgerFindingInput {
  class: FindingClass;
  severity: FindingSeverity;
  confidence: number;
  title: string;
  summary: string;
  signature: string;
  recurrenceKey: string;
  proposedAction: FindingProposedAction;
  evidenceRefs: FindingEvidenceRef[];
}

/** One session exhibiting one finding. `ref.runId` is the idempotency key. */
export interface FindingOccurrence {
  finding: LedgerFindingInput;
  ref: FindingAffectedRef;
}

/** The aggregate columns of a `post_session_findings` row. */
export interface FindingLedgerAggregate {
  class: FindingClass;
  severity: FindingSeverity;
  confidence: number | null;
  title: string;
  summary: string | null;
  recurrenceKey: string | null;
  proposedAction: FindingProposedAction;
  occurrenceCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  affectedRefs: FindingAffectedRef[];
  evidenceRefs: FindingEvidenceRef[];
}

function mergeEvidence(newest: FindingEvidenceRef[], older: FindingEvidenceRef[]): FindingEvidenceRef[] {
  const seen = new Set<string>();
  const out: FindingEvidenceRef[] = [];
  for (const r of [...newest, ...older]) {
    const k = `${r.kind}\u0000${r.ref}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
    if (out.length >= MAX_LEDGER_EVIDENCE_REFS) break;
  }
  return out;
}

/**
 * Fold one occurrence into a finding's aggregate. Deterministic. An occurrence
 * whose run is already on the row returns the aggregate unchanged with
 * `counted: false` — reprocessing an incident never counts it twice.
 *
 * Highest severity and confidence win and never regress; the headline (title,
 * summary, class, proposed action) follows the most severe occurrence.
 */
export function aggregateFindingOccurrence(
  existing: FindingLedgerAggregate | null,
  occ: FindingOccurrence,
): { next: FindingLedgerAggregate; counted: boolean } {
  const f = occ.finding;
  const seenAt = new Date(occ.ref.seenAt);
  if (!existing) {
    return {
      counted: true,
      next: {
        class: f.class,
        severity: f.severity,
        confidence: f.confidence,
        title: f.title,
        summary: f.summary,
        recurrenceKey: f.recurrenceKey,
        proposedAction: f.proposedAction,
        occurrenceCount: 1,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
        affectedRefs: [occ.ref],
        evidenceRefs: mergeEvidence(f.evidenceRefs, []),
      },
    };
  }
  if (existing.affectedRefs.some(r => r.runId === occ.ref.runId)) return { next: existing, counted: false };

  const escalates = severityRank(f.severity) < severityRank(existing.severity);
  const headline = escalates
    ? { class: f.class, title: f.title, summary: f.summary, proposedAction: f.proposedAction }
    : { class: existing.class, title: existing.title, summary: existing.summary, proposedAction: existing.proposedAction };
  const refs = [...existing.affectedRefs, occ.ref]
    .sort((a, b) => a.seenAt.localeCompare(b.seenAt))
    .slice(-MAX_LEDGER_AFFECTED_REFS);
  return {
    counted: true,
    next: {
      ...headline,
      severity: maxSeverity(existing.severity, f.severity),
      confidence: Math.max(existing.confidence ?? 0, f.confidence),
      recurrenceKey: existing.recurrenceKey ?? f.recurrenceKey,
      occurrenceCount: existing.occurrenceCount + 1,
      firstSeenAt: seenAt < existing.firstSeenAt ? seenAt : existing.firstSeenAt,
      lastSeenAt: seenAt > existing.lastSeenAt ? seenAt : existing.lastSeenAt,
      affectedRefs: refs,
      evidenceRefs: mergeEvidence(f.evidenceRefs, existing.evidenceRefs),
    },
  };
}

/** Sessions on the row seen inside the last `windowDays`. */
export function recentOccurrences(agg: Pick<FindingLedgerAggregate, 'affectedRefs'>, windowDays: number, now: Date): number {
  const since = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  return agg.affectedRefs.filter(r => new Date(r.seenAt).getTime() >= since).length;
}

// ── Action policy ───────────────────────────────────────────────────────────

export type FindingActionTarget = 'task' | 'proposal';

export type FindingActionReason =
  | 'critical'
  | 'high_confident'
  | 'high_below_threshold'
  | 'medium_recurred'
  | 'medium_observing'
  | 'low_aggregate_only'
  | 'no_action'
  | 'already_actioned';

export interface FindingActionDecision {
  /** File the target (task or proposal) now — subject to mode and the atomic claim. */
  act: boolean;
  target: FindingActionTarget;
  reason: FindingActionReason;
  /** Critical: also surface a mission/workspace warning. */
  warn: boolean;
  /** Critical recurring on an already-filed task: append the new session to it. */
  appendToTask: boolean;
}

/** Knowledge defects become correction proposals; everything else a task. */
export function findingActionTarget(f: { class: FindingClass; proposedAction: FindingProposedAction }): FindingActionTarget {
  return f.class === 'knowledge' || f.proposedAction === 'propose_memory_correction' ? 'proposal' : 'task';
}

const ACTED: ReadonlySet<FindingActionState> = new Set(['task_filed', 'proposal_filed', 'suppressed']);

/**
 * The §9 table. Pure and mode-agnostic: `act` says what the policy wants;
 * whether a shadow run may do it, and whether this caller wins the claim, are
 * the recorder's business.
 */
export function decideFindingAction(
  agg: FindingLedgerAggregate,
  ctx: { policy: FindingActionPolicy; now: Date; actionState: FindingActionState; counted: boolean },
): FindingActionDecision {
  const target = findingActionTarget(agg);
  const decision = (act: boolean, reason: FindingActionReason): FindingActionDecision => ({
    act,
    target,
    reason,
    warn: act && agg.severity === 'critical',
    appendToTask: false,
  });

  if (agg.class === 'no_action') return decision(false, 'no_action');
  if (ACTED.has(ctx.actionState)) {
    return {
      ...decision(false, 'already_actioned'),
      appendToTask: ctx.actionState === 'task_filed' && agg.severity === 'critical' && ctx.counted,
    };
  }
  switch (agg.severity) {
    case 'critical':
      return decision(true, 'critical');
    case 'high':
      return (agg.confidence ?? 0) >= ctx.policy.highConfidenceThreshold
        ? decision(true, 'high_confident')
        : decision(false, 'high_below_threshold');
    case 'medium': {
      const { count, windowDays } = ctx.policy.mediumRecurrence;
      return recentOccurrences(agg, windowDays, ctx.now) >= count
        ? decision(true, 'medium_recurred')
        : decision(false, 'medium_observing');
    }
    default:
      return decision(false, 'low_aggregate_only');
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────

export interface FindingIdentity {
  findingId: string;
  signature: string;
  policyVersion: string;
  aggregate: FindingLedgerAggregate;
}

export const FOLLOW_UP_TITLE_PREFIX = '[post-session] ';
const MAX_SESSIONS_LISTED = 10;

const PRIORITY: Record<FindingSeverity, number> = { critical: 9, high: 7, medium: 5, low: 3 };

const CATEGORY: Record<FindingClass, 'bug' | 'research' | 'chore' | 'infra'> = {
  platform: 'bug',
  retrieval: 'research',
  knowledge: 'research',
  agent_use: 'chore',
  environment: 'infra',
  task_spec: 'chore',
  no_action: 'chore',
};

function sessionLines(agg: FindingLedgerAggregate): string[] {
  return agg.affectedRefs.slice(-MAX_SESSIONS_LISTED).reverse()
    .map(r => `- run \`${r.runId}\` · worker \`${r.workerId}\` · task ${r.taskId ? `\`${r.taskId}\`` : '(none)'} · ${r.seenAt}`);
}

function evidenceLines(refs: FindingEvidenceRef[]): string[] {
  return refs.map(r => `- ${r.kind}: \`${r.ref}\``);
}

/** One line appended to a filed task when the same critical finding recurs. */
export function occurrenceNote(ref: FindingAffectedRef, occurrenceCount: number): string {
  return `\n\n---\n_Seen again (occurrence ${occurrenceCount}): run \`${ref.runId}\` · worker \`${ref.workerId}\` · task ${ref.taskId ? `\`${ref.taskId}\`` : '(none)'} · ${ref.seenAt}._`;
}

export interface FollowUpTaskSpec {
  title: string;
  description: string;
  priority: number;
  category: (typeof CATEGORY)[FindingClass];
  kind: 'engineering' | 'research';
  context: { postSessionFinding: { findingId: string; signature: string; policyVersion: string; class: FindingClass; severity: FindingSeverity } };
}

export function buildFollowUpTask(id: FindingIdentity): FollowUpTaskSpec {
  const a = id.aggregate;
  const description = [
    `The post-session quality loop found this in completed agent work and the action policy promoted it (${a.severity}, confidence ${a.confidence ?? 'unknown'}).`,
    '',
    `**Finding:** ${a.title}`,
    a.summary ? `\n${a.summary}` : '',
    '',
    `- Class: ${a.class} · proposed action: ${a.proposedAction}`,
    `- Occurrences: ${a.occurrenceCount} (first ${a.firstSeenAt.toISOString()}, last ${a.lastSeenAt.toISOString()})`,
    `- Ledger: finding \`${id.findingId}\` · signature \`${id.signature}\` · policy ${id.policyVersion}`,
    '',
    '## Sessions',
    ...sessionLines(a),
    '',
    '## Evidence',
    ...evidenceLines(a.evidenceRefs),
    '',
    'Confirm the root cause from the evidence before changing anything; the finding is an analyser judgement, not a verified defect.',
  ].join('\n');
  return {
    title: `${FOLLOW_UP_TITLE_PREFIX}${a.title}`,
    description,
    priority: PRIORITY[a.severity],
    category: CATEGORY[a.class],
    kind: a.proposedAction === 'investigate_retrieval' ? 'research' : 'engineering',
    context: {
      postSessionFinding: {
        findingId: id.findingId,
        signature: id.signature,
        policyVersion: id.policyVersion,
        class: a.class,
        severity: a.severity,
      },
    },
  };
}

export interface CorrectionProposalSpec {
  /** Unique per workspace — the artifact insert is itself the dedupe. */
  key: string;
  type: 'recommendation';
  title: string;
  content: string;
  metadata: {
    kind: 'memory_correction_proposal';
    status: 'proposed';
    findingId: string;
    signature: string;
    policyVersion: string;
    severity: FindingSeverity;
    memorySourceIds: string[];
    contradictingEvidence: FindingEvidenceRef[];
    sessions: Array<{ runId: string; workerId: string; taskId: string | null }>;
    appliedAt: null;
  };
}

/** Evidence kinds that are pointers to the session itself, not to the contradiction. */
const SESSION_REF_KINDS = new Set(['post_session_run', 'worker', 'task', 'transcript']);

export function correctionProposalKey(policyVersion: string, signature: string): string {
  return `post-session-correction:${policyVersion}:${signature}`;
}

/**
 * §9 knowledge findings: an auditable proposal naming the memory, the
 * contradicting shipped-state evidence, the suggested supersession and the
 * sessions that exposed it. It is a proposal only — applying it is a later,
 * explicit action. The claim itself is referenced by memory id, not copied.
 */
export function buildCorrectionProposal(id: FindingIdentity): CorrectionProposalSpec {
  const a = id.aggregate;
  const memorySourceIds = [...new Set(a.evidenceRefs.filter(r => r.kind === 'memory').map(r => r.ref))];
  const contradictingEvidence = a.evidenceRefs.filter(r => r.kind !== 'memory' && !SESSION_REF_KINDS.has(r.kind));
  const sessions = a.affectedRefs.slice(-MAX_SESSIONS_LISTED).map(r => ({ runId: r.runId, workerId: r.workerId, taskId: r.taskId }));
  const content = [
    `# Memory correction proposal`,
    '',
    `**Status:** proposed — this has not been applied. Nothing in the post-session loop writes memory; a person or an explicit follow-up action decides.`,
    '',
    `**Finding:** ${a.title} (${a.severity}, confidence ${a.confidence ?? 'unknown'}, seen ${a.occurrenceCount}×)`,
    a.summary ? `\n${a.summary}` : '',
    '',
    '## Memory believed wrong or stale',
    ...(memorySourceIds.length ? memorySourceIds.map(m => `- \`${m}\` — read the claim with recall id=${m}`) : ['- (source id not recorded on the finding)']),
    '',
    '## Contradicting shipped-state evidence',
    ...(contradictingEvidence.length ? evidenceLines(contradictingEvidence) : ['- (none recorded beyond the session refs below)']),
    '',
    '## Suggested correction',
    memorySourceIds.length
      ? `Verify the evidence above, then write a corrected memory that supersedes ${memorySourceIds.map(m => `\`${m}\``).join(', ')} (learn with supersedes), or update it in place if only a detail is wrong.`
      : 'Verify the evidence above and identify the stale memory before writing a correction that supersedes it.',
    '',
    '## Sessions that exposed it',
    ...sessionLines(a),
    '',
    `Ledger: finding \`${id.findingId}\` · signature \`${id.signature}\` · policy ${id.policyVersion}`,
  ].join('\n');
  return {
    key: correctionProposalKey(id.policyVersion, id.signature),
    type: 'recommendation',
    title: `Memory correction proposal: ${a.title}`,
    content,
    metadata: {
      kind: 'memory_correction_proposal',
      status: 'proposed',
      findingId: id.findingId,
      signature: id.signature,
      policyVersion: id.policyVersion,
      severity: a.severity,
      memorySourceIds,
      contradictingEvidence,
      sessions,
      appliedAt: null,
    },
  };
}
