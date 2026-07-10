'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import type { WorkspaceReleaseConfig, ReleaseTrigger, ReleaseStrategy } from '@buildd/core/db/schema';

type StrategyOption = ReleaseStrategy | 'none';

interface LastRelease {
  taskId: string;
  taskTitle: string;
  missionId: string | null;
  completedAt: string;
  releaseResult: {
    status?: string;
    deployState?: string;
    deployUrl?: string;
    sha?: string;
  } | null;
  sha: string | null;
}

interface RecentRelease {
  taskId: string;
  taskTitle: string;
  missionId: string | null;
  completedAt: string;
  deployState: string | null;
  deployUrl: string | null;
  status: string | null;
  sha: string | null;
}

interface Props {
  workspaceId: string;
  teamId: string;
  initialReleaseConfig: WorkspaceReleaseConfig | null;
  hasRepo: boolean;
}

const TERMINAL_DEPLOY_STATES = new Set(['READY', 'ERROR', 'CANCELED', 'TIMEOUT', null]);

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function DeployStateBadge({ state }: { state: string | null | undefined }) {
  if (!state) return <span className="text-text-muted text-xs">—</span>;
  const colorMap: Record<string, string> = {
    READY: 'bg-status-success/15 text-status-success',
    BUILDING: 'bg-amber-500/15 text-amber-600 animate-pulse',
    ERROR: 'bg-status-error/15 text-status-error',
    CANCELED: 'bg-surface-4 text-text-muted',
    TIMEOUT: 'bg-status-error/15 text-status-error',
  };
  const cls = colorMap[state] ?? 'bg-surface-4 text-text-muted';
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${cls}`}>
      {state}
    </span>
  );
}

function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="text-text-muted text-xs">—</span>;
  const colorMap: Record<string, string> = {
    completed: 'bg-status-success/15 text-status-success',
    failed: 'bg-status-error/15 text-status-error',
    skipped: 'bg-surface-4 text-text-muted',
  };
  const cls = colorMap[status] ?? 'bg-surface-4 text-text-muted';
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${cls}`}>
      {status}
    </span>
  );
}

export default function ReleaseSection({ workspaceId, teamId, initialReleaseConfig, hasRepo }: Props) {
  const cfg = initialReleaseConfig;

  const [strategy, setStrategy] = useState<StrategyOption>(
    cfg?.enabled === false ? 'none' : (cfg?.strategy ?? 'none')
  );
  const [prodBranch, setProdBranch] = useState(cfg?.prodBranch ?? 'main');
  const [ref, setRef] = useState(cfg?.ref ?? 'dev');
  const [workflowFile, setWorkflowFile] = useState(cfg?.workflowFile ?? 'release.yml');
  const [trigger, setTrigger] = useState<ReleaseTrigger>(cfg?.trigger ?? 'on_mission_complete');

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [releasing, setReleasing] = useState(false);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [releaseSuccess, setReleaseSuccess] = useState<string | null>(null);

  const [lastRelease, setLastRelease] = useState<LastRelease | null>(null);
  const [recentReleases, setRecentReleases] = useState<RecentRelease[]>([]);
  const [loadingReleases, setLoadingReleases] = useState(false);

  const [hasVercelToken, setHasVercelToken] = useState<boolean | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchReleaseHistory = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/last-release`);
      if (!res.ok) return;
      const data = await res.json();
      setLastRelease(data.lastRelease ?? null);
      setRecentReleases(data.recentReleases ?? []);
    } catch {
      // silently ignore
    }
  }, [workspaceId]);

  // Initial load of release history
  useEffect(() => {
    if (!hasRepo) return;
    setLoadingReleases(true);
    fetchReleaseHistory().finally(() => setLoadingReleases(false));
  }, [hasRepo, fetchReleaseHistory]);

  // Poll when last release is in a building state
  useEffect(() => {
    const isBuilding = lastRelease?.releaseResult?.deployState
      ? !TERMINAL_DEPLOY_STATES.has(lastRelease.releaseResult.deployState)
      : false;

    if (isBuilding) {
      pollRef.current = setInterval(fetchReleaseHistory, 10_000);
    } else {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    }

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [lastRelease, fetchReleaseHistory]);

  // Fetch Vercel token status
  useEffect(() => {
    if (!teamId) return;
    fetch(`/api/secrets?teamId=${teamId}`)
      .then((r) => r.json())
      .then((data) => {
        const hasToken = (data.secrets ?? []).some(
          (s: { purpose: string }) => s.purpose === 'vercel_token'
        );
        setHasVercelToken(hasToken);
      })
      .catch(() => setHasVercelToken(null));
  }, [teamId]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    setSaveError(null);

    let releaseConfig: Record<string, unknown>;
    if (strategy === 'none') {
      releaseConfig = { strategy: 'none' }; // API treats 'none' as enabled: false
    } else if (strategy === 'branch_merge') {
      releaseConfig = {
        enabled: true,
        strategy: 'branch_merge',
        prodBranch: prodBranch.trim() || 'main',
        ref: ref.trim() || 'dev',
        trigger,
      };
    } else if (strategy === 'workflow_dispatch') {
      releaseConfig = {
        enabled: true,
        strategy: 'workflow_dispatch',
        workflowFile: workflowFile.trim() || 'release.yml',
        ref: ref.trim() || 'dev',
        trigger,
      };
    } else {
      releaseConfig = { enabled: false };
    }

    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ releaseConfig }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function handleReleaseNow() {
    setReleasing(true);
    setReleaseError(null);
    setReleaseSuccess(null);

    try {
      const res = await fetch('/api/releases/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Release trigger failed');
      setReleaseSuccess(data.runUrl ? `Release dispatched — run started` : 'Release triggered');
      setTimeout(() => setReleaseSuccess(null), 8000);
      // Start polling for updated status
      setTimeout(() => fetchReleaseHistory(), 2000);
      setTimeout(() => fetchReleaseHistory(), 8000);
    } catch (err) {
      setReleaseError(err instanceof Error ? err.message : 'Release trigger failed');
    } finally {
      setReleasing(false);
    }
  }

  const isReleaseEnabled = strategy !== 'none';
  const needsVercel = strategy === 'branch_merge';
  const vercelMissing = needsVercel && hasVercelToken === false;
  const releaseNowDisabled = !isReleaseEnabled || vercelMissing || releasing;

  let releaseNowTitle: string | undefined;
  if (!isReleaseEnabled) releaseNowTitle = 'Select a release strategy first';
  else if (vercelMissing) releaseNowTitle = 'Add Vercel token in Connections to release';
  else if (strategy === 'branch_merge') releaseNowTitle = 'branch_merge releases automatically on task completion';

  const isBranchMergeManualBlocked = strategy === 'branch_merge';

  if (!hasRepo) {
    return (
      <section className="mt-10">
        <h2 className="section-label mb-3">Release</h2>
        <div className="card p-4">
          <p className="text-sm text-text-muted">Link a GitHub repo to enable releases.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="mt-10">
      <h2 className="section-label mb-3">Release</h2>
      <form onSubmit={handleSave} className="space-y-6">
        <div className="card p-4 space-y-5">

          {/* Strategy selector */}
          <div>
            <label className="block text-sm font-medium mb-1">Strategy</label>
            <select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as StrategyOption)}
              className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 text-sm"
            >
              <option value="none">None — releases not configured</option>
              <option value="branch_merge">Branch merge (merge source → production)</option>
              <option value="workflow_dispatch">Workflow dispatch (trigger GitHub Actions)</option>
              <option value="script" disabled>Script — coming soon</option>
            </select>
            {strategy === 'none' && (
              <p className="text-xs text-text-muted mt-1">No automatic or manual releases will run for this workspace.</p>
            )}
          </div>

          {/* branch_merge fields */}
          {strategy === 'branch_merge' && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Source (e.g. dev)</label>
                <input
                  type="text"
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                  placeholder="dev"
                  className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Production (e.g. main)</label>
                <input
                  type="text"
                  value={prodBranch}
                  onChange={(e) => setProdBranch(e.target.value)}
                  placeholder="main"
                  className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 text-sm font-mono"
                />
              </div>
            </div>
          )}

          {/* workflow_dispatch fields */}
          {strategy === 'workflow_dispatch' && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Workflow file (e.g. release.yml)</label>
                <input
                  type="text"
                  value={workflowFile}
                  onChange={(e) => setWorkflowFile(e.target.value)}
                  placeholder="release.yml"
                  className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Ref (e.g. dev)</label>
                <input
                  type="text"
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                  placeholder="dev"
                  className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 text-sm font-mono"
                />
              </div>
            </div>
          )}

          {/* Trigger policy */}
          {isReleaseEnabled && (
            <div>
              <label className="block text-sm font-medium mb-2">Trigger</label>
              <div className="space-y-2">
                {(
                  [
                    {
                      value: 'on_mission_complete' as ReleaseTrigger,
                      label: 'When mission completes',
                      badge: 'recommended',
                      help: 'Releases once after all tasks in a mission finish. Batches your work into one ship.',
                    },
                    {
                      value: 'every_merge' as ReleaseTrigger,
                      label: 'Every merge',
                      help: 'Releases on each completed task. Use for hotfix workspaces or repos that ship continuously.',
                    },
                    {
                      value: 'manual' as ReleaseTrigger,
                      label: 'Manual only',
                      help: "Nothing releases automatically. Use the 'Release now' button below or trigger_release via MCP.",
                    },
                    {
                      value: 'scheduled' as ReleaseTrigger,
                      label: 'Scheduled',
                      disabled: true,
                      help: 'Phase 2 — coming soon. Nightly or periodic releases on a cron schedule.',
                    },
                  ] as Array<{
                    value: ReleaseTrigger;
                    label: string;
                    badge?: string;
                    help: string;
                    disabled?: boolean;
                  }>
                ).map((opt) => (
                  <label
                    key={opt.value}
                    className={`flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
                      trigger === opt.value
                        ? 'border-primary bg-primary/5'
                        : opt.disabled
                          ? 'border-border-default opacity-50 cursor-not-allowed'
                          : 'border-border-default hover:border-border-strong'
                    }`}
                  >
                    <input
                      type="radio"
                      name="trigger"
                      value={opt.value}
                      checked={trigger === opt.value}
                      disabled={opt.disabled}
                      onChange={() => !opt.disabled && setTrigger(opt.value)}
                      className="mt-0.5 shrink-0"
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{opt.label}</span>
                        {opt.badge && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-primary/15 text-primary">
                            {opt.badge}
                          </span>
                        )}
                        {opt.disabled && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-surface-4 text-text-muted">
                            coming soon
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-text-muted mt-0.5">{opt.help}</p>
                    </div>
                  </label>
                ))}
              </div>
              {trigger === 'on_mission_complete' && (
                <p className="text-xs text-text-muted mt-2">
                  Note: tasks not in a mission will not trigger a release with this setting.
                </p>
              )}
            </div>
          )}

          {/* Vercel token status */}
          <div className="flex items-center gap-2 text-sm pt-1 border-t border-border-default">
            <span className="text-text-secondary">Vercel token:</span>
            {hasVercelToken === null ? (
              <span className="text-text-muted">checking…</span>
            ) : hasVercelToken ? (
              <span className="text-status-success font-medium">Configured ✓</span>
            ) : (
              <span className="text-amber-600 font-medium">
                Not configured —{' '}
                <Link href="/app/settings" className="underline hover:no-underline">
                  Configure in Connections →
                </Link>
              </span>
            )}
          </div>
        </div>

        {/* Save button */}
        <div className="flex items-center gap-4">
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 bg-primary text-white hover:bg-primary-hover rounded-md disabled:opacity-50 text-sm"
          >
            {saving ? 'Saving…' : 'Save Release Config'}
          </button>
          {saved && <span className="text-status-success text-sm">Saved</span>}
          {saveError && <span className="text-status-error text-sm">{saveError}</span>}
        </div>

        {/* Release now + status strip */}
        {isReleaseEnabled && (
          <div className="card p-4 space-y-4">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleReleaseNow}
                disabled={releaseNowDisabled || isBranchMergeManualBlocked}
                title={releaseNowTitle}
                className="px-4 py-2 bg-primary text-white hover:bg-primary-hover rounded-md disabled:opacity-50 text-sm"
              >
                {releasing ? 'Triggering…' : 'Release now'}
              </button>
              {isBranchMergeManualBlocked && (
                <span className="text-xs text-text-muted">
                  branch_merge releases automatically on task completion.
                </span>
              )}
              {releaseSuccess && (
                <span className="text-status-success text-sm">{releaseSuccess}</span>
              )}
              {releaseError && (
                <span className="text-status-error text-sm">{releaseError}</span>
              )}
            </div>

            {/* Last-release status strip */}
            <div>
              <div className="text-xs font-medium text-text-secondary mb-2">Last release</div>
              {loadingReleases ? (
                <div className="text-xs text-text-muted">Loading…</div>
              ) : !lastRelease ? (
                <div className="text-xs text-text-muted">No releases yet.</div>
              ) : (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                  <DeployStateBadge state={lastRelease.releaseResult?.deployState} />
                  <span
                    className="text-text-secondary"
                    title={lastRelease.completedAt}
                  >
                    {relativeTime(lastRelease.completedAt)}
                  </span>
                  {lastRelease.sha && (
                    <span className="font-mono text-text-secondary">{lastRelease.sha.slice(0, 7)}</span>
                  )}
                  {lastRelease.releaseResult?.deployUrl && (
                    <a
                      href={lastRelease.releaseResult.deployUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline"
                    >
                      Open →
                    </a>
                  )}
                </div>
              )}
            </div>

            {/* Recent releases table */}
            {recentReleases.length > 0 && (
              <div>
                <div className="text-xs font-medium text-text-secondary mb-2">Recent releases</div>
                <div className="rounded-md border border-border-default overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-surface-2">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium text-text-secondary">When</th>
                        <th className="px-3 py-2 text-left font-medium text-text-secondary">Task</th>
                        <th className="px-3 py-2 text-left font-medium text-text-secondary">Commit</th>
                        <th className="px-3 py-2 text-left font-medium text-text-secondary">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-default">
                      {recentReleases.slice(0, 5).map((r: RecentRelease) => (
                        <tr key={r.taskId} className="hover:bg-surface-2">
                          <td className="px-3 py-2 text-text-secondary whitespace-nowrap" title={r.completedAt}>
                            {relativeTime(r.completedAt)}
                          </td>
                          <td className="px-3 py-2 max-w-[180px] truncate">
                            <Link
                              href={`/app/tasks/${r.taskId}`}
                              className="text-primary hover:underline truncate block"
                            >
                              {r.taskTitle || r.taskId.slice(0, 8)}
                            </Link>
                          </td>
                          <td className="px-3 py-2 font-mono text-text-secondary">
                            {r.sha ? r.sha.slice(0, 7) : '—'}
                          </td>
                          <td className="px-3 py-2">
                            {r.deployState ? (
                              <DeployStateBadge state={r.deployState} />
                            ) : (
                              <StatusBadge status={r.status} />
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </form>
    </section>
  );
}
