/**
 * Dispatch recovery (operator-recovery spec §9.3, runbook
 * `dispatch.delivery_exhausted`): a task whose delivery exhausted its attempts.
 *
 * Owns only the `repeated_failure` / `stranded_gate` incidents the runbook
 * names (`runbookFor`); every other incident of those rules stays unassessed,
 * as before. Policy, on fresh facts:
 *  1. Check passes: the subject left `pending`, or a worker started after the
 *     episode began. Recovered.
 *  2. The runbook: `redeliver_dispatch` (a new outbox row), once per
 *     generation, only with a runner online for the workspace; `wait` while
 *     no runner is online; `escalate` once the redelivery did not help.
 *  3. Escalation is the platform owner's (`repair_infrastructure:dispatch`),
 *     never a customer's question.
 *
 * `redeliver_dispatch` is new in B2, so the loop runs it in shadow (§9.5)
 * until a `set_policy` turns it on.
 */
import type { FailureRecoveryDecision } from '@buildd/shared';
import { MAX_DELIVERY_ATTEMPTS } from '@buildd/dispatch-contract';
import { readRecovery, type RecoveryFamily, type RecoveryPolicyOutcome, type RecoveryVerdict } from './failure-incident-recovery';
import { loadRepairFacts, RUNBOOKS, runbookFor, type RepairFacts } from './failure-incident-repairs';
import type { StoredIncident } from './failure-incident-store';

const DISMISS_ONLY: FailureRecoveryDecision = {
  question: 'Buildd could not deliver this task. Dismiss it?',
  options: [{ capability: 'dismiss', label: 'Dismiss', effect: 'It leaves Needs You; Buildd keeps checking it.' }],
  recommended: 'dismiss',
};

/** Pure. The dispatch policy over facts read now. */
export function evaluateDispatchFailure(incident: StoredIncident, facts: RepairFacts, _now: string): RecoveryPolicyOutcome {
  const prior = readRecovery(incident);
  const s = facts.subjects[0] ?? null;
  const episodeStartedAt = prior?.firstSeenAt ?? incident.firstSeenAt;
  const gap = {
    capability: 'repair_infrastructure:dispatch',
    reason: 'The task could not be delivered to a runner, and a fresh delivery did not help',
    label: 'Buildd is working on a platform problem affecting this task.',
  };
  const base = {
    cause: { reasonCode: prior?.cause.reasonCode ?? incident.reasonCode, rule: incident.rule, ownership: 'infrastructure' as const },
    subjects: facts.subjects.map(x => ({ kind: 'task' as const, id: x.taskId })),
    blockers: [],
    overlappingPaths: [],
    episodeStartedAt,
    lastProgressAt: s?.lastWorkerAt && s.lastWorkerAt > episodeStartedAt ? s.lastWorkerAt : null,
    verification: { predicate: 'dispatch.acked_and_worker_created', params: {} },
    fallbackDecision: DISMISS_ONLY,
    fallbackOperator: gap,
  };
  const outcome = (verdict: RecoveryVerdict): RecoveryPolicyOutcome => ({ ...base, verdict });

  if (!s || s.status === null) return outcome({ kind: 'inconclusive', reason: 'Buildd could not read the undelivered task.' });
  if (s.status !== 'pending' || (s.lastWorkerAt && s.lastWorkerAt > episodeStartedAt)) {
    return outcome({ kind: 'passed', summary: 'The task was delivered and started.' });
  }
  const generation = prior?.generation ?? 1;
  const redelivered = facts.incident.spentKeys.some(k => k.includes(':redeliver_dispatch:') && k.includes(`:g${generation}:`));
  const answer = RUNBOOKS['dispatch.delivery_exhausted']({
    outboxExhausted: !!s.outbox && s.outbox.status === 'failed' && s.outbox.attemptCount >= MAX_DELIVERY_ATTEMPTS,
    taskPending: true,
    runnerOnline: facts.runnerOnline,
    redeliveredThisGeneration: redelivered,
  });
  if (answer === 'redeliver_dispatch') {
    return outcome({ kind: 'repair', action: 'redeliver_dispatch', subject: { kind: 'task', id: s.taskId }, once: true, label: 'Delivering the task to a runner again.', params: {} });
  }
  if (answer === 'escalate') return outcome({ kind: 'operator', ...gap });
  return outcome({ kind: 'wait', label: facts.runnerOnline === false ? 'Waiting for a runner to come online.' : 'Waiting for the delivery to settle.' });
}

export const dispatchRecoveryFamily: RecoveryFamily<RepairFacts> = {
  rule: 'repeated_failure',
  applies: incident => runbookFor({ ...incident, causeCode: readRecovery(incident)?.cause.reasonCode }) === 'dispatch.delivery_exhausted',
  async observe(incident) {
    const facts = await loadRepairFacts(incident);
    // The read time is not evidence: the same facts must hash to the same revision (FIR §5 rule 1).
    return { complete: facts.subjects.length > 0 && facts.subjects.every(x => x.status !== null), facts: { ...facts, observedAt: '' } };
  },
  evaluate: evaluateDispatchFailure,
};
