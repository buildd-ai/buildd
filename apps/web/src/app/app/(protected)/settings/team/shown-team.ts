/**
 * Which team Settings › Team shows: `?team=<id>` when it names one of the
 * person's teams, else the active team. An id they are not a member of falls
 * back silently, so the page never shows a team it would refuse to load.
 */
export function pickShownTeam<T extends { id: string }>(
  userTeams: T[],
  requested: string | string[] | undefined,
  active: T | null,
): T | null {
  const id = Array.isArray(requested) ? requested[0] : requested;
  return (id && userTeams.find((t) => t.id === id)) || active;
}
