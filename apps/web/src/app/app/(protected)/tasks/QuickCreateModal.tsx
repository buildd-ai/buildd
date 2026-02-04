'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

interface ActiveLocalUi {
  localUiUrl: string;
  accountId: string;
  accountName: string;
  maxConcurrent: number;
  activeWorkers: number;
  capacity: number;
  workspaceIds: string[];
  workspaceNames: string[];
}

interface Props {
  workspaceId: string;
  workspaceName: string;
  onClose: () => void;
  onCreated: (taskId: string) => void;
}

const ASSIGNMENT_TIMEOUT_MS = 8000; // 8 seconds to accept before reassigning

export default function QuickCreateModal({
  workspaceId,
  workspaceName,
  onClose,
  onCreated,
}: Props) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [showDescription, setShowDescription] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeLocalUis, setActiveLocalUis] = useState<ActiveLocalUi[]>([]);
  const [selectedLocalUi, setSelectedLocalUi] = useState<string>('');
  const [assignmentStatus, setAssignmentStatus] = useState<'idle' | 'waiting' | 'accepted' | 'reassigned'>('idle');
  const [countdown, setCountdown] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    fetchActiveWorkers();

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  const fetchActiveWorkers = async () => {
    try {
      const res = await fetch('/api/workers/active');
      if (res.ok) {
        const data = await res.json();
        // Filter to only show workers that have capacity and can work on this workspace
        const availableWorkers = (data.activeLocalUis || []).filter(
          (ui: ActiveLocalUi) =>
            ui.capacity > 0 && ui.workspaceIds.includes(workspaceId)
        );
        setActiveLocalUis(availableWorkers);
      }
    } catch {
      // Silently fail - worker assignment is optional
    }
  };

  const pollTaskStatus = useCallback(async (taskId: string, startTime: number) => {
    try {
      const res = await fetch(`/api/tasks?id=${taskId}`);
      if (!res.ok) return;

      const data = await res.json();
      const task = data.tasks?.find((t: any) => t.id === taskId);

      if (task && task.status !== 'pending') {
        // Task was claimed
        setAssignmentStatus('accepted');
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
        }
        onCreated(taskId);
        return;
      }

      // Check if timeout expired
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, Math.ceil((ASSIGNMENT_TIMEOUT_MS - elapsed) / 1000));
      setCountdown(remaining);

      if (elapsed >= ASSIGNMENT_TIMEOUT_MS) {
        // Timeout - reassign to all workers
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
        }
        setAssignmentStatus('reassigned');

        // Call reassign endpoint
        await fetch(`/api/tasks/${taskId}/reassign`, { method: 'POST' });

        // Give it a moment then complete
        setTimeout(() => {
          onCreated(taskId);
        }, 500);
      }
    } catch {
      // Ignore polling errors
    }
  }, [onCreated]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setLoading(true);
    setError('');
    setAssignmentStatus('idle');

    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          title: title.trim(),
          description: description.trim() || null,
          priority: 5,
          creationSource: 'dashboard',
          // Optionally assign to a specific local-ui
          ...(selectedLocalUi && { assignToLocalUiUrl: selectedLocalUi }),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create task');
      }

      const task = await res.json();

      // If assigned to specific worker, poll for acceptance
      if (selectedLocalUi) {
        setAssignmentStatus('waiting');
        setCountdown(Math.ceil(ASSIGNMENT_TIMEOUT_MS / 1000));
        const startTime = Date.now();

        // Start polling every second
        pollIntervalRef.current = setInterval(() => {
          pollTaskStatus(task.id, startTime);
        }, 1000);

        // Initial poll
        pollTaskStatus(task.id, startTime);
      } else {
        // No specific assignment, just complete
        onCreated(task.id);
      }
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && assignmentStatus === 'idle') {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-start justify-center pt-32 z-50"
      onClick={(e) => e.target === e.currentTarget && assignmentStatus === 'idle' && onClose()}
      onKeyDown={handleKeyDown}
    >
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-md">
        {assignmentStatus === 'waiting' ? (
          // Waiting for worker to accept
          <div className="p-6 text-center">
            <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full mx-auto mb-4" />
            <p className="text-gray-700 dark:text-gray-300 mb-2">
              Waiting for worker to accept...
            </p>
            <p className="text-sm text-gray-500">
              Auto-reassigning in {countdown}s
            </p>
          </div>
        ) : assignmentStatus === 'reassigned' ? (
          // Task reassigned
          <div className="p-6 text-center">
            <div className="w-8 h-8 bg-amber-100 dark:bg-amber-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </div>
            <p className="text-gray-700 dark:text-gray-300">
              Reassigned to available workers
            </p>
          </div>
        ) : (
          // Normal form
          <form onSubmit={handleSubmit}>
            <div className="p-4 border-b border-gray-200 dark:border-gray-700">
              <div className="flex items-center justify-between">
                <div className="text-sm text-gray-500">
                  New task in <span className="font-medium text-gray-700 dark:text-gray-300">{workspaceName}</span>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                >
                  &times;
                </button>
              </div>
            </div>

            <div className="p-4 space-y-3">
              {error && (
                <div className="p-2 text-sm bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded">
                  {error}
                </div>
              )}

              <input
                ref={inputRef}
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Task title"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                disabled={loading}
              />

              {showDescription ? (
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Description (optional)"
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                  disabled={loading}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setShowDescription(true)}
                  className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                >
                  + Add description
                </button>
              )}

              {/* Worker assignment */}
              {activeLocalUis.length > 0 && (
                <div className="space-y-1">
                  <label className="text-xs text-gray-500 dark:text-gray-400">
                    Assign to worker (optional)
                  </label>
                  <select
                    value={selectedLocalUi}
                    onChange={(e) => setSelectedLocalUi(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                    disabled={loading}
                  >
                    <option value="">Queue for any worker</option>
                    {activeLocalUis.map((ui) => (
                      <option key={ui.localUiUrl} value={ui.localUiUrl}>
                        {ui.accountName} ({ui.capacity} slot{ui.capacity !== 1 ? 's' : ''} available)
                      </option>
                    ))}
                  </select>
                  {selectedLocalUi && (
                    <p className="text-xs text-green-600 dark:text-green-400">
                      Task will be sent directly (auto-reassigns after {ASSIGNMENT_TIMEOUT_MS / 1000}s if not accepted)
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="p-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={loading}
                className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || !title.trim()}
                className="px-3 py-1.5 text-sm bg-black dark:bg-white text-white dark:text-black rounded hover:opacity-80 disabled:opacity-50"
              >
                {loading ? 'Creating...' : selectedLocalUi ? 'Create & Send' : 'Create'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
