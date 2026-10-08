/**
 * One read of "which model does each tier run, why, and is there something
 * newer": the answer behind manage_model_tiers action=policy, Settings → Models
 * and the Home stale-model notice. DB-backed; the logic is model-upgrade-policy.ts.
 */
import { getCachedOpenRouterCatalog } from './model-catalog-cache';
import { getModelCertifications } from './model-certification-store';
import { resolveTierEntry } from './model-tier-registry';
import { TIERS } from './model-tier-defaults';
import {
  ANY_CURRENT_RUNNER,
  explainTierAdoption,
  type EffectiveUpgradePolicy,
  type TierAdoption,
} from './model-upgrade-policy';
import { loadUpgradePolicy } from './model-upgrade-policy-store';

export interface AdoptionReport {
  policy: EffectiveUpgradePolicy;
  tiers: TierAdoption[];
}

/**
 * The agent-surface answer for a team (or one workspace), as an up-to-date
 * runner would be served: an older runner may still get an earlier in-band
 * model, which is a runner upgrade, not a policy question.
 */
export async function buildAdoptionReport(
  teamId: string,
  workspaceId: string | null,
  now = Date.now(),
): Promise<AdoptionReport> {
  const [policy, catalog, certifications] = await Promise.all([
    loadUpgradePolicy(teamId, workspaceId),
    getCachedOpenRouterCatalog(),
    getModelCertifications(),
  ]);
  const entries = await Promise.all(
    TIERS.map((tier) => resolveTierEntry(tier, teamId, workspaceId, 'agent', ANY_CURRENT_RUNNER)),
  );
  return {
    policy,
    tiers: TIERS.map((tier, i) =>
      explainTierAdoption({ tier, current: entries[i], policy, catalog, certifications, now }),
    ),
  };
}
