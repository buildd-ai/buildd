'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useLocalUiHealth } from '../useLocalUiHealth';
import { subscribeToChannel, unsubscribeFromChannel, CHANNEL_PREFIX } from '@/lib/pusher-client';

interface Props {
  taskId: string;
  workspaceId: string;
}

// How long the modal actively waits for a worker to claim before it stops
// counting down. This is NOT a deadline for the task — /start only broadcasts a
// Pusher poke and the task stays queued regardless — so on expiry we show a
// "still queued" state, not an error. 8s was too tight for the
// Pusher→runner→claim round-trip and made every start look like it failed.
const ASSIGNMENT_TIMEOUT_MS = 30000;

export default function StartTaskButton({ taskId, workspaceId }: Props) {
  const [showModal, setShowModal] = useState(false);
  const [loading, setLoading] = useState(false);
  const { available: activeLocalUis } = useLocalUiHealth(workspaceId);
  const [selectedLocalUi, setSelectedLocalUi] = useState<string>('');
  const [status, setStatus] = useState<'idle' | 'starting' | 'waiting' | 'accepted' | 'failed' | 'queued' | 'gated'>('idle');
  const [countdown, setCountdown] = useState(0);
  const [error, setError] = useState('');
  const [claimedWorker, setClaimedWorker] = useState<{ id: string; localUiUrl: string | null } | null>(null);
  const [blockingDeps, setBlockingDeps] = useState<Array<{ taskId: string | null; taskTitle: string | null; prUrl: string | null; prNumber: number | null }>>([]);
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
      // Not a failure: the task is still queued and will be claimed as soon as a
      // worker is free (or on the next runner poll). Say so instead of implying
      // it broke.
      setStatus('queued');
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

  const handleStart = async (forceOverride = false) => {
    setLoading(true);
    setError('');
    setStatus('starting');

    try {
      const res = await fetch(`/api/tasks/${taskId}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetLocalUiUrl: selectedLocalUi || undefined,
          ...(forceOverride ? { forceOverride: true } : {}),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        // Dep-PR gate: show the blocking reason + "Start anyway" option
        if (res.status === 422 && data.gateReason === 'unmerged_dep_pr') {
          setBlockingDeps(data.blockingDeps || []);
          setStatus('gated');
          return;
        }
        throw new Error(data.error || 'Failed to start task');
      }

      // Start polling for task status change
      setStatus('waiting');
      setCountdown(Math.ceil(ASSIGNMENT_TIMEOUT_MS / 1000));
      const startTime = Date.now();
      const targetUrl = selectedLocalUi;

      // Subscribe to Pusher for instant claim notification
      const channelName = `${CHANNEL_PREFIX}workspace-${workspaceId}`;
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
    setBlockingDeps([]);
  };

  const handleViewInDashboard = () => {
    router.refresh();
    setShowModal(false);
  };

  const handleRetry = () => {
    setStatus('idle');
    setError('');
    setBlockingDeps([]);
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
                  <button
                    onClick={handleViewInDashboard}
                    className="flex items-center justify-center gap-2 w-full px-4 py-2.5 bg-primary text-white rounded-md hover:bg-primary-hover transition-opacity"
                  >
                    View in Dashboard
                  </button>
                </div>
              </div>
            ) : status === 'queued' ? (
              <div className="p-6">
                <div className="text-center mb-4">
                  <div className="w-10 h-10 bg-status-warning/10 rounded-full flex items-center justify-center mx-auto mb-3">
                    <svg className="w-6 h-6 text-status-warning" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <p className="text-text-primary font-medium mb-1">Still queued</p>
                  <p className="text-sm text-text-secondary">
                    No worker is free right now. The task stays queued and starts
                    automatically as soon as a worker picks it up — you can close this.
                  </p>
                </div>
                <div className="flex justify-center gap-2">
                  <button
                    onClick={handleRetry}
                    className="px-4 py-2 text-sm bg-surface-3 rounded hover:bg-surface-4"
                  >
                    Poke workers again
                  </button>
                  <button
                    onClick={handleClose}
                    className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
                  >
                    Close
                  </button>
                </div>
              </div>
            ) : status === 'gated' ? (
              <div className="p-6">
                <div className="text-center mb-4">
                  <div className="w-10 h-10 bg-status-warning/10 rounded-full flex items-center justify-center mx-auto mb-3">
                    <svg className="w-6 h-6 text-status-warning" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                    </svg>
                  </div>
                  <p className="text-text-primary font-medium mb-1">Blocked: dependency PR not merged</p>
                  <p className="text-sm text-text-secondary mb-3">
                    The following {blockingDeps.length === 1 ? 'PR is' : 'PRs are'} blocking this task. Workers will not claim it until {blockingDeps.length === 1 ? 'it merges' : 'they merge'}.
                  </p>
                  <div className="space-y-2 text-left">
                    {blockingDeps.map((dep, i) => (
                      <div key={i} className="p-2 bg-surface-3 rounded border border-border-default text-sm">
                        {dep.taskTitle && (
                          <p className="text-text-secondary text-xs mb-1 truncate">{dep.taskTitle}</p>
                        )}
                        {dep.prUrl ? (
                          <a
                            href={dep.prUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary-400 hover:underline"
                          >
                            PR #{dep.prNumber ?? '?'} →
                          </a>
                        ) : (
                          <span className="text-text-muted">No PR URL</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <button
                    onClick={() => handleStart(true)}
                    disabled={loading}
                    className="px-4 py-2 text-sm bg-status-warning text-white rounded hover:opacity-90 disabled:opacity-50 font-medium"
                  >
                    Start anyway (bypass gate)
                  </button>
                  <button
                    onClick={handleClose}
                    className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
                  >
                    Cancel
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
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      <button
                        type="button"
                        onClick={() => setSelectedLocalUi('')}
                        disabled={loading}
                        className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors ${
                          selectedLocalUi === ''
                            ? 'border-primary bg-primary-subtle'
                            : 'border-border-default hover:border-text-muted'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium">Any available worker</span>
                          {selectedLocalUi === '' && (
                            <svg className="w-4 h-4 text-primary" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                            </svg>
                          )}
                        </div>
                        <p className="text-xs text-text-muted mt-0.5">Queued for the next available worker</p>
                      </button>

                      {activeLocalUis.map((ui) => (
                        <button
                          key={ui.localUiUrl}
                          type="button"
                          onClick={() => setSelectedLocalUi(ui.localUiUrl)}
                          disabled={loading}
                          className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors ${
                            selectedLocalUi === ui.localUiUrl
                              ? 'border-primary bg-primary-subtle'
                              : 'border-border-default hover:border-text-muted'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium">{ui.accountName}</span>
                            <div className="flex items-center gap-2">
                              {ui.live && (
                                <span className="flex items-center gap-1 text-xs text-status-success">
                                  <span className="w-1.5 h-1.5 rounded-full bg-status-success" />
                                  Live
                                </span>
                              )}
                              {selectedLocalUi === ui.localUiUrl && (
                                <svg className="w-4 h-4 text-primary" fill="currentColor" viewBox="0 0 20 20">
                                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                                </svg>
                              )}
                            </div>
                          </div>
                          <p className="text-xs text-text-muted mt-0.5">
                            {ui.capacity} slot{ui.capacity !== 1 ? 's' : ''} available
                          </p>
                          {ui.environment && (
                            <div className="mt-1.5 space-y-0.5">
                              {ui.environment.tools.length > 0 && (
                                <p className="text-[11px] text-text-muted truncate">
                                  <span className="text-text-secondary">Tools:</span>{' '}
                                  {ui.environment.tools.map(t => t.version ? `${t.name} ${t.version}` : t.name).join(', ')}
                                </p>
                              )}
                              {ui.environment.envKeys.length > 0 && (
                                <p className="text-[11px] text-text-muted truncate">
                                  <span className="text-text-secondary">Env:</span>{' '}
                                  {ui.environment.envKeys.length <= 3
                                    ? ui.environment.envKeys.join(', ')
                                    : `${ui.environment.envKeys.slice(0, 3).join(', ')} +${ui.environment.envKeys.length - 3} more`}
                                </p>
                              )}
                              {ui.environment.mcp.length > 0 && (
                                <p className="text-[11px] text-text-muted truncate">
                                  <span className="text-text-secondary">MCP:</span>{' '}
                                  {ui.environment.mcp.join(', ')}
                                </p>
                              )}
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
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
                    onClick={() => handleStart()}
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
