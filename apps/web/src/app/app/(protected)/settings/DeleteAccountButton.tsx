'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import ConfirmDialog from '@/components/ConfirmDialog';

export default function DeleteAccountButton({ accountId, accountName }: { accountId: string; accountName: string }) {
  const router = useRouter();
  const [showConfirm, setShowConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/accounts/${accountId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Could not delete the account.");
      }

      setShowConfirm(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the account.");
      setDeleting(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setShowConfirm(true)}
        disabled={deleting}
        className="btn btn-danger"
      >
        {deleting ? 'Deleting…' : 'Delete'}
      </button>

      <ConfirmDialog
        open={showConfirm}
        title={`Delete "${accountName}"?`}
        message={error || "Revokes the API key. You can't undo this."}
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
