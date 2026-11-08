/** The workspace to read: the requested one only if the viewer can reach it, else their first. */
export function resolveComparisonWorkspace<W extends { id: string }>(reachable: readonly W[], requested: string | undefined): W | null {
  return reachable.find((w) => w.id === requested) ?? reachable[0] ?? null;
}
