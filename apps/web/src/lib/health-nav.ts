/**
 * The Health sub-nav, for the Health module. The list itself lives in core
 * navigation (lib/nav-config.tsx: HEALTH_NAV), because the mobile header names
 * these pages; this file adds the operator filter the sub-nav applies.
 */
import { HEALTH_NAV, type HealthNavItem } from './nav-config';

export { HEALTH_INDEX_HREF, HEALTH_NAV, healthItemFor, type HealthNavItem, type HealthSectionId } from './nav-config';

export function healthNavFor(isOperator: boolean): HealthNavItem[] {
  return HEALTH_NAV.filter(item => isOperator || !item.operatorOnly);
}
