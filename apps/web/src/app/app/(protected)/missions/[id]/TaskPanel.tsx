'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import WorkerRespondInput from '@/components/WorkerRespondInput';

interface TaskPanelData {
  id: string;
  title: string;
  status: string;
  description: string | null;
  mode: string | null;
  roleSlug: string | null;
  createdAt: string;
  missionId: string | null;
  worker: {
    id: string;
    status: string;
    currentAction: string | null;
    turns: number | null;
    prUrl: string | null;
    prNumber: number | null;
    commitCount: number | null;
    filesChanged: number | null;
    costUsd: number | null;
    startedAt: string | null;
    completedAt: string | null;
    waitingFor: { type: string; prompt: string; options?: string[] } | null;
    branch: string | null;
  } | null;
  result: {
    summary: string | null;
    nextSuggestion: string | null;
  } | null;
}

function timeAgo(date: string): string {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Pending', cls: 'bg-text-muted/15 text-text-muted' },
  queued: { label: 'Queued', cls: 'bg-status-info/15 text-status-info' },
  running: { label: 'Running', cls: 'bg-status-info/15 text-status-info' },
  assigned: { label: 'Assigned', cls: 'bg-status-info/15 text-status-info' },
  waiting_input: { label: 'Needs Input', cls: 'bg-status-warning/15 text-status-warning' },
  completed: { label: 'Completed', cls: 'bg-status-success/15 text-status-success' },
  failed: { label: 'Failed', cls: 'bg-status-error/15 text-status-error' },
};

export default function TaskPanel({
  taskId,
  onClose,
}: {
  taskId: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<TaskPanelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTask = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/summary`);
      if (!res.ok) throw new Error('Failed to load task');
      setData(await res.json());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    fetchTask();
    // Poll for updates while panel is open
    const interval = setInterval(fetchTask, 5000);
    return () => clearInterval(interval);
  }, [fetchTask]);

  // Close on escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const status = STATUS_LABELS[data?.status || ''] || STATUS_LABELS.pending;
  const w = data?.worker;
  const isWaiting = w?.status === 'waiting_input' && w?.waitingFor;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-md bg-surface-1 border-l border-border-default shadow-xl overflow-y-auto animate-slide-in-right">
        {/* Header */}
        <div className="sticky top-0 bg-surface-1 border-b border-border-default px-5 py-4 flex items-center gap-3 z-10">
          <button
            onClick={onClose}
            className="p-1 -ml-1 rounded hover:bg-surface-3 transition-colors"
          >
            <svg className="w-5 h-5 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <span className="text-[14px] font-semibold text-text-primary truncate flex-1">
            {loading ? 'Loading...' : data?.title || 'Task'}
          </span>
          <Link
            href={`/app/tasks/${taskId}`}
            className="text-[12px] text-accent-text hover:underline shrink-0"
          >
            Full detail &rarr;
          </Link>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-16">
            <span className="text-[13px] text-text-muted">Loading task...</span>
          </div>
        )}

        {error && (
          <div className="px-5 py-8 text-center">
            <p className="text-[13px] text-status-error">{error}</p>
          </div>
        )}

        {data && !loading && (
          <div className="px-5 py-4 space-y-5">
            {/* Status + meta */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded ${status.cls}`}>
                {status.label}
              </span>
              {data.roleSlug && (
                <span className="text-[11px] text-text-muted font-mono">{data.roleSlug}</span>
              )}
              <span className="text-[11px] text-text-muted">{timeAgo(data.createdAt)}</span>
            </div>

            {/* Description */}
            {data.description && (
              <p className="text-[13px] text-text-secondary leading-relaxed line-clamp-4">
                {data.description}
              </p>
            )}

            {/* Worker activity */}
            {w && (
              <div className="rounded-lg border border-border-default p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-semibold text-text-primary">Worker</span>
                  <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded ${
                    STATUS_LABELS[w.status]?.cls || 'text-text-muted'
                  }`}>
                    {STATUS_LABELS[w.status]?.label || w.status}
                  </span>
                </div>

                {w.currentAction && w.status === 'running' && (
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-status-info animate-status-pulse shrink-0" />
                    <span className="text-[12px] text-status-info truncate">{w.currentAction}</span>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2 text-[12px]">
                  {w.turns != null && (
                    <div>
                      <span className="text-text-muted">Turns:</span>{' '}
                      <span className="text-text-primary">{w.turns}</span>
                    </div>
                  )}
                  {w.commitCount != null && w.commitCount > 0 && (
                    <div>
                      <span className="text-text-muted">Commits:</span>{' '}
                      <span className="text-text-primary">{w.commitCount}</span>
                    </div>
                  )}
                  {w.filesChanged != null && w.filesChanged > 0 && (
                    <div>
                      <span className="text-text-muted">Files:</span>{' '}
                      <span className="text-text-primary">{w.filesChanged}</span>
                    </div>
                  )}
                  {w.costUsd != null && (
                    <div>
                      <span className="text-text-muted">Cost:</span>{' '}
                      <span className="text-text-primary">${w.costUsd.toFixed(3)}</span>
                    </div>
                  )}
                </div>

                {w.branch && (
                  <div className="text-[12px]">
                    <span className="text-text-muted">Branch:</span>{' '}
                    <span className="text-text-primary font-mono text-[11px]">{w.branch}</span>
                  </div>
                )}

                {w.prUrl && (
                  <a
                    href={w.prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-[12px] text-accent-text hover:underline"
                  >
                    PR #{w.prNumber}
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                )}
              </div>
            )}

            {/* Waiting for input */}
            {isWaiting && w?.waitingFor && (
              <div className="rounded-lg border border-status-warning/30 bg-status-warning/5 p-4">
                <span className="text-[11px] font-semibold text-status-warning uppercase tracking-wider">Needs Input</span>
                <WorkerRespondInput
                  workerId={w.id}
                  question={w.waitingFor.prompt}
                  options={w.waitingFor.options}
                />
              </div>
            )}

            {/* Result summary */}
            {data.result?.summary && (
              <div>
                <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wider">Summary</span>
                <p className="text-[13px] text-text-secondary leading-relaxed mt-1">
                  {data.result.summary}
                </p>
              </div>
            )}

            {/* Next suggestion */}
            {data.result?.nextSuggestion && (
              <p className="text-[12px] text-text-muted italic">
                <span className="text-text-secondary">Suggested:</span>{' '}
                &ldquo;{data.result.nextSuggestion}&rdquo;
              </p>
            )}
          </div>
        )}
      </div>
    </>
  );
}
