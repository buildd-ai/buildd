/**
 * Returns true if the given nav href should be considered active for the current pathname.
 * Handles prefix-matching for most routes, with exact match for /app/home.
 */
export function isNavActive(pathname: string, href: string): boolean {
  if (href === '/app/home') {
    return pathname === '/app/home' || pathname === '/app/dashboard';
  }
  if (href === '/app/missions') {
    return pathname.startsWith('/app/missions');
  }
  if (href === '/app/tasks') {
    return pathname.startsWith('/app/tasks');
  }
  if (href === '/app/team') {
    return pathname === '/app/team' || pathname.startsWith('/app/team/');
  }
  if (href === '/app/health') {
    return pathname.startsWith('/app/health');
  }
  return pathname === href;
}
