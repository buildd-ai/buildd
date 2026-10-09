/**
 * Returns true if the given nav href should be considered active for the current pathname.
 * Handles prefix-matching for most routes, with exact match for /app/home.
 */
export function isNavActive(pathname: string, href: string): boolean {
  if (href === '/app/home') {
    return pathname === '/app/home' || pathname === '/app/dashboard';
  }
  if (href === '/app/missions') {
    // Releases and Initiatives live under Missions (no nav item of their own).
    return ['/app/missions', '/app/releases', '/app/initiatives'].some(p => pathname === p || pathname.startsWith(`${p}/`));
  }
  if (href === '/app/initiatives') {
    return pathname.startsWith('/app/initiatives');
  }
  if (href === '/app/tasks') {
    return pathname.startsWith('/app/tasks');
  }
  if (href === '/app/team') {
    return pathname === '/app/team' || pathname.startsWith('/app/team/');
  }
  if (href === '/app/chat') {
    return pathname === '/app/chat' || pathname.startsWith('/app/chat/');
  }
  if (href === '/app/health') {
    return pathname.startsWith('/app/health');
  }
  return pathname === href;
}

/**
 * Account/connection pages have no bottom-nav tab — they are reached from the
 * header avatar menu, which shows the active state for them instead. Team
 * (the roles page) lives under Settings too.
 */
export function isAccountRoute(pathname: string): boolean {
  return ['/app/settings', '/app/team'].some(p => pathname === p || pathname.startsWith(`${p}/`));
}
