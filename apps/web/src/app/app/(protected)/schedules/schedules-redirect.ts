/**
 * Where the retired cross-workspace Schedules page sends you: the named
 * workspace's schedules when you can see it, else your first workspace's,
 * else Missions (mission check-ins and crons live on the mission).
 */
export function schedulesRedirectTarget(input: {
  requested: string | null;
  workspaces: ReadonlyArray<{ id: string; name: string }>;
}): string {
  const { requested, workspaces } = input;
  const ws = workspaces.find(w => w.id === requested) ?? workspaces[0];
  return ws ? `/app/workspaces/${ws.id}/schedules` : '/app/missions';
}
