'use client';

import { useCallback, useEffect, useState } from 'react';
import ConfirmDialog from '@/components/ConfirmDialog';
import { Select } from '@/components/ui/Select';
import Notice from '@/components/ui/Notice';
import { roleHas } from '@/lib/permission-registry';

interface Team { id: string; name: string; role: string }
interface ConnectorShare { sharedWithTeamId: string; teamName?: string }

/**
 * Cross-team sharing for one team app (spec §1b, owner side): which teams use
 * this team's credential, share with another, or move ownership. Opened from
 * an app's details by a team admin; the routes refuse everyone else.
 */
export default function SharingDialog({ connector, onClose, onTransferred }: {
  connector: { id: string; name: string };
  onClose: () => void;
  /** Ownership moved: the app leaves this team's list. */
  onTransferred: (text: string) => void;
}) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [shares, setShares] = useState<ConnectorShare[]>([]);
  const [ownerTeamId, setOwnerTeamId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [shareTeamId, setShareTeamId] = useState('');
  const [saving, setSaving] = useState(false);
  const [revokingTeamId, setRevokingTeamId] = useState<string | null>(null);
  const [transferTeamId, setTransferTeamId] = useState('');
  const [confirmingTransfer, setConfirmingTransfer] = useState(false);
  const [transferLoading, setTransferLoading] = useState(false);

  const loadShares = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/connectors/${connector.id}/shares`);
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setShares(data.shares || []);
        setOwnerTeamId(data.ownerTeamId ?? null);
      } else {
        setError(data.message || "Couldn't load who it's shared with.");
      }
    } catch {
      setError("Couldn't load teams.");
    } finally {
      setLoading(false);
    }
  }, [connector.id]);

  useEffect(() => {
    void loadShares();
    void fetch('/api/teams').then(r => (r.ok ? r.json() : { teams: [] })).then((d: { teams?: { id: string; name: string; role?: string }[] }) => {
      setTeams((d.teams ?? []).map(t => ({ id: t.id, name: t.name, role: t.role ?? 'member' })));
    }).catch(() => {});
  }, [loadShares]);

  async function send(method: 'POST' | 'DELETE', teamId: string) {
    const res = await fetch(`/api/connectors/${connector.id}/shares`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ teamId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setError(err.message || (method === 'POST' ? "Couldn't share it." : "Couldn't stop sharing."));
      return false;
    }
    return true;
  }

  async function share() {
    if (!shareTeamId) return;
    setSaving(true);
    setError(null);
    try {
      if (await send('POST', shareTeamId)) { setShareTeamId(''); await loadShares(); }
    } finally { setSaving(false); }
  }

  async function revoke(teamId: string) {
    setRevokingTeamId(teamId);
    setError(null);
    try {
      if (await send('DELETE', teamId)) setShares(prev => prev.filter(s => s.sharedWithTeamId !== teamId));
    } finally { setRevokingTeamId(null); }
  }

  async function transfer() {
    setTransferLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/connectors/${connector.id}/transfer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ teamId: transferTeamId }),
      });
      if (res.ok) {
        onTransferred(`${connector.name} moved to ${teams.find(t => t.id === transferTeamId)?.name ?? 'the selected team'}.`);
        return;
      }
      const err = await res.json().catch(() => ({}));
      setError(err.message || "Couldn't move it.");
    } catch {
      setError("Couldn't move it.");
    } finally {
      setTransferLoading(false);
      setConfirmingTransfer(false);
    }
  }

  // Share with teams the person is on, minus the owner and teams already
  // granted; ownership moves only to a team they administer (spec §1b).
  const sharedIds = new Set(shares.map(s => s.sharedWithTeamId));
  const shareable = teams.filter(t => t.id !== ownerTeamId && !sharedIds.has(t.id));
  const transferable = teams.filter(t => t.id !== ownerTeamId && roleHas(t.role, 'manage_connectors'));

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        onClick={(e) => e.target === e.currentTarget && onClose()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div role="dialog" aria-modal="true" aria-labelledby="sharing-title" className="card w-full max-w-md p-6" data-testid="sharing-dialog">
          <h2 id="sharing-title" className="mb-1 text-title font-semibold text-text-primary">Share {connector.name}</h2>
          <p className="mb-4 text-meta text-text-muted">Other teams use your team&apos;s sign-in and choose their own workspaces.</p>

          {error && <Notice tone="err" className="mb-3">{error}</Notice>}

          <p className="mb-1 text-body font-medium text-text-primary">Shared with</p>
          {loading ? (
            <p className="mb-4 text-body text-text-muted">Loading…</p>
          ) : shares.length === 0 ? (
            <p className="mb-4 text-body text-text-muted">No other teams.</p>
          ) : (
            <ul className="mb-4 divide-y divide-border-default border-y border-border-default">
              {shares.map(s => (
                <li key={s.sharedWithTeamId} className="flex min-h-11 items-center justify-between gap-3">
                  <span className="text-body text-text-primary">{s.teamName || 'A team'}</span>
                  <button type="button" className="btn btn-quiet btn-sm h-11 md:h-8" disabled={revokingTeamId === s.sharedWithTeamId} onClick={() => void revoke(s.sharedWithTeamId)}>
                    {revokingTeamId === s.sharedWithTeamId ? 'Stopping…' : 'Stop sharing'}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {shareable.length > 0 && (
            <div className="mb-5 flex gap-2">
              <Select aria-label="Share with team" value={shareTeamId} onChange={setShareTeamId} placeholder="Choose a team…" options={shareable.map(t => ({ value: t.id, label: t.name }))} className="flex-1" />
              <button type="button" onClick={() => void share()} disabled={saving || !shareTeamId} className="btn">{saving ? 'Sharing…' : 'Share'}</button>
            </div>
          )}

          {transferable.length > 0 && (
            <div className="border-t border-border-default pt-4">
              <p className="mb-1 text-body font-medium text-text-primary">Move to another team</p>
              <div className="flex gap-2">
                <Select aria-label="Move to team" value={transferTeamId} onChange={setTransferTeamId} placeholder="Choose a team…" options={transferable.map(t => ({ value: t.id, label: t.name }))} className="flex-1" />
                <button type="button" onClick={() => setConfirmingTransfer(true)} disabled={!transferTeamId || transferLoading} className="btn btn-danger">Move…</button>
              </div>
            </div>
          )}

          <div className="mt-5 flex justify-end">
            <button type="button" onClick={onClose} className="btn btn-quiet">Close</button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmingTransfer}
        title={`Move ${connector.name}?`}
        message={`${teams.find(t => t.id === transferTeamId)?.name ?? 'The selected team'} will own it and its sign-in. Existing shares stay. Your team keeps it only if they share it back.`}
        confirmLabel="Move"
        variant="danger"
        loading={transferLoading}
        onConfirm={transfer}
        onCancel={() => setConfirmingTransfer(false)}
      />
    </>
  );
}
