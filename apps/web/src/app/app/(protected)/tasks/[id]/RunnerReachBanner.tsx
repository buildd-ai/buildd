'use client';

/**
 * Why no runner can claim this pending task, and (owner/admin only) the
 * one-click fix: link the team's online runners to the restricted workspace.
 * The rule is lib/runner-reach-diagnosis.
 */
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { RunnerReachDiagnosis } from '@/lib/runner-reach-diagnosis';

export default function RunnerReachBanner({
  workspaceId,
  diagnosis,
  canFix,
}: {
  workspaceId: string;
  diagnosis: RunnerReachDiagnosis;
  canFix: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function link() {
    setPending(true);
    setError(null);
    try {
      for (const accountId of diagnosis.fixAccountIds) {
        const res = await fetch(`/api/workspaces/${workspaceId}/accounts`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ accountId, canClaim: true, canCreate: true }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Link failed (${res.status})`);
        }
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Link failed');
    } finally {
      setPending(false);
    }
  }

  const canLink = canFix && diagnosis.fixAccountIds.length > 0;
  return (
    <div
      data-testid="runner-reach-banner"
      data-reason={diagnosis.reason}
      role="status"
      className="mb-6 space-y-3 border border-status-warning p-4"
    >
      <p className="font-mono text-meta font-medium text-status-warning">{diagnosis.message}</p>
      <div className="flex flex-wrap items-center gap-2">
        {canLink && (
          <button
            type="button"
            data-action="link_runner"
            onClick={link}
            disabled={pending}
            className="btn btn-primary min-h-11 shrink-0"
          >
            {pending ? 'Linking…' : diagnosis.fixAccountIds.length === 1 ? 'Link my runner' : `Link ${diagnosis.fixAccountIds.length} runners`}
          </button>
        )}
        <Link
          href={`/app/workspaces/${workspaceId}`}
          className="inline-flex min-h-11 items-center px-3 font-mono text-meta text-text-secondary hover:bg-surface-3 hover:text-text-primary"
        >
          Workspace runners
        </Link>
      </div>
      {!canFix && diagnosis.fixAccountIds.length > 0 && (
        <p className="font-mono text-[11px] text-text-muted">A team owner or admin can link it.</p>
      )}
      {error && <p className="font-mono text-meta text-status-error">{error}</p>}
    </div>
  );
}
