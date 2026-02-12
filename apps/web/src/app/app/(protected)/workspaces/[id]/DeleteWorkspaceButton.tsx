'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import ConfirmDialog from '@/components/ConfirmDialog';

export default function DeleteWorkspaceButton({ workspaceId, workspaceName }: { workspaceId: string; workspaceName: string }) {
  const router = useRouter();
  const [showConfirm, setShowConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to delete');
      }

      router.push('/app/workspaces');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete workspace');
      setDeleting(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setShowConfirm(true)}
        disabled={deleting}
        className="px-4 py-2 border border-status-error/30 text-status-error rounded-lg hover:bg-status-error/10 disabled:opacity-50"
      >
        {deleting ? 'Deleting...' : 'Delete Workspace'}
      </button>

      <ConfirmDialog
        open={showConfirm}
        title={`Delete "${workspaceName}"?`}
        message={error || "This will also delete all tasks and workers in this workspace. This cannot be undone."}
        confirmLabel="Delete"
        variant="danger"
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => {
          setShowConfirm(false);
          setError(null);
        }}
      />
    </>
  );
}
