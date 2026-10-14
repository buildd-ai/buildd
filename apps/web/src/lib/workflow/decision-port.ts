/**
 * buildd's decision layer as the kernel's `Decide` port
 * (docs/specs/workflow-kernel-library.md §2 "Decide"), owned by the decisions
 * module and handed in through the composition root (`workflowKernelHooks()`
 * in apps/web/src/modules.ts). The kernel reaches it only through
 * `decideAt` / `decideAndRecord`, which bound it with a timeout, take the
 * package default when it has no answer, and record the decision as a fact.
 *
 * One point so far: `visual_impact`, answered by the `buildd.visual_impact`
 * decision kind through `runBuilddDecision` (its capability check, the team's
 * decision model, its own ledger row). Only the model's own answer is an
 * answer: a rule or fallback response throws with its reason code, so the
 * kernel records the default with that reason (`fallback: error`).
 */
import { runBuilddDecision } from '@buildd/core/decision-policy';
import { visualImpactKind } from '@buildd/core/decision-kind-visual-impact';
import type { Decide } from '@buildd/workflow-kernel/ports';

export const BUILDD_DECIDER_ID = 'buildd.decision-model';

/** The scope a decision is asked in: who pays for it and whose ledger it lands in. */
export interface DecisionScope { teamId: string; workspaceId: string; missionId: string }

function scopeOf(input: Record<string, unknown>): DecisionScope | null {
  const s = input.scope as Partial<DecisionScope> | null | undefined;
  return s && typeof s.teamId === 'string' && typeof s.workspaceId === 'string' && typeof s.missionId === 'string'
    ? { teamId: s.teamId, workspaceId: s.workspaceId, missionId: s.missionId } : null;
}

export const builddDecide: Decide = {
  id: BUILDD_DECIDER_ID,
  async decide(point, input) {
    if (point !== 'visual_impact') return null;
    const scope = scopeOf(input);
    if (!scope) return null;
    const response = await runBuilddDecision(
      visualImpactKind,
      { features: input.features as never, subjectRef: { type: 'mission', id: scope.missionId } },
      scope,
    );
    if (response.source !== 'model') throw new Error(`no model answer: ${response.reasonCode}`);
    return { verdict: response.decision, confidence: response.confidence ?? 0, reason: response.reasonCode };
  },
};
