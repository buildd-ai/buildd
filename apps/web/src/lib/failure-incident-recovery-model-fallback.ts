/**
 * Model-fallback recovery: the `model_dispatch_fallback` rule's one family.
 *
 * The claim route refuses a model the runner cannot launch and serves the
 * tier's fallback (dispatch-model-guard.ts). The run then succeeds, so a
 * successful task says nothing about whether the cause is gone: it ran on the
 * substitute. The only evidence that counts is claims served the requested
 * model after the last refusal. Policy, on fresh facts:
 *  1. Check passes: at least MIN_SERVED_AS_REQUESTED claims in the workspace
 *     served the refused model as requested after the newest refusal.
 *     Recovered.
 *  2. No fix task yet, and a refusal arrived after Buildd began watching (the
 *     pattern is live, not the tail of one already fixed): file the one fix
 *     task. Otherwise inconclusive, never resolved, until the claims arrive.
 *  3. Fix task running: delegated to it.
 *  4. Fix finished and refusals continue: wait for its release to reach
 *     dispatch (bounded by the episode deadline, then the operator). On a
 *     recurrence (the incident was resolved once) the fix did not hold: the
 *     operator, naming the earlier fix.
 *  5. Fix finished, no refusal since, too few claims to tell: inconclusive.
 */
import { isTerminalTaskStatus, type FailureRecoveryBlocker, type FailureRecoveryDecision, type FailureRecoveryRef } from '@buildd/shared';
import { DISPATCH_MODEL_REJECTED_PATTERN } from '@buildd/core/dispatch-model-guard';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { parseModelDispatchFallbackSignature } from './failure-pattern-sentinel';
import { readRecovery, type RecoveryFamily, type RecoveryPolicyOutcome, type RecoveryVerdict } from './failure-incident-recovery';
import type { StoredIncident } from './failure-incident-store';

/** Claims that must serve the refused model as requested before the incident resolves (bug-intake §5.5: 20 runs). */
export const MIN_SERVED_AS_REQUESTED = 20;

export interface ModelFallbackRecoveryFacts {
  /** Newest refusal matching the signature in the workspace; null when none was found. */
  lastFallbackAt: string | null;
  /** Claims after `lastFallbackAt` that served the refused model as requested; null when not read. */
  servedSince: number | null;
  /** The incident's one fix task; `finishedAt` is set once it is terminal. */
  fixTask: { id: string; status: string; finishedAt: string | null } | null;
}

const DISMISS_ONLY: FailureRecoveryDecision = {
  question: 'Tasks keep running on a fallback model. Dismiss this?',
  options: [{ capability: 'dismiss', label: 'Dismiss', effect: 'It leaves Needs You; Buildd keeps checking it.' }],
  recommended: 'dismiss',
};

const short = (id: string) => id.slice(0, 8);

/** Pure. The model-fallback policy over facts read now. */
export function evaluateModelFallback(incident: StoredIncident, facts: ModelFallbackRecoveryFacts, now: string): RecoveryPolicyOutcome {
  const key = parseModelDispatchFallbackSignature(incident.signature);
  const prior = readRecovery(incident);
  const model = key?.rejectedModel ?? 'the requested model';
  const fix = facts.fixTask;
  const fixDone = !!fix && isTerminalTaskStatus(fix.status);
  // Buildd began watching at the first assessment; once the fix finished, the
  // episode is the wait for it to reach dispatch.
  const watchingSince = prior?.firstSeenAt ?? now;
  const episodeStartedAt = fixDone && fix!.finishedAt ? fix!.finishedAt : watchingSince;
  const blockers: FailureRecoveryBlocker[] = fix ? [{ kind: 'task', id: fix.id, state: fix.status, observedAt: fix.finishedAt ?? incident.lastSeenAt }] : [];
  const recurred = incident.recurrenceCount > 0;
  const gap = {
    capability: 'repair_infrastructure:model_dispatch',
    reason: `Claims for ${model} (${key?.source ?? 'unknown source'}) are still refused as ${key?.reason ?? 'unknown'} and served a fallback`
      + `${fix ? ` after fix task ${short(fix.id)} (${fix.status})` : ''}`
      + `${recurred ? `; it recurred ${incident.recurrenceCount} time(s) after being resolved, so the earlier fix did not hold` : ''}.`
      + ' Check the CLI floor table (MODEL_MIN_CLI_VERSION) against the CLI the runners bundle, then the registry row naming the model.',
    label: 'Tasks are running on an older model than the one asked for. The operator has been told.',
  };
  const subject: FailureRecoveryRef = incident.affectedRefs.taskIds[0]
    ? { kind: 'task', id: incident.affectedRefs.taskIds[0] }
    : { kind: 'worker', id: incident.affectedRefs.workerIds[0] ?? incident.id };
  const base = {
    cause: { reasonCode: 'dispatch.model_fallback', rule: incident.rule, ownership: 'infrastructure' as const },
    // Subjects stay empty: the affected tasks already ran, and a growing set would restart the generation every sweep.
    subjects: [],
    blockers,
    overlappingPaths: [],
    episodeStartedAt,
    lastProgressAt: null,
    verification: {
      predicate: 'dispatch.model_served_as_requested',
      params: { model, minClaims: MIN_SERVED_AS_REQUESTED, lastFallbackAt: facts.lastFallbackAt, servedSince: facts.servedSince },
    },
    fallbackDecision: DISMISS_ONLY,
    fallbackOperator: gap,
  };
  const outcome = (verdict: RecoveryVerdict): RecoveryPolicyOutcome => ({ ...base, verdict });

  if (!key) return outcome({ kind: 'inconclusive', reason: 'Not a model-fallback signature.' });
  if (facts.lastFallbackAt === null || facts.servedSince === null) {
    return outcome({ kind: 'inconclusive', reason: 'Buildd could not read the dispatch record for this model.' });
  }
  const progress = `${facts.servedSince} of ${MIN_SERVED_AS_REQUESTED} claims since the last fallback served ${model} as requested`;

  // 1. The check: fresh claims, not a task that succeeded on the substitute.
  if (facts.servedSince >= MIN_SERVED_AS_REQUESTED) {
    return outcome({ kind: 'passed', summary: `${facts.servedSince} claims since the last fallback served ${model} as requested.` });
  }

  // 2. No fix yet.
  if (!fix) {
    if (facts.lastFallbackAt > watchingSince) {
      return outcome({ kind: 'repair', action: 'file_fix_task', subject, once: true, label: `Buildd filed a fix: tasks asking for ${model} keep running on a fallback.`, params: {} });
    }
    return outcome({ kind: 'inconclusive', reason: `No fallback since Buildd began watching; ${progress}.` });
  }

  // 3. The fix is running.
  if (!fixDone) return outcome({ kind: 'delegated', nextActionKind: 'fix_task_running', label: `Fix running for ${model} (task ${short(fix.id)}).`, ref: `fix:${fix.id}` });

  // 4. Refused after the fix finished.
  if (fix.finishedAt && facts.lastFallbackAt > fix.finishedAt) {
    if (recurred) return outcome({ kind: 'operator', ...gap });
    return outcome({ kind: 'wait', label: `Fix ${short(fix.id)} finished; waiting for its release to reach dispatch (${progress}).` });
  }

  // 5. Quiet, but not yet shown.
  return outcome({ kind: 'inconclusive', reason: `No fallback since fix ${short(fix.id)} finished; ${progress}.` });
}

/** Read the newest refusal, the claims since it and the fix task from their owners. */
export async function dbObserveModelFallback(incident: StoredIncident): Promise<{ complete: boolean; facts: ModelFallbackRecoveryFacts }> {
  const empty: ModelFallbackRecoveryFacts = { lastFallbackAt: null, servedSince: null, fixTask: null };
  const key = parseModelDispatchFallbackSignature(incident.signature);
  if (!key || !incident.workspaceId) return { complete: false, facts: empty };
  const [{ db }, { tasks, workerErrorTraces }, { and, eq, gt, like, max, count }] = await Promise.all([
    import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'),
  ]);

  // The excerpt is describeDispatchModelRejection's line; its prefix names id, source and reason.
  const prefix = `dispatch refused model "${key.rejectedModel}" from ${key.source} (${key.reason});`;
  const [last] = await db
    .select({ at: max(workerErrorTraces.ts) })
    .from(workerErrorTraces)
    .innerJoin(tasks, eq(tasks.id, workerErrorTraces.taskId))
    .where(and(
      eq(workerErrorTraces.pattern, DISPATCH_MODEL_REJECTED_PATTERN),
      eq(tasks.workspaceId, incident.workspaceId),
      like(workerErrorTraces.excerpt, `${prefix.replace(/[\\%_]/g, c => `\\${c}`)}%`),
    ));
  const lastFallbackAt = last?.at ? new Date(last.at as unknown as string).toISOString() : null;

  let servedSince: number | null = null;
  if (lastFallbackAt) {
    const [served] = await db
      .select({ n: count() })
      .from(tasks)
      .where(and(
        eq(tasks.workspaceId, incident.workspaceId),
        eq(tasks.predictedModel, key.rejectedModel),
        gt(tasks.claimedAt, new Date(lastFallbackAt)),
      ));
    servedSince = Number(served?.n ?? 0);
  }

  let fixTask: ModelFallbackRecoveryFacts['fixTask'] = null;
  let fixId = incident.linkedFixTaskId;
  if (!fixId) {
    const { createDbFixTaskPort } = await import('./failure-incident-actions');
    fixId = await createDbFixTaskPort().findOpenByIncident(incident.id, incident.workspaceId);
  }
  if (fixId) {
    const row = await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, fixId)), columns: { id: true, status: true, updatedAt: true } });
    if (row) fixTask = { id: row.id, status: row.status, finishedAt: isTerminalTaskStatus(row.status) ? row.updatedAt.toISOString() : null };
  }

  return { complete: lastFallbackAt !== null, facts: { lastFallbackAt, servedSince, fixTask } };
}

export const modelFallbackRecoveryFamily: RecoveryFamily<ModelFallbackRecoveryFacts> = {
  rule: 'model_dispatch_fallback',
  observe: dbObserveModelFallback,
  evaluate: evaluateModelFallback,
};
