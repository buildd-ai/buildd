'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

interface Workspace {
  id: string;
  name: string;
  teamId: string;
}

interface Props {
  workspaces: Workspace[];
  currentTeamId: string | null;
  teams: { id: string; name: string }[];
}

type Scope = 'team' | 'workspace';

/**
 * Unified agent-backend credentials. Both Claude (setup token / API key) and
 * Codex (auth.json) are stored in the shared `secrets` table and scoped the same
 * way: team-wide (all workspaces) by default, or narrowed to one workspace.
 * See docs/credentials-architecture.md.
 */
export default function AgentBackendsSection({ workspaces, currentTeamId, teams }: Props) {
  // Inline team selector: set a credential for any of your teams without using
  // the global team switcher. Defaults to the cookie-based current team.
  const [activeTeamId, setActiveTeamId] = useState<string | null>(currentTeamId);

  // Only workspaces in the active team can share a team-wide credential.
  const teamWorkspaces = useMemo(
    () => (activeTeamId ? workspaces.filter((w) => w.teamId === activeTeamId) : workspaces),
    [workspaces, activeTeamId],
  );

  const [scope, setScope] = useState<Scope>('team');
  const [workspaceId, setWorkspaceId] = useState<string>(teamWorkspaces[0]?.id ?? '');

  // Keep the selected workspace valid when the active team changes.
  useEffect(() => {
    if (!teamWorkspaces.some((w) => w.id === workspaceId)) {
      setWorkspaceId(teamWorkspaces[0]?.id ?? '');
    }
  }, [teamWorkspaces, workspaceId]);

  // The Codex API is nested under a workspace; for team scope we still need a
  // workspace in the team to authorize + resolve the team id.
  const accessWorkspaceId = scope === 'workspace' ? workspaceId : teamWorkspaces[0]?.id ?? '';
  const teamId = activeTeamId ?? teamWorkspaces[0]?.teamId ?? '';

  return (
    <section>
      <div className="flex items-end justify-between mb-3 gap-3">
        <h2 className="section-label">Agent backends</h2>
      </div>

      <div className="card p-4 space-y-5">
        <p className="text-sm text-text-secondary">
          Credentials runners use to authenticate an agent backend. Set one credential for{' '}
          <strong className="text-text-primary">all workspaces</strong> in the team, or scope it to a single workspace.
        </p>

        {/* Inline team selector — overrides the cookie-based team for this card. */}
        {teams.length > 1 && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs font-medium text-text-secondary">Team</span>
            <select
              value={activeTeamId ?? ''}
              onChange={(e) => setActiveTeamId(e.target.value)}
              className="h-9 px-2 rounded-lg border border-border-default bg-surface text-sm"
            >
              {teams.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
        )}

        {teamWorkspaces.length === 0 ? (
          <p className="text-sm text-text-muted">This team has no workspaces yet.</p>
        ) : (
          <>
            {/* Shared scope selector */}
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs font-medium text-text-secondary">Applies to</span>
              <div className="inline-flex rounded-lg border border-border-default overflow-hidden">
                <button
                  onClick={() => setScope('team')}
                  className={`px-3 h-9 text-sm font-medium transition-colors ${scope === 'team' ? 'bg-surface-3 text-text-primary' : 'text-text-secondary'}`}
                >
                  All workspaces
                </button>
                <button
                  onClick={() => setScope('workspace')}
                  className={`px-3 h-9 text-sm font-medium border-l border-border-default transition-colors ${scope === 'workspace' ? 'bg-surface-3 text-text-primary' : 'text-text-secondary'}`}
                >
                  One workspace
                </button>
              </div>
              {scope === 'workspace' && (
                <select
                  value={workspaceId}
                  onChange={(e) => setWorkspaceId(e.target.value)}
                  className="h-9 px-2 rounded-lg border border-border-default bg-surface text-sm"
                >
                  {teamWorkspaces.map((ws) => (
                    <option key={ws.id} value={ws.id}>{ws.name}</option>
                  ))}
                </select>
              )}
            </div>

            <ClaudeCard teamId={teamId} scope={scope} workspaceId={scope === 'workspace' ? workspaceId : null} />
            <div className="border-t border-border-default" />
            <CodexCard accessWorkspaceId={accessWorkspaceId} scope={scope} />
          </>
        )}
      </div>
    </section>
  );
}

// ── Claude ─────────────────────────────────────────────────────────────────────

type ClaudePurpose = 'oauth_token' | 'anthropic_api_key';

interface SecretMeta {
  id: string;
  purpose: string;
  accountId: string | null;
  workspaceId: string | null;
  createdAt: string;
  updatedAt: string;
}

function ClaudeCard({ teamId, scope, workspaceId }: { teamId: string; scope: Scope; workspaceId: string | null }) {
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [purpose, setPurpose] = useState<ClaudePurpose>('oauth_token');
  const [value, setValue] = useState('');
  // Hide the token input behind "Replace credential" once one exists, mirroring
  // CodexCard's pasteOpen — so we don't invite a second un-revoked credential.
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!teamId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/secrets?teamId=${teamId}`);
      if (res.ok) {
        const data = await res.json();
        setSecrets((data.secrets ?? []) as SecretMeta[]);
      }
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    setReplaceOpen(false);
    setValue('');
    setMsg(null);
    void load();
  }, [load]);

  // Credentials matching the selected scope.
  const matching = secrets.filter(
    (s) =>
      (s.purpose === 'oauth_token' || s.purpose === 'anthropic_api_key') &&
      (scope === 'workspace' ? s.workspaceId === workspaceId : s.workspaceId === null),
  );
  // The credential currently shown in the status row (most recently created).
  const current = [...matching].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )[0] ?? null;

  async function save() {
    setBusy(true);
    setMsg(null);
    // Capture existing matching ids so we can revoke them after a successful
    // replace — avoids accumulating two credentials for the same scope.
    const priorIds = matching.map((s) => s.id);
    try {
      const res = await fetch('/api/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          value: value.trim(),
          purpose,
          teamId,
          ...(scope === 'workspace' && workspaceId ? { workspaceId } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to save');
      // Revoke the superseded credential(s) so only the new one remains.
      const newId = data.id as string | undefined;
      await Promise.all(
        priorIds
          .filter((id) => id !== newId)
          .map((id) => fetch(`/api/secrets?id=${id}`, { method: 'DELETE' })),
      );
      setValue('');
      setReplaceOpen(false);
      setMsg({ type: 'success', text: priorIds.length > 0 ? 'Claude credential replaced.' : 'Claude credential saved.' });
      await load();
    } catch (e) {
      setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Failed to save' });
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!confirm('Remove this Claude credential?')) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/secrets?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      setMsg({ type: 'success', text: 'Credential removed.' });
      await load();
    } catch {
      setMsg({ type: 'error', text: 'Failed to remove credential' });
    } finally {
      setBusy(false);
    }
  }

  const placeholder = purpose === 'oauth_token'
    ? 'sk-ant-oat01-… (output of `claude setup-token`)'
    : 'sk-ant-api03-… (Anthropic API key)';

  const form = (
    <div className="space-y-2">
      {current && (
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">Replace credential</div>
          <button onClick={() => { setReplaceOpen(false); setValue(''); }} className="text-xs text-text-tertiary">Cancel</button>
        </div>
      )}
      <div className="flex gap-2">
        <button
          onClick={() => setPurpose('oauth_token')}
          className={`px-2.5 h-8 rounded-lg text-xs font-medium border transition-colors ${purpose === 'oauth_token' ? 'border-status-info text-status-info' : 'border-border-default text-text-secondary'}`}
        >
          Setup token
        </button>
        <button
          onClick={() => setPurpose('anthropic_api_key')}
          className={`px-2.5 h-8 rounded-lg text-xs font-medium border transition-colors ${purpose === 'anthropic_api_key' ? 'border-status-info text-status-info' : 'border-border-default text-text-secondary'}`}
        >
          API key
        </button>
      </div>
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        className="w-full h-11 px-3 rounded-lg border bg-surface font-mono text-xs"
      />
      <button
        onClick={save}
        disabled={busy || !value.trim()}
        className="h-9 px-4 rounded-lg bg-status-info text-white text-sm font-medium disabled:opacity-50"
      >
        {busy ? 'Saving…' : current ? 'Replace credential' : 'Save credential'}
      </button>
    </div>
  );

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium text-text-primary">Claude</h3>
        <p className="text-xs text-text-secondary mt-0.5">
          Provide an OAuth token from <code className="bg-surface-3 px-1 rounded text-[11px]">claude setup-token</code> (seat-based)
          or an Anthropic API key (pay-per-token).
        </p>
      </div>

      {loading ? (
        <div className="text-sm text-text-tertiary">Loading…</div>
      ) : current ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-status-success/10 text-status-success border border-status-success/30">
              <span className="w-1.5 h-1.5 rounded-full bg-status-success" />
              {current.purpose === 'oauth_token' ? 'OAuth setup token' : 'Anthropic API key'}
            </span>
            <span className="text-xs text-text-muted">{current.workspaceId ? 'this workspace' : 'all workspaces'}</span>
          </div>

          <div className="bg-surface-3/50 rounded-lg p-3 space-y-1 text-xs text-text-secondary">
            <div>Set: {new Date(current.createdAt).toLocaleString()}</div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={() => revoke(current.id)} disabled={busy} className="text-sm text-status-error font-medium disabled:opacity-50">Revoke</button>
            {!replaceOpen && (
              <button onClick={() => { setReplaceOpen(true); setValue(''); setMsg(null); }} className="text-sm font-medium text-text-secondary">
                Replace credential
              </button>
            )}
          </div>

          {replaceOpen && form}
        </div>
      ) : (
        form
      )}

      {msg && (
        <div className={`text-sm ${msg.type === 'error' ? 'text-status-error' : 'text-status-success'}`}>{msg.text}</div>
      )}
    </div>
  );
}

// ── Codex ──────────────────────────────────────────────────────────────────────

interface CodexStatus {
  connected: boolean;
  expired: boolean;
  accountId: string | null;
  lastRefreshedAt: string | null;
  scope: 'team' | 'workspace' | null;
}

function CodexCard({ accessWorkspaceId, scope }: { accessWorkspaceId: string; scope: Scope }) {
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteValue, setPasteValue] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const base = `/api/workspaces/${accessWorkspaceId}/codex-credential`;
  const q = `?scope=${scope}`;

  const load = useCallback(async () => {
    if (!accessWorkspaceId) return;
    setLoading(true);
    setMsg(null);
    try {
      const res = await fetch(`${base}${q}`);
      setStatus(res.ok ? await res.json() : null);
    } catch {
      setMsg({ type: 'error', text: 'Failed to load Codex status' });
    } finally {
      setLoading(false);
    }
  }, [base, q, accessWorkspaceId]);

  useEffect(() => {
    setPasteOpen(false);
    setPasteValue('');
    setPasteError(null);
    void load();
  }, [load]);

  function validate(raw: string): string | null {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return 'Must be valid JSON'; }
    if (!parsed || typeof parsed !== 'object') return 'Must be a JSON object';
    const root = parsed as Record<string, unknown>;
    // Codex CLI nests fields under `tokens`; accept that or a flat object.
    const a = (root.tokens && typeof root.tokens === 'object' ? root.tokens : root) as Record<string, unknown>;
    if (typeof a.access_token !== 'string' || typeof a.refresh_token !== 'string' || typeof a.account_id !== 'string') {
      return 'auth.json must contain access_token, refresh_token, and account_id';
    }
    return null;
  }

  async function connect() {
    const err = validate(pasteValue);
    if (err) { setPasteError(err); return; }
    setBusy(true);
    setPasteError(null);
    setMsg(null);
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authJson: pasteValue, scope }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to connect');
      setStatus(data);
      setPasteValue('');
      setPasteOpen(false);
      setMsg({ type: 'success', text: 'Codex credential connected.' });
    } catch (e) {
      setPasteError(e instanceof Error ? e.message : 'Failed to connect');
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${base}/refresh${q}`, { method: 'POST' });
      const data = await res.json();
      if (data.status === 'refreshed') { setMsg({ type: 'success', text: 'Token refreshed.' }); await load(); }
      else if (data.status === 'locked') setMsg({ type: 'success', text: 'Token was refreshed recently.' });
      else if (data.status === 'error') setMsg({ type: 'error', text: 'Refresh failed — the credential may be invalid.' });
      else setMsg({ type: 'error', text: 'No credential to refresh.' });
    } catch {
      setMsg({ type: 'error', text: 'Failed to refresh token' });
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!confirm('Remove this Codex credential?')) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${base}${q}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) throw new Error('Delete failed');
      setStatus({ connected: false, expired: false, accountId: null, lastRefreshedAt: null, scope: null });
      setMsg({ type: 'success', text: 'Credential removed.' });
    } catch {
      setMsg({ type: 'error', text: 'Failed to remove credential' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium text-text-primary">Codex</h3>
        <p className="text-xs text-text-secondary mt-0.5">
          Paste the contents of <code className="bg-surface-3 px-1 rounded text-[11px]">~/.codex/auth.json</code> from a machine
          where you&apos;ve authenticated with Codex.
        </p>
      </div>

      {loading ? (
        <div className="text-sm text-text-tertiary">Loading…</div>
      ) : status?.connected ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            {status.expired ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-status-warning/10 text-status-warning border border-status-warning/30">
                <span className="w-1.5 h-1.5 rounded-full bg-status-warning" /> Expired — needs refresh
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-status-success/10 text-status-success border border-status-success/30">
                <span className="w-1.5 h-1.5 rounded-full bg-status-success" /> Connected
              </span>
            )}
            <span className="text-xs text-text-muted">{status.scope === 'workspace' ? 'this workspace' : 'all workspaces'}</span>
          </div>

          <div className="bg-surface-3/50 rounded-lg p-3 space-y-1 text-xs text-text-secondary">
            {status.accountId && <div>Account: <span className="font-mono text-text-primary">{status.accountId}</span></div>}
            {status.lastRefreshedAt && <div>Last refreshed: {new Date(status.lastRefreshedAt).toLocaleString()}</div>}
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={refresh} disabled={busy} className="text-sm font-medium text-status-info disabled:opacity-50">
              {busy ? 'Refreshing…' : 'Refresh now'}
            </button>
            <button onClick={revoke} disabled={busy} className="text-sm text-status-error font-medium disabled:opacity-50">Revoke</button>
            {!pasteOpen && (
              <button onClick={() => { setPasteOpen(true); setPasteValue(''); setPasteError(null); }} className="text-sm font-medium text-text-secondary">
                Replace credential
              </button>
            )}
          </div>

          {pasteOpen && (
            <CodexPasteForm value={pasteValue} onChange={setPasteValue} error={pasteError} busy={busy} onConnect={connect}
              onCancel={() => { setPasteOpen(false); setPasteValue(''); setPasteError(null); }} />
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-surface-3 text-text-muted border border-border-default">
            <span className="w-1.5 h-1.5 rounded-full bg-text-muted" /> Not connected
          </span>
          <CodexPasteForm value={pasteValue} onChange={setPasteValue} error={pasteError} busy={busy} onConnect={connect} />
        </div>
      )}

      {msg && (
        <div className={`text-sm ${msg.type === 'error' ? 'text-status-error' : 'text-status-success'}`}>{msg.text}</div>
      )}
    </div>
  );
}

function CodexPasteForm({ value, onChange, error, busy, onConnect, onCancel }: {
  value: string; onChange: (v: string) => void; error: string | null; busy: boolean; onConnect: () => void; onCancel?: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">Paste auth.json</div>
        {onCancel && <button onClick={onCancel} className="text-xs text-text-tertiary">Cancel</button>}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={'{\n  "access_token": "...",\n  "refresh_token": "...",\n  "account_id": "..."\n}'}
        rows={6}
        className="w-full px-3 py-2 rounded-lg border bg-surface font-mono text-xs resize-y"
      />
      {error && <div className="text-sm text-status-error">{error}</div>}
      <button onClick={onConnect} disabled={busy || !value.trim()} className="h-9 px-4 rounded-lg bg-status-info text-white text-sm font-medium disabled:opacity-50">
        {busy ? 'Connecting…' : 'Connect'}
      </button>
    </div>
  );
}
