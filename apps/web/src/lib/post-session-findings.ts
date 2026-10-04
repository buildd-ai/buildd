/**
 * Post-session quality loop — the finding ledger and the §9 action policy, the
 * server half (artifact `post-session-quality-loop-spec` §8–§9, §11; pure
 * half: `@buildd/core/post-session-findings`).
 *
 * For one analysed run: fold each finding into its ledger row, decide what
 * the policy wants, and — in `propose` mode only — file one deduped follow-up
 * task or one correction proposal. Then mark the run `analysed`.
 *
 * Atomicity, without transactions (neon-http has none):
 *  - **Ledger row.** INSERT … ON CONFLICT DO NOTHING on the unique
 *    (workspace, signature, policy) index; on conflict, a compare-and-set on
 *    `updated_at`, retried. Concurrent sightings all count, none twice.
 *  - **Occurrence.** Keyed by run id on the row, so reprocessing an incident
 *    never counts it again.
 *  - **Action.** The doc-fix dispatch pattern: insert the task, then claim it
 *    on the finding with `UPDATE … WHERE action_task_id IS NULL AND
 *    action_artifact_id IS NULL`. The loser deletes its task. A task orphaned
 *    by a crash between insert and claim is found by its finding id and
 *    adopted, not duplicated. Proposals are keyed artifacts, so the insert is
 *    itself idempotent.
 *
 * Never mutates memory: a knowledge defect is a proposal artifact, and nothing
 * here calls learn. The run is marked `analysed` only after every action
 * succeeded; a failed action leaves it `triaged` for the next sweep, which
 * re-folds idempotently and retries the claim.
 */

import {
  aggregateFindingOccurrence,
  buildCorrectionProposal,
  buildFollowUpTask,
  decideFindingAction,
  occurrenceNote,
  resolveFindingActionPolicy,
  type CorrectionProposalSpec,
  type FindingActionPolicy,
  type FindingActionReason,
  type FindingLedgerAggregate,
  type FindingOccurrence,
  type FollowUpTaskSpec,
} from '@buildd/core/post-session-findings';
import {
  POST_SESSION_POLICY_VERSION,
  resolvePostSessionQualityMode,
  type FindingActionState,
  type PostSessionQualityConfig,
  type PostSessionQualityMode,
  type PostSessionRunState,
} from '@buildd/core/post-session-quality';
import type {
  AnalysePostSessionResult,
  PostSessionAnalysis,
  PostSessionQualityFinding,
  PostSessionTraceCoverage,
} from './post-session-quality-analysis';

// ── Store ───────────────────────────────────────────────────────────────────

export interface FindingRunRow {
  id: string;
  state: PostSessionRunState;
  workerId: string;
  taskId: string | null;
  workspaceId: string;
  missionId: string | null;
  policyVersion: string;
  /** The mode recorded on the run — a later mode change does not reinterpret it. */
  mode: PostSessionQualityMode;
  /** The workspace's current gitConfig, for the policy thresholds. */
  gitConfig: { postSessionQuality?: PostSessionQualityConfig | null } | null;
}

export interface StoredFinding extends FindingLedgerAggregate {
  id: string;
  workspaceId: string;
  signature: string;
  policyVersion: string;
  actionState: FindingActionState;
  actionTaskId: string | null;
  actionArtifactId: string | null;
  actionAt: Date | null;
  updatedAt: Date;
}

export interface PostSessionFindingStore {
  loadRun(runId: string): Promise<FindingRunRow | null>;
  /** ON CONFLICT DO NOTHING on (workspace, signature, policy). null = the row exists. */
  insertFinding(input: { workspaceId: string; signature: string; policyVersion: string; aggregate: FindingLedgerAggregate; now: Date }): Promise<StoredFinding | null>;
  loadFinding(workspaceId: string, signature: string, policyVersion: string): Promise<StoredFinding | null>;
  /** CAS on updated_at. null = someone else wrote first. */
  updateFindingIfUnchanged(id: string, expectedUpdatedAt: Date, aggregate: FindingLedgerAggregate, updatedAt: Date): Promise<StoredFinding | null>;
  /** A non-terminal follow-up task already carrying this finding id (crash orphan). */
  findOpenFollowUpTask(workspaceId: string, findingId: string): Promise<string | null>;
  insertTask(workspaceId: string, spec: FollowUpTaskSpec, now: Date): Promise<string>;
  deleteTask(taskId: string): Promise<void>;
  /** Realtime nudge to runners once the claim is won. Best effort. */
  dispatchTask(taskId: string): Promise<void>;
  /** Fenced on no action recorded yet and state observed|promoted. false = lost. */
  claimAction(findingId: string, claim: { state: 'task_filed' | 'proposal_filed'; taskId?: string; artifactId?: string; now: Date }): Promise<boolean>;
  /** observed → promoted: the policy wanted to act but the run's mode forbids it. */
  markPromoted(findingId: string, now: Date): Promise<void>;
  /** Keyed artifact insert; returns the id of the new or existing proposal. */
  upsertProposal(workspaceId: string, missionId: string | null, spec: CorrectionProposalSpec, now: Date): Promise<string>;
  appendToTask(taskId: string, text: string, now: Date): Promise<void>;
  insertWarning(note: { missionId: string; taskId: string | null; title: string; body: string }): Promise<void>;
  /** Fenced on state='triaged'. Writes the §12 coverage columns. */
  markRunAnalysed(runId: string, coverage: PostSessionTraceCoverage, now: Date): Promise<boolean>;
  /**
   * Leaves the run triaged; records why the stage failed and bumps
   * updated_at, so a run that keeps failing rotates behind the others.
   */
  recordFailure(runId: string, stage: 'analyse' | 'act', error: string, now: Date): Promise<void>;
  listTriaged(input: { policyVersion: string; limit: number }): Promise<string[]>;
}

async function defaultStore(): Promise<PostSessionFindingStore> {
  const mod = await import('./post-session-findings-store');
  return mod.postSessionFindingStore;
}

// ── Recording ───────────────────────────────────────────────────────────────

export type FindingOutcome =
  | 'observed'      // policy does not act (yet)
  | 'would_act'     // policy wants to act; shadow mode
  | 'task_filed'
  | 'proposal_filed'
  | 'deduped'       // another caller holds the action
  | 'task_updated'; // a recurring critical appended to its filed task

export interface RecordedFinding {
  findingId: string;
  signature: string;
  counted: boolean;
  occurrenceCount: number;
  reason: FindingActionReason;
  outcome: FindingOutcome;
  taskId: string | null;
  artifactId: string | null;
}

export type RecordPostSessionFindingsResult =
  | { status: 'recorded'; runId: string; findings: RecordedFinding[] }
  | { status: 'action_failed'; runId: string; error: string }
  | { status: 'not_ready'; runId: string; state: PostSessionRunState }
  | { status: 'missing' }
  | { status: 'error'; error: string };

export interface RecordDeps {
  store?: PostSessionFindingStore;
  now?: Date;
}

const MAX_ERROR_CHARS = 500;
const MAX_CAS_ATTEMPTS = 8;

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > MAX_ERROR_CHARS ? msg.slice(0, MAX_ERROR_CHARS) : msg;
}

/** Strictly after the row's last write, so the CAS token always moves. */
function nextUpdatedAt(prev: Date, now: Date): Date {
  return now.getTime() > prev.getTime() ? now : new Date(prev.getTime() + 1);
}

async function foldOccurrence(
  store: PostSessionFindingStore,
  run: FindingRunRow,
  occ: FindingOccurrence,
  now: Date,
): Promise<{ row: StoredFinding; counted: boolean }> {
  const key = { workspaceId: run.workspaceId, signature: occ.finding.signature, policyVersion: run.policyVersion };
  for (let i = 0; i < MAX_CAS_ATTEMPTS; i++) {
    const existing = await store.loadFinding(key.workspaceId, key.signature, key.policyVersion);
    if (!existing) {
      const { next } = aggregateFindingOccurrence(null, occ);
      const inserted = await store.insertFinding({ ...key, aggregate: next, now });
      if (inserted) return { row: inserted, counted: true };
      continue; // lost the insert race; fold into the winner's row
    }
    const { next, counted } = aggregateFindingOccurrence(existing, occ);
    if (!counted) return { row: existing, counted: false };
    const updated = await store.updateFindingIfUnchanged(existing.id, existing.updatedAt, next, nextUpdatedAt(existing.updatedAt, now));
    if (updated) return { row: updated, counted: true };
  }
  throw new Error(`finding ledger contention on ${occ.finding.signature}`);
}

function toOccurrence(run: FindingRunRow, f: PostSessionQualityFinding, now: Date): FindingOccurrence {
  return {
    finding: {
      class: f.class,
      severity: f.severity,
      confidence: f.confidence,
      title: f.title,
      summary: f.summary,
      signature: f.signature,
      recurrenceKey: f.recurrenceKey,
      proposedAction: f.proposedAction,
      evidenceRefs: f.evidenceRefs,
    },
    ref: { runId: run.id, workerId: run.workerId, taskId: run.taskId, seenAt: now.toISOString() },
  };
}

async function fileTask(store: PostSessionFindingStore, run: FindingRunRow, row: StoredFinding, warn: boolean, now: Date): Promise<{ outcome: FindingOutcome; taskId: string | null }> {
  const orphan = await store.findOpenFollowUpTask(run.workspaceId, row.id);
  const spec = buildFollowUpTask({ findingId: row.id, signature: row.signature, policyVersion: row.policyVersion, aggregate: row });
  const taskId = orphan ?? await store.insertTask(run.workspaceId, spec, now);
  const won = await store.claimAction(row.id, { state: 'task_filed', taskId, now });
  if (!won) {
    // Someone else holds the action. Our fresh task was never dispatched.
    if (!orphan) await store.deleteTask(taskId);
    return { outcome: 'deduped', taskId: null };
  }
  // Pending tasks are claimable by polling anyway; the nudge only saves latency.
  await store.dispatchTask(taskId).catch(() => {});
  if (warn && run.missionId) {
    await store.insertWarning({
      missionId: run.missionId,
      taskId: run.taskId,
      title: `Critical post-session finding: ${row.title}`.slice(0, 200),
      body: `The post-session quality loop found a critical issue in a session of this mission and filed follow-up task ${taskId}. Seen ${row.occurrenceCount}× (signature ${row.signature}).`,
    });
  }
  return { outcome: 'task_filed', taskId };
}

async function fileProposal(store: PostSessionFindingStore, run: FindingRunRow, row: StoredFinding, now: Date): Promise<{ outcome: FindingOutcome; artifactId: string | null }> {
  const spec = buildCorrectionProposal({ findingId: row.id, signature: row.signature, policyVersion: row.policyVersion, aggregate: row });
  const artifactId = await store.upsertProposal(run.workspaceId, run.missionId, spec, now);
  const won = await store.claimAction(row.id, { state: 'proposal_filed', artifactId, now });
  return won ? { outcome: 'proposal_filed', artifactId } : { outcome: 'deduped', artifactId: null };
}

async function act(
  store: PostSessionFindingStore,
  run: FindingRunRow,
  policy: FindingActionPolicy,
  f: PostSessionQualityFinding,
  now: Date,
): Promise<RecordedFinding> {
  const occ = toOccurrence(run, f, now);
  const { row, counted } = await foldOccurrence(store, run, occ, now);
  const decision = decideFindingAction(row, { policy, now, actionState: row.actionState, counted });
  const base = { findingId: row.id, signature: row.signature, counted, occurrenceCount: row.occurrenceCount, reason: decision.reason, taskId: row.actionTaskId, artifactId: row.actionArtifactId };
  // Both the run's recorded mode and the workspace's current one must allow
  // filing: a move to propose is not retroactive, a move out of it is immediate.
  const mayFile = run.mode === 'propose' && resolvePostSessionQualityMode(run.gitConfig) === 'propose';

  if (decision.appendToTask && row.actionTaskId && mayFile) {
    await store.appendToTask(row.actionTaskId, occurrenceNote(occ.ref, row.occurrenceCount), now);
    return { ...base, outcome: 'task_updated' };
  }
  if (!decision.act) return { ...base, outcome: 'observed' };
  if (!mayFile) {
    await store.markPromoted(row.id, now);
    return { ...base, outcome: 'would_act' };
  }
  if (decision.target === 'proposal') {
    const r = await fileProposal(store, run, row, now);
    return { ...base, outcome: r.outcome, artifactId: r.artifactId ?? base.artifactId };
  }
  const r = await fileTask(store, run, row, decision.warn, now);
  return { ...base, outcome: r.outcome, taskId: r.taskId ?? base.taskId };
}

/**
 * Persist one run's analysis into the ledger and apply the action policy.
 * Never throws. Idempotent per run: a second call for the same run (crash
 * replay, racing sweep) counts nothing again and files nothing again.
 */
export async function recordPostSessionFindings(
  runId: string,
  analysis: PostSessionAnalysis,
  deps: RecordDeps = {},
): Promise<RecordPostSessionFindingsResult> {
  let store: PostSessionFindingStore;
  const now = deps.now ?? new Date();
  try {
    store = deps.store ?? await defaultStore();
    const run = await store.loadRun(runId);
    if (!run) return { status: 'missing' };
    if (run.state !== 'triaged') return { status: 'not_ready', runId, state: run.state };
    const policy = resolveFindingActionPolicy(run.gitConfig);

    const recorded: RecordedFinding[] = [];
    try {
      // Sequential: two findings of one run have distinct signatures, and the
      // ledger is background work that must not burst the database.
      for (const f of analysis.findings) recorded.push(await act(store, run, policy, f, now));
    } catch (err) {
      const error = errorText(err);
      await store.recordFailure(runId, 'act', error, now).catch(() => {});
      return { status: 'action_failed', runId, error };
    }
    await store.markRunAnalysed(runId, analysis.coverage, now);
    return { status: 'recorded', runId, findings: recorded };
  } catch (err) {
    return { status: 'error', error: errorText(err) };
  }
}

// ── Sweep step ──────────────────────────────────────────────────────────────

export interface RecordTriagedSummary {
  candidates: number;
  recorded: number;
  notReady: number;
  analyseErrors: number;
  recordErrors: number;
  /** Triaged runs not started because the time budget ran out. */
  deferred: number;
  /** Findings the policy wants acted on (filed, would file, or already filed). */
  actionable: number;
  tasksFiled: number;
  proposalsFiled: number;
  deduped: number;
  wouldAct: number;
  /** Findings that did not file again because their action already exists. */
  duplicatesSuppressed: number;
  /** Analysed runs whose transcript could not be read (coverage degraded, not failed). */
  transcriptUnread: number;
}

export const POST_SESSION_RECORD_LIMIT = 20;

/** Transcript outcomes that are a read failure, as opposed to a transcript that does not exist. */
const TRANSCRIPT_READ_FAILURES = new Set(['not_read', 'read_failed']);

function isActionable(f: RecordedFinding): boolean {
  return f.outcome !== 'observed' || f.reason === 'already_actioned';
}

function isSuppressedDuplicate(f: RecordedFinding): boolean {
  return f.outcome === 'deduped' || f.outcome === 'task_updated'
    || (f.outcome === 'observed' && f.reason === 'already_actioned');
}

/**
 * Stage C + D over every `triaged` run: analyse (read-only), then record and
 * act. One run's failure never stops the rest. Scheduled by
 * `post-session-loop.ts`.
 */
export async function recordTriagedRuns(opts: {
  store?: PostSessionFindingStore;
  analyse?: (runId: string) => Promise<AnalysePostSessionResult>;
  now?: Date;
  limit?: number;
  policyVersion?: string;
  /** Checked before each run; false = stop starting work (time budget spent). */
  shouldContinue?: () => boolean;
} = {}): Promise<RecordTriagedSummary> {
  const summary: RecordTriagedSummary = {
    candidates: 0, recorded: 0, notReady: 0, analyseErrors: 0, recordErrors: 0, deferred: 0,
    actionable: 0, tasksFiled: 0, proposalsFiled: 0, deduped: 0, wouldAct: 0, duplicatesSuppressed: 0, transcriptUnread: 0,
  };
  const now = opts.now ?? new Date();
  const shouldContinue = opts.shouldContinue ?? (() => true);
  let store: PostSessionFindingStore;
  let ids: string[];
  try {
    store = opts.store ?? await defaultStore();
    ids = await store.listTriaged({ policyVersion: opts.policyVersion ?? POST_SESSION_POLICY_VERSION, limit: opts.limit ?? POST_SESSION_RECORD_LIMIT });
  } catch {
    summary.recordErrors++;
    return summary;
  }
  const analyse = opts.analyse ?? (async (runId: string) => {
    const { analysePostSessionRun } = await import('./post-session-quality-analysis');
    return analysePostSessionRun(runId, { now });
  });
  summary.candidates = ids.length;
  for (const [i, runId] of ids.entries()) {
    if (!shouldContinue()) {
      summary.deferred = ids.length - i;
      break;
    }
    const a = await analyse(runId).catch((err): AnalysePostSessionResult => ({ status: 'error', error: errorText(err) }));
    if (a.status !== 'analysed') {
      if (a.status === 'not_ready') {
        summary.notReady++;
      } else {
        summary.analyseErrors++;
        if (a.status === 'error') await store.recordFailure(runId, 'analyse', a.error, now).catch(() => {});
      }
      continue;
    }
    const r = await recordPostSessionFindings(runId, a.analysis, { store, now });
    if (r.status === 'recorded') {
      summary.recorded++;
      if (TRANSCRIPT_READ_FAILURES.has(a.analysis.coverage.traceMissing.reason ?? '')) summary.transcriptUnread++;
      for (const f of r.findings) {
        if (isActionable(f)) summary.actionable++;
        if (isSuppressedDuplicate(f)) summary.duplicatesSuppressed++;
        if (f.outcome === 'task_filed') summary.tasksFiled++;
        else if (f.outcome === 'proposal_filed') summary.proposalsFiled++;
        else if (f.outcome === 'deduped') summary.deduped++;
        else if (f.outcome === 'would_act') summary.wouldAct++;
      }
    } else if (r.status === 'not_ready') {
      summary.notReady++;
    } else {
      summary.recordErrors++;
    }
  }
  return summary;
}
