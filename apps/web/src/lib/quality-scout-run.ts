/**
 * One Quality Scout run, end to end (artifact workspace-quality-scout-spec §3,
 * §12, §16): claim → profile → signals → candidates → selection → execution →
 * ledger → follow-up policy → readout.
 *
 * Three exported legs, composed by `runQualityScout`: `planScoutRun` (prior,
 * claim, profile, signals, candidates, selection, contracts saved, a host per
 * probe), `executeScoutProbes` (one host's probes, inside the bounds) and
 * `finalizeScoutRun` (results, findings, follow-ups, metrics). When probes are
 * assigned to a runner, the server runs its own and the run parks
 * `awaiting_host` (`parkScoutRun`) instead of finalizing; whatever no runner
 * reports by the deadline is finalized `unsupported` by
 * `finalizeExpiredScoutRun` — never `pass`, never dropped.
 *
 * Host-agnostic: everything that touches the world comes in through
 * `ScoutRunDeps` — the capability profile, the grounding signals, the decision
 * kind, the probe ports (read-only by construction, see core executors), the
 * ledger and the action store. A host that cannot run commands simply passes
 * no command port, and those probes are honestly `unsupported`.
 *
 * Bounded: at most `budget.maxProbes` probes, a wall-clock bound
 * (`maxDurationMs`) checked before each probe and raced against it, and a
 * dollar bound (`budget.maxCostUsd`) on the decision cost. A probe the time
 * bound cuts off is finalized `inconclusive`/`not_executed` — never dropped,
 * never `pass`.
 *
 * The dollar bound applies where the money is spent: probe selection is the
 * only model cost in a run, so the cap is checked before each decision call
 * (see `selectScoutProbes`), and a capped run falls back to the deterministic
 * rule for its remaining slots and records `costCapHit`. Probe execution has
 * no model cost and is never withheld on cost. An absent cap is deliberately
 * not a dollar ceiling: selection is already bounded by call count (at most
 * three small structured decisions per probe slot, so ≤ 30 per run), and a
 * team that wants a hard dollar ceiling sets `maxCostUsd`.
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
import { generateScoutCandidates, type ScoutProbeCandidate, type ScoutSignals } from '@buildd/core/quality-scout/candidates';
import {
  runScoutProbe,
  SCOUT_ADAPTER_BY_KIND,
  type ScoutProbeExecution,
  type ScoutProbePorts,
  type ScoutRunProbeOptions,
} from '@buildd/core/quality-scout/executors';
import {
  completeScoutRun,
  expireRunnerProbes,
  failScoutRun,
  recordScoutFailure,
  scoutParkingExpiry,
  scoutProbeRecord,
  scoutRunStaleness,
  startScoutRun,
  type ScoutFindingStore,
  type ScoutResolvedFinding,
} from '@buildd/core/quality-scout/ledger';
import { selectScoutProbes, type ScoutProbeDecider } from '@buildd/core/quality-scout/selector';
import {
  DEFAULT_SCOUT_HOST_DEADLINE_MS,
  DEFAULT_SCOUT_RUNNER_MAX_DURATION_MS,
  MAX_SCOUT_HOST_DEADLINE_MS,
  SCOUT_ACTION_OUTCOMES,
  SCOUT_RUNNER_NEEDS,
  SCOUT_STAGES,
  type ScoutActionOutcome,
  type ScoutHostExpiryReason,
  type ScoutHostNeed,
  type ScoutMode,
  type ScoutPlanSummary,
  type ScoutProbeHost,
  type ScoutProbeRecord,
  type ScoutReproducibility,
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
  retireScoutFollowUp,
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
  /** Runner-hosted bounds, used only when the run parks. Defaults: 20 min to execute, 30 min to wait. */
  host?: { runnerMaxDurationMs?: number; hostDeadlineMs?: number };
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
  /** Resolve the open findings of a check that passed; returns the ones it resolved. */
  resolveForPass(run: ScoutRun, probe: ScoutProbeRecord): Promise<ScoutResolvedFinding[]>;
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
  /**
   * What a runner of the workspace's team can host for this repo right now
   * (`environment.scoutHost` on a recent heartbeat). Given: probes are
   * assigned a host, candidates no host can run are skipped `no_host`, and a
   * run with runner probes parks `awaiting_host`. Absent: a single-host run on
   * `ports`, exactly as before (the dogfood script, `host: server`).
   */
  runnerHost?(): Promise<ReadonlySet<ScoutHostNeed> | null>;
}

export type ScoutRunOutcome =
  | { status: 'skipped'; reason: 'mode_off' | 'invalid_sha' | 'invalid_ref' | 'invalid_trigger' | 'duplicate'; runId: string | null }
  | { status: 'completed'; runId: string; metrics: ScoutRunMetrics }
  | { status: 'awaiting_host'; runId: string; runnerProbes: number; hostDeadline: string }
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

// ── Hosts ───────────────────────────────────────────────────────────────────

/**
 * What a probe bound to `executor` needs from its host. Null when nothing
 * could execute it (no executor, or a capability kind no adapter exercises):
 * the executor's own gate says `unsupported` for those.
 */
export function scoutHostNeed(executor: string | null, profile: ScoutCapabilityProfile): ScoutHostNeed | null {
  if (!executor) return null;
  const cap = profile.capabilities.find((c) => c.id === executor);
  const kind = (cap?.kind ?? executor.split(':')[0]) as keyof typeof SCOUT_ADAPTER_BY_KIND;
  switch (SCOUT_ADAPTER_BY_KIND[kind]) {
    case 'command': return 'command';
    case 'surface': return 'capture';
    case 'spec': return 'spec';
    case 'readiness': return 'readiness';
    case 'api': return cap?.target === 'app-boot' ? 'app-boot' : 'http';
    default: return null;
  }
}

/** The needs a set of ports serves. `app-boot` only when the host actually booted an app. */
export function scoutPortNeeds(ports: ScoutProbePorts): Set<ScoutHostNeed> {
  const out = new Set<ScoutHostNeed>();
  if (ports.command) out.add('command');
  if (ports.capture) out.add('capture');
  if (ports.http) out.add('http');
  if (ports.http?.appBaseUrl) out.add('app-boot');
  if (ports.spec) out.add('spec');
  if (ports.readiness) out.add('readiness');
  return out;
}

/**
 * Where each selected probe runs: `server` when this host's ports serve it,
 * `runner` when only a runner can and one is available, else `server` (where
 * the capability gate makes it `unsupported`). Skipped probes carry no host.
 */
export function assignScoutHosts(
  records: readonly ScoutProbeRecord[],
  profile: ScoutCapabilityProfile,
  serverNeeds: ReadonlySet<ScoutHostNeed>,
  runnerNeeds: ReadonlySet<ScoutHostNeed>,
): ScoutProbeRecord[] {
  return records.map((p) => {
    if (p.selection.status !== 'selected') return p;
    const need = scoutHostNeed(p.executor, profile);
    const host: ScoutProbeHost = need && !serverNeeds.has(need) && runnerNeeds.has(need) && SCOUT_RUNNER_NEEDS.includes(need) ? 'runner' : 'server';
    return Object.freeze({ ...p, host });
  });
}

export function clampRunnerDuration(ms: number | undefined): number {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.min(Math.floor(ms), MAX_SCOUT_MAX_DURATION_MS) : DEFAULT_SCOUT_RUNNER_MAX_DURATION_MS;
}

/** The lease a runner holds is its duration bound plus this; the deadline never cuts a held lease short. */
export const SCOUT_LEASE_SLACK_MS = 5 * 60_000;

export function clampHostDeadline(ms: number | undefined, runnerMaxDurationMs: number): number {
  const wanted = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.min(Math.floor(ms), MAX_SCOUT_HOST_DEADLINE_MS) : DEFAULT_SCOUT_HOST_DEADLINE_MS;
  return Math.max(wanted, runnerMaxDurationMs + SCOUT_LEASE_SLACK_MS);
}

// ── Plan ────────────────────────────────────────────────────────────────────

/** A claimed run with its contracts frozen, ready to execute. */
export interface ScoutPlannedRun {
  run: ScoutRun;
  profile: ScoutCapabilityProfile;
  records: ScoutProbeRecord[];
  /** Mutable: execute and finalize add their stage times and warnings. */
  summary: ScoutPlanSummary;
  startedAt: Date;
  maxDurationMs: number;
  /** Hosts were assigned (the run may park); false is a single-host run. */
  hosted: boolean;
}

function warner(summary: ScoutPlanSummary) {
  return (w: string) => { if (summary.warnings.length < MAX_WARNINGS) summary.warnings.push(w); };
}

function timer(now: () => Date, stages: Record<ScoutStage, ScoutStageMetric>) {
  return async <T>(stage: ScoutStage, fn: () => Promise<T>): Promise<T> => {
    const t = now().getTime();
    try {
      return await fn();
    } finally {
      stages[stage].ms += now().getTime() - t;
    }
  };
}

async function failRun(run: ScoutRun, err: unknown, deps: Pick<ScoutRunDeps, 'now' | 'ledger'>): Promise<Extract<ScoutRunOutcome, { status: 'failed' }>> {
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

/**
 * prior → claim → profile → signals → candidates → selection → contracts
 * saved, then (when `deps.runnerHost` is given) a host per selected probe.
 * Never throws: a failure after the claim fails the run and records it.
 */
export async function planScoutRun(
  req: ScoutRunRequest,
  deps: ScoutRunDeps,
): Promise<{ status: 'planned'; plan: ScoutPlannedRun } | Exclude<ScoutRunOutcome, { status: 'completed' | 'awaiting_host' }>> {
  if (req.mode === 'off') return { status: 'skipped', reason: 'mode_off', runId: null };
  const maxDurationMs = clampScoutDuration(req.maxDurationMs);
  const summary: ScoutPlanSummary = {
    candidatesGenerated: 0,
    candidatesTruncated: 0,
    decisionsAsked: 0,
    decisionFailures: 0,
    costCapHit: false,
    stages: emptyStages(),
    warnings: [],
    deadlineHit: false,
    reproducibility: {},
  };
  const warn = warner(summary);

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

  const timed = timer(deps.now, summary.stages);
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
    summary.candidatesGenerated = set.candidates.length;
    summary.candidatesTruncated = set.truncated;

    // Hosts: only when the caller can tell whether a runner is available.
    const hosted = typeof deps.runnerHost === 'function';
    const serverNeeds = scoutPortNeeds(deps.ports);
    let runnerNeeds: ReadonlySet<ScoutHostNeed> = new Set();
    if (hosted) {
      try {
        runnerNeeds = (await deps.runnerHost!()) ?? new Set();
      } catch (err) {
        warn(`runner availability unreadable, no runner assumed: ${message(err)}`);
      }
    }
    const hostable = hosted
      ? (c: ScoutProbeCandidate): string | null => {
        const need = scoutHostNeed(c.executor, profile);
        if (!need || serverNeeds.has(need) || runnerNeeds.has(need)) return null;
        return SCOUT_RUNNER_NEEDS.includes(need) ? 'no_runner_host' : `no_server_port:${need}`;
      }
      : undefined;

    const costBefore = deps.takeDecisionCost?.() ?? null;
    const maxCostUsd = run.budget.maxCostUsd;
    const selection = await timed('select', () =>
      selectScoutProbes(set, deps.decide, {
        budget: run.budget.maxProbes,
        ...(hostable ? { hostable } : {}),
        ...(maxCostUsd !== null && deps.takeDecisionCost
          ? {
              cost: {
                maxUsd: maxCostUsd,
                // Null means no receipt has carried a cost yet: nothing spent this run.
                spent: () => (deps.takeDecisionCost?.() ?? 0) - (costBefore ?? 0),
              },
            }
          : {}),
      }),
    );
    const costAfter = deps.takeDecisionCost?.() ?? null;
    summary.stages.select.costUsd = costAfter === null ? null : costAfter - (costBefore ?? 0);
    summary.decisionsAsked = selection.decisionsAsked;
    summary.decisionFailures = selection.decisionFailures;
    summary.costCapHit = selection.costCapHit;
    if (selection.costCapHit) {
      warn(`cost cap of $${maxCostUsd} reached during selection; ${selection.decisionsCapped} decision(s) answered by the fallback rule`);
    }

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
    if (hosted) records = assignScoutHosts(records, profile, serverNeeds, runnerNeeds);
    await deps.ledger.saveProbes(run, records);
    return { status: 'planned', plan: { run, profile, records, summary, startedAt, maxDurationMs, hosted } };
  } catch (err) {
    return failRun(run, err, deps);
  }
}

// ── Execute ─────────────────────────────────────────────────────────────────

export interface ScoutExecuteBounds {
  now(): Date;
  /** The run's clock: the time bound counts from here. */
  startedAt: Date;
  maxDurationMs: number;
  probeOptions?: Omit<ScoutRunProbeOptions, 'now'>;
  /** Execute only probes assigned to this host. Absent: every selected probe (a single-host run). */
  host?: ScoutProbeHost;
}

export interface ScoutExecuteResult {
  records: ScoutProbeRecord[];
  reproducibility: Record<string, ScoutReproducibility>;
  deadlineHit: boolean;
  ms: number;
  warnings: string[];
}

/**
 * Run the selected probes this host owns, in order, inside the time bound. A
 * probe already carrying a result is left alone. Never throws; a probe whose
 * port throws is warned about and left for finalize to mark `not_executed`.
 */
export async function executeScoutProbes(
  run: ScoutRun,
  records: readonly ScoutProbeRecord[],
  profile: ScoutCapabilityProfile,
  ports: ScoutProbePorts,
  bounds: ScoutExecuteBounds,
): Promise<ScoutExecuteResult> {
  const t0 = bounds.now().getTime();
  const executions = new Map<string, ScoutProbeExecution>();
  const warnings: string[] = [];
  let deadlineHit = false;
  for (const p of records) {
    if (p.selection.status !== 'selected' || p.result) continue;
    if (bounds.host && (p.host ?? 'server') !== bounds.host) continue;
    const left = bounds.maxDurationMs - (bounds.now().getTime() - bounds.startedAt.getTime());
    if (left <= 0) { deadlineHit = true; break; }
    try {
      const exec = await within(
        runScoutProbe(run, p, profile, ports, { attempts: DEFAULT_SCOUT_PROBE_ATTEMPTS, ...bounds.probeOptions, now: bounds.now }),
        left,
      );
      if (exec === TIMED_OUT) { deadlineHit = true; break; }
      executions.set(p.candidateId, exec);
    } catch (err) {
      if (warnings.length < MAX_WARNINGS) warnings.push(`probe ${p.candidateId}: ${message(err)}`);
    }
  }
  const reproducibility: Record<string, ScoutReproducibility> = {};
  for (const [id, e] of executions) reproducibility[id] = e.reproducibility;
  return {
    records: records.map((p) => {
      const probe = executions.get(p.candidateId)?.probe;
      // Keep the host the plan assigned; the executor does not know it.
      return probe ? (p.host ? Object.freeze({ ...probe, host: p.host }) : probe) : p;
    }),
    reproducibility,
    deadlineHit,
    ms: bounds.now().getTime() - t0,
    warnings,
  };
}

/** Fold one host's execution into the plan. */
export function mergeScoutExecution(plan: ScoutPlannedRun, ex: ScoutExecuteResult): void {
  plan.records = ex.records;
  plan.summary.stages.execute.ms += ex.ms;
  plan.summary.deadlineHit ||= ex.deadlineHit;
  Object.assign(plan.summary.reproducibility, ex.reproducibility);
  const warn = warner(plan.summary);
  for (const w of ex.warnings) warn(w);
}

// ── Park ────────────────────────────────────────────────────────────────────

const runnerProbesOf = (records: readonly ScoutProbeRecord[]) => records.filter((p) => p.selection.status === 'selected' && p.host === 'runner');

/**
 * Hand the runner-assigned probes over: save the server's results, freeze the
 * profile and plan on the row, set the deadline, leave the lease empty.
 */
export async function parkScoutRun(plan: ScoutPlannedRun, req: ScoutRunRequest, deps: Pick<ScoutRunDeps, 'now' | 'ledger'>): Promise<ScoutRunOutcome> {
  const now = deps.now();
  const runnerMaxDurationMs = clampRunnerDuration(req.host?.runnerMaxDurationMs);
  const hostDeadline = new Date(now.getTime() + clampHostDeadline(req.host?.hostDeadlineMs, runnerMaxDurationMs)).toISOString();
  const run: ScoutRun = {
    ...plan.run,
    status: 'awaiting_host',
    parking: {
      parkedAt: now.toISOString(),
      hostDeadline,
      runnerMaxDurationMs,
      profile: plan.profile,
      plan: plan.summary,
      lease: null,
      leaseLapses: 0,
    },
  };
  try {
    await deps.ledger.saveProbes(run, plan.records);
    await deps.ledger.saveRun(run);
  } catch (err) {
    return failRun(plan.run, err, deps);
  }
  return { status: 'awaiting_host', runId: run.id, runnerProbes: runnerProbesOf(plan.records).length, hostDeadline };
}

// ── Finalize ────────────────────────────────────────────────────────────────

export interface ScoutFinalizeInput {
  run: ScoutRun;
  records: readonly ScoutProbeRecord[];
  summary: ScoutPlanSummary;
  mode: Exclude<ScoutMode, 'off'>;
  policy?: ScoutActionPolicy;
  /** Set by the expiry sweep: how many runner probes it finalized `unsupported`, and why. */
  expiry?: { reason: ScoutHostExpiryReason; expired: number };
}

/**
 * completeScoutRun → probe results saved → findings → follow-up policy →
 * metrics → run saved. Every selected probe without a result ends
 * `inconclusive`/`not_executed`; nothing here turns a missing result into a
 * pass. Never throws.
 */
export async function finalizeScoutRun(
  input: ScoutFinalizeInput,
  deps: Pick<ScoutRunDeps, 'now' | 'ledger' | 'actions' | 'headSha'>,
): Promise<ScoutRunOutcome> {
  const { summary } = input;
  const policy = input.policy ?? DEFAULT_SCOUT_ACTION_POLICY;
  const warn = warner(summary);
  const timed = timer(deps.now, summary.stages);
  let run = input.run;
  try {
    const completed = completeScoutRun(run, input.records, {
      candidatesGenerated: summary.candidatesGenerated,
      costUsd: summary.stages.select.costUsd,
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
          let resolved: ScoutResolvedFinding[];
          try {
            resolved = await deps.ledger.resolveForPass(run, p);
          } catch (err) {
            warn(`resolve failed: ${message(err)}`);
            continue;
          }
          findings.resolved += resolved.length;
          // A resolved finding's follow-up is no longer owed.
          for (const f of resolved) {
            if (f.actionTaskId) actions[await retireScoutFollowUp(f, run, deps.actions)]++;
          }
          continue;
        }
        // inconclusive / unsupported: recorded on the probe row, never a defect.
        if (verdict !== 'fail') continue;
        const change = await recordScoutFailure(run, p, {
          store: deps.ledger.findings,
          now: deps.now,
          reproducibility: summary.reproducibility[p.candidateId] ?? 'unknown',
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
        const acted = await actOnScoutFinding(finding, run, { mode: input.mode, policy, now: deps.now() }, deps.actions);
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
    const stages = summary.stages;
    const stageCosts = SCOUT_STAGES.map((s) => stages[s].costUsd).filter((c): c is number => c !== null);
    const runnerProbes = runnerProbesOf(completed.probes).length;
    const metrics: ScoutRunMetrics = {
      candidatesGenerated: summary.candidatesGenerated,
      candidatesTruncated: summary.candidatesTruncated,
      probesSelected: selected.length,
      probesRun: selected.length - notExecuted,
      probesNotExecuted: notExecuted,
      decisionsAsked: summary.decisionsAsked,
      decisionFailures: summary.decisionFailures,
      costCapHit: summary.costCapHit,
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
      deadlineHit: summary.deadlineHit,
      warnings: summary.warnings,
      ...(runnerProbes > 0
        ? {
            hosts: {
              runnerProbes,
              runnerExpired: input.expiry?.expired ?? 0,
              expiryReason: input.expiry?.reason ?? null,
              awaitingHostMs: run.parking ? Math.max(0, deps.now().getTime() - Date.parse(run.parking.parkedAt)) : null,
            },
          }
        : {}),
    };
    await deps.ledger.saveRun(run, { ...completed.totals, costUsd: metrics.costUsd }, metrics);
    return { status: 'completed', runId: run.id, metrics };
  } catch (err) {
    return failRun(input.run, err, deps);
  }
}

/**
 * Finalize a parked run nobody finished: its unexecuted runner probes become
 * `unsupported` (`no_runner_claimed` / `runner_host_lost`), never `pass` and
 * never dropped; the server's own results stand. Returns null when the run is
 * not parked or not yet expired.
 */
export async function finalizeExpiredScoutRun(
  run: ScoutRun,
  records: readonly ScoutProbeRecord[],
  deps: Pick<ScoutRunDeps, 'now' | 'ledger' | 'actions' | 'headSha'>,
  opts: { policy?: ScoutActionPolicy } = {},
): Promise<ScoutRunOutcome | null> {
  if (run.status !== 'awaiting_host' || !run.parking) return null;
  const now = deps.now();
  const reason = scoutParkingExpiry(run.parking, now);
  if (!reason) return null;
  const expired = expireRunnerProbes(run, records, reason, now);
  const summary: ScoutPlanSummary = structuredClone(run.parking.plan);
  return finalizeScoutRun(
    { run, records: expired.probes, summary, mode: run.mode, policy: opts.policy, expiry: { reason, expired: expired.expired } },
    deps,
  );
}

// ── Compose ─────────────────────────────────────────────────────────────────

/**
 * Run one bounded Scout pass: plan → execute (this host) → finalize, or park
 * when probes are assigned to a runner. Without `deps.runnerHost` nothing is
 * assigned and nothing parks: a single-host run, as the dogfood script and a
 * `host: server` workspace get. Never throws.
 */
export async function runQualityScout(req: ScoutRunRequest, deps: ScoutRunDeps): Promise<ScoutRunOutcome> {
  const planned = await planScoutRun(req, deps);
  if (planned.status !== 'planned') return planned;
  const { plan } = planned;
  try {
    const ex = await executeScoutProbes(plan.run, plan.records, plan.profile, deps.ports, {
      now: deps.now,
      startedAt: plan.startedAt,
      maxDurationMs: plan.maxDurationMs,
      probeOptions: req.probeOptions,
      ...(plan.hosted ? { host: 'server' as const } : {}),
    });
    mergeScoutExecution(plan, ex);
  } catch (err) {
    return failRun(plan.run, err, deps);
  }
  if (plan.hosted && runnerProbesOf(plan.records).length > 0) return parkScoutRun(plan, req, deps);
  return finalizeScoutRun({ run: plan.run, records: plan.records, summary: plan.summary, mode: req.mode as Exclude<ScoutMode, 'off'>, policy: req.policy }, deps);
}
