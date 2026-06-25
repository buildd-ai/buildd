'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

export interface WorkspaceFilterProps {
  workspaces: { id: string; name: string }[];
  selectedId: string | null;
}

/**
 * Build the ?workspace= query string for a given selection.
 * Exported for testing — the component delegates navigation to this.
 */
export function buildWorkspaceParam(currentSearch: string, workspaceId: string | null): string {
  const params = new URLSearchParams(currentSearch);
  if (workspaceId) {
    params.set('workspace', workspaceId);
  } else {
    params.delete('workspace');
  }
  return params.toString();
}

/**
 * Shared workspace narrowing filter used on team-primary data surfaces.
 * State lives in the URL (?workspace=<id>) — shareable and back-button safe.
 * Null selection (default) means all workspaces in the active team.
 * Switching teams (page reload) naturally clears the param.
 */
export function WorkspaceFilter({ workspaces, selectedId }: WorkspaceFilterProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const handleChange = useCallback(
    (id: string | null) => {
      const qs = buildWorkspaceParam(searchParams.toString(), id);
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`);
    },
    [router, pathname, searchParams],
  );

  if (workspaces.length === 0) return null;

  return (
    <select
      value={selectedId ?? ''}
      onChange={(e) => handleChange(e.target.value || null)}
      className="h-8 px-2 text-xs rounded-lg border border-border-default bg-surface text-text-secondary hover:border-border-strong transition-colors"
      aria-label="Filter by workspace"
    >
      <option value="">All workspaces</option>
      {workspaces.map((ws) => (
        <option key={ws.id} value={ws.id}>
          {ws.name}
        </option>
      ))}
    </select>
  );
}
