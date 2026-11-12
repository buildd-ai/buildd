'use client';

import { useState } from 'react';
import Switch, { SWITCH_HIT_AREA } from '@/components/ui/Switch';
import ConfirmDialog from '@/components/ConfirmDialog';

/**
 * workspaces.knowledge_ingest: whether the repo's code, docs and pull request
 * changes are indexed for search. Off stops all new indexing and keeps what is
 * stored; deleting the stored content is its own action, so switching off can
 * never delete anything by accident.
 */
export default function KnowledgeIngestSection({
  workspaceId,
  initial,
  canEdit,
}: {
  workspaceId: string;
  initial: boolean;
  canEdit: boolean;
}) {
  const [on, setOn] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [purging, setPurging] = useState(false);
  const [purgeError, setPurgeError] = useState<string | null>(null);
  const [purgedChunks, setPurgedChunks] = useState<number | null>(null);

  async function patch(body: Record<string, unknown>) {
    const res = await fetch(`/api/workspaces/${workspaceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Could not save. Try again.');
    return data as { purgedChunks?: number };
  }

  async function toggle(next: boolean) {
    if (saving) return;
    setOn(next);
    setSaving(true);
    setError(null);
    try {
      await patch({ knowledgeIngest: next });
    } catch (e) {
      setOn(!next);
      setError(e instanceof Error ? e.message : 'Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  }

  async function purge() {
    setPurging(true);
    setPurgeError(null);
    try {
      const data = await patch({ purgeKnowledge: true });
      setPurgedChunks(typeof data.purgedChunks === 'number' ? data.purgedChunks : 0);
      setConfirming(false);
    } catch (e) {
      setPurgeError(e instanceof Error ? e.message : 'Could not delete. Try again.');
    } finally {
      setPurging(false);
    }
  }

  return (
    <div id="knowledge-ingest" data-testid="knowledge-ingest-section" className="py-4 first:pt-0 last:pb-0 scroll-mt-20">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 id="knowledge-ingest-label" className="text-sm font-medium text-text-primary">Index repository content for search</h3>
          <p className="text-xs text-text-secondary mt-0.5">
            Agents search this repository&apos;s code, docs and pull request changes. Off stops new indexing and keeps what is stored.
          </p>
        </div>
        {canEdit ? (
          <Switch
            checked={on}
            onChange={toggle}
            disabled={saving}
            labelledBy="knowledge-ingest-label"
            className={SWITCH_HIT_AREA}
          />
        ) : (
          <span data-testid="knowledge-ingest-value" className="text-sm text-text-primary shrink-0">{on ? 'On' : 'Off'}</span>
        )}
      </div>
      {error && <p className="text-status-error text-sm mt-2" role="alert">{error}</p>}

      {canEdit && (
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-text-primary">Delete indexed content</h3>
            <p className="text-xs text-text-secondary mt-0.5">
              {purgedChunks !== null
                ? `Deleted ${purgedChunks.toLocaleString()} indexed ${purgedChunks === 1 ? 'piece' : 'pieces'} of content.`
                : 'Removes stored code, docs and pull request content. Memories and task history stay.'}
            </p>
          </div>
          <button
            type="button"
            data-testid="knowledge-purge-button"
            onClick={() => setConfirming(true)}
            disabled={purging}
            className="btn btn-danger min-h-11 shrink-0"
          >
            {purging ? 'Deleting…' : 'Delete indexed content'}
          </button>
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        title="Delete indexed content?"
        message={
          purgeError
          || (on
            ? "Deletes the stored code, docs and pull request content. Indexing is still on, so the next merge starts it again. You can't undo this."
            : "Deletes the stored code, docs and pull request content. You can't undo this.")
        }
        confirmLabel="Delete"
        variant="danger"
        loading={purging}
        onConfirm={purge}
        onCancel={() => {
          setConfirming(false);
          setPurgeError(null);
        }}
      />
    </div>
  );
}
