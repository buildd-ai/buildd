/** Claim's learning extension contract, wired by the composition root. */
import type { ClaimLearningPolicy } from '@buildd/core/orchestration-claim-learning';
import type { OrchestrationDecisionDeps } from '@buildd/core/orchestration-decision';

export interface ClaimLearningHooks {
  areaClass(paths: readonly string[]): 'core/db' | 'other' | 'unknown';
  fingerprint: string;
  loadPolicy(gate: string, area: string): Promise<ClaimLearningPolicy>;
  record: NonNullable<OrchestrationDecisionDeps['record']>;
}
