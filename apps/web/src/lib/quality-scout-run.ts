/**
 * One Quality Scout run, end to end (artifact workspace-quality-scout-spec §3,
 * §12, §16): claim → profile → signals → candidates → selection → execution →
 * ledger → follow-up policy → readout.
 *
 * Host-agnostic: everything that touches the world comes in through
 * `ScoutRunDeps` — the capability profile, the grounding signals, the decision
 * kind, the probe ports (read-only by construction, see core executors), the
 * ledger and the action store. A host that cannot run commands simply passes
 * no command port, and those probes are honestly `unsupported`.
 *
 * Bounded: at most `budget.maxProbes` probes, a wall-clock bound
 * (`maxDurationMs`) checked before each probe and raced against it, and a
 * dollar bound on the decision cost. A probe the bound cuts off is finalized
 * `inconclusive`/`not_executed` — never dropped, never `pass`.
 *
 * Fail-open: nothing here throws. A broken profile fails the run (recorded,
 * returned); a broken signal source degrades to "no change signals"; a broken
 * ledger or action write is counted and the run carries on. Nothing blocks a
 * merge or a release on a Scout run.
 *
 * Deduped: the run id is derived from (workspace, SHA) for automatic triggers,
 * so a mission trigger and a periodic tick on the same SHA claim the same row
 * and exactly one of them runs. A manual run adds its own key.
 */

import { createHash } from 'node:crypto';
import { generateScoutCandidates, type ScoutSignals } from '@buildd/core/quality-scout/candidates';
import { runScoutProbe, type ScoutProbeExecution, type ScoutProbePorts, type ScoutRunProbeOptions } from '@buildd/core/quality-scout/executors';
import {
  completeScoutRun,
  failScoutRun,
  recordScoutFailure,
  scoutProbeRecord,
  scoutRunStaleness,
  startScoutRun,
  type ScoutFindingStore,
} from '@buildd/core/quality-scout/ledger';
import { selectScoutProbes, type ScoutProbeDecider } from '@buildd/core/quality-scout/selector';
import {
  SCOUT_ACTION_OUTCOMES,
  SCOUT_STAGES,
  type ScoutActionOutcome,
  type ScoutMode,
  type ScoutProbeRecord,
  type ScoutRun,
  type ScoutRunMetrics,
  type ScoutRunTotals,
  type ScoutRunTrigger,
  type ScoutStage,
  type ScoutStageMetric,
} from '@buildd/core/quality-scout/types';
import type { ScoutCapabilityProfile } from '@buildd/core/scout-capabilities';
import {
  actOnScoutFinding,
  DEFAULT_SCOUT_ACTION_POLICY,
  type ScoutActionPolicy,
  type ScoutActionStore,
} from './quality-scout-actions';

/** Default wall-clock bound for one run. */
export const DEFAULT_SCOUT_MAX_DURATION_MS = 10 * 60_000;
export const MAX_SCOUT_MAX_DURATION_MS = 60 * 60_000;
/**
 * A failing probe is re-run once by default, so "deterministic" means
 * "failed the same way twice", not "failed once" (spec §10 medium rule).
 */
export const DEFAULT_SCOUT_PROBE_ATTEMPTS = 2;
const MAX_WARNINGS = 20;

export interface ScoutRunRequest {
  workspaceId: string;
  missionId?: string | null;
  trigger: ScoutRunTrigger;
  mode: ScoutMode;
  candidate: { ref: string; sha: string };
  budget?: { maxProbes?: number; maxCostUsd?: number | null };
  maxDurationMs?: number;
  /** Manual runs only: distinguishes a deliberate re-run of the same SHA from a double tap. */
  dedupeKey?: string;
  policy?: ScoutActionPolicy;
  probeOptions?: Omit<ScoutRunProbeOptions, 'now'>;
}

/** Run persistence. The DB-backed one lives in `quality-scout-trigger.ts`. */
export interface ScoutRunLedger {
  /** The latest completed run on `ref`: the `prior` for this one. */
  latestRun(workspaceId: string, ref: string): Promise<{ id: string; sha: string } | null>;
  /**
   * Atomic: insert the run row, or take over a `failed` row / a `running` row
   * that started before `staleBefore`. `duplicate` when a live or finished run
   * already holds the id.
   */
  claimRun(run: ScoutRun, staleBefore: Date): Promise<'claimed' | 'duplicate'>;
  saveRun(run: ScoutRun, totals?: ScoutRunTotals, metrics?: ScoutRunMetrics): Promise<void>;
  saveProbes(run: ScoutRun, probes: readonly ScoutProbeRecord[]): Promise<void>;
  findings: ScoutFindingStore;
  resolveForPass(run: ScoutRun, probe: ScoutProbeRecord): Promise<number>;
}

export interface ScoutRunDeps {
  now(): Date;
  loadProfile(): Promise<ScoutCapabilityProfile>;
  gatherSignals(ctx: { candidate: { ref: string; sha: string }; prior: { runId: string; sha: string } | null }): Promise<ScoutSignals>;
  decide: ScoutProbeDecider;
  /** Total decision cost (USD) reported so far, when the decider can tell. */
  takeDecisionCost?(): number | null;
  ports: ScoutProbePorts;
  ledger: ScoutRunLedger;
  actions: ScoutActionStore;
  /** The ref's current head, for staleness. Null when it cannot be read. */
  headSha(): Promise<string | null>;
}

export type ScoutRunOutcome =
  | { status: 'skipped'; reason: 'mode_off' | 'invalid_sha' | 'invalid_ref' | 'invalid_trigger' | 'duplicate'; runId: string | null }
  | { status: 'completed'; runId: string; metrics: ScoutRunMetrics }
  | { status: 'failed'; runId: string | null; error: string };

/** A UUID-shaped id from a hash, so the same trigger key always names the same run row. */
export function scoutRunId(workspaceId: string, trigger: ScoutRunTrigger, sha: string, dedupeKey?: string): string {
  const key = trigger === 'manual' ? `manual:${dedupeKey ?? ''}` : 'auto';
  const h = createHash('sha256').update(`quality-scout-run\u0000${workspaceId}\u0000${sha.toLowerCase()}\u0000${key}`).digest('hex');
  // Version 5-style nibble and RFC 4122 variant, so it reads as a well-formed UUID.
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function clampScoutDuration(ms: number | undefined): number {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.min(Math.floor(ms), MAX_SCOUT_MAX_DURATION_MS) : DEFAULT_SCOUT_MAX_DURATION_MS;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function emptyStages(): Record<ScoutStage, ScoutStageMetric> {
  return Object.fromEntries(SCOUT_STAGES.map((s) => [s, { ms: 0, costUsd: null }])) as Record<ScoutStage, ScoutStageMetric>;
}

function emptyActions(): Record<ScoutActionOutcome, number> {
  return Object.fromEntries(SCOUT_ACTION_OUTCOMES.map((o) => [o, 0])) as Record<ScoutActionOutcome, number>;
}

const TIMED_OUT = Symbol('timed-out');

async function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), Math.max(ms, 0)); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run one bounded Scout pass. Never throws. */
export async function runQualityScout(req: ScoutRunRequest, deps: ScoutRunDeps): Promise<ScoutRunOutcome> {
  if (req.mode === 'off') return { status: 'skipped', reason: 'mode_off', runId: null };
  const maxDurationMs = clampScoutDuration(req.maxDurationMs);
  const policy = req.policy ?? DEFAULT_SCOUT_ACTION_POLICY;
  const warnings: string[] = [];
  const warn = (w: string) => { if (warnings.length < MAX_WARNINGS) warnings.push(w); };

  const startedAt = deps.now();
  let prior: { runId: string; sha: string } | null = null;
  try {
    const latest = await deps.ledger.latestRun(req.workspaceId, req.candidate.ref?.trim?.() ?? '');
    prior = latest ? { runId: latest.id, sha: latest.sha } : null;
  } catch (err) {
    warn(`prior run unreadable: ${message(err)}`);
  }

  const started = startScoutRun({
    id: scoutRunId(req.workspaceId, req.trigger, String(req.candidate?.sha ?? ''), req.dedupeKey),
    workspaceId: req.workspaceId,
    missionId: req.missionId ?? null,
    trigger: req.trigger,
    mode: req.mode,
    candidate: req.candidate,
    prior,
    budget: req.budget,
    now: startedAt,
  });
  if (!started.ok) return { status: 'skipped', reason: started.reason, runId: null };
  let run = started.run;
  // A prior that is this very row (a takeover of a failed attempt) is no prior at all.
  if (run.prior?.runId === run.id) run = { ...run, prior: null };

  try {
    const claim = await deps.ledger.claimRun(run, new Date(startedAt.getTime() - 2 * maxDurationMs));
    if (claim === 'duplicate') return { status: 'skipped', reason: 'duplicate', runId: run.id };
  } catch (err) {
    console.warn('[quality-scout] run claim failed (non-fatal):', message(err));
    return { status: 'failed', runId: null, error: message(err) };
  }

  const stages = emptyStages();
  const elapsed = () => deps.now().getTime() - startedAt.getTime();
  const timed = async <T>(stage: ScoutStage, fn: () => Promise<T>): Promise<T> => {
    const t = deps.now().getTime();
    try {
      return await fn();
    } finally {
      stages[stage].ms += deps.now().getTime() - t;
    }
  };

  try {
    const profile = await timed('profile', deps.loadProfile);

    const signals = await timed('signals', async () => {
      try {
        return await deps.gatherSignals({ candidate: run.candidate, prior: run.prior });
      } catch (err) {
        warn(`signals unavailable, ran on config/history only: ${message(err)}`);
        return { candidateRef: run.candidate.ref, priorRef: run.prior?.sha ?? null, changedPaths: [] } satisfies ScoutSignals;
      }
    });

    const set = await timed('generate', async () => generateScoutCandidates({ ...signals, candidateRef: run.candidate.ref }, profile));
    for (const w of set.warnings) warn(w);

    const costBefore = deps.takeDecisionCost?.() ?? null;
    const selection = await timed('select', () => selectScoutProbes(set, deps.decide, { budget: run.budget.maxProbes }));
    const costAfter = deps.takeDecisionCost?.() ?? null;
    stages.select.costUsd = costAfter === null ? null : costAfter - (costBefore ?? 0);

    // Freeze every candidate's contract — selected or not — before anything executes.
    let records: ScoutProbeRecord[] = [];
    for (const s of selection.selected) {
      try {
        records.push(scoutProbeRecord(s.candidate, { status: 'selected', via: s.via, reasonCode: s.reasonCode, decisionSource: s.decisionSource }));
      } catch (err) {
        warn(message(err));
      }
    }
    for (const s of selection.skipped) {
      try {
        records.push(scoutProbeRecord(s.candidate, { status: 'skipped', reason: s.reason, reasonCode: s.reasonCode ?? null }));
      } catch (err) {
        warn(message(err));
      }
    }
    await deps.ledger.saveProbes(run, records);

    // ── Execute, inside the bounds ──
    const executions = new Map<string, ScoutProbeExecution>();
    let deadlineHit = false;
    await timed('execute', async () => {
      for (const p of records) {
        if (p.selection.status !== 'selected') continue;
        const left = maxDurationMs - elapsed();
        if (left <= 0) { deadlineHit = true; break; }
        const spent = stages.select.costUsd ?? 0;
        if (run.budget.maxCostUsd !== null && spent >= run.budget.maxCostUsd) {
          warn('cost budget exhausted before execution');
          deadlineHit = true;
          break;
        }
        try {
          const exec = await within(
            runScoutProbe(run, p, profile, deps.ports, { attempts: DEFAULT_SCOUT_PROBE_ATTEMPTS, ...req.probeOptions, now: deps.now }),
            left,
          );
          if (exec === TIMED_OUT) { deadlineHit = true; break; }
          executions.set(p.candidateId, exec);
        } catch (err) {
          warn(`probe ${p.candidateId}: ${message(err)}`);
        }
      }
    });
    records = records.map((p) => executions.get(p.candidateId)?.probe ?? p);

    const completed = completeScoutRun(run, records, {
      candidatesGenerated: set.candidates.length,
      costUsd: stages.select.costUsd,
      now: deps.now(),
    });
    run = completed.run;
    try {
      await deps.ledger.saveProbes(run, completed.probes);
    } catch (err) {
      warn(`probe results not saved: ${message(err)}`);
    }

    // ── Ledger + follow-up policy ──
    const findings = { created: 0, recurred: 0, regressed: 0, resolved: 0, writeFailures: 0 };
    const actions = emptyActions();
    let actionable = 0;
    await timed('act', async () => {
      for (const p of completed.probes) {
        const verdict = p.result?.verdict;
        if (p.selection.status !== 'selected' || !p.result) continue;
        if (verdict === 'pass') {
          try {
            findings.resolved += await deps.ledger.resolveForPass(run, p);
          } catch (err) {
            warn(`resolve failed: ${message(err)}`);
          }
          continue;
        }
        // inconclusive / unsupported: recorded on the probe row, never a defect.
        if (verdict !== 'fail') continue;
        const change = await recordScoutFailure(run, p, {
          store: deps.ledger.findings,
          now: deps.now,
          reproducibility: executions.get(p.candidateId)?.reproducibility ?? 'unknown',
        });
        if (change === 'failed') { findings.writeFailures++; continue; }
        if (change === 'created' || change === 'recurred' || change === 'regressed') findings[change]++;
        let finding;
        try {
          finding = await deps.ledger.findings.find(run.workspaceId, p.result.signature);
        } catch (err) {
          warn(`finding unreadable: ${message(err)}`);
          continue;
        }
        if (!finding) continue;
        const acted = await actOnScoutFinding(finding, run, { mode: req.mode, policy, now: deps.now() }, deps.actions);
        actions[acted.outcome]++;
        if (acted.decision.kind === 'file' || acted.decision.kind === 'propose') actionable++;
      }
    });

    let headSha: string | null = null;
    try {
      headSha = await deps.headSha();
    } catch (err) {
      warn(`head unreadable: ${message(err)}`);
    }

    const selected = completed.probes.filter((p) => p.selection.status === 'selected');
    const notExecuted = selected.filter((p) => p.result?.reason === 'not_executed').length;
    const stageCosts = SCOUT_STAGES.map((s) => stages[s].costUsd).filter((c): c is number => c !== null);
    const metrics: ScoutRunMetrics = {
      candidatesGenerated: set.candidates.length,
      candidatesTruncated: set.truncated,
      probesSelected: selected.length,
      probesRun: selected.length - notExecuted,
      probesNotExecuted: notExecuted,
      decisionsAsked: selection.decisionsAsked,
      decisionFailures: selection.decisionFailures,
      verdicts: completed.totals.verdicts,
      stages,
      costUsd: stageCosts.length > 0 ? stageCosts.reduce((a, b) => a + b, 0) : null,
      findings,
      actionable,
      actions,
      dedupeSuppressed: actions.updated + actions.suppressed,
      exercised: run.candidate,
      prior: run.prior,
      headSha,
      staleness: scoutRunStaleness(run, headSha),
      deadlineHit,
      warnings,
    };
    await deps.ledger.saveRun(run, { ...completed.totals, costUsd: metrics.costUsd }, metrics);
    return { status: 'completed', runId: run.id, metrics };
  } catch (err) {
    const error = message(err);
    console.warn('[quality-scout] run failed (non-fatal):', error);
    const failed = failScoutRun(run, error, deps.now());
    try {
      await deps.ledger.saveRun(failed);
    } catch (saveErr) {
      console.warn('[quality-scout] failed run not saved:', message(saveErr));
    }
    return { status: 'failed', runId: run.id, error: failed.error ?? error };
  }
}
