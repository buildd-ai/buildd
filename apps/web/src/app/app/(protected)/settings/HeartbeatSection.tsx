'use client';

import { useState, useEffect } from 'react';

export default function HeartbeatSection({ workspaceId }: { workspaceId: string }) {
  const [checklist, setChecklist] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newItem, setNewItem] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchChecklist();
  }, [workspaceId]);

  async function fetchChecklist() {
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/heartbeat`);
      if (res.ok) {
        const data = await res.json();
        setChecklist(data.checklist || []);
      } else {
        setError('Failed to load checklist');
      }
    } catch {
      setError('Failed to load checklist');
    } finally {
      setLoading(false);
    }
  }

  async function saveChecklist(updated: string[]) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/heartbeat`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checklist: updated }),
      });
      if (res.ok) {
        const data = await res.json();
        setChecklist(data.checklist || updated);
      } else {
        const err = await res.json().catch(() => ({}));
        setError(err.error || 'Failed to save');
      }
    } catch {
      setError('Failed to save');
    } finally {
      setSaving(false);
    }
  }

  function handleAdd() {
    const trimmed = newItem.trim();
    if (!trimmed) return;
    const updated = [...checklist, trimmed];
    setNewItem('');
    setChecklist(updated);
    saveChecklist(updated);
  }

  function handleDelete(index: number) {
    const updated = checklist.filter((_, i) => i !== index);
    setChecklist(updated);
    saveChecklist(updated);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAdd();
    }
  }

  return (
    <section>
      <div className="flex justify-between items-center mb-4">
        <div>
          <h2 className="text-lg font-semibold">Heartbeat Checklist</h2>
          <p className="text-xs text-text-muted mt-0.5">
            Items workers verify during periodic heartbeat checks.
          </p>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg text-sm bg-status-error/10 text-status-error border border-status-error/30">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-text-secondary text-sm">Loading...</div>
      ) : (
        <div className="border border-border-default rounded-lg">
          {checklist.length === 0 && !saving ? (
            <div className="p-6 text-center">
              <p className="text-text-secondary text-sm">No checklist items yet</p>
            </div>
          ) : (
            <div className="divide-y divide-border-default">
              {checklist.map((item, index) => (
                <div key={index} className="flex items-center justify-between p-3 group">
                  <span className="text-sm text-text-primary">{item}</span>
                  <button
                    onClick={() => handleDelete(index)}
                    disabled={saving}
                    className="text-text-secondary hover:text-status-error text-sm opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-50 px-1"
                    aria-label={`Remove "${item}"`}
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="border-t border-border-default p-3 flex gap-2">
            <input
              type="text"
              value={newItem}
              onChange={(e) => setNewItem(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Add checklist item..."
              disabled={saving}
              className="flex-1 text-sm bg-transparent border border-border-default rounded-md px-3 py-1.5 placeholder:text-text-muted focus:outline-none focus:border-primary disabled:opacity-50"
            />
            <button
              onClick={handleAdd}
              disabled={saving || !newItem.trim()}
              className="px-3 py-1.5 text-sm bg-primary text-white rounded-md hover:bg-primary-hover disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Add'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
