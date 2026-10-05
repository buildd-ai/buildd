/**
 * Health information architecture: one list for the Health sub-nav (desktop
 * column), the phone link row, and the mobile header title. Every item is its
 * own route so a section is linkable. Operator is buildd's own tooling and
 * exists only for platform operators (lib/platform-operator.ts).
 */

export type HealthSectionId = 'overview' | 'failures' | 'runners' | 'usage' | 'insights' | 'operator';

export interface HealthNavItem {
  id: HealthSectionId;
  label: string;
  href: string;
  /** Only buildd platform operators see this item and its route. */
  operatorOnly?: boolean;
}

export const HEALTH_INDEX_HREF = '/app/health';

export const HEALTH_NAV: readonly HealthNavItem[] = [
  { id: 'overview', label: 'Overview', href: HEALTH_INDEX_HREF },
  { id: 'failures', label: 'Failures', href: '/app/health/failures' },
  { id: 'runners', label: 'Runners & capacity', href: '/app/health/runners' },
  { id: 'usage', label: 'Usage', href: '/app/health/usage' },
  { id: 'insights', label: 'Insights', href: '/app/health/insights' },
  { id: 'operator', label: 'Operator', href: '/app/health/operator', operatorOnly: true },
];

export function healthNavFor(isOperator: boolean): HealthNavItem[] {
  return HEALTH_NAV.filter(item => isOperator || !item.operatorOnly);
}

export function healthItemFor(pathname: string): HealthNavItem | null {
  if (pathname === HEALTH_INDEX_HREF) return HEALTH_NAV[0];
  for (const item of HEALTH_NAV) {
    if (item.href === HEALTH_INDEX_HREF) continue;
    if (pathname === item.href || pathname.startsWith(`${item.href}/`)) return item;
  }
  return null;
}
