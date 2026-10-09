/**
 * Failure Pattern Sentinel — the deterministic rule engine.
 *
 * Pure: bounded structured facts in, incident candidates out. No DB, no clock
 * (`facts.now` is the clock), no model. The same facts in any order produce the
 * same candidates, byte for byte, so a re-run sweep is a no-op downstream.
 *
 * The facts are read from telemetry that already exists — worker failure
 * signatures (`normalizeErrorSignature`, the same normalizer
 * `get_failure_analytics` and `gate_events.reason` use), `gate_events` rows,
 * retry lineage (`ciRetryPrNumber` / `reviewerRetryPrNumber` /
 * `conflictRetryPrNumber` + `context.rootTaskId`). This module never re-derives
 * a signature; collectors pass the stored one through. Persisting a candidate
 * is `failure-incident-store.ts`; deciding whether to page is not here at all.
 *
 * Each candidate carries:
 *  - `signature` — stable identity of the PATTERN, never of an occurrence:
 *    `<rule>|ws=<workspaceId|none>|<discriminators>`. Occurrence ids, counts
 *    and timestamps never enter it, so the 2nd and the 200th occurrence land on
 *    the same incident row. Bump FAILURE_PATTERN_DETECTOR_VERSION instead of
 *    changing a signature shape in place.
 *  - `occurrences` — every underlying event (pointer refs, bounded by the
 *    fact caps) so the store can count each exactly once across sweeps.
 *  - `evidence` — the newest MAX_EVIDENCE_REFS of those, for display.
 *  - `severity` — the deterministic MINIMUM. A later policy layer may raise
 *    it, never lower it.
 */
import type {
  FailureIncidentAffectedRefs,
  FailureIncidentEvidenceRef,
  FailureIncidentRule,
  FailureIncidentSeverity,
} from '@buildd/shared';
import { toFrictionSignature } from '@buildd/core/failure-friction-signature';
import { gateFrictionSignature } from '@buildd/core/gate-friction-signature';

/** Part of the incident key. Bump when a rule's signature shape or meaning changes. */
export const FAILURE_PATTERN_DETECTOR_VERSION = 'fps-v1';

export const MAX_EVIDENCE_REFS = 20;
export const MAX_AFFECTED_REFS = 25;
/** Per fact kind. Collectors should already bound their queries; this is the backstop. */
export const MAX_FACTS_PER_KIND = 2000;

export const DEFAULT_SENTINEL_THRESHOLDS = {
  /** Distinct retry children for one (PR, kind, stage, iteration) that make it critical. */
  retryForkCriticalChildren: 3,
  /** Distinct PRs in one lineage that make it high even if not open together. */
  lineageHighPrs: 3,
  repeatedFailureWindowMinutes: 60,
  repeatedFailureMinTasks: 3,
  repeatedFailureHighTasks: 5,
  repeatedFailureCriticalTasks: 10,
  strandedGateMinTasks: 3,
  strandedGateHighTasks: 10,
  pathOverlapStallMinutes: 120,
  pathOverlapHighTasks: 3,
  providerMismatchMinWorkers: 2,
  providerMismatchHighWorkers: 5,
  spikeMinSample: 10,
  spikeMinRecentRate: 0.25,
  /** Recent rate must be at least this multiple of the baseline rate… */
  spikeMinRatio: 2,
  /** …and at least this many points above it. */
  spikeMinDelta: 0.15,
  spikeCriticalRate: 0.5,
  spikeCriticalFailed: 10,
  outputUnmetWindowMinutes: 360,
  outputUnmetMinTasks: 3,
  outputUnmetHighTasks: 8,
} as const;

export type SentinelThresholds = { [K in keyof typeof DEFAULT_SENTINEL_THRESHOLDS]: number };

// ── Facts ───────────────────────────────────────────────────────────────────

export type RetryKind = 'ci' | 'reviewer' | 'conflict';

/** One retry/fix child task (a row with one of the three retry PR columns set). */
export interface RetryChildFact {
  taskId: string;
  parentTaskId: string | null;
  /** The PR being fixed — the retry column's value. */
  subjectPrNumber: number;
  kind: RetryKind;
  /** Sub-stage within the kind when one exists (e.g. head SHA, review round); null when none. */
  stage: string | null;
  /** `context.iteration` / `context.conflictIteration`. */
  iteration: number | null;
  createdAt: string;
  /** A PR this child opened of its own (could not reuse the branch). */
  openedPrNumber?: number | null;
}

/** One logical retry lineage, rooted at `context.rootTaskId` (see attempt-lineage.ts). */
export interface RetryLineageFact {
  rootTaskId: string;
  taskIds: string[];
  prs: Array<{ number: number; state: 'open' | 'merged' | 'closed'; at: string }>;
}

/** One failed worker session. `signature` is already normalized — pass it through. */
export interface WorkerFailureFact {
  workerId: string;
  taskId: string | null;
  /** Lineage root; falls back to taskId. Retries of one task are not "unrelated". */
  rootTaskId?: string | null;
  signature: string;
  exitCause: string | null;
  /** For output_unmet: where in the lifecycle the gate refused (e.g. 'complete_task'). */
  lifecycleBoundary?: string | null;
  occurredAt: string;
  /** worker_terminal_records.id when the collector has it — preferred evidence pointer. */
  terminalRecordId?: string | null;
}

/** One gate_events row, as stored. */
export interface GateEventFact {
  id: string;
  gate: string;
  outcome: string;
  /** Already normalized on write. */
  reason: string;
  taskId: string | null;
  occurredAt: string;
}

/** A task the claim loop keeps deferring behind a path overlap. */
export interface PathOverlapDeferralFact {
  taskId: string;
  blockingPrNumber: number | null;
  firstDeferredAt: string;
  lastDeferredAt: string;
  /** Last sign the task or its blocker moved (claim, blocker merge/close…); null for none. */
  lastProgressAt: string | null;
}

/** A failure or provider wall, and who it was charged to. */
export interface ProviderAttributionFact {
  workerId: string;
  taskId: string | null;
  /** Provider the session actually ran on. */
  executedProvider: string;
  /** Provider the failure / wall / budget was attributed to. */
  attributedProvider: string;
  occurredAt: string;
}

export interface FailureRateFact {
  recent: { failed: number; total: number };
  baseline: { failed: number; total: number };
  /** The recent window's failed workers, for evidence and occurrence counting. */
  recentFailures?: Array<{ workerId: string; at: string }>;
}

export interface SentinelFacts {
  workspaceId: string | null;
  /** ISO. The engine's only clock. */
  now: string;
  retryChildren?: RetryChildFact[];
  lineages?: RetryLineageFact[];
  workerFailures?: WorkerFailureFact[];
  gateEvents?: GateEventFact[];
  pathOverlapDeferrals?: PathOverlapDeferralFact[];
  providerAttributions?: ProviderAttributionFact[];
  failureRate?: FailureRateFact | null;
}

// ── Candidates ──────────────────────────────────────────────────────────────

export interface IncidentCandidate {
  rule: FailureIncidentRule;
  /** Machine-readable `<family>.<reason>`; stable per rule. */
  reasonCode: string;
  signature: string;
  detectorVersion: string;
  workspaceId: string | null;
  /** Deterministic minimum severity. */
  severity: FailureIncidentSeverity;
  title: string;
  /** Every occurrence behind this candidate, newest first (bounded by the fact caps). */
  occurrences: FailureIncidentEvidenceRef[];
  /** Newest MAX_EVIDENCE_REFS occurrences. */
  evidence: FailureIncidentEvidenceRef[];
  affected: FailureIncidentAffectedRefs;
  impact: Record<string, number>;
  firstObservedAt: string;
  lastObservedAt: string;
}

const SEVERITY_RANK: Record<FailureIncidentSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function severityRank(s: FailureIncidentSeverity): number {
  return SEVERITY_RANK[s] ?? 0;
}

export function maxSeverity(a: FailureIncidentSeverity, b: FailureIncidentSeverity): FailureIncidentSeverity {
  return severityRank(b) > severityRank(a) ? b : a;
}

/** Newest first, ties by kind then id; one ref per (kind, id), keeping its newest `at`. */
export function boundEvidenceRefs(
  refs: ReadonlyArray<FailureIncidentEvidenceRef>,
  cap: number = MAX_EVIDENCE_REFS,
): FailureIncidentEvidenceRef[] {
  return sortEvidence(dedupeEvidence(refs)).slice(0, cap);
}

function dedupeEvidence(refs: ReadonlyArray<FailureIncidentEvidenceRef>): FailureIncidentEvidenceRef[] {
  const byKey = new Map<string, FailureIncidentEvidenceRef>();
  for (const r of refs) {
    const k = evidenceKey(r);
    const prev = byKey.get(k);
    if (!prev || r.at > prev.at) byKey.set(k, r);
  }
  return [...byKey.values()];
}

function sortEvidence(refs: FailureIncidentEvidenceRef[]): FailureIncidentEvidenceRef[] {
  return refs.sort((a, b) =>
    a.at < b.at ? 1 : a.at > b.at ? -1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

export function evidenceKey(r: Pick<FailureIncidentEvidenceRef, 'kind' | 'id'>): string {
  return `${r.kind}:${r.id}`;
}

/** Ordered newest-first unique values, capped. Input must already be newest-first. */
function boundedUnique<T>(values: Iterable<T | null | undefined>, cap: number = MAX_AFFECTED_REFS): T[] {
  const out: T[] = [];
  const seen = new Set<T>();
  for (const v of values) {
    if (v === null || v === undefined || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= cap) break;
  }
  return out;
}

function wsPart(workspaceId: string | null): string {
  return `ws=${workspaceId ?? 'none'}`;
}

/** Signature segments must not smuggle the separator in. */
function seg(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-';
  return String(value).replace(/[|\s]+/g, '_');
}

/** The exact identity of a retry fork. Child ids, count and timing never enter it. */
export function retryForkSignature(
  workspaceId: string | null,
  key: { subjectPrNumber: number; kind: RetryKind; stage: string | null; iteration: number | null },
): string {
  return [
    'retry_fork',
    wsPart(workspaceId),
    `pr=${seg(key.subjectPrNumber)}`,
    `kind=${seg(key.kind)}`,
    `stage=${seg(key.stage)}`,
    `iter=${seg(key.iteration)}`,
  ].join('|');
}

/** Newest first, ties broken by `id` so input order never leaks into the output. */
function newestFirst<T>(rows: ReadonlyArray<T>, at: (r: T) => string, id: (r: T) => string): T[] {
  return [...rows]
    .sort((a, b) => {
      const ta = at(a), tb = at(b);
      if (ta !== tb) return ta < tb ? 1 : -1;
      const ia = id(a), ib = id(b);
      return ia < ib ? -1 : ia > ib ? 1 : 0;
    })
    .slice(0, MAX_FACTS_PER_KIND);
}

function minutesBefore(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) - minutes * 60_000).toISOString();
}

function minutesBetween(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / 60_000;
}

function pct(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
}

function buildCandidate(
  facts: SentinelFacts,
  c: Omit<IncidentCandidate, 'detectorVersion' | 'workspaceId' | 'evidence' | 'firstObservedAt' | 'lastObservedAt' | 'occurrences'> & {
    occurrences: FailureIncidentEvidenceRef[];
  },
): IncidentCandidate {
  const occurrences = sortEvidence(dedupeEvidence(c.occurrences));
  const ats = occurrences.map(o => o.at);
  return {
    ...c,
    detectorVersion: FAILURE_PATTERN_DETECTOR_VERSION,
    workspaceId: facts.workspaceId,
    occurrences,
    evidence: occurrences.slice(0, MAX_EVIDENCE_REFS),
    firstObservedAt: ats.length ? ats[ats.length - 1] : facts.now,
    lastObservedAt: ats.length ? ats[0] : facts.now,
  };
}

/** Group rows by key, preserving the (newest-first) input order within a group. */
function groupBy<T>(rows: ReadonlyArray<T>, key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

// ── Rules ───────────────────────────────────────────────────────────────────

function ruleRetryFork(facts: SentinelFacts, t: SentinelThresholds): IncidentCandidate[] {
  const rows = newestFirst(facts.retryChildren ?? [], r => r.createdAt, r => r.taskId);
  const groups = groupBy(rows, r => retryForkSignature(facts.workspaceId, r));
  const out: IncidentCandidate[] = [];
  for (const [signature, group] of groups) {
    const children = boundedUnique(group.map(r => r.taskId), Number.MAX_SAFE_INTEGER);
    if (children.length < 2) continue;
    const head = group[0];
    const openedPrs = boundedUnique(group.map(r => r.openedPrNumber), Number.MAX_SAFE_INTEGER);
    const severity: FailureIncidentSeverity =
      children.length >= t.retryForkCriticalChildren || openedPrs.length >= 2 ? 'critical' : 'high';
    out.push(buildCandidate(facts, {
      rule: 'retry_fork',
      reasonCode: 'retry_fork.duplicate_children',
      signature,
      severity,
      title: `${children.length} parallel ${head.kind} retry children for PR #${head.subjectPrNumber}` +
        `${head.iteration !== null ? ` (iteration ${head.iteration})` : ''}`,
      occurrences: group.map(r => ({ kind: 'task', id: r.taskId, at: r.createdAt })),
      affected: {
        taskIds: boundedUnique([...group.map(r => r.taskId), ...group.map(r => r.parentTaskId)]),
        workerIds: [],
        prNumbers: boundedUnique([head.subjectPrNumber, ...openedPrs]),
      },
      impact: { children: children.length, openedPrs: openedPrs.length },
    }));
  }
  return out;
}

function ruleLineageMultiPr(facts: SentinelFacts, t: SentinelThresholds): IncidentCandidate[] {
  const out: IncidentCandidate[] = [];
  const lineages = [...(facts.lineages ?? [])]
    .sort((a, b) => (a.rootTaskId < b.rootTaskId ? -1 : a.rootTaskId > b.rootTaskId ? 1 : 0))
    .slice(0, MAX_FACTS_PER_KIND);
  for (const l of lineages) {
    const prs = newestFirst(l.prs, p => p.at, p => String(p.number).padStart(12, '0'));
    const distinct = new Map<number, (typeof prs)[number]>();
    for (const p of prs) if (!distinct.has(p.number)) distinct.set(p.number, p);
    if (distinct.size < 2) continue;
    const open = [...distinct.values()].filter(p => p.state === 'open').length;
    const severity: FailureIncidentSeverity = open >= 2 || distinct.size >= t.lineageHighPrs ? 'high' : 'medium';
    out.push(buildCandidate(facts, {
      rule: 'lineage_multi_pr',
      reasonCode: 'lineage.multiple_prs',
      signature: ['lineage_multi_pr', wsPart(facts.workspaceId), `root=${seg(l.rootTaskId)}`].join('|'),
      severity,
      title: `${distinct.size} PRs in one retry lineage${open >= 2 ? ` (${open} open at once)` : ''}`,
      occurrences: [...distinct.values()].map(p => ({ kind: 'pr', id: String(p.number), at: p.at, note: p.state })),
      affected: {
        taskIds: boundedUnique([l.rootTaskId, ...[...l.taskIds].sort()]),
        workerIds: [],
        prNumbers: boundedUnique([...distinct.keys()]),
      },
      impact: { prs: distinct.size, openPrs: open, tasks: new Set(l.taskIds).size },
    }));
  }
  return out;
}

/** Exits that are not failures of the work (mirrors failure-analytics' bookkeeping set). */
const NON_FAILURE_EXITS = new Set(['needs_input', 'task_cancelled', 'reassigned', 'never_started']);

function failureRef(f: WorkerFailureFact): FailureIncidentEvidenceRef {
  return f.terminalRecordId
    ? { kind: 'terminal_record', id: f.terminalRecordId, at: f.occurredAt }
    : { kind: 'worker', id: f.workerId, at: f.occurredAt };
}

const lineageOf = (f: WorkerFailureFact) => f.rootTaskId ?? f.taskId ?? `worker:${f.workerId}`;

function ruleRepeatedFailure(facts: SentinelFacts, t: SentinelThresholds): IncidentCandidate[] {
  const since = minutesBefore(facts.now, t.repeatedFailureWindowMinutes);
  const rows = newestFirst(facts.workerFailures ?? [], f => f.occurredAt, f => f.workerId).filter(f =>
    f.occurredAt >= since &&
    f.occurredAt <= facts.now &&
    !!f.signature &&
    f.exitCause !== 'output_unmet' &&
    !NON_FAILURE_EXITS.has(f.exitCause ?? ''),
  );
  const out: IncidentCandidate[] = [];
  for (const [signature, group] of groupBy(rows, f => f.signature)) {
    const lineages = new Set(group.map(lineageOf));
    if (lineages.size < t.repeatedFailureMinTasks) continue;
    const severity: FailureIncidentSeverity =
      lineages.size >= t.repeatedFailureCriticalTasks ? 'critical'
        : lineages.size >= t.repeatedFailureHighTasks ? 'high' : 'medium';
    out.push(buildCandidate(facts, {
      rule: 'repeated_failure',
      reasonCode: 'failure.repeated_across_tasks',
      // toFrictionSignature: the same key a friction report for this failure
      // carries, so the fix-task dedupe downstream lines up with the incident.
      signature: ['repeated_failure', wsPart(facts.workspaceId), toFrictionSignature(signature)].join('|'),
      severity,
      title: `Same failure across ${lineages.size} unrelated tasks: ${signature.slice(0, 120)}`,
      occurrences: group.map(failureRef),
      affected: {
        taskIds: boundedUnique(group.map(f => f.taskId)),
        workerIds: boundedUnique(group.map(f => f.workerId)),
        prNumbers: [],
      },
      impact: { failures: group.length, distinctTasks: lineages.size, windowMinutes: t.repeatedFailureWindowMinutes },
    }));
  }
  return out;
}

function ruleStrandedGate(facts: SentinelFacts, t: SentinelThresholds): IncidentCandidate[] {
  const rows = newestFirst(facts.gateEvents ?? [], g => g.occurredAt, g => g.id).filter(g => g.outcome === 'stranded');
  const out: IncidentCandidate[] = [];
  for (const group of groupBy(rows, g => `${g.gate}\u0000${g.reason}`).values()) {
    const tasks = new Set(group.map(g => g.taskId ?? `event:${g.id}`));
    if (tasks.size < t.strandedGateMinTasks) continue;
    const { gate, reason } = group[0];
    out.push(buildCandidate(facts, {
      rule: 'stranded_gate',
      reasonCode: 'gate.stranded_repeated',
      signature: ['stranded_gate', wsPart(facts.workspaceId), `gate=${seg(gate)}`, gateFrictionSignature(gate, reason)].join('|'),
      severity: tasks.size >= t.strandedGateHighTasks ? 'high' : 'medium',
      title: `${tasks.size} tasks stranded at ${gate}: ${reason.slice(0, 120)}`,
      occurrences: group.map(g => ({ kind: 'gate_event', id: g.id, at: g.occurredAt })),
      affected: { taskIds: boundedUnique(group.map(g => g.taskId)), workerIds: [], prNumbers: [] },
      impact: { strandedEvents: group.length, distinctTasks: tasks.size },
    }));
  }
  return out;
}

function rulePathOverlapStall(facts: SentinelFacts, t: SentinelThresholds): IncidentCandidate[] {
  const stalled = (facts.pathOverlapDeferrals ?? [])
    .filter(d =>
      minutesBetween(d.firstDeferredAt, d.lastDeferredAt) >= t.pathOverlapStallMinutes &&
      (d.lastProgressAt === null || d.lastProgressAt < d.firstDeferredAt),
    )
    // The occurrence instant is when the deferral crossed the threshold — a
    // fixed point per deferral episode, so a re-sweep does not recount it.
    .map(d => ({ d, at: new Date(Date.parse(d.firstDeferredAt) + t.pathOverlapStallMinutes * 60_000).toISOString() }));
  const rows = newestFirst(stalled, s => s.at, s => s.d.taskId);
  const out: IncidentCandidate[] = [];
  for (const group of groupBy(rows, s => (s.d.blockingPrNumber === null ? 'unknown' : `pr:${s.d.blockingPrNumber}`)).values()) {
    const blocker = group[0].d.blockingPrNumber;
    const tasks = new Set(group.map(s => s.d.taskId));
    const longest = Math.max(...group.map(s => minutesBetween(s.d.firstDeferredAt, s.d.lastDeferredAt)));
    const severity: FailureIncidentSeverity =
      tasks.size >= t.pathOverlapHighTasks || longest >= t.pathOverlapStallMinutes * 4 ? 'high' : 'medium';
    out.push(buildCandidate(facts, {
      rule: 'path_overlap_stall',
      reasonCode: 'path_overlap.no_progress',
      signature: ['path_overlap_stall', wsPart(facts.workspaceId), `blocker=${blocker === null ? 'unknown' : `pr:${blocker}`}`].join('|'),
      severity,
      title: `${tasks.size} task(s) deferred on path overlap ${blocker === null ? '' : `behind PR #${blocker} `}with no progress`,
      occurrences: group.map(s => ({ kind: 'task', id: s.d.taskId, at: s.at })),
      affected: {
        taskIds: boundedUnique(group.map(s => s.d.taskId)),
        workerIds: [],
        prNumbers: blocker === null ? [] : [blocker],
      },
      impact: { stalledTasks: tasks.size, longestStallMinutes: Math.round(longest) },
    }));
  }
  return out;
}

function ruleProviderMismatch(facts: SentinelFacts, t: SentinelThresholds): IncidentCandidate[] {
  const rows = newestFirst(facts.providerAttributions ?? [], r => r.occurredAt, r => r.workerId)
    .filter(r => r.executedProvider && r.attributedProvider && r.executedProvider !== r.attributedProvider);
  const out: IncidentCandidate[] = [];
  for (const group of groupBy(rows, r => `${r.executedProvider}\u0000${r.attributedProvider}`).values()) {
    const workers = new Set(group.map(r => r.workerId));
    if (workers.size < t.providerMismatchMinWorkers) continue;
    const { executedProvider: ran, attributedProvider: charged } = group[0];
    out.push(buildCandidate(facts, {
      rule: 'provider_attribution_mismatch',
      reasonCode: 'provider.attribution_mismatch',
      signature: ['provider_attribution_mismatch', wsPart(facts.workspaceId), `ran=${seg(ran)}`, `charged=${seg(charged)}`].join('|'),
      severity: workers.size >= t.providerMismatchHighWorkers ? 'high' : 'medium',
      title: `${workers.size} failures on ${ran} charged to ${charged}`,
      occurrences: group.map(r => ({ kind: 'worker', id: r.workerId, at: r.occurredAt })),
      affected: {
        taskIds: boundedUnique(group.map(r => r.taskId)),
        workerIds: boundedUnique(group.map(r => r.workerId)),
        prNumbers: [],
      },
      impact: { mismatchedWorkers: workers.size },
    }));
  }
  return out;
}

function ruleFailureRateSpike(facts: SentinelFacts, t: SentinelThresholds): IncidentCandidate[] {
  const fr = facts.failureRate;
  if (!fr || fr.recent.total < t.spikeMinSample) return [];
  const recentRate = fr.recent.failed / fr.recent.total;
  const baselineRate = fr.baseline.total > 0 ? fr.baseline.failed / fr.baseline.total : 0;
  const spiking =
    recentRate >= t.spikeMinRecentRate &&
    recentRate >= baselineRate * t.spikeMinRatio &&
    recentRate - baselineRate >= t.spikeMinDelta;
  if (!spiking) return [];
  const failures = newestFirst(fr.recentFailures ?? [], f => f.at, f => f.workerId);
  return [buildCandidate(facts, {
    rule: 'failure_rate_spike',
    reasonCode: 'failure_rate.spike',
    signature: ['failure_rate_spike', wsPart(facts.workspaceId)].join('|'),
    severity: recentRate >= t.spikeCriticalRate && fr.recent.failed >= t.spikeCriticalFailed ? 'critical' : 'high',
    title: `Failure rate ${pct(fr.recent.failed, fr.recent.total)}% vs ${pct(fr.baseline.failed, fr.baseline.total)}% baseline`,
    occurrences: failures.map(f => ({ kind: 'worker', id: f.workerId, at: f.at })),
    affected: { taskIds: [], workerIds: boundedUnique(failures.map(f => f.workerId)), prNumbers: [] },
    impact: {
      recentFailed: fr.recent.failed,
      recentTotal: fr.recent.total,
      recentRatePct: pct(fr.recent.failed, fr.recent.total),
      baselineRatePct: pct(fr.baseline.failed, fr.baseline.total),
    },
  })];
}

function ruleOutputUnmetBoundary(facts: SentinelFacts, t: SentinelThresholds): IncidentCandidate[] {
  const since = minutesBefore(facts.now, t.outputUnmetWindowMinutes);
  const rows = newestFirst(facts.workerFailures ?? [], f => f.occurredAt, f => f.workerId)
    .filter(f => f.exitCause === 'output_unmet' && f.occurredAt >= since && f.occurredAt <= facts.now);
  const out: IncidentCandidate[] = [];
  for (const [boundary, group] of groupBy(rows, f => f.lifecycleBoundary || 'unknown')) {
    const lineages = new Set(group.map(lineageOf));
    if (lineages.size < t.outputUnmetMinTasks) continue;
    out.push(buildCandidate(facts, {
      rule: 'output_unmet_boundary',
      reasonCode: 'output_unmet.repeated_boundary',
      signature: ['output_unmet_boundary', wsPart(facts.workspaceId), `boundary=${seg(boundary)}`].join('|'),
      severity: lineages.size >= t.outputUnmetHighTasks ? 'high' : 'medium',
      title: `${lineages.size} tasks ended output-unmet at ${boundary}`,
      occurrences: group.map(failureRef),
      affected: {
        taskIds: boundedUnique(group.map(f => f.taskId)),
        workerIds: boundedUnique(group.map(f => f.workerId)),
        prNumbers: [],
      },
      impact: { failures: group.length, distinctTasks: lineages.size, windowMinutes: t.outputUnmetWindowMinutes },
    }));
  }
  return out;
}

const RULES = [
  ruleRetryFork,
  ruleLineageMultiPr,
  ruleRepeatedFailure,
  ruleStrandedGate,
  rulePathOverlapStall,
  ruleProviderMismatch,
  ruleFailureRateSpike,
  ruleOutputUnmetBoundary,
];

/**
 * Run every rule over one workspace's facts. Output is sorted by signature so
 * it is identical for identical facts regardless of input order.
 */
export function detectFailurePatterns(
  facts: SentinelFacts,
  thresholds: Partial<SentinelThresholds> = {},
): IncidentCandidate[] {
  const t: SentinelThresholds = { ...DEFAULT_SENTINEL_THRESHOLDS, ...thresholds };
  return RULES.flatMap(rule => rule(facts, t)).sort((a, b) =>
    a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0,
  );
}
