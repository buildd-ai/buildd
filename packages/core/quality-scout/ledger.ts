/**
 * Quality Scout run / probe / finding ledger (artifact
 * workspace-quality-scout-spec §3, §6, §9–§12).
 *
 * Built on the shared verification substrate (`../verification-check`): a
 * selected probe becomes a `VerificationCheck` on the candidate SHA, and
 * `runVerificationCheck` owns the order capability → evidence → executor. So a
 * probe whose capability is missing is `unsupported` and one whose evidence is
 * short is `inconclusive` — by construction, never `pass`. A selected probe
 * that never ran is finalized as `inconclusive` (`not_executed`), not dropped.
 *
 * What this file adds is Scout policy only:
 *  - a run records the exact ref + SHA it exercised and the prior run it is
 *    compared against, so staleness is a SHA comparison, not a guess;
 *  - findings dedupe on the substrate signature per workspace: a recurrence
 *    updates the existing row (count, last-seen SHA) instead of adding one;
 *    only `fail` writes, only a `pass` of the same check resolves;
 *  - mode is off | shadow | propose. Nothing here blocks a merge or release.
 *
 * Pure functions first; the DB-backed store is at the bottom and every write
 * is injectable, the way `decision-ledger.ts` is.
 */

import { and, desc, eq, ne, sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../db/client';
import { qualityScoutFindings, qualityScoutProbes, qualityScoutRuns } from '../db/schema';
import {
  maxSeverity,
  summarizeVerificationResults,
  verificationSignature,
  VERIFICATION_SEVERITIES,
  type EvidenceRequirement,
  type VerificationResult,
  type VerificationSeverity,
} from '../verification-check';
import {
  DEFAULT_SCOUT_MAX_PROBES,
  MAX_SCOUT_DISMISS_REASON,
  MAX_SCOUT_MAX_PROBES,
  SCOUT_COSTS,
  SCOUT_FLAVOR,
  SCOUT_MODES,
  SCOUT_POLICY_VERSION,
  SCOUT_PROBE_FAMILIES,
  SCOUT_RUN_TRIGGERS,
  type ScoutBudget,
  type ScoutCost,
  type ScoutFinding,
  type ScoutHostExpiryReason,
  type ScoutMode,
  type ScoutProbeFamily,
  type ScoutProbeRecord,
  type ScoutProbeSelection,
  type ScoutReproducibility,
  type ScoutRun,
  type ScoutRunParking,
  type ScoutRunMetrics,
  type ScoutRunTotals,
  type ScoutRunTrigger,
  type ScoutSourceSignal,
} from './types';

// The probe-as-check half is pure and lives apart from the DB stores below, so
// a runner can execute probes without this module's database graph.
import { buildScoutProbeCheck, executeScoutProbe, SCOUT_CHECK_VERSION, scoutCheckId, scoutExecutionCheckId } from './probe-check';
export { buildScoutProbeCheck, executeScoutProbe, SCOUT_CHECK_VERSION, scoutCheckId, scoutExecutionCheckId };

const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_ERROR_CHARS = 500;
const MAX_REF_CHARS = 255;
/** Version of the check a probe becomes. Bump if a probe's id stops meaning the same invariant. */

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

// ── Mode ────────────────────────────────────────────────────────────────────

/**
 * `gitConfig.qualityScout` → mode. Absent config or no `mode`: `off` — Scout
 * spends a budget, so it is opt-in. A present but unrecognised value means the
 * owner meant to turn it on: `shadow`, which records and never files.
 */
export function resolveScoutMode(raw: unknown): ScoutMode {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'off';
  const mode = (raw as { mode?: unknown }).mode;
  if (mode === undefined || mode === null) return 'off';
  return (SCOUT_MODES as readonly unknown[]).includes(mode) ? (mode as ScoutMode) : 'shadow';
}

// ── Run ─────────────────────────────────────────────────────────────────────

export interface StartScoutRunInput {
  id?: string;
  workspaceId: string;
  missionId?: string | null;
  trigger: ScoutRunTrigger;
  mode: ScoutMode;
  candidate: { ref: string; sha: string };
  prior?: { runId: string; sha: string } | null;
  budget?: { maxProbes?: number; maxCostUsd?: number | null };
  now: Date;
}

export type StartScoutRunResult =
  | { ok: true; run: ScoutRun }
  | { ok: false; reason: 'mode_off' | 'invalid_sha' | 'invalid_ref' | 'invalid_trigger' };

export function clampScoutBudget(b: StartScoutRunInput['budget']): ScoutBudget {
  const raw = b?.maxProbes;
  const maxProbes = typeof raw === 'number' && Number.isFinite(raw)
    ? Math.min(Math.max(Math.floor(raw), 1), MAX_SCOUT_MAX_PROBES)
    : DEFAULT_SCOUT_MAX_PROBES;
  const cost = b?.maxCostUsd;
  return { maxProbes, maxCostUsd: typeof cost === 'number' && Number.isFinite(cost) && cost > 0 ? cost : null };
}

function normalizeSha(sha: unknown): string | null {
  if (typeof sha !== 'string') return null;
  const s = sha.trim().toLowerCase();
  return SHA_RE.test(s) ? s : null;
}

/** Open a run. Refuses without a full SHA: a run that cannot say what it exercised cannot go stale. */
export function startScoutRun(input: StartScoutRunInput): StartScoutRunResult {
  if (input.mode === 'off') return { ok: false, reason: 'mode_off' };
  if (!(SCOUT_RUN_TRIGGERS as readonly string[]).includes(input.trigger)) return { ok: false, reason: 'invalid_trigger' };
  const sha = normalizeSha(input.candidate?.sha);
  if (!sha) return { ok: false, reason: 'invalid_sha' };
  const ref = typeof input.candidate.ref === 'string' ? input.candidate.ref.trim() : '';
  if (!ref) return { ok: false, reason: 'invalid_ref' };
  const priorSha = input.prior ? normalizeSha(input.prior.sha) : null;
  return {
    ok: true,
    run: {
      id: input.id ?? randomUUID(),
      workspaceId: input.workspaceId,
      missionId: input.missionId ?? null,
      trigger: input.trigger,
      mode: input.mode,
      status: 'running',
      candidate: { ref: clip(ref, MAX_REF_CHARS), sha },
      prior: input.prior && priorSha ? { runId: input.prior.runId, sha: priorSha } : null,
      budget: clampScoutBudget(input.budget),
      policyVersion: SCOUT_POLICY_VERSION,
      startedAt: input.now.toISOString(),
      completedAt: null,
      error: null,
    },
  };
}

/**
 * Has newer work landed since `run` exercised its candidate? `unknown` when the
 * run never completed or the current head is not a full SHA — never `fresh`
 * by default.
 */
export function scoutRunStaleness(run: ScoutRun, currentSha: string | null | undefined): 'fresh' | 'stale' | 'unknown' {
  if (run.status !== 'completed') return 'unknown';
  const sha = normalizeSha(currentSha);
  if (!sha) return 'unknown';
  return sha === run.candidate.sha ? 'fresh' : 'stale';
}

// ── Probe ───────────────────────────────────────────────────────────────────

/**
 * What the ledger needs from a generated candidate. Structural, so the
 * candidate generator's own type satisfies it without this module importing
 * the generator. `evidenceRequirements` may be bare keys (read as `complete`).
 */
export interface ScoutCandidateLike {
  id: string;
  family: ScoutProbeFamily;
  probeKind: string;
  title: string;
  invariant: string;
  sourceSignals: readonly ScoutSourceSignal[];
  preconditions: readonly string[];
  executor: string | null;
  estimatedCost: ScoutCost;
  /** Severity if broken. */
  severity: VerificationSeverity;
  evidenceRequirements: ReadonlyArray<string | EvidenceRequirement>;
  unsupportedReason?: string;
  mutates?: boolean;
}

function normalizeRequirement(r: string | EvidenceRequirement): EvidenceRequirement {
  if (typeof r === 'string') return { key: r, need: 'complete' };
  return { key: r.key, need: r.need === 'partial' ? 'partial' : 'complete' };
}

/** Freeze a candidate and its selection into the probe contract. Throws on a missing invariant. */
export function scoutProbeRecord(c: ScoutCandidateLike, selection: ScoutProbeSelection): ScoutProbeRecord {
  const invariant = typeof c.invariant === 'string' ? c.invariant.trim() : '';
  if (!invariant) throw new Error(`scout probe ${c.id}: invariant must be declared before execution`);
  if (!(SCOUT_PROBE_FAMILIES as readonly string[]).includes(c.family)) throw new Error(`scout probe ${c.id}: unknown family ${c.family}`);
  if (!(VERIFICATION_SEVERITIES as readonly string[]).includes(c.severity)) throw new Error(`scout probe ${c.id}: unknown severity ${c.severity}`);
  return Object.freeze({
    candidateId: c.id,
    family: c.family,
    probeKind: c.probeKind,
    title: c.title,
    invariant,
    sourceSignals: c.sourceSignals.map(s => ({ type: s.type, ref: s.ref })),
    preconditions: [...c.preconditions],
    executor: c.executor,
    estimatedCost: (SCOUT_COSTS as readonly string[]).includes(c.estimatedCost) ? c.estimatedCost : 'high',
    risk: c.severity,
    mutates: c.mutates === true,
    evidenceRequirements: c.evidenceRequirements.map(normalizeRequirement),
    unsupportedReason: c.unsupportedReason ?? null,
    selection: { ...selection },
    result: null,
  });
}

function notExecutedResult(run: ScoutRun, probe: ScoutProbeRecord, now: Date): VerificationResult {
  const checkId = scoutCheckId(probe.candidateId);
  return {
    checkId,
    checkVersion: SCOUT_CHECK_VERSION,
    subject: { kind: 'candidate-sha', ref: run.candidate.sha },
    verdict: 'inconclusive',
    severity: null,
    confidence: null,
    observed: null,
    evidenceRefs: [],
    reason: 'not_executed',
    evidenceShortfall: [],
    signature: verificationSignature([checkId]),
    recurrenceKey: checkId,
    provenance: { flavor: SCOUT_FLAVOR, origin: `run:${run.id}`, executor: 'none', ranAt: now.toISOString() },
  };
}

/**
 * A runner-assigned probe no runner reported for. `unsupported`, never `pass`:
 * nothing exercised it, and no host that could is reachable.
 */
export function hostExpiredResult(run: ScoutRun, probe: ScoutProbeRecord, reason: ScoutHostExpiryReason, now: Date): VerificationResult {
  return { ...notExecutedResult(run, probe, now), verdict: 'unsupported', reason };
}

/**
 * Has a parked run waited long enough? Past its host deadline, or its lease
 * lapsed a second time (the claim route re-queues after the first lapse).
 * `runner_host_lost` when a runner ever held it, else `no_runner_claimed`.
 */
export function scoutParkingExpiry(parking: ScoutRunParking, now: Date): ScoutHostExpiryReason | null {
  const t = now.getTime();
  const leaseLapsedNow = !!parking.lease && Date.parse(parking.lease.expiresAt) <= t;
  const lapses = parking.leaseLapses + (leaseLapsedNow ? 1 : 0);
  const expired = Date.parse(parking.hostDeadline) <= t || lapses >= 2;
  if (!expired) return null;
  return parking.lease || parking.leaseLapses > 0 ? 'runner_host_lost' : 'no_runner_claimed';
}

/** Finalize every runner probe that has no result yet as `unsupported` with `reason`. Server results are kept. */
export function expireRunnerProbes(
  run: ScoutRun,
  probes: readonly ScoutProbeRecord[],
  reason: ScoutHostExpiryReason,
  now: Date,
): { probes: ScoutProbeRecord[]; expired: number } {
  let expired = 0;
  const out = probes.map(p => {
    if (p.selection.status !== 'selected' || p.host !== 'runner' || p.result) return p;
    expired++;
    return Object.freeze({ ...p, result: hostExpiredResult(run, p, reason, now) });
  });
  return { probes: out, expired };
}

/** Every selected probe ends with a result: one that never ran is `inconclusive`/`not_executed`. */
export function finalizeScoutProbes(run: ScoutRun, probes: readonly ScoutProbeRecord[], now: Date): ScoutProbeRecord[] {
  return probes.map(p => (p.selection.status === 'selected' && !p.result
    ? Object.freeze({ ...p, result: notExecutedResult(run, p, now) })
    : p));
}

export function completeScoutRun(
  run: ScoutRun,
  probes: readonly ScoutProbeRecord[],
  opts: { candidatesGenerated: number; costUsd?: number | null; now: Date },
): { run: ScoutRun; probes: ScoutProbeRecord[]; totals: ScoutRunTotals } {
  const finalized = finalizeScoutProbes(run, probes, opts.now);
  const selected = finalized.filter(p => p.selection.status === 'selected');
  const totals: ScoutRunTotals = {
    candidatesGenerated: opts.candidatesGenerated,
    probesSelected: selected.length,
    probesSkipped: finalized.length - selected.length,
    verdicts: summarizeVerificationResults(selected.map(p => p.result!)),
    costUsd: opts.costUsd ?? null,
  };
  return { run: { ...run, status: 'completed', completedAt: opts.now.toISOString() }, probes: finalized, totals };
}

export function failScoutRun(run: ScoutRun, error: string, now: Date): ScoutRun {
  return { ...run, status: 'failed', completedAt: now.toISOString(), error: clip(String(error), MAX_ERROR_CHARS) };
}

// ── Findings ────────────────────────────────────────────────────────────────

export type ScoutFindingChange = 'created' | 'recurred' | 'regressed' | 'resolved' | 'unchanged' | 'ignored';

const maxConfidence = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b));

/**
 * Merge a probe's result into the finding with its signature. Only `fail`
 * writes. The same run applied twice is a no-op, so a retried write never
 * double-counts. Action state and its task survive a recurrence: the existing
 * follow-up is updated, never re-filed.
 *
 * `reproducibility` is what the executor established this run (repeat
 * attempts, or a deterministic adapter). A known answer replaces the stored
 * one — an intermittent re-run demotes an earlier `deterministic` — and
 * `unknown` never erases a known one.
 */
export function applyScoutFailure(
  existing: ScoutFinding | null,
  run: ScoutRun,
  probe: ScoutProbeRecord,
  now: Date,
  reproducibility: ScoutReproducibility = 'unknown',
): { finding: ScoutFinding | null; change: ScoutFindingChange } {
  const r = probe.result;
  if (!r || r.verdict !== 'fail') return { finding: existing, change: existing ? 'unchanged' : 'ignored' };
  if (existing && existing.lastSeenRunId === run.id) return { finding: existing, change: 'unchanged' };
  const severity = r.severity ?? probe.risk;
  const at = now.toISOString();
  if (!existing) {
    return {
      change: 'created',
      finding: {
        workspaceId: run.workspaceId,
        signature: r.signature,
        recurrenceKey: r.recurrenceKey,
        checkId: r.checkId,
        family: probe.family,
        invariant: probe.invariant,
        severity,
        confidence: r.confidence,
        observed: r.observed,
        evidenceRefs: r.evidenceRefs,
        reproducibility,
        state: 'open',
        actionState: 'none',
        actionTaskId: null,
        occurrenceCount: 1,
        regressionCount: 0,
        firstSeenRunId: run.id,
        firstSeenSha: run.candidate.sha,
        lastSeenRunId: run.id,
        lastSeenSha: run.candidate.sha,
        firstSeenAt: at,
        lastSeenAt: at,
        resolvedRunId: null,
        resolvedSha: null,
        resolvedAt: null,
        dismissedReason: null,
        dismissedAt: null,
        dismissedBy: null,
      },
    };
  }
  const regressed = existing.state === 'resolved';
  return {
    change: regressed ? 'regressed' : 'recurred',
    finding: {
      ...existing,
      severity: maxSeverity(existing.severity, severity),
      confidence: maxConfidence(existing.confidence, r.confidence),
      observed: r.observed ?? existing.observed,
      evidenceRefs: r.evidenceRefs.length > 0 ? r.evidenceRefs : existing.evidenceRefs,
      reproducibility: reproducibility === 'unknown' ? existing.reproducibility : reproducibility,
      state: existing.state === 'dismissed' ? 'dismissed' : 'open',
      occurrenceCount: existing.occurrenceCount + 1,
      regressionCount: existing.regressionCount + (regressed ? 1 : 0),
      lastSeenRunId: run.id,
      lastSeenSha: run.candidate.sha,
      lastSeenAt: at,
      resolvedRunId: regressed ? null : existing.resolvedRunId,
      resolvedSha: regressed ? null : existing.resolvedSha,
      resolvedAt: regressed ? null : existing.resolvedAt,
    },
  };
}

/** A `pass` of the same check, at `run`'s SHA, resolves an open finding. Nothing else does. */
export function resolveScoutFinding(existing: ScoutFinding, run: ScoutRun, now: Date): { finding: ScoutFinding; change: ScoutFindingChange } {
  if (existing.state !== 'open') return { finding: existing, change: 'unchanged' };
  return {
    change: 'resolved',
    finding: { ...existing, state: 'resolved', resolvedRunId: run.id, resolvedSha: run.candidate.sha, resolvedAt: now.toISOString() },
  };
}

/** The columns a dismissal writes, or why it cannot. Pure: the write is `dismissScoutFindingRow`. */
export type ScoutDismissal =
  | { ok: true; fields: { state: 'dismissed'; dismissedReason: string; dismissedBy: string; dismissedAt: Date } }
  | { ok: false; error: 'reason_required' | 'by_required' };

export function scoutDismissal(input: { reason: unknown; by: unknown; now: Date }): ScoutDismissal {
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) return { ok: false, error: 'reason_required' };
  const by = typeof input.by === 'string' ? input.by.trim() : '';
  if (!by) return { ok: false, error: 'by_required' };
  return {
    ok: true,
    fields: { state: 'dismissed', dismissedReason: clip(reason, MAX_SCOUT_DISMISS_REASON), dismissedBy: clip(by, MAX_REF_CHARS), dismissedAt: input.now },
  };
}

// ── Store ───────────────────────────────────────────────────────────────────

/** Finding persistence. `update` is a compare-and-set on `occurrenceCount`. */
export interface ScoutFindingStore {
  find(workspaceId: string, signature: string): Promise<ScoutFinding | null>;
  /** False when a row with this signature already exists. */
  insert(finding: ScoutFinding): Promise<boolean>;
  /** False when the stored count is no longer `expectedCount`. */
  update(finding: ScoutFinding, expectedCount: number): Promise<boolean>;
}

const MAX_CAS_ATTEMPTS = 4;

/**
 * Persist a probe's failure into the finding ledger. Read → merge → CAS, and
 * on a lost race re-read and merge again, so concurrent runs never lose an
 * occurrence. Never throws: a ledger write must not fail the run.
 */
export async function recordScoutFailure(
  run: ScoutRun,
  probe: ScoutProbeRecord,
  deps: { store?: ScoutFindingStore; now?: () => Date; reproducibility?: ScoutReproducibility } = {},
): Promise<ScoutFindingChange | 'failed'> {
  const r = probe.result;
  if (!r || r.verdict !== 'fail') return 'ignored';
  const store = deps.store ?? dbScoutFindingStore;
  const now = deps.now ?? (() => new Date());
  try {
    for (let i = 0; i < MAX_CAS_ATTEMPTS; i++) {
      const existing = await store.find(run.workspaceId, r.signature);
      const { finding, change } = applyScoutFailure(existing, run, probe, now(), deps.reproducibility);
      if (!finding || change === 'unchanged') return change;
      const ok = existing ? await store.update(finding, existing.occurrenceCount) : await store.insert(finding);
      if (ok) return change;
    }
    console.warn('[quality-scout] finding CAS exhausted:', r.signature);
    return 'failed';
  } catch (err) {
    console.warn('[quality-scout] finding write failed (non-fatal):', (err as Error)?.message ?? err);
    return 'failed';
  }
}

type FindingRow = typeof qualityScoutFindings.$inferSelect;

export function scoutFindingRow(f: ScoutFinding) {
  return {
    workspaceId: f.workspaceId,
    signature: f.signature,
    recurrenceKey: f.recurrenceKey,
    checkId: f.checkId,
    family: f.family,
    invariant: f.invariant,
    severity: f.severity,
    confidence: f.confidence,
    observed: f.observed,
    evidenceRefs: f.evidenceRefs,
    reproducibility: f.reproducibility,
    state: f.state,
    actionState: f.actionState,
    actionTaskId: f.actionTaskId,
    occurrenceCount: f.occurrenceCount,
    regressionCount: f.regressionCount,
    firstSeenRunId: f.firstSeenRunId,
    firstSeenSha: f.firstSeenSha,
    lastSeenRunId: f.lastSeenRunId,
    lastSeenSha: f.lastSeenSha,
    firstSeenAt: new Date(f.firstSeenAt),
    lastSeenAt: new Date(f.lastSeenAt),
    resolvedRunId: f.resolvedRunId,
    resolvedSha: f.resolvedSha,
    resolvedAt: f.resolvedAt ? new Date(f.resolvedAt) : null,
    dismissedReason: f.dismissedReason,
    dismissedAt: f.dismissedAt ? new Date(f.dismissedAt) : null,
    dismissedBy: f.dismissedBy,
  };
}

/**
 * The columns a recurrence rewrites. `action_state` / `action_task_id` are
 * left out on purpose: they belong to the follow-up claim, which updates them
 * without touching `occurrence_count`. Writing them here would let a run that
 * read the row before the claim reset a filed follow-up to `none` — and the
 * next run would file a second task for the same defect.
 */
export function scoutFindingLedgerSet(f: ScoutFinding) {
  const {
    actionState: _state,
    actionTaskId: _task,
    // The dismissal belongs to whoever dismissed it, same as the action columns.
    dismissedReason: _reason,
    dismissedAt: _at,
    dismissedBy: _by,
    ...rest
  } = scoutFindingRow(f);
  return rest;
}

/**
 * The recurrence compare-and-set. A dismissal does not bump
 * `occurrence_count`, so a run that read the row before it was dismissed would
 * pass the count check and write `state = 'open'` back. Unless the merged
 * finding is itself dismissed, the write also requires the row is not: a lost
 * check re-reads, and the re-merge keeps the dismissal.
 */
export function scoutFindingCasWhere(finding: ScoutFinding, expectedCount: number): SQL | undefined {
  return and(
    eq(qualityScoutFindings.workspaceId, finding.workspaceId),
    eq(qualityScoutFindings.signature, finding.signature),
    eq(qualityScoutFindings.occurrenceCount, expectedCount),
    ...(finding.state === 'dismissed' ? [] : [ne(qualityScoutFindings.state, 'dismissed')]),
  );
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function scoutFindingFromRow(row: FindingRow): ScoutFinding {
  return {
    workspaceId: row.workspaceId,
    signature: row.signature,
    recurrenceKey: row.recurrenceKey,
    checkId: row.checkId,
    family: row.family,
    invariant: row.invariant,
    severity: row.severity,
    confidence: row.confidence,
    observed: row.observed,
    evidenceRefs: row.evidenceRefs ?? [],
    reproducibility: row.reproducibility,
    state: row.state,
    actionState: row.actionState,
    actionTaskId: row.actionTaskId,
    occurrenceCount: row.occurrenceCount,
    regressionCount: row.regressionCount,
    firstSeenRunId: row.firstSeenRunId,
    firstSeenSha: row.firstSeenSha,
    lastSeenRunId: row.lastSeenRunId,
    lastSeenSha: row.lastSeenSha,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    resolvedRunId: row.resolvedRunId,
    resolvedSha: row.resolvedSha,
    resolvedAt: iso(row.resolvedAt),
    dismissedReason: row.dismissedReason ?? null,
    dismissedAt: iso(row.dismissedAt ?? null),
    dismissedBy: row.dismissedBy ?? null,
  };
}

export const dbScoutFindingStore: ScoutFindingStore = {
  async find(workspaceId, signature) {
    const [row] = await db.select().from(qualityScoutFindings)
      .where(and(eq(qualityScoutFindings.workspaceId, workspaceId), eq(qualityScoutFindings.signature, signature)))
      .limit(1);
    return row ? scoutFindingFromRow(row) : null;
  },
  async insert(finding) {
    const rows = await db.insert(qualityScoutFindings).values(scoutFindingRow(finding))
      .onConflictDoNothing({ target: [qualityScoutFindings.workspaceId, qualityScoutFindings.signature] })
      .returning({ id: qualityScoutFindings.id });
    return rows.length > 0;
  },
  async update(finding, expectedCount) {
    const rows = await db.update(qualityScoutFindings)
      .set({ ...scoutFindingLedgerSet(finding), updatedAt: new Date() })
      .where(scoutFindingCasWhere(finding, expectedCount))
      .returning({ id: qualityScoutFindings.id });
    return rows.length > 0;
  },
};

/**
 * Dismiss one finding: a single conditional UPDATE, so two people dismissing
 * at once record one reason. `dismissed: false` with `exists` tells an
 * already-dismissed finding apart from one that is not there. The follow-up
 * task, if any, is the caller's to retire.
 */
export async function dismissScoutFindingRow(
  workspaceId: string,
  signature: string,
  fields: Extract<ScoutDismissal, { ok: true }>['fields'],
): Promise<{ dismissed: true; actionTaskId: string | null } | { dismissed: false; exists: boolean }> {
  const where = and(eq(qualityScoutFindings.workspaceId, workspaceId), eq(qualityScoutFindings.signature, signature));
  const [row] = await db.update(qualityScoutFindings)
    .set({ ...fields, updatedAt: fields.dismissedAt })
    .where(and(where, ne(qualityScoutFindings.state, 'dismissed')))
    .returning({ actionTaskId: qualityScoutFindings.actionTaskId });
  if (row) return { dismissed: true, actionTaskId: row.actionTaskId };
  const [existing] = await db.select({ id: qualityScoutFindings.id }).from(qualityScoutFindings).where(where).limit(1);
  return { dismissed: false, exists: !!existing };
}

export function scoutRunRow(run: ScoutRun, totals?: ScoutRunTotals, metrics?: ScoutRunMetrics) {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    missionId: run.missionId,
    trigger: run.trigger,
    mode: run.mode,
    status: run.status,
    candidateRef: run.candidate.ref,
    candidateSha: run.candidate.sha,
    priorRunId: run.prior?.runId ?? null,
    priorSha: run.prior?.sha ?? null,
    budget: run.budget,
    policyVersion: run.policyVersion,
    candidatesGenerated: totals?.candidatesGenerated ?? null,
    probesSelected: totals?.probesSelected ?? null,
    probesSkipped: totals?.probesSkipped ?? null,
    verdicts: totals?.verdicts ?? null,
    costUsd: totals?.costUsd == null ? null : totals.costUsd.toFixed(4),
    metrics: metrics ?? null,
    error: run.error,
    hostState: run.parking
      ? { parkedAt: run.parking.parkedAt, runnerMaxDurationMs: run.parking.runnerMaxDurationMs, profile: run.parking.profile, plan: run.parking.plan }
      : null,
    hostDeadline: run.parking ? new Date(run.parking.hostDeadline) : null,
    hostLeaseHolder: run.parking?.lease?.holder ?? null,
    hostLeaseExpiresAt: run.parking?.lease ? new Date(run.parking.lease.expiresAt) : null,
    hostLeaseLapses: run.parking?.leaseLapses ?? 0,
    startedAt: new Date(run.startedAt),
    completedAt: run.completedAt ? new Date(run.completedAt) : null,
  };
}

type RunRow = typeof qualityScoutRuns.$inferSelect;
type ProbeRow = typeof qualityScoutProbes.$inferSelect;

/** The inverse of `scoutRunRow`, for a run finalized after it parked. */
export function scoutRunFromRow(row: RunRow): ScoutRun {
  const hs = row.hostState;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    missionId: row.missionId,
    trigger: row.trigger,
    mode: row.mode,
    status: row.status,
    candidate: { ref: row.candidateRef, sha: row.candidateSha },
    prior: row.priorRunId && row.priorSha ? { runId: row.priorRunId, sha: row.priorSha } : null,
    budget: row.budget,
    policyVersion: row.policyVersion,
    startedAt: row.startedAt.toISOString(),
    completedAt: iso(row.completedAt),
    error: row.error,
    parking: hs && row.hostDeadline
      ? {
          parkedAt: hs.parkedAt,
          hostDeadline: row.hostDeadline.toISOString(),
          runnerMaxDurationMs: hs.runnerMaxDurationMs,
          profile: hs.profile,
          plan: hs.plan,
          lease: row.hostLeaseHolder && row.hostLeaseExpiresAt
            ? { holder: row.hostLeaseHolder, expiresAt: row.hostLeaseExpiresAt.toISOString() }
            : null,
          leaseLapses: row.hostLeaseLapses ?? 0,
        }
      : null,
  };
}

/** The inverse of `scoutProbeRow`. */
export function scoutProbeFromRow(row: ProbeRow): ScoutProbeRecord {
  return Object.freeze({
    candidateId: row.candidateId,
    family: row.family,
    probeKind: row.probeKind,
    title: row.title,
    invariant: row.invariant,
    sourceSignals: row.sourceSignals,
    preconditions: row.preconditions,
    executor: row.executor,
    estimatedCost: row.estimatedCost,
    risk: row.risk,
    mutates: row.mutates,
    evidenceRequirements: row.evidenceRequirements,
    unsupportedReason: row.unsupportedReason,
    selection: row.selection,
    ...(row.host ? { host: row.host } : {}),
    result: row.result ?? null,
  });
}

export function scoutProbeRow(run: ScoutRun, p: ScoutProbeRecord) {
  return {
    runId: run.id,
    workspaceId: run.workspaceId,
    candidateId: p.candidateId,
    family: p.family,
    probeKind: p.probeKind,
    title: p.title,
    invariant: p.invariant,
    sourceSignals: p.sourceSignals,
    preconditions: p.preconditions,
    executor: p.executor,
    estimatedCost: p.estimatedCost,
    risk: p.risk,
    mutates: p.mutates,
    evidenceRequirements: p.evidenceRequirements,
    unsupportedReason: p.unsupportedReason,
    selection: p.selection,
    host: p.host ?? null,
    verdict: p.result?.verdict ?? null,
    signature: p.result?.signature ?? null,
    result: p.result,
  };
}

/** Insert or update the run row (start, then again on complete/fail). */
export async function saveScoutRun(run: ScoutRun, totals?: ScoutRunTotals, metrics?: ScoutRunMetrics): Promise<void> {
  const row = scoutRunRow(run, totals, metrics);
  const { id: _id, workspaceId: _ws, ...rest } = row;
  await db.insert(qualityScoutRuns).values(row).onConflictDoUpdate({ target: qualityScoutRuns.id, set: rest });
}

/** Upsert probe rows: the contract is written before execution, the result after. */
export async function saveScoutProbes(run: ScoutRun, probes: readonly ScoutProbeRecord[]): Promise<void> {
  if (probes.length === 0) return;
  await db.insert(qualityScoutProbes).values(probes.map(p => scoutProbeRow(run, p)))
    .onConflictDoUpdate({
      target: [qualityScoutProbes.runId, qualityScoutProbes.candidateId],
      set: {
        selection: sql`excluded.selection`,
        host: sql`excluded.host`,
        verdict: sql`excluded.verdict`,
        signature: sql`excluded.signature`,
        result: sql`excluded.result`,
        updatedAt: sql`now()`,
      },
    });
}

/** A finding a pass just resolved, with the follow-up that may still be presented as owed. */
export interface ScoutResolvedFinding {
  signature: string;
  actionTaskId: string | null;
}

/** Resolve open findings of a check that passed in `run`. Returns the ones it resolved. */
export async function resolveScoutFindingsForPass(run: ScoutRun, probe: ScoutProbeRecord, now = new Date()): Promise<ScoutResolvedFinding[]> {
  if (probe.result?.verdict !== 'pass') return [];
  const rows = await db.update(qualityScoutFindings)
    .set({ state: 'resolved', resolvedRunId: run.id, resolvedSha: run.candidate.sha, resolvedAt: now, updatedAt: now })
    .where(and(
      eq(qualityScoutFindings.workspaceId, run.workspaceId),
      eq(qualityScoutFindings.checkId, probe.result.checkId),
      eq(qualityScoutFindings.state, 'open'),
    ))
    .returning({ signature: qualityScoutFindings.signature, actionTaskId: qualityScoutFindings.actionTaskId });
  return rows;
}

/** The latest completed run on a ref — the `prior` for the next run and the base for staleness. */
export async function latestScoutRun(workspaceId: string, ref: string): Promise<{ id: string; sha: string; completedAt: Date | null } | null> {
  const [row] = await db.select({ id: qualityScoutRuns.id, sha: qualityScoutRuns.candidateSha, completedAt: qualityScoutRuns.completedAt })
    .from(qualityScoutRuns)
    .where(and(
      eq(qualityScoutRuns.workspaceId, workspaceId),
      eq(qualityScoutRuns.candidateRef, ref),
      eq(qualityScoutRuns.status, 'completed'),
    ))
    .orderBy(desc(qualityScoutRuns.completedAt))
    .limit(1);
  return row ?? null;
}
