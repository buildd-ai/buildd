'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';

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
  taskId: string;
  workspaceId: string;
}

const ASSIGNMENT_TIMEOUT_MS = 8000;

export default function StartTaskButton({ taskId, workspaceId }: Props) {
  const [showModal, setShowModal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeLocalUis, setActiveLocalUis] = useState<ActiveLocalUi[]>([]);
  const [selectedLocalUi, setSelectedLocalUi] = useState<string>('');
  const [status, setStatus] = useState<'idle' | 'starting' | 'waiting' | 'accepted' | 'failed'>('idle');
  const [countdown, setCountdown] = useState(0);
  const [error, setError] = useState('');
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const router = useRouter();

  // Fetch available workers when modal opens
  useEffect(() => {
    if (!showModal) return;

    async function fetchWorkers() {
      try {
        const res = await fetch('/api/workers/active');
        if (res.ok) {
          const data = await res.json();
          // Filter to workers that have capacity and can work on this workspace
          const available = (data.activeLocalUis || []).filter(
            (ui: ActiveLocalUi) =>
              ui.capacity > 0 && ui.workspaceIds.includes(workspaceId)
          );
          setActiveLocalUis(available);
        }
      } catch {
        // Silently fail
      }
    }

    fetchWorkers();
  }, [showModal, workspaceId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  const pollTaskStatus = useCallback(async (startTime: number) => {
    try {
      const res = await fetch(`/api/tasks/${taskId}`);
      if (!res.ok) return;

      const task = await res.json();

      if (task.status !== 'pending') {
        // Task was claimed
        setStatus('accepted');
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
        }
        // Refresh page to show active worker
        setTimeout(() => {
          router.refresh();
          setShowModal(false);
        }, 500);
        return;
      }

      // Update countdown
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, Math.ceil((ASSIGNMENT_TIMEOUT_MS - elapsed) / 1000));
      setCountdown(remaining);

      if (elapsed >= ASSIGNMENT_TIMEOUT_MS) {
        // Timeout - assignment failed
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
        }
        setStatus('failed');
        setError('No worker claimed the task. Try again or select a different worker.');
      }
    } catch {
      // Ignore polling errors
    }
  }, [taskId, router]);

  const handleStart = async () => {
    setLoading(true);
    setError('');
    setStatus('starting');

    try {
      const res = await fetch(`/api/tasks/${taskId}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetLocalUiUrl: selectedLocalUi || undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to start task');
      }

      // Start polling for task status change
      setStatus('waiting');
      setCountdown(Math.ceil(ASSIGNMENT_TIMEOUT_MS / 1000));
      const startTime = Date.now();

      pollIntervalRef.current = setInterval(() => {
        pollTaskStatus(startTime);
      }, 1000);

      // Initial poll
      pollTaskStatus(startTime);
    } catch (err: any) {
      setError(err.message);
      setStatus('failed');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    if (status === 'waiting') return; // Don't close while waiting
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }
    setShowModal(false);
    setStatus('idle');
    setError('');
    setSelectedLocalUi('');
  };

  const handleRetry = () => {
    setStatus('idle');
    setError('');
  };

  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700"
      >
        Start Task
      </button>

      {showModal && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={(e) => e.target === e.currentTarget && handleClose()}
        >
          <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-md">
            {status === 'waiting' ? (
              <div className="p-6 text-center">
                <div className="animate-spin w-8 h-8 border-2 border-green-500 border-t-transparent rounded-full mx-auto mb-4" />
                <p className="text-gray-700 dark:text-gray-300 mb-2">
                  Waiting for worker to accept...
                </p>
                <p className="text-sm text-gray-500">
                  Timeout in {countdown}s
                </p>
              </div>
            ) : status === 'accepted' ? (
              <div className="p-6 text-center">
                <div className="w-8 h-8 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
                  <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <p className="text-gray-700 dark:text-gray-300">
                  Task started successfully
                </p>
              </div>
            ) : status === 'failed' ? (
              <div className="p-6">
                <div className="text-center mb-4">
                  <div className="w-8 h-8 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </div>
                  <p className="text-red-600 dark:text-red-400 text-sm">{error}</p>
                </div>
                <div className="flex justify-center gap-2">
                  <button
                    onClick={handleRetry}
                    className="px-4 py-2 text-sm bg-gray-100 dark:bg-gray-800 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
                  >
                    Try Again
                  </button>
                  <button
                    onClick={handleClose}
                    className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
                  >
                    Close
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="p-4 border-b border-gray-200 dark:border-gray-700">
                  <div className="flex items-center justify-between">
                    <h3 className="font-medium">Start Task</h3>
                    <button
                      onClick={handleClose}
                      className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                    >
                      &times;
                    </button>
                  </div>
                </div>

                <div className="p-4 space-y-4">
                  {error && (
                    <div className="p-2 text-sm bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded">
                      {error}
                    </div>
                  )}

                  <div>
                    <label className="block text-sm text-gray-600 dark:text-gray-400 mb-2">
                      Select a worker
                    </label>
                    <select
                      value={selectedLocalUi}
                      onChange={(e) => setSelectedLocalUi(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 focus:ring-2 focus:ring-green-500 focus:border-transparent"
                      disabled={loading}
                    >
                      <option value="">Any available worker</option>
                      {activeLocalUis.map((ui) => (
                        <option key={ui.localUiUrl} value={ui.localUiUrl}>
                          {ui.accountName} ({ui.capacity} slot{ui.capacity !== 1 ? 's' : ''} available)
                        </option>
                      ))}
                    </select>
                    {activeLocalUis.length === 0 && (
                      <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                        No workers with capacity detected. The task will be queued for the next available worker.
                      </p>
                    )}
                  </div>
                </div>

                <div className="p-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
                  <button
                    onClick={handleClose}
                    disabled={loading}
                    className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleStart}
                    disabled={loading}
                    className="px-4 py-2 text-sm bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
                  >
                    {loading ? 'Starting...' : 'Start'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
