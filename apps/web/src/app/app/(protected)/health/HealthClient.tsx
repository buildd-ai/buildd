'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { WorkspaceFilter } from '@/components/WorkspaceFilter';
import { isRunnerOnline } from '@/lib/runner-heartbeats';
import type { WatchedProjectRow, WorkspaceOption, VercelTokenOption, UsageStats } from './page';
import type { RunnerHeartbeat } from '@/lib/runner-heartbeats';

interface Props {
  initialRows: WatchedProjectRow[];
  workspaces: WorkspaceOption[];
  vercelTokens: VercelTokenOption[];
  hasGlobalVercelToken: boolean;
  runners: RunnerHeartbeat[];
  usageStats: UsageStats | null;
  teamWorkspaces: { id: string; name: string }[];
  wsFilter: string | null;
}

interface FormState {
  workspaceId: string;
  repo: string;
  vercelProjectId: string;
  vercelTokenSecretId: string | null;
  inFlightWindowMin: number;
  prodGraceMin: number;
  roleSlug: string;
  pushoverApp: 'tasks' | 'alerts';
  baseRef: string;
  labelFilter: string;
  titlePrefix: string;
  notes: string;
  enabled: boolean;
}

function blankForm(workspaceId: string): FormState {
  return {
    workspaceId,
    repo: '',
    vercelProjectId: '',
    vercelTokenSecretId: null,
    inFlightWindowMin: 60,
    prodGraceMin: 60,
    roleSlug: 'ops',
    pushoverApp: 'alerts',
    baseRef: 'main',
    labelFilter: '',
    titlePrefix: '',
    notes: '',
    enabled: true,
  };
}

function rowToForm(row: WatchedProjectRow): FormState {
  return {
    workspaceId: row.workspaceId,
    repo: row.repo,
    vercelProjectId: row.vercelProjectId ?? '',
    vercelTokenSecretId: row.vercelTokenSecretId,
    inFlightWindowMin: row.inFlightWindowMin,
    prodGraceMin: row.prodGraceMin,
    roleSlug: row.roleSlug,
    pushoverApp: row.pushoverApp,
    baseRef: row.releasePrFilter.base ?? 'main',
    labelFilter: row.releasePrFilter.label ?? '',
    titlePrefix: row.releasePrFilter.titlePrefix ?? '',
    notes: row.notes ?? '',
    enabled: row.enabled,
  };
}

function formToBody(form: FormState): Record<string, unknown> {
  const releasePrFilter: Record<string, string> = {};
  if (form.baseRef) releasePrFilter.base = form.baseRef;
  if (form.labelFilter) releasePrFilter.label = form.labelFilter;
  if (form.titlePrefix) releasePrFilter.titlePrefix = form.titlePrefix;
  return {
    repo: form.repo.trim(),
    enabled: form.enabled,
    vercelProjectId: form.vercelProjectId.trim() || null,
    vercelTokenSecretId: form.vercelTokenSecretId,
    inFlightWindowMin: Number(form.inFlightWindowMin),
    prodGraceMin: Number(form.prodGraceMin),
    roleSlug: form.roleSlug.trim() || 'ops',
    pushoverApp: form.pushoverApp,
    releasePrFilter,
    notes: form.notes.trim() || null,
  };
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function HealthClient({
  initialRows,
  workspaces,
  vercelTokens,
  hasGlobalVercelToken,
  runners,
  usageStats,
  teamWorkspaces,
  wsFilter,
}: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [editing, setEditing] = useState<{ mode: 'create' | 'edit'; row?: WatchedProjectRow } | null>(null);
  const [form, setForm] = useState<FormState>(blankForm(workspaces[0]?.id ?? ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState('');
  const [newTokenLabel, setNewTokenLabel] = useState('');

  const tokensByTeam = useMemo(() => {
    const map = new Map<string, VercelTokenOption[]>();
    for (const t of vercelTokens) {
      const list = map.get(t.teamId) ?? [];
      list.push(t);
      map.set(t.teamId, list);
    }
    return map;
  }, [vercelTokens]);

  const activeTeamId = workspaces.find((w) => w.id === form.workspaceId)?.teamId ?? '';
  const teamTokens = activeTeamId ? tokensByTeam.get(activeTeamId) ?? [] : [];

  function vercelMissing(row: WatchedProjectRow): boolean {
    return Boolean(row.vercelProjectId) && !row.vercelTokenSecretId && !hasGlobalVercelToken;
  }

  const refresh = () => startTransition(() => router.refresh());

  const startCreate = () => {
    setError(null);
    setForm(blankForm(workspaces[0]?.id ?? ''));
    setEditing({ mode: 'create' });
  };
  const startEdit = (row: WatchedProjectRow) => {
    setError(null);
    setForm(rowToForm(row));
    setEditing({ mode: 'edit', row });
  };
  const close = () => {
    setEditing(null);
    setError(null);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (editing?.mode === 'create') {
        if (!form.workspaceId) throw new Error('Workspace required');
        const res = await fetch(`/api/workspaces/${form.workspaceId}/watched-projects`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(formToBody(form)),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? 'Create failed');
      } else if (editing?.mode === 'edit' && editing.row) {
        const res = await fetch(`/api/watched-projects/${editing.row.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(formToBody(form)),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? 'Update failed');
      }
      close();
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  const deleteRow = async (row: WatchedProjectRow) => {
    if (!confirm(`Delete watched project ${row.repo}?`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/watched-projects/${row.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Delete failed');
      close();
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  const addVercelToken = async () => {
    const value = newToken.trim();
    if (!value) {
      setError('Paste a Vercel API token first');
      return;
    }
    if (!activeTeamId) {
      setError('No team — pick a workspace first');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          value,
          purpose: 'vercel_token',
          label: newTokenLabel.trim() || 'Vercel API token',
          teamId: activeTeamId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to store token');
      setForm({ ...form, vercelTokenSecretId: data.id });
      setNewToken('');
      setNewTokenLabel('');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to store token');
    } finally {
      setBusy(false);
    }
  };

  const runNow = async (row: WatchedProjectRow) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/watched-projects/${row.id}/run`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? 'Run failed');
      alert(`Ran check. Fired ${data.fired} alert(s).`);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-4 sm:py-6 pb-24">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Project Health</h1>
          <p className="text-sm text-text-tertiary">
            Watcher fires a task + Pushover when CI breaks on release PRs or prod deploys go bad.
          </p>
        </div>
        <WorkspaceFilter workspaces={teamWorkspaces} selectedId={wsFilter} />
      </div>

      {/* Runners */}
      <section className="mb-6">
        <h2 className="section-label mb-3">Runners</h2>
        <div className="card">
          {runners.length === 0 ? (
            <div className="p-4 text-center">
              <p className="text-sm text-text-muted">No runners connected</p>
              <p className="text-xs text-text-muted mt-1">Runners appear here when they send heartbeats.</p>
            </div>
          ) : (
            <div className="divide-y divide-border-default">
              {runners.map((hb) => {
                const online = isRunnerOnline(hb.lastHeartbeatAt);
                return (
                  <div key={hb.id} className="flex items-center gap-3 px-4 py-3">
                    <span
                      className={`glow-dot ${online ? 'glow-dot-success' : ''}`}
                      style={!online ? { background: 'var(--text-muted)' } : undefined}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm text-text-primary truncate">
                          {hb.accountName || 'Runner'}
                        </p>
                        <span className={`text-[10px] font-mono ${online ? 'text-status-success' : 'text-text-muted'}`}>
                          {online ? 'online' : 'stale'}
                        </span>
                      </div>
                      <p className="text-xs text-text-muted">
                        {hb.activeWorkerCount}/{hb.maxConcurrentWorkers} workers · last beat {timeAgo(hb.lastHeartbeatAt)}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Usage (30d) */}
      {usageStats && usageStats.total > 0 && (
        <section className="mb-6">
          <h2 className="section-label mb-3">Usage (30d)</h2>
          <div className="card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-secondary">{usageStats.total} tasks</span>
              <div className="flex items-center gap-3 text-xs">
                <span className="text-status-success">{usageStats.completed} done</span>
                {usageStats.failed > 0 && (
                  <span className="text-status-error">{usageStats.failed} failed</span>
                )}
              </div>
            </div>
            {usageStats.byRole.length > 0 && (
              <div className="space-y-2 pt-1">
                {usageStats.byRole.map((r) => (
                  <div key={r.slug} className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: r.color }} />
                    <span className="text-xs text-text-primary flex-1 truncate">{r.name}</span>
                    <span className="text-xs text-text-muted tabular-nums">
                      {r.completed} done{r.failed > 0 ? ` / ${r.failed} failed` : ''}
                    </span>
                  </div>
                ))}
                {usageStats.unassigned > 0 && (
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full shrink-0 bg-text-muted" />
                    <span className="text-xs text-text-muted flex-1">No role</span>
                    <span className="text-xs text-text-muted tabular-nums">{usageStats.unassigned}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {/* Watched Projects */}
      <section>
        <h2 className="section-label mb-3">Watched Projects</h2>

        {!hasGlobalVercelToken && vercelTokens.length === 0 && initialRows.some((r) => r.vercelProjectId) && (
          <div className="mb-4 rounded-lg border border-status-warning/30 bg-status-warning/10 p-3 text-sm">
            <div className="font-medium text-status-warning">No Vercel token configured</div>
            <p className="text-text-secondary mt-1">
              Some watched projects have a Vercel project ID set but no API token. Add one in the edit drawer of any row — it gets stored encrypted at the team level and reused across rows.
            </p>
          </div>
        )}

        {initialRows.length === 0 ? (
          <div className="border border-dashed rounded-xl p-8 text-center text-text-tertiary">
            <p className="mb-3">No watched projects yet.</p>
            <button
              onClick={startCreate}
              className="inline-flex items-center px-4 h-11 rounded-lg bg-status-info text-white font-medium"
            >
              Add a project
            </button>
          </div>
        ) : (
          <ul className="space-y-3">
            {initialRows.map((row) => (
              <li
                key={row.id}
                className="rounded-xl border bg-surface-elevated p-4 active:bg-surface-pressed"
              >
                <button onClick={() => startEdit(row)} className="w-full text-left">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold truncate">{row.repo}</div>
                      <div className="text-xs text-text-tertiary mt-0.5">{row.workspaceName}</div>
                    </div>
                    <span className={`text-[11px] px-2 py-0.5 rounded-full ${row.enabled ? 'bg-status-success/10 text-status-success' : 'bg-text-tertiary/10 text-text-tertiary'}`}>
                      {row.enabled ? 'enabled' : 'disabled'}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-3 text-xs text-text-secondary">
                    <div>Last check: {timeAgo(row.lastCheckedAt)}</div>
                    <div>Vercel: {row.vercelProjectId ? '✓' : '—'}</div>
                    <div>In-flight: {row.inFlightWindowMin}m</div>
                    <div>Prod grace: {row.prodGraceMin}m</div>
                  </div>
                  {row.lastError && (
                    <div className="mt-2 text-xs text-status-error truncate">⚠ {row.lastError}</div>
                  )}
                  {vercelMissing(row) && (
                    <div className="mt-2 text-xs text-status-warning">
                      ⚠ Vercel project set but no token — prod-deploy check is disabled. Tap Edit to add one.
                    </div>
                  )}
                  {row.recentEvents.length > 0 && (
                    <div className="mt-2 text-xs text-text-tertiary">
                      {row.recentEvents.length} recent firing(s) — latest {timeAgo(row.recentEvents[0].firedAt)}
                    </div>
                  )}
                </button>
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => runNow(row)}
                    disabled={busy}
                    className="flex-1 h-11 rounded-lg bg-surface text-text-primary border text-sm font-medium disabled:opacity-50"
                  >
                    Run now
                  </button>
                  <button
                    onClick={() => startEdit(row)}
                    className="flex-1 h-11 rounded-lg bg-status-info text-white text-sm font-medium"
                  >
                    Edit
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {initialRows.length > 0 && (
        <div className="fixed left-0 right-0 bottom-0 p-4 bg-surface/95 backdrop-blur border-t">
          <button
            onClick={startCreate}
            className="w-full h-12 rounded-lg bg-status-info text-white font-medium"
          >
            Add a project
          </button>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40" onClick={close}>
          <div
            className="w-full sm:max-w-lg sm:rounded-xl rounded-t-2xl bg-surface-elevated max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-surface-elevated border-b px-4 py-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold">
                {editing.mode === 'create' ? 'Add watched project' : 'Edit watched project'}
              </h2>
              <button onClick={close} className="text-text-tertiary text-sm">Cancel</button>
            </div>
            <div className="px-4 py-4 space-y-4">
              {editing.mode === 'create' && (
                <Field label="Workspace">
                  <select
                    value={form.workspaceId}
                    onChange={(e) => setForm({ ...form, workspaceId: e.target.value })}
                    className="w-full h-11 px-3 rounded-lg border bg-surface"
                  >
                    {workspaces.map((w) => (
                      <option key={w.id} value={w.id}>{w.name}</option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="Repo (owner/name)">
                <input
                  value={form.repo}
                  onChange={(e) => setForm({ ...form, repo: e.target.value })}
                  placeholder="buildd-ai/buildd"
                  inputMode="text"
                  autoCapitalize="off"
                  className="w-full h-11 px-3 rounded-lg border bg-surface"
                />
              </Field>
              <div className="rounded-lg border p-3 space-y-3">
                <div className="text-sm font-medium">Vercel (optional — for prod-deploy alerts)</div>
                <Field label="Project ID">
                  <input
                    value={form.vercelProjectId}
                    onChange={(e) => setForm({ ...form, vercelProjectId: e.target.value })}
                    placeholder="prj_…"
                    className="w-full h-11 px-3 rounded-lg border bg-surface"
                  />
                </Field>
                {form.vercelProjectId && (
                  <Field label="API token">
                    <select
                      value={form.vercelTokenSecretId ?? ''}
                      onChange={(e) => setForm({ ...form, vercelTokenSecretId: e.target.value || null })}
                      className="w-full h-11 px-3 rounded-lg border bg-surface"
                    >
                      <option value="">
                        {hasGlobalVercelToken ? 'Use global VERCEL_API_TOKEN' : 'None — prod check disabled'}
                      </option>
                      {teamTokens.map((t: VercelTokenOption) => (
                        <option key={t.id} value={t.id}>{t.label || t.id}</option>
                      ))}
                    </select>
                  </Field>
                )}
                {form.vercelProjectId && !form.vercelTokenSecretId && (
                  <details className="rounded-lg border border-dashed p-3">
                    <summary className="cursor-pointer text-sm font-medium">+ Add a new Vercel token</summary>
                    <div className="mt-3 space-y-2">
                      <p className="text-xs text-text-tertiary">
                        Generate one at <a href="https://vercel.com/account/tokens" target="_blank" rel="noreferrer" className="underline">vercel.com/account/tokens</a> with read access to your project. Stored encrypted at the team level.
                      </p>
                      <input
                        value={newTokenLabel}
                        onChange={(e) => setNewTokenLabel(e.target.value)}
                        placeholder="Label (e.g. 'Personal — read deployments')"
                        className="w-full h-11 px-3 rounded-lg border bg-surface"
                      />
                      <input
                        value={newToken}
                        onChange={(e) => setNewToken(e.target.value)}
                        type="password"
                        placeholder="Paste token here"
                        className="w-full h-11 px-3 rounded-lg border bg-surface"
                      />
                      <button
                        type="button"
                        onClick={addVercelToken}
                        disabled={busy || !newToken.trim()}
                        className="h-11 px-4 rounded-lg bg-status-info text-white text-sm font-medium disabled:opacity-50"
                      >
                        Store token
                      </button>
                    </div>
                  </details>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="In-flight window (min)">
                  <input
                    type="number"
                    min={1}
                    value={form.inFlightWindowMin}
                    onChange={(e) => setForm({ ...form, inFlightWindowMin: Number(e.target.value) })}
                    className="w-full h-11 px-3 rounded-lg border bg-surface"
                  />
                </Field>
                <Field label="Prod grace (min)">
                  <input
                    type="number"
                    min={1}
                    value={form.prodGraceMin}
                    onChange={(e) => setForm({ ...form, prodGraceMin: Number(e.target.value) })}
                    className="w-full h-11 px-3 rounded-lg border bg-surface"
                  />
                </Field>
              </div>
              <Field label="Release PR filter">
                <div className="grid grid-cols-3 gap-2">
                  <input
                    value={form.baseRef}
                    onChange={(e) => setForm({ ...form, baseRef: e.target.value })}
                    placeholder="base"
                    className="h-11 px-3 rounded-lg border bg-surface"
                  />
                  <input
                    value={form.labelFilter}
                    onChange={(e) => setForm({ ...form, labelFilter: e.target.value })}
                    placeholder="label"
                    className="h-11 px-3 rounded-lg border bg-surface"
                  />
                  <input
                    value={form.titlePrefix}
                    onChange={(e) => setForm({ ...form, titlePrefix: e.target.value })}
                    placeholder="title prefix"
                    className="h-11 px-3 rounded-lg border bg-surface"
                  />
                </div>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Role slug (auto-seeded)">
                  <input
                    value={form.roleSlug}
                    onChange={(e) => setForm({ ...form, roleSlug: e.target.value })}
                    placeholder="ops"
                    className="w-full h-11 px-3 rounded-lg border bg-surface"
                  />
                </Field>
                <Field label="Pushover app">
                  <select
                    value={form.pushoverApp}
                    onChange={(e) => setForm({ ...form, pushoverApp: e.target.value as 'tasks' | 'alerts' })}
                    className="w-full h-11 px-3 rounded-lg border bg-surface"
                  >
                    <option value="alerts">alerts</option>
                    <option value="tasks">tasks</option>
                  </select>
                </Field>
              </div>
              <Field label="Notes">
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-2 rounded-lg border bg-surface"
                />
              </Field>
              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                  className="w-5 h-5"
                />
                <span>Enabled</span>
              </label>

              {error && <div className="text-sm text-status-error">{error}</div>}
            </div>
            <div className="sticky bottom-0 bg-surface-elevated border-t px-4 py-3 flex gap-2">
              {editing.mode === 'edit' && editing.row && (
                <button
                  onClick={() => editing.row && deleteRow(editing.row)}
                  disabled={busy}
                  className="h-11 px-4 rounded-lg border text-status-error font-medium"
                >
                  Delete
                </button>
              )}
              <button
                onClick={submit}
                disabled={busy}
                className="flex-1 h-11 rounded-lg bg-status-info text-white font-medium disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-text-secondary mb-1">{label}</span>
      {children}
    </label>
  );
}
