'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Dialog, { BRAND_DIALOG_PANEL } from '@/components/ui/Dialog';

interface Props {
  taskId: string;
  taskStatus: string;
}

export default function DeleteTaskButton({ taskId, taskStatus }: Props) {
  const router = useRouter();
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Allow deleting pending, assigned, or failed tasks (not running or completed)
  const canDelete = ['pending', 'assigned', 'failed'].includes(taskStatus);

  const handleDelete = async () => {
    setLoading(true);
    setError('');

    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to delete task');
      }

      router.push('/app/tasks');
      router.refresh();
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  };

  if (!canDelete) {
    return null;
  }

  return (
    <>
      <button
        onClick={() => setShowConfirm(true)}
        className="px-4 py-2 text-sm text-status-error border border-status-error/20 rounded-md hover:bg-status-error/10"
      >
        Delete
      </button>

      {/* Destructive: a confirmation dialog, not a sheet — in the brand's square, ink-bordered shell. */}
      <Dialog
        open={showConfirm}
        onClose={() => setShowConfirm(false)}
        labelledBy="delete-task-title"
        describedBy="delete-task-body"
        dismissible={!loading}
        className={BRAND_DIALOG_PANEL}
      >
          <div className="p-5">
            <h3 id="delete-task-title" className="mb-2 font-mono text-[15px] font-semibold text-text-primary">Delete task?</h3>
            <p id="delete-task-body" className="text-text-secondary text-sm mb-4">
              This deletes the task and its history. You can’t undo it.
            </p>

            {error && (
              <div className="p-2 text-sm bg-status-error/10 text-status-error rounded mb-4">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowConfirm(false)}
                disabled={loading}
                className="px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-3 rounded"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={loading}
                className="px-3 py-1.5 text-sm bg-status-error text-white rounded hover:opacity-90 disabled:opacity-50"
              >
                {loading ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
      </Dialog>
    </>
  );
}
