'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useLocalUiHealth } from './useLocalUiHealth';
import { uploadImagesToR2 } from '@/lib/upload';

interface PastedImage {
  filename: string;
  mimeType: string;
  data: string;
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
  const { available: activeLocalUis } = useLocalUiHealth(workspaceId);
  const [selectedLocalUi, setSelectedLocalUi] = useState<string>('');
  const [assignmentStatus, setAssignmentStatus] = useState<'idle' | 'waiting' | 'accepted' | 'reassigned'>('idle');
  const [countdown, setCountdown] = useState(0);
  const [pastedImages, setPastedImages] = useState<PastedImage[]>([]);
  const [claimedWorker, setClaimedWorker] = useState<{ id: string; localUiUrl: string | null } | null>(null);
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);

  // Recurring schedule
  const [recurring, setRecurring] = useState(false);
  const [cronExpression, setCronExpression] = useState('0 9 * * *');
  const inputRef = useRef<HTMLInputElement>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    inputRef.current?.focus();

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;

        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          setPastedImages(prev => [...prev, {
            filename: file.name || `pasted-image-${Date.now()}.png`,
            mimeType: file.type,
            data: dataUrl,
          }]);
        };
        reader.readAsDataURL(file);
        // Auto-show description area when image is pasted
        setShowDescription(true);
      }
    }
  }, []);

  const removeImage = useCallback((index: number) => {
    setPastedImages(prev => prev.filter((_, i) => i !== index));
  }, []);

  const pollTaskStatus = useCallback(async (taskId: string, startTime: number, targetLocalUiUrl: string) => {
    try {
      const res = await fetch(`/api/tasks?id=${taskId}`);
      if (!res.ok) return;

      const data = await res.json();
      const task = data.tasks?.find((t: any) => t.id === taskId);

      if (task && task.status !== 'pending') {
        // Task was claimed - fetch worker details
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
          // If we can't get worker details, use the target URL we assigned to
          setClaimedWorker({ id: '', localUiUrl: targetLocalUiUrl });
        }

        setCreatedTaskId(taskId);
        setAssignmentStatus('accepted');
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
        setCreatedTaskId(taskId);

        // Call reassign endpoint
        await fetch(`/api/tasks/${taskId}/reassign`, { method: 'POST' });
      }
    } catch {
      // Ignore polling errors
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setLoading(true);
    setError('');
    setAssignmentStatus('idle');

    try {
      if (recurring) {
        // Create schedule instead of task
        const res = await fetch(`/api/workspaces/${workspaceId}/schedules`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: title.trim(),
            cronExpression,
            timezone: 'UTC',
            taskTemplate: {
              title: title.trim(),
              description: description.trim() || undefined,
              priority: 5,
            },
          }),
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to create schedule');
        }

        // Navigate to schedules page
        window.location.href = `/app/workspaces/${workspaceId}/schedules`;
        return;
      }

      // Upload images to R2 if available, fall back to inline base64
      let attachments: any[] | undefined;
      if (pastedImages.length > 0) {
        try {
          attachments = await uploadImagesToR2(workspaceId, pastedImages);
        } catch {
          attachments = pastedImages;
        }
      }

      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          title: title.trim(),
          description: description.trim() || null,
          priority: 5,
          creationSource: 'dashboard',
          ...(selectedLocalUi && { assignToLocalUiUrl: selectedLocalUi }),
          ...(attachments && { attachments }),
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
        setCreatedTaskId(task.id);
        const startTime = Date.now();
        const targetUrl = selectedLocalUi;

        // Start polling every second
        pollIntervalRef.current = setInterval(() => {
          pollTaskStatus(task.id, startTime, targetUrl);
        }, 1000);

        // Initial poll
        pollTaskStatus(task.id, startTime, targetUrl);
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
      className="fixed inset-0 bg-black/50 flex items-end md:items-start justify-center md:pt-32 z-50"
      onClick={(e) => e.target === e.currentTarget && assignmentStatus === 'idle' && onClose()}
      onKeyDown={handleKeyDown}
    >
      <div className="bg-white dark:bg-gray-900 md:bg-white md:dark:bg-gray-900 rounded-t-2xl md:rounded-lg shadow-xl w-full md:max-w-md md:mx-4 animate-slide-up md:animate-none">
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
        ) : assignmentStatus === 'accepted' ? (
          // Task accepted by worker
          <div className="p-6">
            <div className="text-center mb-4">
              <div className="w-10 h-10 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mx-auto mb-3">
                <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="text-gray-700 dark:text-gray-300 font-medium">
                Task started!
              </p>
              <p className="text-sm text-gray-500 mt-1">
                A worker has picked up your task
              </p>
            </div>
            <div className="space-y-2">
              {claimedWorker?.localUiUrl && claimedWorker.id && (
                <a
                  href={`${claimedWorker.localUiUrl}/worker/${claimedWorker.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 w-full px-4 py-2.5 bg-gradient-to-r from-purple-600 to-cyan-600 text-white rounded-lg hover:opacity-90 transition-opacity"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                  Open in Local UI
                </a>
              )}
              {createdTaskId && (
                <button
                  onClick={() => {
                    onCreated(createdTaskId);
                  }}
                  className="flex items-center justify-center gap-2 w-full px-4 py-2 text-sm border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
                >
                  View in Dashboard
                </button>
              )}
            </div>
          </div>
        ) : assignmentStatus === 'reassigned' ? (
          // Task reassigned to any worker
          <div className="p-6">
            <div className="text-center mb-4">
              <div className="w-10 h-10 bg-amber-100 dark:bg-amber-900/30 rounded-full flex items-center justify-center mx-auto mb-3">
                <svg className="w-6 h-6 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </div>
              <p className="text-gray-700 dark:text-gray-300 font-medium">
                Queued for any worker
              </p>
              <p className="text-sm text-gray-500 mt-1">
                The specific worker didn&apos;t respond, task is now available to all workers
              </p>
            </div>
            {createdTaskId && (
              <button
                onClick={() => {
                  onCreated(createdTaskId);
                }}
                className="flex items-center justify-center gap-2 w-full px-4 py-2 text-sm border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                View in Dashboard
              </button>
            )}
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
                onPaste={handlePaste}
                placeholder="Task title"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                disabled={loading}
              />

              {/* Recurring toggle */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setRecurring(!recurring)}
                  className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors ${
                    recurring
                      ? 'border-fuchsia-300 dark:border-fuchsia-700 bg-fuchsia-50 dark:bg-fuchsia-900/20 text-fuchsia-700 dark:text-fuchsia-300'
                      : 'border-gray-200 dark:border-gray-700 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'
                  }`}
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Recurring
                </button>
                {recurring && (
                  <input
                    type="text"
                    value={cronExpression}
                    onChange={(e) => setCronExpression(e.target.value)}
                    className="flex-1 px-2 py-1 text-xs font-mono border border-gray-300 dark:border-gray-700 rounded-md bg-white dark:bg-gray-800"
                    placeholder="0 9 * * *"
                  />
                )}
              </div>

              {showDescription ? (
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  onPaste={handlePaste}
                  placeholder="Description (optional) — paste images here"
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

              {pastedImages.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {pastedImages.map((img, i) => (
                    <div key={i} className="relative group">
                      <img
                        src={img.data}
                        alt={img.filename}
                        className="max-h-20 rounded border border-gray-200 dark:border-gray-700"
                      />
                      <button
                        type="button"
                        onClick={() => removeImage(i)}
                        className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 text-white rounded-full text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        &times;
                      </button>
                    </div>
                  ))}
                </div>
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
                        {ui.accountName} ({ui.capacity} slot{ui.capacity !== 1 ? 's' : ''}{ui.live ? ' — live' : ''})
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

            <div className="p-4 border-t border-gray-200 dark:border-gray-700 flex flex-col md:flex-row md:justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={loading}
                className="hidden md:block px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || !title.trim()}
                className="w-full md:w-auto py-3 md:py-1.5 px-3 text-sm bg-violet-600 hover:bg-violet-700 md:bg-black md:dark:bg-white text-white md:dark:text-black rounded-lg md:rounded hover:opacity-80 disabled:opacity-50 font-medium md:font-normal"
              >
                {loading
                  ? 'Creating...'
                  : recurring
                    ? 'Create Schedule'
                    : selectedLocalUi
                      ? 'Create & Send'
                      : 'Create'
                }
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
