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
import { STRAND_CHOICE_CAPABILITY } from './strand-choice-decision';
import { strandChoiceObjective } from './strand-choice-gold';

/** Objectives for features that write `decision_records` under a bare capability id, not a kind id. */
export const CAPABILITY_OBJECTIVES: Readonly<Record<string, DecisionObjective>> = {
  [STRAND_CHOICE_CAPABILITY]: strandChoiceObjective,
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
