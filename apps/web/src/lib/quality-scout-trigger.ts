/**
 * When a Quality Scout run starts, and on what host (artifact
 * workspace-quality-scout-spec §11–§12).
 *
 * Three triggers, all opt-in through `gitConfig.qualityScout`:
 *  - **manual** — the owner asks (`POST /api/workspaces/[id]/quality-scout`).
 *    Allowed whenever the mode is not `off`.
 *  - **mission-candidate** — a mission's integration branch just became a
 *    candidate (its PR into trunk opened). On by default once a mode is set;
 *    `triggers.missionCandidate: false` turns it off.
 *  - **periodic** — only when `triggers.periodicHours` is set. Rides the
 *    hourly schedules tick; no daily cadence is assumed.
 *
 * Every trigger is fail-open and fire-and-forget for its caller: a Scout run
 * never delays, fails or blocks the mission PR, the cron tick or a release.
 * Automatic triggers on the same SHA share one run row (see `scoutRunId`), so
 * a mission trigger and a periodic tick never exercise one commit twice.
 *
 * The server host is deliberately thin. It has no sandbox, so it offers no
 * command port (those probes are `unsupported`, honestly); it sends read-only
 * HTTP to a declared test environment and reads readiness at the candidate
 * SHA. A browser capture takes longer than a server run may live, so surface
 * probes are left to a runner-hosted run that passes its own ports.
 */

import { db } from '@buildd/core/db';
import { qualityScoutFindings, qualityScoutProbes, qualityScoutRuns, workspaces, type WorkspaceGitConfig, type WorkspaceReleaseConfig } from '@buildd/core/db/schema';
import { and, desc, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import type { DecisionReceipt } from '@builddai/ai-kit/decide';
import { computeReadiness } from '@buildd/core/workspace-readiness';
import { discoverScoutCapabilities } from '@buildd/core/scout-capabilities';
import type { ScoutSignals } from '@buildd/core/quality-scout/candidates';
import type { ScoutHttpRequest, ScoutHttpResponse, ScoutProbePorts } from '@buildd/core/quality-scout/executors';
import {
  dbScoutFindingStore,
  latestScoutRun,
  resolveScoutFindingsForPass,
  resolveScoutMode,
  saveScoutProbes,
  saveScoutRun,
  scoutRunRow,
} from '@buildd/core/quality-scout/ledger';
import { createScoutProbeDecider } from '@buildd/core/quality-scout/selector';
import type { ScoutMode, ScoutRunTrigger } from '@buildd/core/quality-scout/types';
import { githubApi } from '@/lib/github';
import { scheduleAfter, insertDecisionReceipts } from '@/lib/memory-decisions';
import { gatherReadinessInput } from '@/lib/workspace-readiness-io';
import { dbScoutActionStore, resolveScoutActionPolicy, type ScoutActionPolicy } from './quality-scout-actions';
import {
  clampScoutDuration,
  runQualityScout,
  type ScoutRunDeps,
  type ScoutRunLedger,
  type ScoutRunOutcome,
  type ScoutRunRequest,
} from './quality-scout-run';

// ── Config ──────────────────────────────────────────────────────────────────

/** A server-hosted run never outlives a serverless invocation. */
export const SERVER_SCOUT_MAX_DURATION_MS = 4 * 60_000;
export const DEFAULT_SERVER_SCOUT_DURATION_MS = 2 * 60_000;
const MIN_PERIODIC_HOURS = 1;
const MAX_PERIODIC_HOURS = 24 * 30;
/** Manual double-taps inside one bucket are one run; a deliberate re-run later is another. */
const MANUAL_BUCKET_MS = 10 * 60_000;

export interface ScoutTriggerConfig {
  mode: ScoutMode;
  missionCandidate: boolean;
  /** Null: never periodic. */
  periodicHours: number | null;
  budget: { maxProbes?: number; maxCostUsd?: number | null };
  maxDurationMs: number;
  policy: ScoutActionPolicy;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The one place `gitConfig.qualityScout` trigger/budget fields are read. Never throws. */
export function resolveScoutTriggerConfig(raw: unknown): ScoutTriggerConfig {
  const c = isRecord(raw) ? raw : {};
  const triggers = isRecord(c.triggers) ? c.triggers : {};
  const budget = isRecord(c.budget) ? c.budget : {};
  const hours = triggers.periodicHours;
  return {
    mode: resolveScoutMode(raw),
    missionCandidate: triggers.missionCandidate !== false,
    periodicHours: finite(hours) && hours >= MIN_PERIODIC_HOURS && hours <= MAX_PERIODIC_HOURS ? hours : null,
    budget: {
      ...(finite(budget.maxProbes) ? { maxProbes: budget.maxProbes } : {}),
      ...(finite(budget.maxCostUsd) ? { maxCostUsd: budget.maxCostUsd } : {}),
    },
    maxDurationMs: Math.min(
      clampScoutDuration(finite(budget.maxDurationMs) ? budget.maxDurationMs : DEFAULT_SERVER_SCOUT_DURATION_MS),
      SERVER_SCOUT_MAX_DURATION_MS,
    ),
    policy: resolveScoutActionPolicy(raw),
  };
}

/** Is a periodic run owed? Only when configured, and the last run started at least `periodicHours` ago. */
export function isPeriodicScoutDue(cfg: ScoutTriggerConfig, lastStartedAt: Date | null, now: Date): boolean {
  if (cfg.mode === 'off' || cfg.periodicHours === null) return false;
  if (!lastStartedAt) return true;
  return now.getTime() - lastStartedAt.getTime() >= cfg.periodicHours * 3_600_000;
}

export function manualDedupeKey(now: Date): string {
  return String(Math.floor(now.getTime() / MANUAL_BUCKET_MS));
}

// ── Trigger ─────────────────────────────────────────────────────────────────

export interface ScoutWorkspace {
  id: string;
  teamId: string;
  gitConfig: WorkspaceGitConfig | null;
  configStatus: 'unconfigured' | 'admin_confirmed';
  releaseConfig: WorkspaceReleaseConfig | null;
  githubRepo: { fullName: string; defaultBranch?: string | null; installation: { installationId: number } | null } | null;
}

export interface ScoutTriggerInput {
  workspaceId: string;
  trigger: Exclude<ScoutRunTrigger, 'pre-release'>;
  missionId?: string | null;
  /** Defaults to the workspace's default branch. */
  ref?: string | null;
  /** Defaults to the ref's current head. */
  sha?: string | null;
}

export type ScoutTriggerOutcome =
  | ScoutRunOutcome
  | { status: 'skipped'; reason: 'no_workspace' | 'trigger_disabled' | 'no_repo' | 'no_candidate_sha'; runId: null };

export interface ScoutTriggerDeps {
  now(): Date;
  loadWorkspace(id: string): Promise<ScoutWorkspace | null>;
  headSha(ws: ScoutWorkspace, ref: string): Promise<string | null>;
  buildRunDeps(ws: ScoutWorkspace, req: ScoutRunRequest): ScoutRunDeps;
  run(req: ScoutRunRequest, deps: ScoutRunDeps): Promise<ScoutRunOutcome>;
}

export function defaultBranchOf(ws: ScoutWorkspace): string {
  return ws.gitConfig?.defaultBranch || ws.githubRepo?.defaultBranch || 'main';
}

/** Decide, resolve the candidate, and run. Never throws. */
export async function triggerQualityScout(input: ScoutTriggerInput, deps: ScoutTriggerDeps = serverScoutTriggerDeps): Promise<ScoutTriggerOutcome> {
  try {
    const ws = await deps.loadWorkspace(input.workspaceId);
    if (!ws) return { status: 'skipped', reason: 'no_workspace', runId: null };
    const cfg = resolveScoutTriggerConfig(ws.gitConfig?.qualityScout);
    if (cfg.mode === 'off') return { status: 'skipped', reason: 'mode_off', runId: null };
    if (input.trigger === 'mission-candidate' && !cfg.missionCandidate) return { status: 'skipped', reason: 'trigger_disabled', runId: null };
    if (input.trigger === 'periodic' && cfg.periodicHours === null) return { status: 'skipped', reason: 'trigger_disabled', runId: null };
    if (!ws.githubRepo?.installation) return { status: 'skipped', reason: 'no_repo', runId: null };

    const ref = input.ref?.trim() || defaultBranchOf(ws);
    const sha = input.sha?.trim() || (await deps.headSha(ws, ref));
    if (!sha) return { status: 'skipped', reason: 'no_candidate_sha', runId: null };

    const req: ScoutRunRequest = {
      workspaceId: ws.id,
      missionId: input.missionId ?? null,
      trigger: input.trigger,
      mode: cfg.mode,
      candidate: { ref, sha },
      budget: cfg.budget,
      maxDurationMs: cfg.maxDurationMs,
      policy: cfg.policy,
      ...(input.trigger === 'manual' ? { dedupeKey: manualDedupeKey(deps.now()) } : {}),
    };
    return await deps.run(req, deps.buildRunDeps(ws, req));
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn('[quality-scout] trigger failed (non-fatal):', error);
    return { status: 'failed', runId: null, error };
  }
}

/**
 * The mission-candidate hook: called once a mission's integration branch has
 * an open PR into trunk. Returns immediately; the run happens after the
 * caller's response, and its failure is only logged.
 */
export function scheduleMissionCandidateScout(
  args: { missionId: string; workspaceId: string; ref: string; sha?: string | null },
  schedule: (task: () => Promise<unknown>) => void = scheduleAfter,
): void {
  // Inert under unit tests unless a test passes its own scheduler: the callers'
  // suites mock the DB, and a background run against those mocks is noise.
  if (process.env.NODE_ENV === 'test' && schedule === scheduleAfter) return;
  schedule(async () => {
    const out = await triggerQualityScout({ trigger: 'mission-candidate', ...args });
    if (out.status !== 'skipped' || out.reason !== 'mode_off') {
      console.log(`[quality-scout] mission ${args.missionId.slice(0, 8)} candidate run: ${out.status}${'reason' in out ? ` (${out.reason})` : ''}`);
    }
  });
}

export interface PeriodicScoutSweep {
  configured: number;
  due: number;
  scheduled: string[];
  errors: number;
}

/**
 * The periodic hook, on the hourly schedules tick: find workspaces that asked
 * for a periodic run and are due, and start at most `maxWorkspaces` of them
 * after the tick responds. Cheap when nobody opted in: one indexed query.
 */
export async function runPeriodicQualityScouts(
  now: Date,
  opts: { maxWorkspaces?: number; schedule?: (task: () => Promise<unknown>) => void } = {},
): Promise<PeriodicScoutSweep> {
  const out: PeriodicScoutSweep = { configured: 0, due: 0, scheduled: [], errors: 0 };
  const schedule = opts.schedule ?? scheduleAfter;
  const max = opts.maxWorkspaces ?? 3;
  const rows = await db.select({ id: workspaces.id, gitConfig: workspaces.gitConfig }).from(workspaces)
    .where(isNotNull(sql`${workspaces.gitConfig} -> 'qualityScout' -> 'triggers' -> 'periodicHours'`));
  for (const row of rows) {
    const cfg = resolveScoutTriggerConfig(row.gitConfig?.qualityScout);
    if (cfg.mode === 'off' || cfg.periodicHours === null) continue;
    out.configured++;
    try {
      const [last] = await db.select({ startedAt: qualityScoutRuns.startedAt }).from(qualityScoutRuns)
        .where(eq(qualityScoutRuns.workspaceId, row.id))
        .orderBy(desc(qualityScoutRuns.startedAt))
        .limit(1);
      if (!isPeriodicScoutDue(cfg, last?.startedAt ?? null, now)) continue;
      out.due++;
      if (out.scheduled.length >= max) continue;
      out.scheduled.push(row.id);
      schedule(() => triggerQualityScout({ workspaceId: row.id, trigger: 'periodic' }));
    } catch (err) {
      out.errors++;
      console.warn('[quality-scout] periodic check failed (non-fatal):', err instanceof Error ? err.message : err);
    }
  }
  return out;
}

// ── DB-backed run ledger ────────────────────────────────────────────────────

export const dbScoutRunLedger: ScoutRunLedger = {
  async latestRun(workspaceId, ref) {
    const row = await latestScoutRun(workspaceId, ref);
    return row ? { id: row.id, sha: row.sha } : null;
  },
  async claimRun(run, staleBefore) {
    const row = scoutRunRow(run);
    const inserted = await db.insert(qualityScoutRuns).values(row).onConflictDoNothing({ target: qualityScoutRuns.id })
      .returning({ id: qualityScoutRuns.id });
    if (inserted.length > 0) return 'claimed';
    // Take over a failed attempt, or one whose host died mid-run. Atomic: two
    // takers race on this WHERE and one gets the row.
    const { id: _id, workspaceId: _ws, ...rest } = row;
    const taken = await db.update(qualityScoutRuns).set({ ...rest, metrics: null, error: null })
      .where(and(
        eq(qualityScoutRuns.id, run.id),
        or(eq(qualityScoutRuns.status, 'failed'), and(eq(qualityScoutRuns.status, 'running'), lt(qualityScoutRuns.startedAt, staleBefore))),
      ))
      .returning({ id: qualityScoutRuns.id });
    if (taken.length === 0) return 'duplicate';
    // The earlier attempt's contracts are not this attempt's.
    await db.delete(qualityScoutProbes).where(eq(qualityScoutProbes.runId, run.id));
    return 'claimed';
  },
  saveRun: saveScoutRun,
  saveProbes: saveScoutProbes,
  findings: dbScoutFindingStore,
  resolveForPass: (run, probe) => resolveScoutFindingsForPass(run, probe),
};

// ── Server host ─────────────────────────────────────────────────────────────

const MAX_BODY_EXCERPT = 2_000;
const MAX_CHANGED_FILES = 300;
const READ_ONLY = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Read-only HTTP to the declared test environment. A write method is refused
 * here as well as by the planner. The exchange is recorded on the run's probe
 * row (`result.observed`), which is what the evidence ref names.
 */
export function serverHttpPort(fetchImpl: typeof fetch = fetch): NonNullable<ScoutProbePorts['http']> {
  return {
    appBaseUrl: null,
    async request(req: ScoutHttpRequest): Promise<ScoutHttpResponse> {
      if (!READ_ONLY.has(req.method.toUpperCase())) return { status: null };
      const started = Date.now();
      try {
        const res = await fetchImpl(req.url, { method: req.method, redirect: 'follow', signal: AbortSignal.timeout(req.timeoutMs) });
        const body = req.method.toUpperCase() === 'HEAD' ? '' : await res.text();
        return {
          status: res.status,
          finalUrl: res.url || req.url,
          bodyExcerpt: body.slice(0, MAX_BODY_EXCERPT),
          durationMs: Date.now() - started,
          evidenceRef: `scout-probe-row:${req.method.toUpperCase()} ${new URL(req.url).pathname}`,
        };
      } catch {
        return { status: null, durationMs: Date.now() - started };
      }
    },
  };
}

async function compareChangedPaths(ws: ScoutWorkspace, base: string, head: string): Promise<string[]> {
  const repo = ws.githubRepo!;
  const data = await githubApi(repo.installation!.installationId, `/repos/${repo.fullName}/compare/${base}...${head}`);
  const files = Array.isArray(data?.files) ? data.files : [];
  return files.slice(0, MAX_CHANGED_FILES).map((f: { filename?: string }) => f.filename).filter((p: unknown): p is string => typeof p === 'string');
}

async function priorSevereFindings(workspaceId: string): Promise<NonNullable<ScoutSignals['priorFindings']>> {
  const rows = await db.select({
    signature: qualityScoutFindings.signature,
    severity: qualityScoutFindings.severity,
    family: qualityScoutFindings.family,
    invariant: qualityScoutFindings.invariant,
  }).from(qualityScoutFindings)
    .where(and(
      eq(qualityScoutFindings.workspaceId, workspaceId),
      eq(qualityScoutFindings.state, 'open'),
      inArray(qualityScoutFindings.severity, ['critical', 'high']),
    ))
    .orderBy(desc(qualityScoutFindings.lastSeenAt))
    .limit(20);
  return rows;
}

/** The workspace's readiness, read at an exact commit instead of the branch tip. */
function atSha(ws: ScoutWorkspace, sha: string) {
  return { ...ws, gitConfig: { ...(ws.gitConfig ?? {}), defaultBranch: sha } as WorkspaceGitConfig };
}

export function buildServerScoutRunDeps(ws: ScoutWorkspace, req: ScoutRunRequest): ScoutRunDeps {
  let decisionCost: number | null = null;
  const receipts: Promise<void>[] = [];
  const decide = createScoutProbeDecider({
    teamId: ws.teamId,
    workspaceId: ws.id,
    missionId: req.missionId ?? null,
    onUsage: (receipt: DecisionReceipt) => {
      const c = receipt.usage?.costUsd;
      if (typeof c === 'number' && Number.isFinite(c)) decisionCost = (decisionCost ?? 0) + c;
      receipts.push(insertDecisionReceipts([receipt], { teamId: ws.teamId }).catch(() => {}));
    },
  });
  const sha = req.candidate.sha;
  return {
    now: () => new Date(),
    loadProfile: async () => {
      const readiness = computeReadiness(await gatherReadinessInput(atSha(ws, sha)));
      return discoverScoutCapabilities({ readiness, extension: ws.gitConfig?.qualityScout });
    },
    gatherSignals: async ({ candidate, prior }) => {
      const [changedPaths, priorFindings] = await Promise.all([
        prior && prior.sha !== candidate.sha ? compareChangedPaths(ws, prior.sha, candidate.sha) : Promise.resolve([]),
        priorSevereFindings(ws.id),
      ]);
      return { candidateRef: candidate.ref, priorRef: prior?.sha ?? null, changedPaths, priorFindings };
    },
    decide,
    takeDecisionCost: () => decisionCost,
    ports: {
      http: serverHttpPort(),
      readiness: {
        async read({ sha: at }) {
          const report = computeReadiness(await gatherReadinessInput(atSha(ws, at)));
          return { report, evidenceRef: `readiness@${at}` };
        },
      },
    },
    ledger: dbScoutRunLedger,
    actions: dbScoutActionStore,
    headSha: () => serverHeadSha(ws, req.candidate.ref),
  };
}

export async function serverHeadSha(ws: ScoutWorkspace, ref: string): Promise<string | null> {
  const repo = ws.githubRepo;
  if (!repo?.installation) return null;
  try {
    const data = await githubApi(repo.installation.installationId, `/repos/${repo.fullName}/commits/${encodeURIComponent(ref)}`);
    return typeof data?.sha === 'string' ? data.sha : null;
  } catch {
    return null;
  }
}

export async function loadScoutWorkspace(id: string): Promise<ScoutWorkspace | null> {
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, id),
    columns: { id: true, teamId: true, gitConfig: true, configStatus: true, releaseConfig: true },
    with: { githubRepo: { with: { installation: true } } },
  });
  if (!ws || !ws.teamId) return null;
  return {
    id: ws.id,
    teamId: ws.teamId,
    gitConfig: ws.gitConfig,
    configStatus: ws.configStatus,
    releaseConfig: ws.releaseConfig,
    githubRepo: ws.githubRepo
      ? {
          fullName: ws.githubRepo.fullName,
          defaultBranch: ws.githubRepo.defaultBranch ?? null,
          installation: ws.githubRepo.installation ? { installationId: ws.githubRepo.installation.installationId } : null,
        }
      : null,
  };
}

export const serverScoutTriggerDeps: ScoutTriggerDeps = {
  now: () => new Date(),
  loadWorkspace: loadScoutWorkspace,
  headSha: serverHeadSha,
  buildRunDeps: buildServerScoutRunDeps,
  run: runQualityScout,
};
