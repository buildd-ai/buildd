/** DB-backed deps for the platform tier defaults (lib/admin/platform-tier-defaults.ts). */
import { getCachedOpenRouterCatalog } from '@buildd/core/model-catalog-cache';
import { getModelCertifications } from '@buildd/core/model-certification-store';
import { resolveTierEntry } from '@buildd/core/model-tier-registry';
import { ANY_CURRENT_RUNNER } from '@buildd/core/model-upgrade-policy';
import { readPlatformTierDefault, writePlatformTierDefault } from '@buildd/core/model-tier-platform-default-store';
import { completePlatformAdminAudit, recordPlatformAdminAuditIntent } from './audit';
import { isPlatformOperatorCaller } from './platform-operator-caller';
import type { PlatformTierDefaultsDeps } from './platform-tier-defaults';

export function platformTierDefaultsDeps(): PlatformTierDefaultsDeps {
  return {
    now: () => Date.now(),
    catalog: getCachedOpenRouterCatalog,
    certifications: getModelCertifications,
    // No team: the platform row, else the policy service, the catalog pick
    // (as the best runner would be served), else the bundled fallback.
    resolveEffective: (tier) => resolveTierEntry(tier, null, null, 'agent', ANY_CURRENT_RUNNER),
    readRow: readPlatformTierDefault,
    writeRow: writePlatformTierDefault,
    isOperator: (caller) =>
      caller.principal === 'task_token' ? Promise.resolve(false) : isPlatformOperatorCaller({ user: caller.user, account: caller.account }),
    auditIntent: recordPlatformAdminAuditIntent,
    auditComplete: completePlatformAdminAudit,
  };
}
