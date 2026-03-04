'use client';

import { useState, useEffect } from 'react';

interface Workspace {
  id: string;
  name: string;
}

export default function HeartbeatSection({ workspaces }: { workspaces: Workspace[] }) {
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>(workspaces[0]?.id || '');
  const [checklist, setChecklist] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newItem, setNewItem] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (selectedWorkspace) {
      fetchChecklist(selectedWorkspace);
    }
  }, [selectedWorkspace]);

  async function fetchChecklist(workspaceId: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/heartbeat`);
      if (res.ok) {
        const data = await res.json();
        setChecklist(data.checklist || []);
      } else {
        setError('Failed to load goals');
      }
    } catch {
      setError('Failed to load goals');
    } finally {
      setLoading(false);
    }
  }

  async function saveChecklist(updated: string[]) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${selectedWorkspace}/heartbeat`, {
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

  if (!workspaces.length) return null;

  return (
    <section>
      <div className="flex justify-between items-center mb-4">
        <div>
          <h2 className="text-lg font-semibold">Worker Goals</h2>
          <p className="text-xs text-text-muted mt-0.5">
            Goals your workers check on periodically while running.
          </p>
        </div>
        {workspaces.length > 1 && (
          <select
            value={selectedWorkspace}
            onChange={(e) => setSelectedWorkspace(e.target.value)}
            className="text-sm bg-surface-2 border border-border-default rounded-md px-2 py-1"
          >
            {workspaces.map((ws) => (
              <option key={ws.id} value={ws.id}>{ws.name}</option>
            ))}
          </select>
        )}
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
              <p className="text-text-secondary text-sm">No goals yet</p>
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
              placeholder="Add a goal..."
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
