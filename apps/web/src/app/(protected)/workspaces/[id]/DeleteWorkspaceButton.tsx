'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function DeleteWorkspaceButton({ workspaceId, workspaceName }: { workspaceId: string; workspaceName: string }) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!confirm(`Delete workspace "${workspaceName}"?\n\nThis will also delete all tasks and workers in this workspace. This cannot be undone.`)) {
      return;
    }

    setDeleting(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to delete');
      }

      router.push('/workspaces');
      router.refresh();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to delete workspace');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <button
      onClick={handleDelete}
      disabled={deleting}
      className="px-4 py-2 border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
    >
      {deleting ? 'Deleting...' : 'Delete Workspace'}
    </button>
  );
}
