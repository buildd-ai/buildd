import { describe, it, expect } from 'bun:test';

// Logic extracted from page.tsx: narrow team workspace IDs to a single
// workspace when a workspace filter is selected via ?workspace=<id>.
// The filter is only applied when the selected workspace belongs to the team
// (wsFilter must be in teamWsIds) to prevent cross-team data exposure.
function resolveQueryWorkspaceIds(
  teamWsIds: string[],
  wsFilter: string | null | undefined,
): string[] {
  return wsFilter && teamWsIds.includes(wsFilter) ? [wsFilter] : teamWsIds;
}

describe('resolveQueryWorkspaceIds', () => {
  it('returns all team workspace IDs when no filter is set', () => {
    const result = resolveQueryWorkspaceIds(['ws-1', 'ws-2', 'ws-3'], null);
    expect(result).toEqual(['ws-1', 'ws-2', 'ws-3']);
  });

  it('narrows to the selected workspace when filter is a valid team workspace', () => {
    const result = resolveQueryWorkspaceIds(['ws-1', 'ws-2', 'ws-3'], 'ws-2');
    expect(result).toEqual(['ws-2']);
  });

  it('ignores a filter that is not in the team workspace list (prevents cross-team exposure)', () => {
    const result = resolveQueryWorkspaceIds(['ws-1', 'ws-2'], 'ws-other-team');
    expect(result).toEqual(['ws-1', 'ws-2']);
  });

  it('returns all workspaces when filter is undefined', () => {
    const result = resolveQueryWorkspaceIds(['ws-1'], undefined);
    expect(result).toEqual(['ws-1']);
  });

  it('returns empty array when team has no workspaces', () => {
    const result = resolveQueryWorkspaceIds([], null);
    expect(result).toEqual([]);
  });

  it('handles single-workspace team with matching filter', () => {
    const result = resolveQueryWorkspaceIds(['ws-solo'], 'ws-solo');
    expect(result).toEqual(['ws-solo']);
  });
});
