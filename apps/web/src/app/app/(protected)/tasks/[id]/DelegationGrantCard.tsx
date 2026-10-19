'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface DelegationNeed {
  workspaceId: string;
  /** The workspace's name, or null when the viewer cannot see it. */
  workspaceName: string | null;
  capability: string;
}

const NEED_TEXT: Record<string, string> = {
  'analytics:read': 'read analytics in',
  'tasks:create': 'file tasks in',
};

/**
 * A pending task held at claim (`delegation_unmet`) because it declares reads
 * or filing targets no grant covers (spec workspace-routing-and-reach I-20).
 * Names each uncovered need and grants them all in one action: the same
 * person-only `delegation` write as update_task, which the route validates
 * (lib/task-delegation-checks.ts resolveTaskDelegationWrite). The task is
 * claimable on the next poll by a runner that reaches each workspace.
 */
export default function DelegationGrantCard({
  taskId,
  needs,
  grant,
  canGrant,
}: {
  taskId: string;
  needs: DelegationNeed[];
  grant: { grants: { workspaceId: string; capabilities: string[] }[] };
  /** False when the viewer does not reach every workspace: the route would refuse. */
  canGrant: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function grantAccess() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delegation: grant }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Could not grant access. Try again.');
        return;
      }
      router.refresh();
    } catch {
      setError('Could not grant access.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div data-testid="delegation-grant" className="bg-status-warning/10 border border-status-warning/20 p-4 mb-6">
      <p className="text-sm font-medium text-status-warning">Held: it needs access to another workspace that nobody has granted yet</p>
      <ul className="mt-2 text-sm text-text-secondary list-disc pl-5">
        {needs.map(n => (
          <li key={`${n.workspaceId}-${n.capability}`} data-testid="delegation-grant-need">
            It will {NEED_TEXT[n.capability] ?? `use ${n.capability} in`} {n.workspaceName ?? `workspace ${n.workspaceId}`}
          </li>
        ))}
      </ul>
      {canGrant ? (
        <button
          type="button"
          data-testid="delegation-grant-action"
          onClick={grantAccess}
          disabled={pending}
          className="mt-3 px-2.5 py-1 min-h-11 md:min-h-0 text-xs font-medium rounded border border-border-default bg-surface-1 text-text-primary hover:bg-surface-2 disabled:opacity-50"
        >
          {pending ? 'Granting…' : 'Grant access'}
        </button>
      ) : (
        <p className="mt-2 text-sm text-text-muted">Someone who reaches each of these workspaces can grant it here.</p>
      )}
      {error && <p className="mt-2 text-sm text-status-error">{error}</p>}
      <p className="mt-2 text-meta text-text-muted">A runner that reaches the workspace starts it on its next poll.</p>
    </div>
  );
}
