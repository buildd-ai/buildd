/**
 * Which objective scores a feature's automatic outcome labels in the health
 * readout (packages/core/decision-feature-health.ts `outcomeGraded`).
 *
 * Nothing new is defined here. A kind carries its objective on its binding
 * (`binding.readout.objective`), the same one the prompt evals and the model
 * optimizer grade collected decisions with; the strand choice is not a
 * registered kind, so its objective (lib/strand-choice-gold.ts) is named here.
 *
 * A feature with no objective is absent: its labels count as coverage only.
 */
import type { DecisionObjective } from '@buildd/core/decision-readout';
import { listBuilddDecisionKinds } from '@buildd/core/decision-kinds';
import { strandChoiceObjective } from './strand-choice-gold';

/**
 * Objectives for features that write `decision_records` under a bare capability id, not a kind id.
 * The id is spelled out, not imported from strand-choice-decision.ts: that module reaches the decision
 * ledger's writers, and a read route must not pull them in (a test pins it equal to STRAND_CHOICE_CAPABILITY).
 */
export const CAPABILITY_OBJECTIVES: Readonly<Record<string, DecisionObjective>> = {
  mission_strand_choice: strandChoiceObjective,
};

/** The kinds whose bindings carry an objective. Loaded lazily: importing one registers it. */
async function loadObjectiveKinds() {
  await Promise.all([
    import('@buildd/core/decision-kind-post-session-triage'),
    import('@buildd/core/decision-kind-scout-probe-selection'),
    import('@buildd/core/decision-kind-operator-recovery'),
  ].map(p => p.catch(err => console.warn('[decision-health] a decision kind did not load:', err instanceof Error ? err.message : String(err)))));
}

/** The objective lookup for a health readout: by ledger capability (a kind id or a bare capability id). */
export async function healthObjectiveLookup(): Promise<(capability: string) => DecisionObjective | undefined> {
  await loadObjectiveKinds();
  const byKind = new Map<string, DecisionObjective>();
  for (const k of listBuilddDecisionKinds()) {
    const o = k.binding.readout?.objective;
    if (o) byKind.set(k.kind, o);
  }
  return capability => byKind.get(capability) ?? CAPABILITY_OBJECTIVES[capability];
}
