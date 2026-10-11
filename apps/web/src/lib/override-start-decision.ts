/**
 * Decisions module: an overriding START (`task.override_started`) as one
 * `orchestration_decisions` row the outcome join (`labelDecisionOutcomes`)
 * grades with no new join (docs/specs/force-start.md §Recording). Core emits
 * the fact (lib/force-start.ts); this is the only writer of the row.
 */
import { recordOrchestrationDecision } from '@buildd/core/orchestration-ledger-source';
import { subscriber, type AnySubscriber, type OverrideStart } from '@/lib/core-events';

/** Fire-and-forget; never throws. */
export function recordOverrideStartDecision(o: OverrideStart): void {
  void recordOrchestrationDecision({
    teamId: o.task.teamId,
    workspaceId: o.task.workspaceId,
    missionId: o.task.missionId,
    taskId: o.task.id,
    workerId: o.workerId,
    prNumber: null,
    headSha: null,
    baseRef: null,
    baseSha: null,
    capability: 'orchestration_claim',
    decisionId: o.decisionId,
    decisionVersion: `${o.policyPrefix}|${o.actor}|engine-0`,
    fingerprint: `${o.policyPrefix}-${o.primary}`.slice(0, 32),
    question: 'force_start',
    step: 0,
    mode: 'live',
    minConfidence: null,
    model: null,
    candidatePolicyVersion: `${o.policyPrefix}.${o.primary}`,
    candidateDigest: o.reasonsDigest,
    candidateCount: o.candidateCount,
    candidateTruncated: false,
    ruleVerdict: 'HOLD',
    suggested: 'START',
    confidence: null,
    effective: 'START',
    applied: true,
    status: 'applied',
    reason: null,
    errorKind: null,
    latencyMs: 0,
    retrievalMs: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    // A person's override is not an experiment draw: arm `human`, kept apart
    // from Jev cohorts. Observational evidence (eval set, disagreement
    // mining), never on-policy. The column is NOT NULL, so propensity is 1
    // (the start happened with certainty) rather than the spec's null.
    experimentArm: o.actor === 'human_force' ? 'human' : 'apply',
    propensity: 1,
    applyingFraction: 1,
    receipt: { actor: o.actor, ...o.receipt } as never,
  });
}

export const overrideStartSubscribers: readonly AnySubscriber[] = [
  subscriber('jev-decisions', 'task.override_started', 'override-start-decision', e => recordOverrideStartDecision(e.override)),
];
