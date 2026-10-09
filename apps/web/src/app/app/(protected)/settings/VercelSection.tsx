'use client';

import { useEffect, useState } from 'react';
import Section from '@/components/ui/Section';
import Notice from '@/components/ui/Notice';
import { useConfirm } from '@/components/useConfirm';
import { Select } from '@/components/ui/Select';

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
  /**
   * Teams where the person may store or delete a token
   * (`manage_team_credentials`). Another team's tokens are listed read-only.
   * Omitted = every team.
   */
  manageableTeamIds?: string[];
}

export default function VercelSection({ teams, manageableTeamIds }: Props) {
  const { confirm, confirmDialog } = useConfirm();
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
    if (!(await confirm({ title: 'Delete Vercel token?', message: 'Any watched project relying on it will need a replacement.', confirmLabel: 'Delete', variant: 'danger' }))) return;
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

  const canManage = !manageableTeamIds || manageableTeamIds.includes(selectedTeamId);

  return (
    <Section
      title="Vercel"
      action={!canManage ? <span data-testid="vercel-read-only" className="text-xs text-text-muted">Admins can change this.</span> : undefined}
    >
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">
          Create a token at{' '}
          <a href="https://vercel.com/account/tokens" target="_blank" rel="noreferrer" className="underline">
            vercel.com/account/tokens
          </a>{' '}
          for prod health alerts.
        </p>

        {justAdded && (
          <Notice tone="ok" title="Token ready" action={{ label: 'Go to Health', href: '/app/health' }}>
            <p className="text-sm text-text-secondary">
              Attach it to a watched project in Health: set the Vercel project ID and pick this token.
            </p>
            <button onClick={() => setJustAdded(false)} className="btn btn-sm btn-quiet mt-1 !px-0">Dismiss</button>
          </Notice>
        )}

        {teams.length > 1 && (
          <label className="block">
            <span className="field-label">Team</span>
            <Select
              aria-label="Team"
              value={selectedTeamId}
              onChange={setSelectedTeamId}
              options={teams.map((t) => ({ value: t.id, label: t.name }))}
            />
          </label>
        )}

        {loading ? (
          <p className="text-sm text-text-muted">Loading…</p>
        ) : tokens.length === 0 ? (
          <p className="text-sm text-text-muted">No tokens.</p>
        ) : (
          <ul className="divide-y divide-border-default">
            {tokens.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-text-primary truncate">{t.label || 'Vercel API token'}</div>
                  <div className="text-xs text-text-secondary">Added {new Date(t.createdAt).toLocaleDateString()}</div>
                </div>
                {canManage && (
                  <button
                    onClick={() => deleteToken(t.id)}
                    disabled={busy}
                    className="btn btn-sm btn-danger"
                  >
                    Delete
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {!canManage ? null : tokens.length > 0 && !addOpen ? (
          <button onClick={() => setAddOpen(true)} className="btn btn-sm">
            Add another token
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
              aria-label="Token label"
              placeholder="Label (e.g. 'Personal · read deployments')"
              className="w-full h-10 px-3 bg-surface text-sm"
            />
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              type="password"
              aria-label="Vercel API token"
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
            <p className="text-xs text-text-muted">Encrypted, team-wide, never sent to runners.</p>
          </div>
        )}

        {message && (
          <p role={message.type === 'error' ? 'alert' : 'status'} className={`text-sm ${message.type === 'error' ? 'text-status-error' : 'text-status-success'}`}>
            {message.text}
          </p>
        )}
      </div>
      {confirmDialog}
    </Section>
  );
}
