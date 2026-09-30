/**
 * Runner tokens grouped by team for Settings → Runners: newest token first
 * inside a group, and the group with the newest token first. Pure.
 */
export interface TokenLike {
  id: string;
  createdAt?: string | Date | null;
  lastSeenAt?: string | null;
  team: { name: string } | null;
}

export interface TokenGroup<T extends TokenLike> {
  team: string;
  tokens: T[];
  /** Most recent heartbeat across the group's tokens, ISO. */
  lastSeenAt: string | null;
}

const at = (d: string | Date | null | undefined) => (d ? new Date(d).getTime() : 0) || 0;

export function groupRunnerTokens<T extends TokenLike>(tokens: readonly T[]): TokenGroup<T>[] {
  const byTeam = new Map<string, T[]>();
  for (const t of tokens) {
    const key = t.team?.name ?? 'No team';
    byTeam.set(key, [...(byTeam.get(key) ?? []), t]);
  }
  const groups = [...byTeam].map(([team, list]) => {
    const sorted = [...list].sort((a, b) => at(b.createdAt) - at(a.createdAt));
    const seen = sorted.map(t => t.lastSeenAt).filter((s): s is string => !!s).sort((a, b) => at(b) - at(a));
    return { team, tokens: sorted, lastSeenAt: seen[0] ?? null };
  });
  return groups.sort((a, b) => at(b.tokens[0]?.createdAt) - at(a.tokens[0]?.createdAt));
}
