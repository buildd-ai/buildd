'use client';

import { useCallback, useEffect, useState } from 'react';
import ConnectionRow, { StatusChip } from '../_components/ConnectionRow';

type RoutingBackend = 'claude' | 'codex';
const ALL_BACKENDS: RoutingBackend[] = ['claude', 'codex'];
const backendLabel = (b: RoutingBackend) => (b === 'claude' ? 'Claude' : 'Codex');

/**
 * Team-level enable/disable for each agent backend (`teams.enabledBackends`).
 * A reversible mask applied at dispatch: disabling one reroutes its jobs to
 * the other without touching per-workspace, role or mission settings.
 * Settings › Models draws it under Used for when the team can run both.
 */
export default function ProviderRoutingToggle({
  teamId,
  workspaceId,
  open,
  onToggle,
  readOnly = false,
}: {
  teamId: string;
  /** Any workspace in the team: `/backends` reports which backends can run there. */
  workspaceId: string;
  open: boolean;
  onToggle: () => void;
  /** Status only: changing routing is a team setting the person does not hold. */
  readOnly?: boolean;
}) {
  const [enabled, setEnabled] = useState<RoutingBackend[] | null>(null); // null = loading/all
  // Which backends can run, so a toggle never leaves only one that cannot.
  // Claude always can: a runner's own login covers it.
  const [configured, setConfigured] = useState<Record<RoutingBackend, boolean>>({ claude: true, codex: false });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!teamId) return;
    try {
      const [teamRes, backendRes] = await Promise.all([
        fetch(`/api/teams/${teamId}`),
        workspaceId ? fetch(`/api/workspaces/${workspaceId}/backends`) : null,
      ]);
      if (teamRes.ok) {
        const data = await teamRes.json();
        const eb = data.team?.enabledBackends as RoutingBackend[] | null | undefined;
        setEnabled(eb && eb.length ? eb : ALL_BACKENDS); // null/empty => all enabled
      }
      if (backendRes?.ok) {
        const data = await backendRes.json();
        const map: Record<string, boolean> = {};
        for (const b of (data.backends ?? []) as { id: string; available: boolean }[]) map[b.id] = b.available;
        setConfigured({ claude: map['claude'] ?? true, codex: map['codex'] ?? false });
      }
    } catch {
      /* non-fatal */
    } finally {
      setLoaded(true);
    }
  }, [teamId, workspaceId]);

  useEffect(() => { void load(); }, [load]);

  const isOn = (b: RoutingBackend) => !enabled || enabled.includes(b);

  async function toggle(b: RoutingBackend) {
    const current = enabled ?? ALL_BACKENDS;
    const next = current.includes(b) ? current.filter((x) => x !== b) : [...current, b];
    if (next.length === 0) {
      setMsg({ type: 'error', text: 'Keep one on.' });
      return;
    }
    // Refuse a set where nothing can run: every pending task would be stranded.
    if (!next.some((id) => configured[id])) {
      const names = next.map(backendLabel).join(' & ');
      setMsg({ type: 'error', text: `${names} can't run yet. Add a key or sign in a runner first.` });
      return;
    }
    const prev = enabled;
    setEnabled(next); // optimistic
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/teams/${teamId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledBackends: next }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Could not update. Try again.');
      const off = ALL_BACKENDS.filter((x) => !next.includes(x));
      setMsg({
        type: 'success',
        text: off.length
          ? `${off.map(backendLabel).join(' & ')} off. Jobs run on ${next.map(backendLabel).join(' & ')}.`
          : 'Both on.',
      });
    } catch (e) {
      setEnabled(prev); // rollback optimistic update
      setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Could not update. Try again.' });
    } finally {
      setBusy(false);
    }
  }

  const off = ALL_BACKENDS.filter((b) => !isOn(b));

  return (
    <ConnectionRow
      testId="routing-row"
      title="Provider routing"
      chip={!loaded ? undefined : off.length === 0
        ? <StatusChip tone="ok">Both on</StatusChip>
        : <StatusChip tone="warn">{off.map(backendLabel).join(' & ')} off</StatusChip>}
      meta="Turn one off to send its jobs to the other."
      open={open}
      onToggle={onToggle}
      readOnly={readOnly}
    >
      <div className="space-y-2">
        {ALL_BACKENDS.map((b) => (
          <div key={b} className="flex items-center justify-between inset-panel">
            <span className="flex flex-wrap items-center gap-2 text-sm text-text-primary">
              <span className={`w-2 h-2 shrink-0 ${isOn(b) ? 'bg-status-success' : 'bg-text-muted'}`} />
              {backendLabel(b)}
              <span className="text-xs text-text-muted">{isOn(b) ? 'On' : 'Off · jobs reroute'}</span>
            </span>
            <button
              onClick={() => toggle(b)}
              disabled={busy || !loaded}
              className="btn"
            >
              {isOn(b) ? 'Turn off' : 'Turn on'}
            </button>
          </div>
        ))}
      </div>
      {msg && (
        <div className={`text-sm ${msg.type === 'error' ? 'text-status-error' : 'text-status-success'}`}>{msg.text}</div>
      )}
    </ConnectionRow>
  );
}
