import { NextResponse } from 'next/server';
import { activePromptFingerprints, promptFallbackCounts } from '@buildd/core/prompts';
import { getControlPlaneIdentity, getDeployIdentity } from '@/lib/deploy-identity';

/**
 * GET /api/deploy-identity
 *
 * Public endpoint (no auth) — answers what code is actually RUNNING right
 * now, read from the platform's own build-time environment. No database
 * access on this path: it must keep answering while the database is
 * unreachable, since "is the right code deployed" is precisely the question
 * asked when something else is broken.
 *
 * `/api/version`'s `deployed` block now reports the same values (via the
 * shared `getDeployIdentity` helper) so the two endpoints can never disagree;
 * this route stays as the minimal, dependency-free form for callers that only
 * need deploy identity, such as release-health verification.
 *
 * `prompts` is which prompt text this instance runs, as fingerprints only (id,
 * row version, content hash; never text), read from the in-process snapshot,
 * not the database. An id absent from `active` runs its public default.
 * `fallbacks` counts this instance's resolves that used a public default.
 *
 * `controlPlane` is the execution control plane Worker's commit and mode (it
 * serves claims, worker updates, webhooks and Dispatch callbacks), `null` when
 * it does not answer within a short timeout. `lockstep` is whether it runs the
 * web app's commit; `null` when either side is unknown.
 */
export async function GET() {
  const identity = getDeployIdentity();
  const controlPlane = await getControlPlaneIdentity();
  const lockstep = identity.sha && controlPlane?.commit ? controlPlane.commit === identity.sha : null;
  return NextResponse.json({
    ...identity,
    controlPlane: controlPlane ? { ...controlPlane, lockstep } : null,
    prompts: { active: activePromptFingerprints(), fallbacks: promptFallbackCounts() },
  });
}
