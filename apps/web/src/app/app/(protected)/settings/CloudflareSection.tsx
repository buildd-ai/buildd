'use client';

import { useEffect, useState } from 'react';
import SettingsSection from './SettingsSection';
import { useConfirm } from '@/components/useConfirm';
import { Select } from '@/components/ui/Select';

interface Team {
  id: string;
  name: string;
}

/** Masked metadata from GET /api/cloudflare/credential. Never the token. */
interface CloudflareCredentialView {
  id: string;
  accountId: string | null;
  aiGatewayId: string | null;
  tokenHint: string | null;
  readable: boolean;
  healthStatus: 'healthy' | 'degraded' | 'revoked' | 'unknown';
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
  createdAt: string;
}

interface Props {
  teams: Team[];
}

/**
 * Settings → Runners → Cloudflare. The team's Cloudflare API token for the
 * cloud runner (apps/cloud-runner): set, verify, delete. Stored as one
 * team-wide `cloudflare_token` secret (encrypted JSON). The browser sends the
 * token once and only ever gets masked metadata back.
 */
export default function CloudflareSection({ teams }: Props) {
  const { confirm, confirmDialog } = useConfirm();
  const [selectedTeamId, setSelectedTeamId] = useState<string>(teams[0]?.id || '');
  const [cred, setCred] = useState<CloudflareCredentialView | null>(null);
  const [loading, setLoading] = useState(false);
  const [apiToken, setApiToken] = useState('');
  const [accountId, setAccountId] = useState('');
  const [aiGatewayId, setAiGatewayId] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!selectedTeamId) return;
    setReplacing(false);
    void load(selectedTeamId);
  }, [selectedTeamId]);

  async function load(teamId: string) {
    setLoading(true);
    try {
      const res = await fetch(`/api/cloudflare/credential?teamId=${teamId}`);
      if (res.ok) {
        const data = await res.json();
        setCred(data.credential ?? null);
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to load the Cloudflare token' });
    } finally {
      setLoading(false);
    }
  }

  function resetForm() {
    setApiToken('');
    setAccountId('');
    setAiGatewayId('');
  }

  async function verify(id: string, quiet = false) {
    setBusy(true);
    if (!quiet) setMessage(null);
    try {
      const res = await fetch(`/api/secrets/${id}/verify`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Verify failed');
      setMessage(data.verified
        ? { type: 'success', text: `Verified: ${data.tokenKind === 'account' ? 'account' : 'user'} token, active.` }
        : { type: 'error', text: `Cloudflare rejected the token: ${data.error ?? 'unknown error'}` });
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Verify failed' });
    } finally {
      setBusy(false);
      await load(selectedTeamId);
    }
  }

  async function save() {
    if (!apiToken.trim() || !accountId.trim()) {
      setMessage({ type: 'error', text: 'Paste the API token and the account ID' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const value = JSON.stringify({
        apiToken: apiToken.trim(),
        accountId: accountId.trim(),
        ...(aiGatewayId.trim() ? { aiGatewayId: aiGatewayId.trim() } : {}),
      });
      const res = await fetch('/api/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value, purpose: 'cloudflare_token', label: 'Cloudflare API token', teamId: selectedTeamId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to store token');
      resetForm();
      setReplacing(false);
      setBusy(false);
      // Check it straight away so a typo shows up now, not at deploy time.
      await verify(data.id, true);
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed' });
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!(await confirm({
      title: 'Delete the Cloudflare token?',
      message: 'A deployed cloud runner keeps running. Redeploying it will need a new token.',
      confirmLabel: 'Delete',
      variant: 'danger',
    }))) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/secrets?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Delete failed');
      await load(selectedTeamId);
      setMessage({ type: 'success', text: 'Deleted.' });
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setBusy(false);
    }
  }

  if (teams.length === 0) return null;

  const showForm = !cred || replacing;

  return (
    <SettingsSection title="Cloudflare">
      <p className="text-sm text-text-secondary">
        Run tasks in Cloudflare containers, one per task, instead of on your own machines.
      </p>

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

      {loading && !cred ? (
        <div className="text-sm text-text-tertiary">Loading…</div>
      ) : cred ? (
        <div className="inset-panel space-y-2" data-testid="cloudflare-credential">
          <div className="flex flex-wrap items-center gap-2">
            {cred.healthStatus === 'healthy' ? (
              <span className="status-pill status-pill-ok">Verified</span>
            ) : cred.healthStatus === 'revoked' ? (
              <span className="status-pill status-pill-err">Rejected by Cloudflare</span>
            ) : cred.healthStatus === 'degraded' ? (
              <span className="status-pill status-pill-warn">Degraded</span>
            ) : (
              <span className="status-pill status-pill-idle">Not verified yet</span>
            )}
            {!cred.readable && <span className="status-pill status-pill-err">Unreadable, replace it</span>}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs font-mono">
            <dt className="text-text-tertiary">Account</dt>
            <dd className="text-text-primary truncate">{cred.accountId ?? '?'}</dd>
            <dt className="text-text-tertiary">Token</dt>
            <dd className="text-text-primary">{cred.tokenHint ?? '?'}</dd>
            <dt className="text-text-tertiary">AI Gateway</dt>
            <dd className="text-text-primary truncate">{cred.aiGatewayId ?? 'none'}</dd>
            <dt className="text-text-tertiary">Checked</dt>
            <dd className="text-text-primary">
              {cred.lastVerifiedAt ? new Date(cred.lastVerifiedAt).toLocaleString() : 'never'}
            </dd>
          </dl>
          {cred.lastVerificationError && cred.healthStatus !== 'healthy' && (
            <p className="text-xs text-status-error break-words">{cred.lastVerificationError}</p>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button onClick={() => verify(cred.id)} disabled={busy} className="btn btn-primary">
              {busy ? 'Working…' : 'Verify'}
            </button>
            {!replacing && (
              <button onClick={() => setReplacing(true)} disabled={busy} className="btn btn-quiet">
                Replace
              </button>
            )}
            <button onClick={() => remove(cred.id)} disabled={busy} className="btn btn-danger">
              Delete
            </button>
          </div>
        </div>
      ) : null}

      {showForm && (
        <div className="space-y-2 border-t border-border-default pt-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-text-primary">{cred ? 'Replace the token' : 'Add a token'}</div>
            {cred && (
              <button onClick={() => { setReplacing(false); resetForm(); }} className="btn btn-quiet">
                Cancel
              </button>
            )}
          </div>
          <p className="text-xs text-text-muted">
            Create one at{' '}
            <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer" className="underline">
              dash.cloudflare.com/profile/api-tokens
            </a>{' '}
            with Workers Scripts, Containers and Durable Objects edit access (plus AI Gateway if you use one).
          </p>
          <input
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
            type="password"
            autoComplete="off"
            aria-label="Cloudflare API token"
            placeholder="API token"
            className="w-full h-10 px-3 bg-surface text-sm"
          />
          <input
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            autoComplete="off"
            aria-label="Cloudflare account ID"
            placeholder="Account ID"
            className="w-full h-10 px-3 bg-surface text-sm font-mono"
          />
          <input
            value={aiGatewayId}
            onChange={(e) => setAiGatewayId(e.target.value)}
            autoComplete="off"
            aria-label="AI Gateway ID"
            placeholder="AI Gateway ID (optional)"
            className="w-full h-10 px-3 bg-surface text-sm font-mono"
          />
          <button onClick={save} disabled={busy || !apiToken.trim() || !accountId.trim()} className="btn btn-primary">
            Store and verify
          </button>
          <p className="text-xs text-text-muted">
            Stored encrypted for the whole team. Only owners and admins can change it. Never sent to runners.
          </p>
        </div>
      )}

      {message && (
        <div className={`text-sm ${message.type === 'error' ? 'text-status-error' : 'text-status-success'}`}>
          {message.text}
        </div>
      )}
      {confirmDialog}
    </SettingsSection>
  );
}
