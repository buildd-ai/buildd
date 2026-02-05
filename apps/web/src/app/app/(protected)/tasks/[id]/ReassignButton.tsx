'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function ReassignButton({ taskId }: { taskId: string }) {
  const [loading, setLoading] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const router = useRouter();

  async function handleReassign() {
    setLoading(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/reassign?force=true`, {
        method: 'POST',
      });

      if (!res.ok) {
        const data = await res.json();
        alert(data.error || 'Failed to reassign task');
        return;
      }

      router.refresh();
      setShowConfirm(false);
    } catch (error) {
      alert('Failed to reassign task');
    } finally {
      setLoading(false);
    }
  }

  if (showConfirm) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-gray-500">Reset to pending?</span>
        <button
          onClick={handleReassign}
          disabled={loading}
          className="px-3 py-1 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
        >
          {loading ? 'Resetting...' : 'Yes, Reset'}
        </button>
        <button
          onClick={() => setShowConfirm(false)}
          className="px-3 py-1 text-sm border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setShowConfirm(true)}
      className="px-4 py-2 text-sm border border-orange-300 dark:border-orange-700 text-orange-600 dark:text-orange-400 rounded-lg hover:bg-orange-50 dark:hover:bg-orange-950"
    >
      Reassign
    </button>
  );
}
