'use client';

import { useState, useEffect } from 'react';
import CopyBlock from '@/components/CopyBlock';
import RunnerInstallSteps from '@/components/RunnerInstallSteps';
import { RUNNER_HEADLESS_LOGIN } from '@/lib/runner-install';

interface LiveRunner {
  id: string;
  accountName: string;
  accountType: 'user' | 'service' | 'action';
  status: 'online' | 'stale';
  lastHeartbeatAt: string;
  maxConcurrentWorkers: number;
  activeWorkerCount: number;
  capacity: number;
}

interface ConnectRunnerSectionProps {
  workspaceId: string;
  runners: {
    service: string[];
    user: string[];
  };
}

type RunnerType = 'service' | 'user';

const runnerMeta: Record<RunnerType, { label: string; description: string; emptyText: string }> = {
  service: { label: 'Service Workers', description: 'Always-on VM or server', emptyText: 'No runners connected' },
  user: { label: 'User Workers', description: 'Your laptop via Claude Code', emptyText: 'No runners connected' },
};

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function ConnectRunnerSection({ workspaceId, runners }: ConnectRunnerSectionProps) {
  const [expanded, setExpanded] = useState<RunnerType | null>(null);
  const [liveRunners, setLiveRunners] = useState<LiveRunner[]>([]);
  const [loadingRunners, setLoadingRunners] = useState(true);

  useEffect(() => {
    let cancelled = false;
    function fetchRunners() {
      fetch(`/api/workspaces/${workspaceId}/runners`)
        .then(res => res.json())
        .then(data => {
          if (!cancelled) setLiveRunners(data.runners || []);
        })
        .catch(() => {
          if (!cancelled) setLiveRunners([]);
        })
        .finally(() => {
          if (!cancelled) setLoadingRunners(false);
        });
    }
    fetchRunners();
    const interval = setInterval(fetchRunners, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [workspaceId]);

  function toggle(type: RunnerType) {
    setExpanded(expanded === type ? null : type);
  }

  return (
    <div className="mb-8">
      <div className="font-mono text-[11px] md:text-[10px] uppercase tracking-[2.5px] text-text-muted pb-2 border-b border-border-default mb-6">
        Runners
      </div>

      {/* Live connected runners */}
      {loadingRunners ? (
        <div className="border border-border-default p-4 mb-4">
          <span className="text-[12px] text-text-muted font-mono">Checking runners…</span>
        </div>
      ) : liveRunners.length > 0 ? (
        <div className="border border-border-default divide-y divide-border-default mb-6">
          {liveRunners.map((runner) => (
            <div key={runner.id} className="flex items-center gap-3 px-4 py-3">
              <span
                className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  runner.status === 'online' ? 'bg-status-success animate-pulse' : 'bg-text-muted'
                }`}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[13px] font-medium text-text-primary truncate">
                    {runner.accountName}
                  </span>
                  <span className={`text-[11px] md:text-[10px] font-mono ${runner.status === 'online' ? 'text-status-success' : 'text-text-muted'}`}>
                    {runner.status}
                  </span>
                </div>
                <div className="text-[11px] text-text-muted font-mono">
                  {runner.activeWorkerCount}/{runner.maxConcurrentWorkers} workers · last beat {timeAgo(runner.lastHeartbeatAt)}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-[13px] font-medium text-text-primary">{runner.capacity}</div>
                <div className="text-[11px] md:text-[10px] text-text-muted font-mono uppercase tracking-wide">slots</div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="border border-dashed border-border-default p-4 mb-6">
          <p className="text-[13px] text-text-secondary">No runners connected.</p>
        </div>
      )}

      {/* Runner type setup cards — stacked for mobile, inline for wider screens */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
        {(Object.keys(runnerMeta) as RunnerType[]).map((type) => {
          const meta = runnerMeta[type];
          const names = runners[type];
          const isExpanded = expanded === type;

          return (
            <button
              key={type}
              onClick={() => toggle(type)}
              className={`bg-surface-2 border p-4 text-left transition-colors cursor-pointer ${
                isExpanded ? 'border-primary bg-primary/5' : 'border-border-default hover:border-text-muted'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium text-sm">{meta.label}</span>
                {names.length > 0 && (
                  <span className="px-2 py-0.5 text-[11px] md:text-[10px] font-medium rounded-full bg-status-success/10 text-status-success">
                    {names.length}
                  </span>
                )}
              </div>
              {names.length > 0 ? (
                <div className="text-xs text-text-muted truncate">{names.join(', ')}</div>
              ) : (
                <div className="text-xs text-text-muted">{meta.emptyText}</div>
              )}
            </button>
          );
        })}
      </div>

      {expanded === 'service' && (
        <div className="border border-primary/30 p-4 bg-primary/5">
          <h3 className="font-medium mb-3">Set up Service Worker</h3>

          <div className="space-y-4">
            <div>
              <div className="text-sm font-medium mb-2">Step 1: Create a Service account</div>
              <p className="text-sm text-text-secondary">
                Go to <a href="/app/accounts/new" className="text-primary hover:underline">Accounts &rarr; New Account</a> and select &quot;Service - Always-on server/VM&quot; as the type.
              </p>
            </div>

            <div>
              <div className="text-sm font-medium mb-2">Step 2: Install and run buildd</div>
              <p className="text-sm text-text-secondary mb-2">
                On your server, install buildd and start it:
              </p>
              <RunnerInstallSteps />
              <p className="text-xs text-text-muted mt-2">
                No browser on the server? Run <code>{RUNNER_HEADLESS_LOGIN}</code> before <code>buildd</code> and log in from the terminal.
              </p>
            </div>

            <div>
              <div className="text-sm font-medium mb-2">Keep it running in the background:</div>
              <CopyBlock text="buildd service install" />
              <p className="text-xs text-text-muted mt-2">Registers buildd as a background service (launchd on macOS, systemd on Linux) so it survives closing the terminal and reboots.</p>
            </div>
          </div>
        </div>
      )}

      {expanded === 'user' && (
        <div className="border border-primary/30 p-4 bg-primary/5">
          <h3 className="font-medium mb-3">Set up User Worker (Claude Code)</h3>

          <div className="space-y-4">
            <div>
              <div className="text-sm font-medium mb-2">Step 1: Create a User account</div>
              <p className="text-sm text-text-secondary">
                Go to <a href="/app/accounts/new" className="text-primary hover:underline">Accounts &rarr; New Account</a> and select &quot;User - Personal laptop/workstation&quot; as the type.
              </p>
            </div>

            <div>
              <div className="text-sm font-medium mb-2">Step 2: Add MCP server to Claude Code</div>
              <p className="text-sm text-text-secondary mb-2">
                Run this command in your terminal:
              </p>
              <pre className="bg-surface-1 text-text-primary p-3 rounded text-xs overflow-x-auto whitespace-pre-wrap">
{`claude mcp add --transport http buildd https://buildd.dev/api/mcp --header "Authorization: Bearer YOUR_API_KEY"`}
              </pre>
            </div>

            <div>
              <div className="text-sm font-medium mb-2">Step 3: Use Claude Code</div>
              <p className="text-sm text-text-secondary">
                Open Claude Code in your repo and say:
              </p>
              <ul className="text-sm text-text-secondary list-disc list-inside mt-1">
                <li>&quot;Check buildd for tasks&quot;</li>
                <li>&quot;Claim a task from buildd&quot;</li>
                <li>&quot;Work on the buildd task&quot;</li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
