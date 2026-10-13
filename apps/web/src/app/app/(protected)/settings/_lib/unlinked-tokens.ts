/**
 * The Runners chip for tokens with no workspace link. Such a token still
 * reaches every open workspace of its own team (lib/workspace-reach.ts), so it
 * is only a problem when the team has none: then it reaches nothing.
 */
export function unlinkedTokensChip(
  unlinked: number,
  openWorkspaces: number,
): { tone: 'idle' | 'warn'; label: string } | null {
  if (unlinked === 0) return null;
  if (openWorkspaces > 0) return { tone: 'idle', label: `${unlinked} on open workspaces only` };
  return { tone: 'warn', label: `${unlinked} ${unlinked === 1 ? 'reaches' : 'reach'} no workspace` };
}
