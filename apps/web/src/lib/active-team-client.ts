/**
 * Client-side view of the active team. The team switcher persists it in the
 * `buildd-team` cookie (see switch-team.ts); forms that ask "which team owns
 * this?" should default to it rather than to Personal.
 */

export function parseActiveTeamCookie(cookie: string): string | null {
  const match = cookie.match(/(?:^|;\s*)buildd-team=([^;]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    // Malformed percent-encoding (hand-edited or truncated cookie): treat as unset.
    return null;
  }
}

export function readActiveTeamCookie(): string | null {
  if (typeof document === 'undefined') return null;
  return parseActiveTeamCookie(document.cookie);
}

/** Active team if the user belongs to it, else Personal, else the first team. */
export function defaultTeamId(
  teams: readonly { id: string; slug: string }[],
  activeTeamId: string | null,
): string {
  const active = activeTeamId ? teams.find(t => t.id === activeTeamId) : undefined;
  if (active) return active.id;
  const personal = teams.find(t => t.slug.startsWith('personal-'));
  if (personal) return personal.id;
  return teams[0]?.id ?? '';
}
