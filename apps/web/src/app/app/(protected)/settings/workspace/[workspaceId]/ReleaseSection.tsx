'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import type { WorkspaceReleaseConfig, ReleaseTrigger, ReleaseStrategy } from '@buildd/core/db/schema';
import { resolveReleaseTrigger } from '@buildd/core/release-strategy';
import { Select } from '@/components/ui/Select';
import StatePill, { StatusPill, TonePill } from '@/components/ui/StatePill';
import type { StateKey } from '@/components/ui/states';

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
  /**
   * The trigger policy the server will actually run, resolved server-side via
   * `resolveReleaseTrigger`. Passed in so this form never displays a default
   * the server does not use (invariant 4, docs/design/mission-delivery-arc.md).
   * Optional only for older call sites; the fallback uses the same function, so
   * the two can never diverge.
   */
  effectiveTrigger?: ReleaseTrigger;
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

/** Vercel's deploy state, as a StatePill. An unknown state keeps its own word. */
const DEPLOY_PILL: Record<string, { state: StateKey; label: string }> = {
  READY: { state: 'landed', label: 'Deployed' },
  BUILDING: { state: 'running', label: 'Building' },
  ERROR: { state: 'failed', label: 'Error' },
  CANCELED: { state: 'not_landed', label: 'Canceled' },
  TIMEOUT: { state: 'failed', label: 'Timed out' },
};

function DeployStateBadge({ state }: { state: string | null | undefined }) {
  if (!state) return <span className="text-text-muted text-xs">unknown</span>;
  const pill = DEPLOY_PILL[state] ?? { state: 'ready' as const, label: state };
  return <StatePill state={pill.state} label={pill.label} title={state} />;
}

function ReleaseStatus({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="text-text-muted text-xs">unknown</span>;
  return <StatusPill status={status} />;
}

export default function ReleaseSection({ workspaceId, teamId, initialReleaseConfig, effectiveTrigger, hasRepo }: Props) {
  const cfg = initialReleaseConfig;

  const [strategy, setStrategy] = useState<StrategyOption>(
    cfg?.enabled === false ? 'none' : (cfg?.strategy ?? 'none')
  );
  const [prodBranch, setProdBranch] = useState(cfg?.prodBranch ?? 'main');
  const [ref, setRef] = useState(cfg?.ref ?? 'dev');
  const [workflowFile, setWorkflowFile] = useState(cfg?.workflowFile ?? 'release.yml');
  // Never re-guess the default here: `resolveReleaseTrigger` is the single
  // source shared with the server readers (mission-release.ts,
  // release-executor.ts, api/github/webhook/route.ts).
  const [trigger, setTrigger] = useState<ReleaseTrigger>(
    effectiveTrigger ?? resolveReleaseTrigger(cfg)
  );

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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

  const isReleaseEnabled = strategy !== 'none';

  if (!hasRepo) {
    return (
      <div className="py-4 first:pt-0 last:pb-0">
        <h3 className="text-sm font-medium text-text-primary">Release</h3>
        <p className="text-xs text-text-muted mt-0.5">Link a GitHub repo to enable releases.</p>
      </div>
    );
  }

  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <h3 className="text-sm font-medium text-text-primary mb-3">Release</h3>
      <form onSubmit={handleSave} className="space-y-5">
        <div className="space-y-5">

          {/* Strategy selector */}
          <div>
            <label className="block text-sm text-text-primary mb-1">Strategy</label>
            <Select
              aria-label="Strategy"
              value={strategy}
              onChange={(v) => setStrategy(v as StrategyOption)}
              options={[
                { value: 'none', label: 'None', description: 'Releases off' },
                { value: 'branch_merge', label: 'Branch merge', description: 'Merge source into production' },
                { value: 'workflow_dispatch', label: 'Workflow dispatch', description: 'Trigger GitHub Actions' },
                { value: 'script', label: 'Script', description: 'Coming soon', disabled: true },
              ]}
            />
            {strategy === 'none' && (
              <p className="text-xs text-text-muted mt-1">buildd won&apos;t run releases for this workspace.</p>
            )}
          </div>

          {/* branch_merge fields */}
          {strategy === 'branch_merge' && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-text-primary mb-1">Source (e.g. dev)</label>
                <input
                  type="text"
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                  placeholder="dev"
                  className="w-full px-3 py-2 border border-border-default bg-surface-1 text-base md:text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-sm text-text-primary mb-1">Production (e.g. main)</label>
                <input
                  type="text"
                  value={prodBranch}
                  onChange={(e) => setProdBranch(e.target.value)}
                  placeholder="main"
                  className="w-full px-3 py-2 border border-border-default bg-surface-1 text-base md:text-sm font-mono"
                />
              </div>
            </div>
          )}

          {/* workflow_dispatch fields */}
          {strategy === 'workflow_dispatch' && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-text-primary mb-1">Workflow file (e.g. release.yml)</label>
                <input
                  type="text"
                  value={workflowFile}
                  onChange={(e) => setWorkflowFile(e.target.value)}
                  placeholder="release.yml"
                  className="w-full px-3 py-2 border border-border-default bg-surface-1 text-base md:text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-sm text-text-primary mb-1">Ref (e.g. dev)</label>
                <input
                  type="text"
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                  placeholder="dev"
                  className="w-full px-3 py-2 border border-border-default bg-surface-1 text-base md:text-sm font-mono"
                />
              </div>
            </div>
          )}

          {/* Trigger policy */}
          {isReleaseEnabled && (
            <div>
              <span className="block text-sm text-text-primary mb-1">Trigger</span>
              <div className="divide-y divide-border-default border-y border-border-default">
                {(
                  [
                    {
                      value: 'on_mission_complete' as ReleaseTrigger,
                      label: 'When mission completes',
                      badge: 'Recommended',
                      help: 'Releases once after every task in a mission finishes, as one ship.',
                    },
                    {
                      value: 'every_merge' as ReleaseTrigger,
                      label: 'Every merge',
                      help: 'Releases on each completed task. Use for hotfix workspaces or repos that ship continuously.',
                    },
                    {
                      value: 'manual' as ReleaseTrigger,
                      label: 'Manual only',
                      help: "You release by hand: 'Release now' on Home, or trigger_release over MCP.",
                    },
                    {
                      value: 'scheduled' as ReleaseTrigger,
                      label: 'Scheduled',
                      disabled: true,
                      help: 'Coming soon. Releases on a cron schedule, such as nightly.',
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
                    className={`flex items-start gap-3 py-3 ${
                      opt.disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
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
                        <span className="text-sm text-text-primary">{opt.label}</span>
                        {opt.badge && <TonePill tone="ok">{opt.badge}</TonePill>}
                        {opt.disabled && <span className="text-xs text-text-muted">Coming soon</span>}
                      </div>
                      <p className="text-xs text-text-muted mt-0.5">{opt.help}</p>
                    </div>
                  </label>
                ))}
              </div>
              {trigger === 'on_mission_complete' && (
                <p className="text-xs text-text-muted mt-2">
                  Tasks outside a mission don&apos;t trigger a release with this setting.
                </p>
              )}
            </div>
          )}

          {/* Vercel token status */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-text-secondary">Vercel token:</span>
            {hasVercelToken === null ? (
              <span className="text-text-muted">checking…</span>
            ) : hasVercelToken ? (
              <TonePill tone="ok">Configured</TonePill>
            ) : (
              <span className="text-text-secondary">
                <TonePill tone="dec">Not configured</TonePill>{' '}
                <Link href="/app/settings/github" className="underline text-text-primary hover:no-underline">
                  Add one in Settings, GitHub and Vercel
                </Link>
              </span>
            )}
          </div>
        </div>

        {/* Save button */}
        <div className="flex flex-wrap items-center gap-4">
          <button
            type="submit"
            disabled={saving}
            className="btn min-h-11"
          >
            {saving ? 'Saving…' : 'Save release settings'}
          </button>
          {saved && <span className="text-status-success text-sm">Saved</span>}
          {saveError && <span className="text-status-error text-sm">{saveError}</span>}
        </div>

        {/* Status strip */}
        {isReleaseEnabled && (
          <div className="space-y-4">
            {/* Last-release status strip */}
            <div>
              <h4 className="text-sm font-medium text-text-primary mb-1">Last release</h4>
              {loadingReleases ? (
                <div className="text-xs text-text-muted">Loading…</div>
              ) : !lastRelease ? (
                <div className="text-xs text-text-muted">No releases.</div>
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
                      className="text-text-primary underline hover:no-underline"
                    >
                      Open deploy
                    </a>
                  )}
                </div>
              )}
            </div>

            {/* Recent releases table */}
            {recentReleases.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-text-primary mb-1">Recent releases</h4>
                <div className="border-y border-border-default overflow-x-auto">
                  <table className="w-full table-fixed text-xs">
                    <thead className="border-b border-border-default">
                      <tr>
                        <th className="w-[88px] sm:w-[96px] px-2 py-2 text-left font-normal text-text-muted">When</th>
                        <th className="px-2 py-2 text-left font-normal text-text-muted">Task</th>
                        <th className="hidden sm:table-cell w-[80px] px-2 py-2 text-left font-normal text-text-muted">Commit</th>
                        <th className="w-[104px] px-2 py-2 text-left font-normal text-text-muted">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-default">
                      {recentReleases.slice(0, 5).map((r: RecentRelease) => (
                        <tr key={r.taskId} className="hover:bg-surface-2">
                          <td className="px-3 py-2 text-text-secondary whitespace-nowrap" title={r.completedAt}>
                            {relativeTime(r.completedAt)}
                          </td>
                          <td className="px-3 py-2 truncate">
                            <Link
                              href={`/app/tasks/${r.taskId}`}
                              className="text-text-primary hover:underline truncate block"
                            >
                              {r.taskTitle || r.taskId.slice(0, 8)}
                            </Link>
                          </td>
                          <td className="hidden sm:table-cell px-3 py-2 font-mono text-text-secondary">
                            {r.sha ? r.sha.slice(0, 7) : ''}
                          </td>
                          <td className="px-3 py-2">
                            {r.deployState ? (
                              <DeployStateBadge state={r.deployState} />
                            ) : (
                              <ReleaseStatus status={r.status} />
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
    </div>
  );
}
