/**
 * Decisions module: the red-check cause a rule could not call
 * (`pr.red_check_unclassified`), judged by `buildd.red_check_cause` from the
 * failing lines and written onto the PR's red-check record
 * (lib/red-check-record.ts `saveRedJudgement`). Home reads the record and
 * never waits on this (surface-ia-home-missions-initiatives.md §11 R-3).
 *
 * A fallback answer (no model route, a provider failure, or below the kind's
 * threshold) is stored too, as `code`, so the card reads as it would without
 * it and the head is not asked again for the same failure. A team that has
 * the capability off stores nothing: no decision was made.
 */
import { runBuilddDecision, type BuilddDecisionScope } from '@buildd/core/decision-policy';
import { redCheckCauseKind, type RedCheckCauseFeatures } from '@buildd/core/decision-kind-red-check-cause';
import type { DecisionRequest, DecisionResponse } from '@buildd/core/decision-kinds';
import type { EventOf } from '@/lib/core-events';
import { redCheckScope, saveRedJudgement } from '@/lib/red-check-record';
import type { RedJudgement } from '@/lib/red-check-cause';

export interface RedCheckDecisionDeps {
  scope?: typeof redCheckScope;
  run?: (
    kind: typeof redCheckCauseKind,
    request: DecisionRequest<RedCheckCauseFeatures>,
    scope: BuilddDecisionScope,
  ) => Promise<Pick<DecisionResponse, 'decision' | 'confidence' | 'source' | 'mode' | 'model' | 'reasonCode' | 'policyVersion'>>;
  save?: typeof saveRedJudgement;
  now?: () => Date;
}

/** Judge one unclassified red head and store the answer. Never throws. */
export async function judgeRedCheck(e: EventOf<'pr.red_check_unclassified'>, deps: RedCheckDecisionDeps = {}): Promise<RedJudgement | null> {
  try {
    const scope = await (deps.scope ?? redCheckScope)(e.repoFullName, e.prNumber);
    if (!scope) return null;
    const run = deps.run ?? runBuilddDecision;
    const response = await run(
      redCheckCauseKind,
      // The kind's parser bounds and checks these (parseRedCheckCauseFeatures).
      { features: { jobs: e.jobs } as unknown as RedCheckCauseFeatures, subjectRef: { type: 'pr', id: `${e.repoFullName}#${e.prNumber}@${e.headSha}` } },
      { teamId: scope.teamId, workspaceId: scope.workspaceId, taskId: scope.taskId },
    );
    if (response.mode === 'disabled' && response.source !== 'rule') return null;
    const judgement: RedJudgement = {
      decision: response.decision === 'environment' ? 'environment' : 'code',
      confidence: response.confidence,
      source: response.source,
      model: response.model,
      reasonCode: response.reasonCode,
      policyVersion: response.policyVersion,
      signature: e.signature,
      at: (deps.now ?? (() => new Date()))().toISOString(),
    };
    const saved = await (deps.save ?? saveRedJudgement)({ repoFullName: e.repoFullName, prNumber: e.prNumber, headSha: e.headSha }, judgement);
    return saved ? judgement : null;
  } catch (err) {
    console.warn(`[red-check-decision] could not judge ${e.repoFullName}#${e.prNumber}@${e.headSha} (non-fatal):`, err);
    return null;
  }
}
