/**
 * The Health sub-nav, for the Health module. The list itself lives in core
 * navigation (lib/nav-config.tsx: HEALTH_NAV), because the mobile header names
 * these pages; this file adds the audience filter the sub-nav applies.
 */
import { HEALTH_NAV, type HealthNavItem } from './nav-config';

export { HEALTH_INDEX_HREF, HEALTH_NAV, healthItemFor, type HealthNavItem, type HealthSectionId } from './nav-config';

export interface HealthViewer {
  /** A buildd platform operator (lib/platform-operator.ts). */
  operator: boolean;
  /** Holds view_team_usage in the active team. */
  teamAdmin: boolean;
}

export function healthNavFor(viewer: HealthViewer): HealthNavItem[] {
  return HEALTH_NAV.filter(item => (viewer.operator || !item.operatorOnly) && (viewer.teamAdmin || !item.teamAdminOnly));
}
