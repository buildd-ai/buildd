'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-status-success/15 text-status-success',
  paused: 'bg-status-warning/15 text-status-warning',
  completed: 'bg-primary/15 text-primary',
  archived: 'bg-surface-3 text-text-muted',
};

interface ObjectiveItem {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  workspaceId: string | null;
  cronExpression: string | null;
  workspace?: { id: string; name: string } | null;
  totalTasks: number;
  completedTasks: number;
  progress: number;
}

export default function ObjectivesList({
  objectives,
  teamId,
}: {
  objectives: ObjectiveItem[];
  teamId: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/objectives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle.trim() }),
      });
      if (res.ok) {
        setNewTitle('');
        startTransition(() => router.refresh());
      }
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      {/* Create form */}
      <form onSubmit={handleCreate} className="flex gap-2 mb-6">
        <input
          type="text"
          value={newTitle}
          onChange={e => setNewTitle(e.target.value)}
          placeholder="New objective..."
          className="flex-1 px-3 py-2 bg-surface-2 border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
          disabled={creating}
        />
        <button
          type="submit"
          disabled={creating || !newTitle.trim()}
          className="px-4 py-2 bg-primary text-white text-sm rounded-md hover:bg-primary-hover disabled:opacity-50"
        >
          {creating ? 'Adding...' : 'Add'}
        </button>
      </form>

      {/* Objectives list */}
      {objectives.length === 0 ? (
        <div className="text-center py-12 text-text-secondary">
          <div className="w-12 h-12 mx-auto mb-4 bg-surface-3 rounded-full flex items-center justify-center">
            <svg className="w-6 h-6 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <p>No objectives yet. Create one to get started.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {objectives.map(obj => (
            <Link
              key={obj.id}
              href={`/app/objectives/${obj.id}`}
              className="block p-4 bg-surface-2 border border-border-default rounded-lg hover:border-primary/30 transition-colors"
            >
              <div className="flex items-center gap-3 mb-2">
                <h3 className="font-medium text-text-primary flex-1 truncate">{obj.title}</h3>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[obj.status] || ''}`}>
                  {obj.status}
                </span>
              </div>

              {obj.description && (
                <p className="text-sm text-text-secondary mb-2 line-clamp-1">{obj.description}</p>
              )}

              <div className="flex items-center gap-4 text-xs text-text-muted">
                {/* Progress bar */}
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <div className="flex-1 h-1.5 bg-surface-3 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full transition-all"
                      style={{ width: `${obj.progress}%` }}
                    />
                  </div>
                  <span>{obj.completedTasks}/{obj.totalTasks}</span>
                </div>

                {obj.workspace ? (
                  <span className="shrink-0">{obj.workspace.name}</span>
                ) : (
                  <span className="shrink-0 text-text-muted">All workspaces</span>
                )}

                {obj.cronExpression && (
                  <span className="shrink-0" title={obj.cronExpression}>Scheduled</span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
