'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { WatchedProjectRow, WorkspaceOption } from './page';

interface Props {
  initialRows: WatchedProjectRow[];
  workspaces: WorkspaceOption[];
}

interface FormState {
  workspaceId: string;
  repo: string;
  vercelProjectId: string;
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

export function HealthClient({ initialRows, workspaces }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [editing, setEditing] = useState<{ mode: 'create' | 'edit'; row?: WatchedProjectRow } | null>(null);
  const [form, setForm] = useState<FormState>(blankForm(workspaces[0]?.id ?? ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">Project Health</h1>
          <p className="text-sm text-text-tertiary">Watcher fires a task + Pushover when CI breaks on release PRs or prod deploys go bad.</p>
        </div>
      </div>

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
              <Field label="Vercel project ID (optional — enables prod-deploy check)">
                <input
                  value={form.vercelProjectId}
                  onChange={(e) => setForm({ ...form, vercelProjectId: e.target.value })}
                  placeholder="prj_…"
                  className="w-full h-11 px-3 rounded-lg border bg-surface"
                />
              </Field>
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
