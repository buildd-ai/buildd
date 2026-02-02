'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function DeleteAccountButton({ accountId, accountName }: { accountId: string; accountName: string }) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!confirm(`Delete account "${accountName}"? This will revoke the API key and cannot be undone.`)) {
      return;
    }

    setDeleting(true);
    try {
      const res = await fetch(`/api/accounts/${accountId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to delete');
      }

      router.refresh();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to delete account');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <button
      onClick={handleDelete}
      disabled={deleting}
      className="text-red-600 hover:text-red-800 text-sm disabled:opacity-50"
    >
      {deleting ? 'Deleting...' : 'Delete'}
    </button>
  );
}
