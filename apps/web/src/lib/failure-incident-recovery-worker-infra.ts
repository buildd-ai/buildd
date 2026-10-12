/**
 * Worker infrastructure recovery (docs/specs/failure-incident-recovery.md
 * §18.4): the `infrastructure_failure` family's worker components.
 *
 *  - `worker.auth`: tasks held for a rejected credential (task-recovery-hold).
 *    The credential checks healthy → release the holds once per generation;
 *    a hold exhausted or the episode deadline passed → `needs_operator`
 *    ("reconnect <credential>"); otherwise wait for the next probe.
 *  - `worker.session_lost`: tasks whose infra retries ran out (`failed`,
 *    `infra_stalled`). Retrying a fourth time is not recovery's to do, so this
 *    is `needs_operator` with the evidence until the task moves.
 *
 * Neither ever reaches a person: ownership is `infrastructure` and exhaustion
 * goes to the operator (`fallbackOperator`). The check is decidable from the
 * subjects' own rows, never "no new occurrence lately".
 */
import type { FailureRecoveryDecision, FailureRecoveryRef } from '@buildd/shared';
import type { WorkerInfraComponent } from './failure-pattern-sentinel';
import { RECOVERY_EPISODE_DEADLINE_MINUTES, type RecoveryFamily, type RecoveryPolicyOutcome, type RecoveryVerdict } from './failure-incident-recovery';
import type { StoredIncident } from './failure-incident-store';
import { readCredentialHold, type CredentialHold } from './task-recovery-hold';

export interface WorkerInfraSubjectFacts {
  taskId: string;
  /** `tasks.status`; null when the row was not found (unknown, never cleared). */
  status: string | null;
  hold: CredentialHold | null;
  /** `result.errorType` on a failed task. */
  errorType: string | null;
  infraRetryCount: number;
  /** Newest worker `createdAt` for the task; null for none. */
  lastWorkerAt: string | null;
  /** The newest worker's error, bounded; evidence for the operator. */
  lastError: string | null;
}

export interface WorkerInfraRecoveryFacts {
  component: WorkerInfraComponent | null;
  /** The credential key (auth) or the friction signature (session_lost). */
  key: string | null;
  /** auth only: the credential checks healthy after the newest hold. null: unknown. */
  credentialHealthy: boolean | null;
  subjects: WorkerInfraSubjectFacts[];
}

/** `component=` and `cred=` / `sig=` out of a worker-infrastructure signature. */
export function parseWorkerInfraSignature(signature: string): { component: WorkerInfraComponent | null; key: string | null } {
  const parts = signature.split('|');
  const component = parts.find(p => p.startsWith('component='))?.slice('component='.length) ?? null;
  const key = parts.find(p => p.startsWith('cred=') || p.startsWith('sig='))?.replace(/^(cred|sig)=/, '') ?? null;
  return {
    component: component === 'worker.auth' || component === 'worker.session_lost' ? component : null,
    key,
  };
}

const DISMISS_ONLY: FailureRecoveryDecision = {
  question: 'Buildd could not recover this infrastructure failure on its own. Dismiss it?',
  options: [{ capability: 'dismiss', label: 'Dismiss', effect: 'It leaves Needs You; Buildd keeps checking it.' }],
  recommended: 'dismiss',
};

/** auth: this subject no longer waits on the credential. */
function authSubjectPassed(s: WorkerInfraSubjectFacts): boolean | null {
  if (s.status === null) return null;
  // Anything past pending (dispatched, running or finished) has left the hold.
  if (s.status !== 'pending') return true;
  if (!s.hold) return true;
  if (!s.hold.releasedAt) return false;
  // Released: passes once a worker started after the hold.
  return !!s.lastWorkerAt && s.lastWorkerAt > s.hold.since;
}

/** session_lost: this subject is no longer stalled on infrastructure. */
function stalledSubjectPassed(s: WorkerInfraSubjectFacts): boolean | null {
  if (s.status === null) return null;
  return !(s.status === 'failed' && s.errorType === 'infra_stalled');
}

const minutesAfter = (iso: string, m: number) => new Date(Date.parse(iso) + m * 60_000).toISOString();

/** Pure. The worker-infrastructure policy over facts read now. */
export function evaluateWorkerInfra(incident: StoredIncident, facts: WorkerInfraRecoveryFacts, now: string): RecoveryPolicyOutcome {
  const component = facts.component ?? parseWorkerInfraSignature(incident.signature).component;
  const subjects: FailureRecoveryRef[] = facts.subjects.map(s => ({ kind: 'task', id: s.taskId }));
  const holds = facts.subjects.map(s => s.hold).filter((h): h is CredentialHold => !!h);
  const episodeStartedAt = holds.map(h => h.firstHeldAt).sort()[0] ?? incident.firstSeenAt;
  const lastProgressAt = facts.subjects.map(s => s.lastWorkerAt).filter((x): x is string => !!x).sort().pop() ?? null;
  const base = {
    cause: { reasonCode: component === 'worker.auth' ? 'infrastructure.auth' : 'infrastructure.session_lost', rule: incident.rule, ownership: 'infrastructure' as const },
    subjects,
    blockers: [],
    overlappingPaths: [],
    episodeStartedAt,
    lastProgressAt,
    verification: { predicate: component === 'worker.auth' ? 'worker_infra.auth.subjects_left_hold' : 'worker_infra.session_lost.subjects_moved', params: { component, key: facts.key } },
    fallbackDecision: DISMISS_ONLY,
  };
  const outcome = (verdict: RecoveryVerdict, fallbackOperator?: RecoveryPolicyOutcome['fallbackOperator']): RecoveryPolicyOutcome =>
    ({ ...base, verdict, ...(fallbackOperator ? { fallbackOperator } : {}) });

  if (facts.subjects.length === 0) return outcome({ kind: 'inconclusive', reason: 'Buildd could not read the affected tasks.' });

  if (component === 'worker.session_lost') {
    const judged = facts.subjects.map(s => ({ s, passed: stalledSubjectPassed(s) }));
    if (judged.every(j => j.passed === true)) return outcome({ kind: 'passed', summary: 'Every stalled task moved again.' });
    const stuck = judged.filter(j => j.passed === false).map(j => j.s);
    if (stuck.length === 0) return outcome({ kind: 'inconclusive', reason: 'Buildd could not confirm the stalled tasks.' });
    const last = stuck.find(s => s.lastError)?.lastError;
    const gap = {
      capability: 'requeue_task',
      reason: `${stuck.length} task(s) lost their session on every infra retry (${stuck.map(s => `task ${s.taskId.slice(0, 8)}: ${s.infraRetryCount} retries`).join(', ')})`
        + `${facts.key ? `; signature ${facts.key}` : ''}${last ? `; last error: ${last.slice(0, 160)}` : ''}. Requeue once the runner issue is fixed.`,
      label: 'Automatic recovery unavailable: the tasks lost their session on every retry. The operator has been told.',
    };
    return outcome({ kind: 'operator', ...gap }, gap);
  }

  if (component !== 'worker.auth') return outcome({ kind: 'inconclusive', reason: 'Unknown infrastructure component.' });

  const judged = facts.subjects.map(s => ({ s, passed: authSubjectPassed(s) }));
  if (judged.every(j => j.passed === true)) return outcome({ kind: 'passed', summary: 'Every held task started again on a healthy credential.' });
  const held = judged.filter(j => j.passed === false && j.s.hold && !j.s.hold.releasedAt).map(j => j.s);
  const label = holds[0]?.label ?? 'the backend credential';
  const gap = {
    capability: 'reconnect_credential',
    reason: `Reconnect ${label}: ${held.length || facts.subjects.length} task(s) are held because it was rejected`
      + `${held.some(s => s.hold?.exhausted) ? ' on every retry' : ''}.`,
    label: `Waiting for ${label} to be reconnected. The operator has been told.`,
  };

  if (held.length > 0 && facts.credentialHealthy === true) {
    return outcome({
      kind: 'repair', action: 'release_hold', subject: { kind: 'task', id: held[0].taskId },
      label: `${label[0].toUpperCase()}${label.slice(1)} checks healthy again; Buildd restarted the held task(s) on their branch.`,
      params: { taskIds: held.map(s => s.taskId), credentialKey: facts.key },
    }, gap);
  }
  // A hold that ran out of retries, or the episode deadline: the operator's.
  const pastDeadline = now >= minutesAfter(episodeStartedAt, RECOVERY_EPISODE_DEADLINE_MINUTES);
  if (held.some(s => s.hold?.exhausted) || (held.length > 0 && pastDeadline)) return outcome({ kind: 'operator', ...gap }, gap);
  if (held.length > 0) {
    const probes = held.map(s => s.hold!).filter(h => !h.exhausted).map(h => h.probeAt).sort();
    return outcome({
      kind: 'wait',
      label: `Waiting for a healthy credential (${label}); Buildd retries the held task(s) when it checks healthy, or at the next probe.`,
      // Look just after the next probe lifts its floor.
      nextCheckAt: probes[0] ? minutesAfter(probes[0], 1) : null,
    }, gap);
  }
  // Released, not yet claimed; or a row the read did not find.
  return outcome({ kind: 'wait', label: 'The held task(s) were released; waiting for a runner to claim them.' }, gap);
}

// ── DB ──────────────────────────────────────────────────────────────────────

/** Read the subjects and, for auth, the credential's health from their owners. */
export async function dbObserveWorkerInfraRecovery(incident: StoredIncident): Promise<{ complete: boolean; facts: WorkerInfraRecoveryFacts }> {
  const [{ db }, { tasks, workers, secrets }, { and, desc, eq, gt, inArray, isNotNull, or }] = await Promise.all([
    import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'),
  ]);
  const { component, key } = parseWorkerInfraSignature(incident.signature);
  const ids = [...new Set(incident.affectedRefs.taskIds)].slice(0, 25);
  if (ids.length === 0) return { complete: false, facts: { component, key, credentialHealthy: null, subjects: [] } };

  const taskRows = await db.select({ id: tasks.id, status: tasks.status, context: tasks.context, result: tasks.result }).from(tasks).where(inArray(tasks.id, ids));
  const workerRows = await db
    .select({ taskId: workers.taskId, createdAt: workers.createdAt, error: workers.error })
    .from(workers).where(inArray(workers.taskId, ids)).orderBy(desc(workers.createdAt)).limit(200);
  const newest = new Map<string, { createdAt: Date; error: string | null }>();
  for (const w of workerRows) if (w.taskId && !newest.has(w.taskId)) newest.set(w.taskId, { createdAt: w.createdAt, error: w.error });
  const byId = new Map(taskRows.map(t => [t.id, t]));

  const subjects: WorkerInfraSubjectFacts[] = ids.map(id => {
    const t = byId.get(id);
    const ctx = (t?.context ?? {}) as Record<string, unknown>;
    const w = newest.get(id);
    return {
      taskId: id,
      status: t?.status ?? null,
      hold: readCredentialHold(ctx),
      errorType: ((t?.result ?? {}) as { errorType?: string }).errorType ?? null,
      infraRetryCount: typeof ctx.infraRetryCount === 'number' ? ctx.infraRetryCount : 0,
      lastWorkerAt: w ? w.createdAt.toISOString() : null,
      lastError: w?.error ? w.error.slice(0, 300) : null,
    };
  });

  let credentialHealthy: boolean | null = null;
  if (component === 'worker.auth' && key) {
    const since = subjects.map(s => s.hold).filter(h => h && !h.releasedAt).map(h => h!.since).sort().pop();
    if (!since) credentialHealthy = null;
    else if (key.startsWith('secret:')) {
      const row = await db.query.secrets.findFirst({
        where: eq(secrets.id, key.slice('secret:'.length)),
        columns: { healthStatus: true, lastSuccessAt: true, lastRefreshSucceededAt: true },
      });
      const after = [row?.lastSuccessAt, row?.lastRefreshSucceededAt].some(d => !!d && d.toISOString() > since);
      credentialHealthy = !!row && row.healthStatus === 'healthy' && after;
    } else if (key.startsWith('account:')) {
      // A runner's own login: healthy once a session of that account got past
      // auth after the newest hold (completed, or running real turns).
      const ok = await db.select({ id: workers.id }).from(workers).where(and(
        eq(workers.accountId, key.slice('account:'.length)),
        gt(workers.createdAt, new Date(since)),
        or(eq(workers.status, 'completed'), and(isNotNull(workers.startedAt), gt(workers.turns, 2))),
      )).limit(1);
      credentialHealthy = ok.length > 0;
    }
  }
  return { complete: taskRows.length > 0, facts: { component, key, credentialHealthy, subjects } };
}

export const workerInfraRecoveryFamily: RecoveryFamily<WorkerInfraRecoveryFacts> = {
  rule: 'infrastructure_failure',
  observe: dbObserveWorkerInfraRecovery,
  evaluate: evaluateWorkerInfra,
};
