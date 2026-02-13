'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useLocalUiHealth } from '../useLocalUiHealth';
import { subscribeToChannel, unsubscribeFromChannel } from '@/lib/pusher-client';

interface Props {
  taskId: string;
  workspaceId: string;
}

const ASSIGNMENT_TIMEOUT_MS = 8000;

export default function StartTaskButton({ taskId, workspaceId }: Props) {
  const [showModal, setShowModal] = useState(false);
  const [loading, setLoading] = useState(false);
  const { available: activeLocalUis } = useLocalUiHealth(workspaceId);
  const [selectedLocalUi, setSelectedLocalUi] = useState<string>('');
  const [status, setStatus] = useState<'idle' | 'starting' | 'waiting' | 'accepted' | 'failed'>('idle');
  const [countdown, setCountdown] = useState(0);
  const [error, setError] = useState('');
  const [claimedWorker, setClaimedWorker] = useState<{ id: string; localUiUrl: string | null } | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const router = useRouter();

  const channelRef = useRef<string | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
      if (channelRef.current) {
        unsubscribeFromChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, []);

  const pollTaskStatus = useCallback(async (startTime: number, targetLocalUiUrl: string) => {
    // Update countdown and check timeout BEFORE the API call
    // so they always execute regardless of API response
    const elapsed = Date.now() - startTime;
    const remaining = Math.max(0, Math.ceil((ASSIGNMENT_TIMEOUT_MS - elapsed) / 1000));
    setCountdown(remaining);

    if (elapsed >= ASSIGNMENT_TIMEOUT_MS) {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
      setStatus('failed');
      setError('No worker claimed the task. Try again or select a different worker.');
      return;
    }

    try {
      const res = await fetch(`/api/tasks/${taskId}`);
      if (!res.ok) return;

      const task = await res.json();

      if (task.status !== 'pending') {
        // Task was claimed
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
        }

        // Get the worker that claimed this task
        try {
          const workerRes = await fetch(`/api/tasks/${taskId}/workers`);
          if (workerRes.ok) {
            const workerData = await workerRes.json();
            const worker = workerData.workers?.[0];
            if (worker) {
              setClaimedWorker({
                id: worker.id,
                localUiUrl: worker.localUiUrl || targetLocalUiUrl,
              });
            }
          }
        } catch {
          // If we can't get worker details, use the target URL
          if (targetLocalUiUrl) {
            setClaimedWorker({ id: '', localUiUrl: targetLocalUiUrl });
          }
        }

        setStatus('accepted');
        return;
      }
    } catch {
      // Ignore polling errors — countdown/timeout still runs above
    }
  }, [taskId]);

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
      const targetUrl = selectedLocalUi;

      // Subscribe to Pusher for instant claim notification
      const channelName = `workspace-${workspaceId}`;
      channelRef.current = channelName;
      const channel = subscribeToChannel(channelName);
      if (channel) {
        const handleClaimed = (data: { task: { id: string }; worker?: { id: string } }) => {
          if (data.task?.id === taskId) {
            // Task was claimed - stop polling
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
            }
            setClaimedWorker({
              id: data.worker?.id || '',
              localUiUrl: targetUrl || null,
            });
            setStatus('accepted');
          }
        };
        channel.bind('task:claimed', handleClaimed);
      }

      pollIntervalRef.current = setInterval(() => {
        pollTaskStatus(startTime, targetUrl);
      }, 1000);

      // Initial poll
      pollTaskStatus(startTime, targetUrl);
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
    if (channelRef.current) {
      unsubscribeFromChannel(channelRef.current);
      channelRef.current = null;
    }
    setShowModal(false);
    setStatus('idle');
    setError('');
    setSelectedLocalUi('');
    setClaimedWorker(null);
  };

  const handleViewInDashboard = () => {
    router.refresh();
    setShowModal(false);
  };

  const handleRetry = () => {
    setStatus('idle');
    setError('');
  };

  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        className="px-4 py-2 text-sm bg-status-success text-white rounded-md hover:opacity-90"
      >
        Start Task
      </button>

      {showModal && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={(e) => e.target === e.currentTarget && handleClose()}
        >
          <div className="bg-surface-2 rounded-lg shadow-xl w-full max-w-md">
            {status === 'waiting' ? (
              <div className="p-6 text-center">
                <div className="animate-spin w-8 h-8 border-2 border-status-success border-t-transparent rounded-full mx-auto mb-4" />
                <p className="text-text-primary mb-2">
                  Waiting for worker to accept...
                </p>
                <p className="text-sm text-text-secondary">
                  Timeout in {countdown}s
                </p>
              </div>
            ) : status === 'accepted' ? (
              <div className="p-6">
                <div className="text-center mb-4">
                  <div className="w-10 h-10 bg-status-success/10 rounded-full flex items-center justify-center mx-auto mb-3">
                    <svg className="w-6 h-6 text-status-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <p className="text-text-primary font-medium">
                    Task started!
                  </p>
                  <p className="text-sm text-text-secondary mt-1">
                    A worker has picked up your task
                  </p>
                </div>
                <div className="space-y-2">
                  {claimedWorker?.localUiUrl && claimedWorker.id && (
                    <a
                      href={`${claimedWorker.localUiUrl}/worker/${claimedWorker.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-center gap-2 w-full px-4 py-2.5 bg-primary text-white rounded-md hover:bg-primary-hover transition-opacity"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                      </svg>
                      Open in Local UI
                    </a>
                  )}
                  <button
                    onClick={handleViewInDashboard}
                    className="flex items-center justify-center gap-2 w-full px-4 py-2 text-sm border border-border-default rounded-md hover:bg-surface-3"
                  >
                    View in Dashboard
                  </button>
                </div>
              </div>
            ) : status === 'failed' ? (
              <div className="p-6">
                <div className="text-center mb-4">
                  <div className="w-8 h-8 bg-status-error/10 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg className="w-5 h-5 text-status-error" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </div>
                  <p className="text-status-error text-sm">{error}</p>
                </div>
                <div className="flex justify-center gap-2">
                  <button
                    onClick={handleRetry}
                    className="px-4 py-2 text-sm bg-surface-3 rounded hover:bg-surface-4"
                  >
                    Try Again
                  </button>
                  <button
                    onClick={handleClose}
                    className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
                  >
                    Close
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="p-4 border-b border-border-default">
                  <div className="flex items-center justify-between">
                    <h3 className="font-medium">Start Task</h3>
                    <button
                      onClick={handleClose}
                      className="text-text-muted hover:text-text-secondary"
                    >
                      &times;
                    </button>
                  </div>
                </div>

                <div className="p-4 space-y-4">
                  {error && (
                    <div className="p-2 text-sm bg-status-error/10 text-status-error rounded">
                      {error}
                    </div>
                  )}

                  <div>
                    <label className="block text-sm text-text-secondary mb-2">
                      Select a worker
                    </label>
                    <select
                      value={selectedLocalUi}
                      onChange={(e) => setSelectedLocalUi(e.target.value)}
                      className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 focus:ring-2 focus:ring-primary-ring focus:border-primary"
                      disabled={loading}
                    >
                      <option value="">Any available worker</option>
                      {activeLocalUis.map((ui) => (
                        <option key={ui.localUiUrl} value={ui.localUiUrl}>
                          {ui.accountName} ({ui.capacity} slot{ui.capacity !== 1 ? 's' : ''}{ui.live ? ' — live' : ''})
                        </option>
                      ))}
                    </select>
                    {activeLocalUis.length === 0 && (
                      <p className="mt-2 text-xs text-status-warning">
                        No workers with capacity detected. The task will be queued for the next available worker.
                      </p>
                    )}
                  </div>
                </div>

                <div className="p-4 border-t border-border-default flex justify-end gap-2">
                  <button
                    onClick={handleClose}
                    disabled={loading}
                    className="px-4 py-2 text-sm text-text-secondary hover:bg-surface-3 rounded"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleStart}
                    disabled={loading}
                    className="px-4 py-2 text-sm bg-status-success text-white rounded hover:opacity-90 disabled:opacity-50"
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
