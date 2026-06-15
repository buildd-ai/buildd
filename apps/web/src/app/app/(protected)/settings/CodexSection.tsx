'use client';

import { useEffect, useState } from 'react';

interface CodexStatus {
  connected: boolean;
  expired: boolean;
  accountId: string | null;
  lastRefreshedAt: string | null;
}

interface Workspace {
  id: string;
  name: string;
}

interface Props {
  workspaces: Workspace[];
}

export default function CodexSection({ workspaces }: Props) {
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(workspaces[0]?.id || '');
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteValue, setPasteValue] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    void load(selectedWorkspaceId);
  }, [selectedWorkspaceId]);

  async function load(workspaceId: string) {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/codex-credential`);
      if (res.ok) {
        setStatus(await res.json());
      } else {
        setStatus(null);
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to load Codex status' });
    } finally {
      setLoading(false);
    }
  }

  function validateAuthJson(raw: string): string | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return 'Must be valid JSON';
    }
    const auth = parsed as Record<string, unknown>;
    if (
      typeof auth.access_token !== 'string' ||
      typeof auth.refresh_token !== 'string' ||
      typeof auth.account_id !== 'string'
    ) {
      return 'JSON must contain access_token, refresh_token, and account_id fields';
    }
    return null;
  }

  async function connect() {
    const err = validateAuthJson(pasteValue);
    if (err) {
      setPasteError(err);
      return;
    }
    setBusy(true);
    setPasteError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/workspaces/${selectedWorkspaceId}/codex-credential`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authJson: pasteValue }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to connect');
      setStatus(data);
      setPasteValue('');
      setPasteOpen(false);
      setMessage({ type: 'success', text: 'Codex credential connected.' });
    } catch (e) {
      setPasteError(e instanceof Error ? e.message : 'Failed to connect');
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!confirm('Remove this Codex credential? The workspace will lose access to Codex.')) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/workspaces/${selectedWorkspaceId}/codex-credential`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) throw new Error('Delete failed');
      setStatus({ connected: false, expired: false, accountId: null, lastRefreshedAt: null });
      setMessage({ type: 'success', text: 'Credential removed.' });
    } catch {
      setMessage({ type: 'error', text: 'Failed to remove credential' });
    } finally {
      setBusy(false);
    }
  }

  if (workspaces.length === 0) return null;

  return (
    <section>
      <div className="flex justify-between items-center mb-3">
        <h2 className="section-label">Codex</h2>
      </div>
      <div className="card p-4 space-y-4">
        <p className="text-sm text-text-secondary">
          Connect your OpenAI Codex account so runners can use Codex as an agent backend. Paste the contents of{' '}
          <code className="text-xs bg-surface-3 px-1 py-0.5 rounded">~/.codex/auth.json</code> from a machine where you&apos;ve authenticated with Codex.
        </p>

        {workspaces.length > 1 && (
          <label className="block">
            <span className="block text-xs font-medium text-text-secondary mb-1">Workspace</span>
            <select
              value={selectedWorkspaceId}
              onChange={(e) => {
                setSelectedWorkspaceId(e.target.value);
                setPasteOpen(false);
                setPasteValue('');
                setPasteError(null);
                setMessage(null);
              }}
              className="w-full h-11 px-3 rounded-lg border bg-surface"
            >
              {workspaces.map((ws) => (
                <option key={ws.id} value={ws.id}>{ws.name}</option>
              ))}
            </select>
          </label>
        )}

        {loading ? (
          <div className="text-sm text-text-tertiary">Loading…</div>
        ) : status?.connected ? (
          <div className="space-y-3">
            {/* Status badge row */}
            <div className="flex items-center gap-3">
              {status.expired ? (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-status-warning/10 text-status-warning border border-status-warning/30">
                  <span className="w-1.5 h-1.5 rounded-full bg-status-warning" />
                  Expired — token needs refresh
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-status-success/10 text-status-success border border-status-success/30">
                  <span className="w-1.5 h-1.5 rounded-full bg-status-success" />
                  Connected
                </span>
              )}
            </div>

            {/* Credential details */}
            <div className="bg-surface-3/50 rounded-lg p-3 space-y-1 text-xs text-text-secondary">
              {status.accountId && (
                <div>Account: <span className="font-mono text-text-primary">{status.accountId}</span></div>
              )}
              {status.lastRefreshedAt && (
                <div>Last refreshed: {new Date(status.lastRefreshedAt).toLocaleString()}</div>
              )}
            </div>

            {status.expired && (
              <div className="rounded-lg border border-status-warning/30 bg-status-warning/10 p-3 text-sm text-text-secondary">
                Token has expired. Replace the credential below, or use the refresh endpoint once available.
              </div>
            )}

            {/* Action buttons */}
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={revoke}
                disabled={busy}
                className="text-sm text-status-error font-medium disabled:opacity-50"
              >
                Revoke
              </button>
              {!pasteOpen && (
                <button
                  onClick={() => { setPasteOpen(true); setPasteValue(''); setPasteError(null); }}
                  className="text-sm font-medium text-status-info"
                >
                  Replace credential
                </button>
              )}
            </div>

            {pasteOpen && <PasteForm value={pasteValue} onChange={setPasteValue} error={pasteError} busy={busy} onConnect={connect} onCancel={() => { setPasteOpen(false); setPasteValue(''); setPasteError(null); }} />}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-1.5">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-surface-3 text-text-muted border border-border-default">
                <span className="w-1.5 h-1.5 rounded-full bg-text-muted" />
                Not connected
              </span>
            </div>
            <PasteForm value={pasteValue} onChange={setPasteValue} error={pasteError} busy={busy} onConnect={connect} />
          </div>
        )}

        {message && (
          <div className={`text-sm ${message.type === 'error' ? 'text-status-error' : 'text-status-success'}`}>
            {message.text}
          </div>
        )}
      </div>
    </section>
  );
}

interface PasteFormProps {
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  busy: boolean;
  onConnect: () => void;
  onCancel?: () => void;
}

function PasteForm({ value, onChange, error, busy, onConnect, onCancel }: PasteFormProps) {
  return (
    <div className="space-y-2 border-t pt-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">Paste auth.json</div>
        {onCancel && (
          <button onClick={onCancel} className="text-xs text-text-tertiary">
            Cancel
          </button>
        )}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={'{\n  "access_token": "...",\n  "refresh_token": "...",\n  "account_id": "..."\n}'}
        rows={6}
        className="w-full px-3 py-2 rounded-lg border bg-surface font-mono text-xs resize-y"
      />
      {error && (
        <div className="text-sm text-status-error">{error}</div>
      )}
      <button
        onClick={onConnect}
        disabled={busy || !value.trim()}
        className="h-11 px-4 rounded-lg bg-status-info text-white text-sm font-medium disabled:opacity-50"
      >
        {busy ? 'Connecting…' : 'Connect'}
      </button>
    </div>
  );
}
