'use client';

import { useCallback, useEffect, useState } from 'react';
import SettingsSection from './SettingsSection';

interface Workspace {
  id: string;
  name: string;
}

interface Props {
  workspaces: Workspace[];
}

interface GitFeaturesState {
  enforceGreenCI: boolean | null; // null = loading
}

export default function WorkspaceGitFeaturesSection({ workspaces }: Props) {
  const [selectedId, setSelectedId] = useState<string>(workspaces[0]?.id ?? '');
  const [state, setState] = useState<GitFeaturesState>({ enforceGreenCI: null });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!selectedId) return;
    setState({ enforceGreenCI: null });
    setMsg(null);
    try {
      const res = await fetch(`/api/workspaces/${selectedId}/config`);
      if (res.ok) {
        const data = await res.json();
        setState({ enforceGreenCI: data.gitConfig?.enforceGreenCI ?? false });
      }
    } catch {
      setState({ enforceGreenCI: false });
    }
  }, [selectedId]);

  useEffect(() => { void load(); }, [load]);

  async function toggle(value: boolean) {
    if (saving) return;
    const prev = state.enforceGreenCI;
    setState({ enforceGreenCI: value }); // optimistic
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/workspaces/${selectedId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gitConfig: { enforceGreenCI: value } }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Failed to save');
      }
      setMsg({
        type: 'success',
        text: value
          ? 'Green CI enforced — PR tasks will loop until checks pass.'
          : 'Green CI enforcement disabled.',
      });
    } catch (e) {
      setState({ enforceGreenCI: prev }); // rollback
      setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Failed to save' });
    } finally {
      setSaving(false);
    }
  }

  if (workspaces.length === 0) return null;

  const loading = state.enforceGreenCI === null;

  return (
    <SettingsSection title="Workspace CI policy">
        <p className="text-sm text-text-secondary">
          Per-workspace settings that govern how tasks interact with CI.
        </p>

        {workspaces.length > 1 && (
          <div>
            <label className="field-label">Workspace</label>
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              className="h-9 px-3 bg-surface text-sm text-text-primary"
            >
              {workspaces.map((ws) => (
                <option key={ws.id} value={ws.id}>{ws.name}</option>
              ))}
            </select>
          </div>
        )}

        <div className="flex items-start justify-between gap-4 inset-panel">
          <div className="space-y-0.5">
            <div className="text-sm font-medium text-text-primary">Require green CI before task completion</div>
            <div className="text-xs text-text-secondary">
              Tasks with <code className="bg-surface-3 px-1 rounded text-[11px]">pr_required</code> output that don&apos;t
              already have a loop config will automatically loop until PR checks pass (max 3 retries).
            </div>
          </div>
          <button
            onClick={() => !loading && toggle(!state.enforceGreenCI)}
            disabled={loading || saving}
            className={`shrink-0 relative inline-flex h-6 w-11 items-center border-2 transition-colors focus:outline-none disabled:opacity-50 ${
              state.enforceGreenCI ? 'bg-accent border-accent' : 'bg-surface-3 border-border-default'
            }`}
            role="switch"
            aria-checked={state.enforceGreenCI ?? false}
          >
            <span
              className={`inline-block h-3.5 w-3.5 transform transition-transform ${
                state.enforceGreenCI ? 'translate-x-5 bg-white' : 'translate-x-1 bg-text-muted'
              }`}
            />
          </button>
        </div>

        {msg && (
          <div className={`text-sm ${msg.type === 'error' ? 'text-status-error' : 'text-status-success'}`}>
            {msg.text}
          </div>
        )}
    </SettingsSection>
  );
}
