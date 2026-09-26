import type { WorkerEnvironment } from '@buildd/shared';
import { CAPABILITY_BROWSER, VISUAL_AUDITOR_ROLE_SLUG } from '@buildd/shared';

/**
 * Role slugs this runner sends as `availableSkills` on claim.
 *
 * Only opt-in EXPLICIT_ROLE_SLUGS go here, never legacy roles: the server
 * ignores explicit slugs when deciding legacy routing, so advertising
 * 'visual-auditor' opens audit tasks without closing builder/organizer/...
 * (see apps/web/src/app/api/workers/claim/role-gate.ts).
 *
 * 'visual-auditor' needs a browser that actually launches, which env-scan
 * reports as CAPABILITY_BROWSER. The env re-scans every 30 min, so a browser
 * installed after boot is advertised from the next scan on.
 *
 * Returns undefined (not []) when there is nothing to advertise so the claim
 * body stays identical to a runner that predates this.
 */
export function advertisedRoleSlugs(env: WorkerEnvironment | undefined): string[] | undefined {
  if (env?.envKeys?.includes(CAPABILITY_BROWSER)) return [VISUAL_AUDITOR_ROLE_SLUG];
  return undefined;
}
