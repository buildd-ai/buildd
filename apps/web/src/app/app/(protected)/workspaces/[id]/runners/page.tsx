'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

interface Runner {
  id: string;
  accountId: string;
  accountName: string;
  accountType: 'user' | 'service' | 'action';
  localUiUrl: string;
  status: 'online' | 'stale';
  lastHeartbeatAt: string;
  maxConcurrentWorkers: number;
  activeWorkerCount: number;
  capacity: number;
  environment?: {
    tools?: string[];
    envKeys?: string[];
    mcp?: string[];
    labels?: string[];
    scannedAt?: string;
  } | null;
}

const TYPE_LABELS: Record<string, { label: string; color: string }> = {
  user: { label: 'User', color: 'bg-blue-500/10 text-blue-400 border-blue-500/30' },
  service: { label: 'Service', color: 'bg-purple-500/10 text-purple-400 border-purple-500/30' },
  action: { label: 'Action', color: 'bg-amber-500/10 text-amber-400 border-amber-500/30' },
};

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export default function RunnersPage() {
  const params = useParams();
  const workspaceId = params.id as string;
  const [runners, setRunners] = useState<Runner[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`/api/workspaces/${workspaceId}/runners`)
      .then(res => res.json())
      .then(data => {
        setRunners(data.runners || []);
      })
      .catch(() => setError('Failed to load runners'))
      .finally(() => setLoading(false));
  }, [workspaceId]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      fetch(`/api/workspaces/${workspaceId}/runners`)
        .then(res => res.json())
        .then(data => setRunners(data.runners || []))
        .catch(() => {});
    }, 30000);
    return () => clearInterval(interval);
  }, [workspaceId]);

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto">
        <Link href={`/app/workspaces/${workspaceId}`} className="text-sm text-text-muted hover:text-text-secondary mb-2 block">
          &larr; Back to workspace
        </Link>

        <div className="mb-8">
          <h1 className="text-2xl font-bold">Runners</h1>
          <p className="text-text-muted mt-1">
            Active runner instances registered via heartbeats for this workspace.
          </p>
        </div>

        {loading ? (
          <div className="text-text-muted">Loading runners...</div>
        ) : error ? (
          <div className="p-4 bg-status-error/10 border border-status-error/30 rounded-lg text-status-error">
            {error}
          </div>
        ) : runners.length === 0 ? (
          <div className="border border-dashed border-border-default rounded-lg p-8 text-center">
            <p className="text-text-secondary mb-2">No active runners</p>
            <p className="text-sm text-text-muted">
              Runners appear here when they send heartbeats. Start a runner with <code className="px-1 py-0.5 bg-surface-3 rounded">buildd run</code> to see it here.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Summary */}
            <div className="flex gap-4 text-sm text-text-secondary mb-4">
              <span>{runners.length} runner{runners.length !== 1 ? 's' : ''}</span>
              <span>{runners.filter(r => r.status === 'online').length} online</span>
              <span>{runners.reduce((sum, r) => sum + r.capacity, 0)} total capacity</span>
            </div>

            {/* Runner cards */}
            <div className="border border-border-default rounded-[10px] divide-y divide-border-default">
              {runners.map((runner) => {
                const typeInfo = TYPE_LABELS[runner.accountType] || TYPE_LABELS.user;
                return (
                  <div key={runner.id} className="p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-medium text-text-primary truncate">
                            {runner.accountName}
                          </span>
                          <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded border ${typeInfo.color}`}>
                            {typeInfo.label}
                          </span>
                          <span className={`flex items-center gap-1 text-xs ${
                            runner.status === 'online' ? 'text-status-success' : 'text-text-muted'
                          }`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${
                              runner.status === 'online' ? 'bg-status-success' : 'bg-text-muted'
                            }`} />
                            {runner.status === 'online' ? 'Online' : 'Stale'}
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
                          <span className="font-mono">{runner.localUiUrl}</span>
                          <span>Last heartbeat: {timeAgo(runner.lastHeartbeatAt)}</span>
                        </div>
                      </div>

                      <div className="text-right shrink-0">
                        <div className="text-sm font-medium">
                          {runner.activeWorkerCount}/{runner.maxConcurrentWorkers}
                        </div>
                        <div className="text-[10px] text-text-muted uppercase tracking-wide">
                          workers
                        </div>
                      </div>
                    </div>

                    {/* Environment labels */}
                    {runner.environment?.labels && runner.environment.labels.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {runner.environment.labels.map((label) => (
                          <span
                            key={label}
                            className="px-1.5 py-0.5 text-[10px] bg-surface-3 text-text-secondary rounded"
                          >
                            {label}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
