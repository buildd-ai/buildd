'use client';

import { useState, useEffect, useRef } from 'react';

interface TaskOption {
  id: string;
  title: string;
  status: string;
}

interface Props {
  workspaceId: string;
  excludeTaskId?: string;
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}

const STATUS_DOT: Record<string, string> = {
  pending: 'bg-status-warning',
  assigned: 'bg-status-info',
  in_progress: 'bg-status-running',
  review: 'bg-status-info',
  completed: 'bg-status-success',
  failed: 'bg-status-error',
};

export function DependencySelector({ workspaceId, excludeTaskId, selectedIds, onChange, disabled }: Props) {
  const [tasks, setTasks] = useState<TaskOption[]>([]);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!workspaceId) return;
    setLoadingTasks(true);
    fetch('/api/tasks')
      .then(res => res.json())
      .then(data => {
        const all: TaskOption[] = (data.tasks || [])
          .filter((t: any) =>
            t.workspaceId === workspaceId &&
            t.id !== excludeTaskId &&
            t.status !== 'completed' &&
            t.status !== 'failed'
          )
          .map((t: any) => ({ id: t.id, title: t.title, status: t.status }));
        setTasks(all);
      })
      .catch(() => setTasks([]))
      .finally(() => setLoadingTasks(false));
  }, [workspaceId, excludeTaskId]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const filtered = tasks.filter(t =>
    !selectedIds.includes(t.id) &&
    t.title.toLowerCase().includes(search.toLowerCase())
  );

  const selectedTasks = tasks.filter(t => selectedIds.includes(t.id));

  // For pre-populated deps that might not be in the filtered list (e.g., completed tasks)
  const missingIds = selectedIds.filter(id => !tasks.some(t => t.id === id));

  return (
    <div ref={containerRef}>
      <label className="block text-sm font-medium mb-1">
        Dependencies <span className="text-text-muted font-normal">(optional)</span>
      </label>

      {/* Selected dependency chips */}
      {(selectedTasks.length > 0 || missingIds.length > 0) && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {selectedTasks.map(t => (
            <span
              key={t.id}
              className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs bg-primary/10 text-primary"
            >
              <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[t.status] || 'bg-text-muted'}`} />
              <span className="max-w-[180px] truncate">{t.title}</span>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => onChange(selectedIds.filter(id => id !== t.id))}
                  className="hover:text-status-error transition-colors"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </span>
          ))}
          {missingIds.map(id => (
            <span
              key={id}
              className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs bg-surface-3 text-text-muted"
            >
              <span className="font-mono">{id.slice(0, 8)}</span>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => onChange(selectedIds.filter(sid => sid !== id))}
                  className="hover:text-status-error transition-colors"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {/* Search input */}
      <div className="relative">
        <input
          type="text"
          placeholder={loadingTasks ? 'Loading tasks...' : 'Search tasks to add as dependency...'}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          disabled={disabled || loadingTasks}
          className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 focus:ring-2 focus:ring-primary-ring focus:border-primary text-sm"
        />

        {/* Dropdown */}
        {open && !loadingTasks && (
          <div className="absolute z-20 mt-1 w-full bg-surface-2 border border-border-default rounded-md shadow-lg max-h-48 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-sm text-text-muted">
                {search ? 'No matching tasks' : 'No available tasks'}
              </div>
            ) : (
              filtered.map(t => (
                <button
                  key={t.id}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onChange([...selectedIds, t.id]);
                    setSearch('');
                    setOpen(false);
                  }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-surface-3 flex items-center gap-2"
                >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[t.status] || 'bg-text-muted'}`} />
                  <span className="truncate">{t.title}</span>
                  <span className="ml-auto text-xs text-text-muted shrink-0">{t.status}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
      <p className="text-xs text-text-muted mt-1">
        Tasks that must complete before this task can be claimed.
      </p>
    </div>
  );
}
