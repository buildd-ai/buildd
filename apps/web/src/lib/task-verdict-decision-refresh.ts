/**
 * Recompute a task's verdict decision after a state change, and cache it on
 * `tasks.verdict_decision`. The only caller is the state-change subscribers
 * (lib/verdict-decision-subscribers.ts); the task page reads the column and never
 * calls this.
 *
 * Loads the same rows the page does, derives the same verdict through the
 * same pure functions (task-verdict-facts.ts → task-verdict.ts), and asks the
 * model only when the model-visible record changed since the last look
 * (fingerprint). Never throws.
 */
import { and, asc, desc, eq, isNotNull } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { missionNotes, tasks, workerErrorTraces, workers } from '@buildd/core/db/schema';
import { loadOpenAttempt } from '@/lib/explain';
import { deriveTaskVerdict, parseStoredVerdictDecision, type StoredVerdictDecision, type TaskVerdict } from './task-verdict';
import { buildVerdictInput, traceOutcomeOf } from './task-verdict-facts';
import { decideTaskVerdict, unclearTraceFacts, verdictFingerprint, VERDICT_LOG_PREFIX, type DecideVerdictDeps, type VerdictRecord } from './task-verdict-decision';
import { classifyTracesByRule, type ConsequenceTrace } from './trace-consequence';

const TRACE_LIMIT = 200;
const NOTES = 5;

export type VerdictTrigger = 'worker_terminal' | 'attempt_end' | 'ci_result' | 'pr_event';

function milestoneText(m: unknown): string | null {
  if (!m || typeof m !== 'object') return null;
  const r = m as { label?: unknown; text?: unknown; type?: unknown };
  if (r.type === 'action') return null;
  const t = typeof r.label === 'string' ? r.label : typeof r.text === 'string' ? r.text : null;
  return t && !/^Ran:/i.test(t) ? t.slice(0, 200) : null;
}

export async function loadVerdictRecord(taskId: string): Promise<{ record: VerdictRecord | null; verdict: TaskVerdict | null; stored: StoredVerdictDecision | null }> {
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { id: true, status: true, mode: true, result: true, workspaceId: true, missionId: true, verdictDecision: true },
    with: { workspace: { columns: { teamId: true, dataClass: true, gitConfig: true } } },
  });
  if (!task?.workspace) return { record: null, verdict: null, stored: null };
  const stored = parseStoredVerdictDecision(task.verdictDecision);

  const taskWorkers = await db.query.workers.findMany({
    where: eq(workers.taskId, taskId),
    orderBy: desc(workers.createdAt),
    columns: { id: true, status: true, waitingFor: true, prUrl: true, prNumber: true, prLifecycleStatus: true, mergedAt: true, error: true, createdAt: true, milestones: true, lastCommitSha: true, linesAdded: true, linesRemoved: true, filesChanged: true },
  });
  const prWorker = taskWorkers.find(w => w.prUrl && w.prNumber) ?? null;
  const prOpen = !!prWorker && !prWorker.mergedAt && prWorker.prLifecycleStatus !== 'closed';

  const [ciAttempts, openAttempt, questions, traceRows] = await Promise.all([
    prWorker?.prNumber
      ? db.query.tasks.findMany({
          where: and(eq(tasks.parentTaskId, taskId), eq(tasks.ciRetryPrNumber, prWorker.prNumber), isNotNull(tasks.ciRetryHeadSha)),
          columns: { id: true, status: true, createdAt: true, context: true, result: true },
          orderBy: asc(tasks.createdAt),
        })
      : Promise.resolve([]),
    prOpen ? loadOpenAttempt(taskId).catch(() => null) : Promise.resolve(null),
    db.select({ id: missionNotes.id }).from(missionNotes)
      .where(and(eq(missionNotes.taskId, taskId), eq(missionNotes.type, 'question'), eq(missionNotes.status, 'open')))
      .limit(1),
    db.select({ id: workerErrorTraces.id, workerId: workerErrorTraces.workerId, pattern: workerErrorTraces.pattern, excerpt: workerErrorTraces.excerpt, source: workerErrorTraces.source, ts: workerErrorTraces.ts })
      .from(workerErrorTraces)
      .where(eq(workerErrorTraces.taskId, taskId))
      .orderBy(desc(workerErrorTraces.ts))
      .limit(TRACE_LIMIT),
  ]);

  const input = buildVerdictInput({
    task: { status: task.status, mode: task.mode, result: task.result },
    workers: taskWorkers,
    ciAttempts,
    openAttempt,
    openQuestion: questions.length > 0,
    // Release attribution only changes a shipped headline, which asks nothing.
    inRelease: false,
  });
  const verdict = deriveTaskVerdict(input);
  if (!verdict) return { record: null, verdict: null, stored };

  const traces: ConsequenceTrace[] = traceRows;
  const consequences = classifyTracesByRule(traces, traceOutcomeOf(verdict, task.status));
  const ws = task.workspace as { teamId: string; dataClass?: string | null; gitConfig?: unknown };
  const sensitive = ws.dataClass === 'sensitive' || (ws.gitConfig as { dataClass?: string } | null)?.dataClass === 'sensitive';
  const newest = taskWorkers[0];
  const record: VerdictRecord = {
    taskId,
    teamId: ws.teamId,
    workspaceId: task.workspaceId,
    missionId: task.missionId ?? null,
    workerId: newest?.id ?? null,
    prNumber: prWorker?.prNumber ?? null,
    headSha: prWorker?.lastCommitSha ?? null,
    sensitive,
    verdict,
    mismatch: input.mismatch ?? [],
    attempts: ciAttempts.map((a, i) => {
      const r = (a.result ?? null) as { files?: number; added?: number; removed?: number } | null;
      return { n: i + 2, status: a.status, diff: r ? `+${r.added ?? 0} -${r.removed ?? 0} · ${r.files ?? 0} files` : null };
    }),
    notes: ((newest?.milestones as unknown[] | null) ?? []).map(milestoneText).filter((t): t is string => !!t).slice(-NOTES),
    unclearTraces: unclearTraceFacts(traces, consequences),
  };
  return { record, verdict, stored };
}

export type WriteVerdictDecision = (taskId: string, decision: StoredVerdictDecision) => Promise<void>;

async function dbWrite(taskId: string, decision: StoredVerdictDecision): Promise<void> {
  await db.update(tasks).set({ verdictDecision: decision as unknown as Record<string, unknown> }).where(eq(tasks.id, taskId));
}

/**
 * Recompute and cache. Returns what is stored now (null: nothing to judge).
 * A record whose fingerprint matches the stored one makes no model call and
 * writes no ledger row.
 */
export async function refreshTaskVerdict(
  taskId: string,
  trigger: VerdictTrigger,
  deps: DecideVerdictDeps & { load?: typeof loadVerdictRecord; write?: WriteVerdictDecision } = {},
): Promise<StoredVerdictDecision | null> {
  try {
    const { record, stored } = await (deps.load ?? loadVerdictRecord)(taskId);
    if (!record) return stored;
    const fingerprint = verdictFingerprint(record);
    if (stored && stored.fingerprint === fingerprint && stored.state === record.verdict.state && stored.causeKey === record.verdict.causeKey) {
      return stored;
    }
    const decision = await decideTaskVerdict(record, deps);
    await (deps.write ?? dbWrite)(taskId, decision);
    console.log(`${VERDICT_LOG_PREFIX} refreshed task=${taskId.slice(0, 8)} trigger=${trigger}`);
    return decision;
  } catch (err) {
    console.warn(`${VERDICT_LOG_PREFIX} refresh failed for task ${taskId.slice(0, 8)} (non-fatal):`, err instanceof Error ? err.message : err);
    return null;
  }
}
