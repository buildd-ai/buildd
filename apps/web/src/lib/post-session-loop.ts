/**
 * Post-session quality loop — the scheduled entry point (artifact
 * `post-session-quality-loop-spec` §4, §11–§12).
 *
 * One bounded pass over the loop, in stage order:
 *  1. collect + triage (`sweepPostSessionRuns`): every recently terminal
 *     worker — completed, failed, aborted, superseded — gets one run per policy
 *     version, then a skip/analyse decision.
 *  2. analyse + act (`recordTriagedRuns`): the selected runs are analysed
 *     read-only, folded into the finding ledger, and the action policy runs.
 *
 * Runtime mode is per workspace (`gitConfig.postSessionQuality.mode`, absent ⇒
 * shadow): `off` keeps a workspace out of every queue, `shadow` does everything
 * but file, `propose` files deduped follow-ups. `POST_SESSION_QUALITY_ENABLED=0`
 * turns the whole loop off for the deploy.
 *
 * Out of band by construction: it reads finished workers from a cron, writes
 * only its own ledger rows and follow-ups, and holds nothing that completion,
 * review, merge or release wait on. Every stage failure is contained and
 * counted; the pass never throws.
 */

import { POST_SESSION_POLICY_VERSION } from '@buildd/core/post-session-quality';
import type { PostSessionSweepSummary } from './post-session-run';
import type { RecordTriagedSummary } from './post-session-findings';
import type { TriageCost } from './post-session-triage';

export interface PostSessionLoopReadout {
  enabled: boolean;
  policyVersion: string;
  /** Terminal worker attempts whose facts were collected this pass. */
  evaluated: number;
  /** Runs given a skip/analyse decision. */
  triaged: number;
  /** ...of which a mechanical hard trigger forced analysis. */
  hardTriggered: number;
  /** ...of which were routed to analysis (model or hard trigger). */
  selectedForAnalysis: number;
  /** Runs analysed and recorded into the finding ledger. */
  analysed: number;
  actionable: number;
  tasksCreated: number;
  proposalsCreated: number;
  /** Shadow mode: findings the policy would have filed. */
  wouldAct: number;
  duplicatesSuppressed: number;
  /** Items left for the next pass because the time budget ran out. */
  deferred: number;
  stageFailures: { collect: number; triage: number; transcript: number; analyse: number; act: number };
  stageCost: {
    triage: TriageCost;
    /** The analyser is deterministic: it makes no model call. */
    analyse: { calls: 0; usd: 0 };
  };
  /** A stage that threw outright (never expected; each stage already contains its own failures). */
  stageErrors: string[];
}

type StageOpts = { now: Date; shouldContinue: () => boolean };

export interface PostSessionLoopOptions {
  now?: Date;
  /** Wall-clock budget for starting new work. In-flight items finish. */
  budgetMs?: number;
  clock?: () => number;
  env?: Record<string, string | undefined>;
  sweep?: (opts: StageOpts) => Promise<PostSessionSweepSummary>;
  record?: (opts: StageOpts) => Promise<RecordTriagedSummary>;
}

export const POST_SESSION_LOOP_BUDGET_MS = 40_000;

function emptyReadout(enabled: boolean): PostSessionLoopReadout {
  return {
    enabled,
    policyVersion: POST_SESSION_POLICY_VERSION,
    evaluated: 0, triaged: 0, hardTriggered: 0, selectedForAnalysis: 0, analysed: 0,
    actionable: 0, tasksCreated: 0, proposalsCreated: 0, wouldAct: 0, duplicatesSuppressed: 0, deferred: 0,
    stageFailures: { collect: 0, triage: 0, transcript: 0, analyse: 0, act: 0 },
    stageCost: { triage: { calls: 0, usd: null, inputTokens: 0, outputTokens: 0 }, analyse: { calls: 0, usd: 0 } },
    stageErrors: [],
  };
}

function message(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

export async function runPostSessionQualityLoop(opts: PostSessionLoopOptions = {}): Promise<PostSessionLoopReadout> {
  const env = opts.env ?? process.env;
  if (env.POST_SESSION_QUALITY_ENABLED === '0') return emptyReadout(false);

  const readout = emptyReadout(true);
  const now = opts.now ?? new Date();
  const clock = opts.clock ?? Date.now;
  const budgetMs = opts.budgetMs ?? POST_SESSION_LOOP_BUDGET_MS;
  const startedAt = clock();
  const shouldContinue = () => clock() - startedAt < budgetMs;
  const stage = { now, shouldContinue };

  const sweep = opts.sweep ?? (async (o: StageOpts) => (await import('./post-session-run')).sweepPostSessionRuns(o));
  const record = opts.record ?? (async (o: StageOpts) => (await import('./post-session-findings')).recordTriagedRuns(o));

  try {
    const s = await sweep(stage);
    readout.evaluated = s.collected;
    readout.triaged = s.triaged;
    readout.hardTriggered = s.hardTriggered;
    readout.selectedForAnalysis = s.selected;
    readout.deferred += s.deferred + s.triageDeferred;
    readout.stageFailures.collect += s.failed + s.errors;
    readout.stageFailures.triage += s.triageErrors;
    readout.stageCost.triage = s.triageCost;
  } catch (err) {
    readout.stageFailures.collect++;
    readout.stageErrors.push(`sweep: ${message(err)}`);
  }

  // Runs whose triage failed stay collected and are retried by the next pass;
  // analysis still drains whatever a previous pass already selected.
  try {
    const r = await record(stage);
    readout.analysed = r.recorded;
    readout.actionable = r.actionable;
    readout.tasksCreated = r.tasksFiled;
    readout.proposalsCreated = r.proposalsFiled;
    readout.wouldAct = r.wouldAct;
    readout.duplicatesSuppressed = r.duplicatesSuppressed;
    readout.deferred += r.deferred;
    readout.stageFailures.transcript += r.transcriptUnread;
    readout.stageFailures.analyse += r.analyseErrors;
    readout.stageFailures.act += r.recordErrors;
  } catch (err) {
    readout.stageFailures.act++;
    readout.stageErrors.push(`record: ${message(err)}`);
  }

  return readout;
}
