/**
 * The Quality Scout operational readout (artifact workspace-quality-scout-spec
 * §12, §16): what state was last exercised, whether newer work makes it stale
 * (per ref and per probe family), what the recent runs cost and found, and
 * where the findings stand.
 *
 * `buildScoutReadout` is pure; `loadScoutReadout` reads the three Scout tables
 * and the refs' current heads. Read-only — nothing here writes.
 */

import { db } from '@buildd/core/db';
import { qualityScoutFindings, qualityScoutProbes, qualityScoutRuns } from '@buildd/core/db/schema';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import {
  SCOUT_ACTION_STATES,
  type ScoutActionState,
  type ScoutMode,
  type ScoutProbeFamily,
  type ScoutRunMetrics,
  type ScoutRunStatus,
  type ScoutRunTrigger,
} from '@buildd/core/quality-scout/types';
import { VERIFICATION_SEVERITIES, type VerificationSeverity, type VerificationVerdict } from '@buildd/core/verification-check';

export const SCOUT_READOUT_RUN_LIMIT = 30;

export interface ScoutRunSummary {
  id: string;
  trigger: ScoutRunTrigger;
  mode: string;
  status: ScoutRunStatus;
  ref: string;
  sha: string;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  metrics: ScoutRunMetrics | null;
}

export interface ScoutRefReadout {
  ref: string;
  lastRun: ScoutRunSummary;
  /** The last run that completed on this ref — what was actually exercised. */
  lastCompleted: ScoutRunSummary | null;
  headSha: string | null;
  staleness: 'fresh' | 'stale' | 'unknown';
  /** Since the last completed run ended. */
  sinceExercisedMs: number | null;
  /** Per family: the newest SHA a probe of that family actually judged (pass or fail). */
  familiesExercised: Partial<Record<ScoutProbeFamily, string>>;
  /** Families whose newest judged SHA is not the head. */
  staleFamilies: ScoutProbeFamily[];
}

export interface ScoutReadout {
  workspaceId: string;
  mode: ScoutMode;
  refs: ScoutRefReadout[];
  recent: ScoutRunSummary[];
  totals: {
    runs: number;
    completed: number;
    failed: number;
    running: number;
    /** Findings first seen by these runs: the "validated new defects" numerator. */
    newDefects: number;
    newDefectsPerRun: number | null;
    actionable: number;
    dedupeSuppressed: number;
    costUsd: number | null;
  };
  findings: {
    open: number;
    openBySeverity: Record<VerificationSeverity, number>;
    openByAction: Record<ScoutActionState, number>;
    resolved: number;
    dismissed: number;
  };
}

export interface ScoutReadoutInput {
  workspaceId: string;
  mode: ScoutMode;
  /** Newest first. */
  runs: ScoutRunSummary[];
  /** Judged probes of those runs. */
  probes: Array<{ runId: string; family: ScoutProbeFamily; verdict: VerificationVerdict | null }>;
  heads: Record<string, string | null>;
  findings: Array<{ severity: VerificationSeverity; state: string; actionState: ScoutActionState }>;
  now: Date;
}

const zero = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

export function buildScoutReadout(input: ScoutReadoutInput): ScoutReadout {
  const runs = [...input.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const runById = new Map(runs.map((r) => [r.id, r]));

  const refs: ScoutRefReadout[] = [];
  for (const ref of [...new Set(runs.map((r) => r.ref))]) {
    const onRef = runs.filter((r) => r.ref === ref);
    const lastCompleted = onRef.find((r) => r.status === 'completed') ?? null;
    const headSha = input.heads[ref] ?? null;
    const familiesExercised: Partial<Record<ScoutProbeFamily, { sha: string; at: string }>> = {};
    for (const p of input.probes) {
      const run = runById.get(p.runId);
      if (!run || run.ref !== ref || run.status !== 'completed') continue;
      if (p.verdict !== 'pass' && p.verdict !== 'fail') continue;
      const cur = familiesExercised[p.family];
      if (!cur || run.startedAt > cur.at) familiesExercised[p.family] = { sha: run.sha, at: run.startedAt };
    }
    const exercised = Object.fromEntries(Object.entries(familiesExercised).map(([f, v]) => [f, v!.sha])) as Partial<Record<ScoutProbeFamily, string>>;
    refs.push({
      ref,
      lastRun: onRef[0],
      lastCompleted,
      headSha,
      staleness: !lastCompleted || !headSha ? 'unknown' : lastCompleted.sha === headSha ? 'fresh' : 'stale',
      sinceExercisedMs: lastCompleted?.completedAt ? input.now.getTime() - Date.parse(lastCompleted.completedAt) : null,
      familiesExercised: exercised,
      staleFamilies: headSha ? (Object.keys(exercised) as ScoutProbeFamily[]).filter((f) => exercised[f] !== headSha).sort() : [],
    });
  }

  const completed = runs.filter((r) => r.status === 'completed');
  const metrics = completed.map((r) => r.metrics).filter((m): m is ScoutRunMetrics => m !== null);
  const costs = metrics.map((m) => m.costUsd).filter((c): c is number => c !== null);
  const newDefects = metrics.reduce((n, m) => n + m.findings.created, 0);

  const open = input.findings.filter((f) => f.state === 'open');
  const openBySeverity = zero(VERIFICATION_SEVERITIES);
  const openByAction = zero(SCOUT_ACTION_STATES);
  for (const f of open) {
    openBySeverity[f.severity]++;
    openByAction[f.actionState]++;
  }

  return {
    workspaceId: input.workspaceId,
    mode: input.mode,
    refs,
    recent: runs,
    totals: {
      runs: runs.length,
      completed: completed.length,
      failed: runs.filter((r) => r.status === 'failed').length,
      running: runs.filter((r) => r.status === 'running').length,
      newDefects,
      newDefectsPerRun: metrics.length > 0 ? newDefects / metrics.length : null,
      actionable: metrics.reduce((n, m) => n + m.actionable, 0),
      dedupeSuppressed: metrics.reduce((n, m) => n + m.dedupeSuppressed, 0),
      costUsd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null,
    },
    findings: {
      open: open.length,
      openBySeverity,
      openByAction,
      resolved: input.findings.filter((f) => f.state === 'resolved').length,
      dismissed: input.findings.filter((f) => f.state === 'dismissed').length,
    },
  };
}

/** Read the recent runs, their judged probes, the findings and each ref's head; build the readout. */
export async function loadScoutReadout(
  workspaceId: string,
  opts: { mode: ScoutMode; headSha: (ref: string) => Promise<string | null>; now?: Date },
): Promise<ScoutReadout> {
  const rows = await db.select().from(qualityScoutRuns)
    .where(eq(qualityScoutRuns.workspaceId, workspaceId))
    .orderBy(desc(qualityScoutRuns.startedAt))
    .limit(SCOUT_READOUT_RUN_LIMIT);
  const runs: ScoutRunSummary[] = rows.map((r) => ({
    id: r.id,
    trigger: r.trigger,
    mode: r.mode,
    status: r.status,
    ref: r.candidateRef,
    sha: r.candidateSha,
    startedAt: r.startedAt.toISOString(),
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    error: r.error,
    metrics: r.metrics ?? null,
  }));
  const ids = runs.map((r) => r.id);
  const [probes, findings, heads] = await Promise.all([
    ids.length > 0
      ? db.select({ runId: qualityScoutProbes.runId, family: qualityScoutProbes.family, verdict: qualityScoutProbes.verdict })
        .from(qualityScoutProbes)
        .where(and(inArray(qualityScoutProbes.runId, ids), isNotNull(qualityScoutProbes.verdict)))
      : Promise.resolve([]),
    db.select({ severity: qualityScoutFindings.severity, state: qualityScoutFindings.state, actionState: qualityScoutFindings.actionState })
      .from(qualityScoutFindings)
      .where(eq(qualityScoutFindings.workspaceId, workspaceId)),
    Promise.all([...new Set(runs.map((r) => r.ref))].map(async (ref) => [ref, await opts.headSha(ref).catch(() => null)] as const)),
  ]);
  return buildScoutReadout({
    workspaceId,
    mode: opts.mode,
    runs,
    probes,
    heads: Object.fromEntries(heads),
    findings,
    now: opts.now ?? new Date(),
  });
}
