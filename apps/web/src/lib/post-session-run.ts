/**
 * Post-session quality loop — Stage A collector (artifact
 * post-session-quality-loop-spec §4–§5).
 *
 * For one terminal worker: create its run row for the current policy version
 * (exactly once), collect the bounded Stage A facts, and record them — or
 * record why collection failed. {@link sweepPostSessionRuns} does that for
 * every recently terminal worker that has no run yet; a sweep sees success,
 * abort and failure paths alike. `post-session-loop.ts` schedules it.
 *
 * Invariants:
 *  - **Idempotent.** The run row is unique on (worker, policy version); a
 *    duplicate claim returns `duplicate` and does no work. Only a `failed` run
 *    under the attempt cap, or one stuck in `collecting` past the stale window,
 *    is claimed again, and every write is fenced on the attempt it belongs to.
 *  - **Out of band.** Nothing here writes the worker or the task. The store
 *    interface has no method that could.
 *  - **Never throws.** Every outcome is a returned status, so a caller on a
 *    cron path cannot be broken by this loop.
 *
 * After collecting, the sweep runs Stage B triage (`post-session-triage.ts`)
 * over every collected-but-untriaged run, so a triage that failed or was cut
 * short is picked up by the next sweep.
 *
 * The DB-backed store is `post-session-store.ts`, loaded lazily so this module
 * stays testable without a database.
 */

import {
  POST_SESSION_POLICY_VERSION,
  buildStageAFacts,
  isEligibleTerminalWorker,
  resolvePostSessionQualityMode,
  type IneligibleReason,
  type PostSessionFailureStage,
  type PostSessionQualityMode,
  type PostSessionRunState,
  type StageAFacts,
  type StageASource,
  type TranscriptAvailability,
} from '@buildd/core/post-session-quality';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import { triagePostSessionRun, type PostSessionTriageStore, type TriageCost, type TriageDeps } from './post-session-triage';

/** The eligibility + mode inputs for one worker. */
export interface PostSessionWorkerRef {
  id: string;
  status: string;
  startedAt: Date | null;
  exitCause: string | null;
  taskId: string | null;
  workspaceId: string;
  missionId: string | null;
  gitConfig: Pick<WorkspaceGitConfig, 'postSessionQuality'> | null;
}

export type ClaimRunResult =
  | { claimed: true; runId: string; attempt: number }
  | { claimed: false; runId: string; state: PostSessionRunState };

export interface PostSessionRunStore extends PostSessionTriageStore {
  loadWorker(workerId: string): Promise<PostSessionWorkerRef | null>;
  /** Insert-or-reclaim the run for (worker, policy version). Atomic. */
  claimRun(input: {
    workerId: string;
    taskId: string | null;
    workspaceId: string;
    missionId: string | null;
    policyVersion: string;
    mode: PostSessionQualityMode;
    now: Date;
  }): Promise<ClaimRunResult>;
  /** Read everything Stage A needs. Throws only when the core rows are unreadable. */
  loadSource(worker: PostSessionWorkerRef, mode: PostSessionQualityMode): Promise<StageASource>;
  /** Fenced on (state='collecting', attempts=attempt). false = lost the fence. */
  completeRun(runId: string, attempt: number, input: {
    facts: StageAFacts;
    transcriptAvailability: TranscriptAvailability;
    now: Date;
  }): Promise<boolean>;
  failRun(runId: string, attempt: number, input: {
    stage: PostSessionFailureStage;
    error: string;
    now: Date;
  }): Promise<void>;
  /** Recently terminal, eligible workers with no settled run for this version. */
  listCandidates(input: { policyVersion: string; since: Date; limit: number; now: Date }): Promise<string[]>;
}

export type ProcessPostSessionResult =
  | { status: 'collected'; runId: string }
  | { status: 'duplicate'; runId: string; state: PostSessionRunState }
  | { status: 'failed'; runId: string; error: string }
  | { status: 'fenced'; runId: string }
  | { status: 'ineligible'; reason: IneligibleReason }
  | { status: 'disabled' }
  | { status: 'missing' }
  | { status: 'error'; error: string };

const MAX_ERROR_CHARS = 500;

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > MAX_ERROR_CHARS ? msg.slice(0, MAX_ERROR_CHARS) : msg;
}

async function defaultStore(): Promise<PostSessionRunStore> {
  const mod = await import('./post-session-store');
  return mod.postSessionRunStore;
}

export async function processPostSessionRun(
  workerId: string,
  opts: { store?: PostSessionRunStore; now?: Date; policyVersion?: string } = {},
): Promise<ProcessPostSessionResult> {
  try {
    const store = opts.store ?? await defaultStore();
    const now = opts.now ?? new Date();
    const policyVersion = opts.policyVersion ?? POST_SESSION_POLICY_VERSION;

    const worker = await store.loadWorker(workerId);
    if (!worker) return { status: 'missing' };
    const eligibility = isEligibleTerminalWorker(worker);
    if (!eligibility.eligible) return { status: 'ineligible', reason: eligibility.reason };
    const mode = resolvePostSessionQualityMode(worker.gitConfig);
    if (mode === 'off') return { status: 'disabled' };

    const claim = await store.claimRun({
      workerId: worker.id,
      taskId: worker.taskId,
      workspaceId: worker.workspaceId,
      missionId: worker.missionId,
      policyVersion,
      mode,
      now,
    });
    if (!claim.claimed) return { status: 'duplicate', runId: claim.runId, state: claim.state };

    try {
      const source = await store.loadSource(worker, mode);
      const facts = buildStageAFacts(source);
      const ok = await store.completeRun(claim.runId, claim.attempt, {
        facts,
        transcriptAvailability: source.transcript.availability,
        now,
      });
      return ok ? { status: 'collected', runId: claim.runId } : { status: 'fenced', runId: claim.runId };
    } catch (err) {
      const error = errorText(err);
      await store.failRun(claim.runId, claim.attempt, { stage: 'collect', error, now }).catch(() => {});
      return { status: 'failed', runId: claim.runId, error };
    }
  } catch (err) {
    return { status: 'error', error: errorText(err) };
  }
}

/** How far back a sweep looks. Bounds the first run after deploy, too. */
export const POST_SESSION_SWEEP_LOOKBACK_MS = 48 * 60 * 60 * 1000;
export const POST_SESSION_SWEEP_LIMIT = 50;

export interface PostSessionSweepSummary {
  candidates: number;
  collected: number;
  duplicate: number;
  failed: number;
  skipped: number;
  errors: number;
  /** Candidates not started because the time budget ran out; the next sweep takes them. */
  deferred: number;
  /** Stage B: runs given a final decision this sweep. */
  triaged: number;
  /** ...of which routed to deeper analysis (model or hard trigger). */
  selected: number;
  /** ...of which a mechanical hard trigger fired, whatever the model said. */
  hardTriggered: number;
  /** ...of which the decision itself was unavailable (fail-open). */
  triageUnavailable: number;
  triageErrors: number;
  triageDeferred: number;
  /** Summed over every decision call this sweep. */
  triageCost: TriageCost;
}

export async function sweepPostSessionRuns(opts: {
  store?: PostSessionRunStore;
  now?: Date;
  limit?: number;
  lookbackMs?: number;
  policyVersion?: string;
  /** Stage B seams (decision call, receipt writer). */
  triage?: Pick<TriageDeps, 'decisionDeps' | 'recordReceipts'>;
  /** Checked before each item; false = stop starting work (time budget spent). */
  shouldContinue?: () => boolean;
} = {}): Promise<PostSessionSweepSummary> {
  const summary: PostSessionSweepSummary = {
    candidates: 0, collected: 0, duplicate: 0, failed: 0, skipped: 0, errors: 0, deferred: 0,
    triaged: 0, selected: 0, hardTriggered: 0, triageUnavailable: 0, triageErrors: 0, triageDeferred: 0,
    triageCost: { calls: 0, usd: null, inputTokens: 0, outputTokens: 0 },
  };
  const shouldContinue = opts.shouldContinue ?? (() => true);
  let store: PostSessionRunStore;
  let ids: string[];
  const now = opts.now ?? new Date();
  const policyVersion = opts.policyVersion ?? POST_SESSION_POLICY_VERSION;
  try {
    store = opts.store ?? await defaultStore();
    ids = await store.listCandidates({
      policyVersion,
      since: new Date(now.getTime() - (opts.lookbackMs ?? POST_SESSION_SWEEP_LOOKBACK_MS)),
      limit: opts.limit ?? POST_SESSION_SWEEP_LIMIT,
      now,
    });
  } catch {
    summary.errors++;
    return summary;
  }
  summary.candidates = ids.length;
  // Sequential: a sweep is background work, and a burst of parallel reads per
  // worker is exactly the Neon load this loop must not add.
  for (const [i, id] of ids.entries()) {
    if (!shouldContinue()) {
      summary.deferred = ids.length - i;
      break;
    }
    const res = await processPostSessionRun(id, { store, now, policyVersion });
    if (res.status === 'collected') summary.collected++;
    else if (res.status === 'duplicate' || res.status === 'fenced') summary.duplicate++;
    else if (res.status === 'failed') summary.failed++;
    else if (res.status === 'error') summary.errors++;
    else summary.skipped++;
  }

  // Stage B over everything collected and not yet triaged — this sweep's runs
  // and any a previous sweep collected but did not finish triaging.
  let untriaged: string[];
  try {
    untriaged = await store.listUntriaged({ policyVersion, limit: opts.limit ?? POST_SESSION_SWEEP_LIMIT });
  } catch {
    summary.triageErrors++;
    return summary;
  }
  for (const [i, runId] of untriaged.entries()) {
    if (!shouldContinue()) {
      summary.triageDeferred = untriaged.length - i;
      break;
    }
    const res = await triagePostSessionRun(runId, { ...opts.triage, store, now });
    if (res.status === 'triaged') {
      summary.triaged++;
      if (res.finalDecision === 'analyse') summary.selected++;
      if (res.hardTriggered) summary.hardTriggered++;
      if (res.triageStatus === 'unavailable') summary.triageUnavailable++;
      addCost(summary.triageCost, res.cost);
    } else if (res.status === 'error') {
      summary.triageErrors++;
    }
  }
  return summary;
}

function addCost(into: TriageCost, c: TriageCost): void {
  into.calls += c.calls;
  into.inputTokens += c.inputTokens;
  into.outputTokens += c.outputTokens;
  if (c.usd !== null) into.usd = Number(((into.usd ?? 0) + c.usd).toFixed(8));
}
