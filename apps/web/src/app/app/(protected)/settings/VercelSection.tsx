'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import SettingsSection from './SettingsSection';

interface Team {
  id: string;
  name: string;
}

interface VercelToken {
  id: string;
  teamId: string;
  label: string | null;
  createdAt: string;
}

interface Props {
  teams: Team[];
}

export default function VercelSection({ teams }: Props) {
  const [selectedTeamId, setSelectedTeamId] = useState<string>(teams[0]?.id || '');
  const [tokens, setTokens] = useState<VercelToken[]>([]);
  const [loading, setLoading] = useState(false);
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [justAdded, setJustAdded] = useState(false);

  useEffect(() => {
    if (!selectedTeamId) return;
    setJustAdded(false);
    void load(selectedTeamId);
  }, [selectedTeamId]);

  async function load(teamId: string) {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/secrets?teamId=${teamId}`);
      if (res.ok) {
        const data = await res.json();
        const filtered = (data.secrets || []).filter((s: { purpose: string }) => s.purpose === 'vercel_token');
        setTokens(filtered);
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to load tokens' });
    } finally {
      setLoading(false);
    }
  }

  async function addToken() {
    if (!value.trim()) {
      setMessage({ type: 'error', text: 'Paste a Vercel API token first' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          value: value.trim(),
          purpose: 'vercel_token',
          label: label.trim() || 'Vercel API token',
          teamId: selectedTeamId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to store token');
      setLabel('');
      setValue('');
      setAddOpen(false);
      setMessage(null);
      setJustAdded(true);
      await load(selectedTeamId);
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setBusy(false);
    }
  }

  async function deleteToken(id: string) {
    if (!confirm('Delete this Vercel token? Any watched project relying on it will need a replacement.')) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/secrets?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Delete failed');
      setJustAdded(false);
      await load(selectedTeamId);
      setMessage({ type: 'success', text: 'Deleted.' });
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setBusy(false);
    }
  }

  if (teams.length === 0) return null;

  return (
    <SettingsSection title="Vercel">
        <p className="text-sm text-text-secondary">
          Watcher uses these tokens to read your Vercel deployment status and alert when prod is unhealthy. Generate one at{' '}
          <a href="https://vercel.com/account/tokens" target="_blank" rel="noreferrer" className="underline">
            vercel.com/account/tokens
          </a>{' '}
          with read access. Stored encrypted at the team level — never sent to runners.
        </p>

        {justAdded && (
          <div className="notice notice-ok space-y-2">
            <div className="font-medium text-status-success">Token ready</div>
            <p className="text-sm text-text-secondary">
              Attach it to a watched project to start receiving prod-deploy alerts. Open the project at <strong>/app/health</strong>, set its Vercel project ID, and pick this token from the dropdown.
            </p>
            <div className="flex items-center gap-3">
              <Link
                href="/app/health"
                className="btn btn-primary"
              >
                Go to Health →
              </Link>
              <button onClick={() => setJustAdded(false)} className="btn btn-quiet">
                Dismiss
              </button>
            </div>
          </div>
        )}

        {teams.length > 1 && (
          <label className="block">
            <span className="field-label">Team</span>
            <select
              value={selectedTeamId}
              onChange={(e) => setSelectedTeamId(e.target.value)}
              className="w-full h-10 px-3 bg-surface text-sm"
            >
              {teams.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </label>
        )}

        {loading ? (
          <div className="text-sm text-text-tertiary">Loading…</div>
        ) : tokens.length === 0 ? (
          <div className="text-sm text-text-tertiary">No tokens stored yet.</div>
        ) : (
          <ul className="space-y-2">
            {tokens.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 inset-panel">
                <div className="min-w-0">
                  <div className="font-medium truncate">{t.label || 'Vercel API token'}</div>
                  <div className="text-xs text-text-tertiary">Added {new Date(t.createdAt).toLocaleDateString()}</div>
                </div>
                <button
                  onClick={() => deleteToken(t.id)}
                  disabled={busy}
                  className="btn btn-danger"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}

        {tokens.length > 0 && !addOpen ? (
          <button
            onClick={() => setAddOpen(true)}
            className="btn btn-quiet"
          >
            + Add another token
          </button>
        ) : (
          <div className="space-y-2 border-t border-border-default pt-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-text-primary">Add a token</div>
              {tokens.length > 0 && (
                <button onClick={() => { setAddOpen(false); setLabel(''); setValue(''); }} className="btn btn-quiet">
                  Cancel
                </button>
              )}
            </div>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Label (e.g. 'Personal — read deployments')"
              className="w-full h-10 px-3 bg-surface text-sm"
            />
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              type="password"
              placeholder="Paste token (sk_…)"
              className="w-full h-10 px-3 bg-surface text-sm"
            />
            <button
              onClick={addToken}
              disabled={busy || !value.trim()}
              className="btn btn-primary"
            >
              Store token
            </button>
          </div>
        )}

        {message && (
          <div className={`text-sm ${message.type === 'error' ? 'text-status-error' : 'text-status-success'}`}>
            {message.text}
          </div>
        )}
    </SettingsSection>
  );
}
