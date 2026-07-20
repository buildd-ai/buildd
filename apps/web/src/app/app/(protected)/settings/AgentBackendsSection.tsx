'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * Shared action affordances for the credential cards. Replaces the old bare
 * blue-/red-text links with consistent bordered pills that read as buttons and
 * carry a clear tone hierarchy (primary action, neutral, destructive).
 */
function CredActionRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 pt-1">{children}</div>;
}

function CredAction({
  onClick, children, disabled, tone = 'neutral',
}: { onClick: () => void; children: ReactNode; disabled?: boolean; tone?: 'primary' | 'neutral' | 'danger' }) {
  const toneCls =
    tone === 'primary' ? 'border-status-info/40 text-status-info hover:bg-status-info/10'
    : tone === 'danger' ? 'border-status-error/40 text-status-error hover:bg-status-error/10'
    : 'border-border-default text-text-secondary hover:bg-surface-3';
  return (
    <button onClick={onClick} disabled={disabled}
      className={`h-8 px-3 rounded-lg border text-xs font-medium transition-colors disabled:opacity-40 ${toneCls}`}>
      {children}
    </button>
  );
}

interface Workspace {
  id: string;
  name: string;
  teamId: string;
}

interface Props {
  workspaces: Workspace[];
  currentTeamId: string | null;
}

type Scope = 'team' | 'workspace' | 'all_teams';

/**
 * Trim whitespace and strip a single pair of wrapping quotes from a pasted token.
 * Mirrors the server-side sanitizeSecretValue — pasted Claude tokens often arrive as
 * `"sk-ant-oat01-…"`, which adds 2 chars and causes a later `401 Invalid bearer token`.
 */
function sanitizeToken(raw: string): string {
  let v = raw.trim();
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      v = v.slice(1, -1).trim();
    }
  }
  return v;
}

export interface TeamTarget {
  teamId: string;
  /** A representative workspace in the team — used to authorize team-scoped writes. */
  workspaceId: string;
}

/**
 * Unified agent-backend credentials. Both Claude (setup token / API key) and
 * Codex (auth.json) are stored in the shared `secrets` table. The team is the auth
 * boundary: a credential is shared team-wide by default, narrowed to one workspace,
 * or — for an operator who runs one runner across several of their teams — fanned
 * out to every team they manage ("all my teams"). See docs/credentials-architecture.md.
 */
export default function AgentBackendsSection({ workspaces, currentTeamId }: Props) {
  // Only workspaces in the active team can share a team-wide credential.
  const teamWorkspaces = useMemo(
    () => (currentTeamId ? workspaces.filter((w) => w.teamId === currentTeamId) : workspaces),
    [workspaces, currentTeamId],
  );

  // One representative workspace per distinct team the user can see — the fan-out
  // targets. Each write is still authorized per-team server-side, so this can only
  // touch teams the user actually belongs to.
  const teamTargets = useMemo<TeamTarget[]>(() => {
    const byTeam = new Map<string, string>();
    for (const w of workspaces) if (!byTeam.has(w.teamId)) byTeam.set(w.teamId, w.id);
    return Array.from(byTeam, ([teamId, workspaceId]) => ({ teamId, workspaceId }));
  }, [workspaces]);
  const multiTeam = teamTargets.length > 1;

  const [scope, setScope] = useState<Scope>('team');
  const [workspaceId, setWorkspaceId] = useState<string>(teamWorkspaces[0]?.id ?? '');
  // Setup-token / API-key is the fallback for Claude — collapsed by default so the
  // one-tap OAuth connect is the single primary Claude action (less clutter).
  const [showClaudeAlt, setShowClaudeAlt] = useState(false);

  // The Codex API is nested under a workspace; for team scope we still need a
  // workspace in the team to authorize + resolve the team id.
  const accessWorkspaceId = scope === 'workspace' ? workspaceId : teamWorkspaces[0]?.id ?? '';
  const teamId = currentTeamId ?? teamWorkspaces[0]?.teamId ?? '';

  if (teamWorkspaces.length === 0) return null;

  return (
    <section>
      <div className="flex items-end justify-between mb-3 gap-3">
        <h2 className="section-label">Agent backends</h2>
      </div>

      <div className="card p-4 space-y-5">
        <p className="text-sm text-text-secondary">
          Credentials runners use to authenticate an agent backend. The team is the
          auth boundary: set one credential for <strong className="text-text-primary">all workspaces</strong> in
          the team, scope it to a single workspace{multiTeam ? <>, or apply it across <strong className="text-text-primary">all {teamTargets.length} teams</strong> you manage</> : null}.
        </p>

        {/* Team provider routing toggle (reversible mask over the resolution chain) */}
        <ProviderRoutingToggle teamId={teamId} />
        <div className="border-t border-border-default" />

        {/* Shared scope selector */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-medium text-text-secondary">Applies to</span>
          <div className="flex sm:inline-flex w-full sm:w-auto rounded-lg border border-border-default overflow-hidden">
            <button
              onClick={() => setScope('team')}
              className={`flex-1 sm:flex-none px-3 h-9 text-sm font-medium transition-colors ${scope === 'team' ? 'bg-surface-3 text-text-primary' : 'text-text-secondary'}`}
            >
              This team
            </button>
            <button
              onClick={() => setScope('workspace')}
              className={`flex-1 sm:flex-none px-3 h-9 text-sm font-medium border-l border-border-default transition-colors ${scope === 'workspace' ? 'bg-surface-3 text-text-primary' : 'text-text-secondary'}`}
            >
              One workspace
            </button>
            {multiTeam && (
              <button
                onClick={() => setScope('all_teams')}
                className={`flex-1 sm:flex-none px-3 h-9 text-sm font-medium border-l border-border-default transition-colors ${scope === 'all_teams' ? 'bg-surface-3 text-text-primary' : 'text-text-secondary'}`}
              >
                All my teams
              </button>
            )}
          </div>
          {scope === 'all_teams' && (
            <span className="text-xs text-text-muted">Writes one credential per team ({teamTargets.length})</span>
          )}
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

        {/* Claude: the one-tap OAuth connect is the primary path. Setup token / API
            key is a collapsed fallback so there's a single Claude section by default. */}
        <ClaudeConnectedAccountCard accessWorkspaceId={accessWorkspaceId} scope={scope} teamTargets={teamTargets} />
        <div>
          <button
            onClick={() => setShowClaudeAlt((v) => !v)}
            className="text-xs font-medium text-text-secondary hover:text-text-primary transition-colors"
          >
            {showClaudeAlt ? '▾' : '▸'} Other ways to connect Claude — setup token or API key
          </button>
          {showClaudeAlt && (
            <div className="mt-3 pl-3 border-l-2 border-border-default">
              <ClaudeCard teamId={teamId} scope={scope} workspaceId={scope === 'workspace' ? workspaceId : null} teamTargets={teamTargets} />
            </div>
          )}
        </div>
        <div className="border-t border-border-default" />
        <CodexCard accessWorkspaceId={accessWorkspaceId} scope={scope} teamTargets={teamTargets} />
      </div>
    </section>
  );
}

// ── Provider routing (team toggle) ──────────────────────────────────────────────

type RoutingBackend = 'claude' | 'codex';
const ALL_BACKENDS: RoutingBackend[] = ['claude', 'codex'];
const backendLabel = (b: RoutingBackend) => (b === 'claude' ? 'Claude' : 'Codex');

/**
 * Team-level enable/disable for each provider. This is a reversible mask applied
 * at dispatch time — disabling a provider reroutes its jobs to an enabled one
 * without touching per-workspace/role/mission settings, and re-enabling restores
 * them automatically. Use it to cut over everything (e.g. after cancelling a sub)
 * in one switch, instead of editing every workspace/role.
 */
function ProviderRoutingToggle({ teamId }: { teamId: string }) {
  const [enabled, setEnabled] = useState<RoutingBackend[] | null>(null); // null = loading/all
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!teamId) return;
    try {
      const res = await fetch(`/api/teams/${teamId}`);
      if (res.ok) {
        const data = await res.json();
        const eb = data.team?.enabledBackends as RoutingBackend[] | null | undefined;
        setEnabled(eb && eb.length ? eb : ALL_BACKENDS); // null/empty => all enabled
      }
    } catch {
      /* non-fatal */
    } finally {
      setLoaded(true);
    }
  }, [teamId]);

  useEffect(() => { void load(); }, [load]);

  const isOn = (b: RoutingBackend) => !enabled || enabled.includes(b);

  async function toggle(b: RoutingBackend) {
    const current = enabled ?? ALL_BACKENDS;
    const next = current.includes(b) ? current.filter((x) => x !== b) : [...current, b];
    if (next.length === 0) {
      setMsg({ type: 'error', text: 'At least one provider must stay enabled.' });
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
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Failed to update');
      const off = ALL_BACKENDS.filter((x) => !next.includes(x));
      setMsg({
        type: 'success',
        text: off.length
          ? `${off.map(backendLabel).join(' & ')} disabled — those jobs now run on ${next.map(backendLabel).join(' & ')}. Re-enable anytime; per-workspace settings are untouched.`
          : 'Both providers enabled (default routing).',
      });
    } catch (e) {
      setEnabled(prev); // rollback optimistic update
      setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Failed to update' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div>
        <h3 className="text-sm font-medium text-text-primary">Provider routing</h3>
        <p className="text-xs text-text-secondary mt-0.5">
          Enable or disable a provider team-wide. Disabling one reroutes its jobs to the other —
          reversible, and it doesn&apos;t change any per-workspace or per-role backend settings.
        </p>
      </div>
      <div className="space-y-2">
        {ALL_BACKENDS.map((b) => (
          <div key={b} className="flex items-center justify-between bg-surface-3/50 rounded-lg px-3 py-2">
            <span className="inline-flex items-center gap-1.5 text-sm text-text-primary">
              <span className={`w-1.5 h-1.5 rounded-full ${isOn(b) ? 'bg-status-success' : 'bg-text-muted'}`} />
              {backendLabel(b)}
              <span className="text-xs text-text-muted">{isOn(b) ? 'enabled' : 'disabled — jobs reroute'}</span>
            </span>
            <button
              onClick={() => toggle(b)}
              disabled={busy || !loaded}
              className={`px-2.5 h-8 rounded-lg text-xs font-medium border transition-colors disabled:opacity-50 ${
                isOn(b) ? 'border-status-success/40 text-status-success' : 'border-border-default text-text-secondary'
              }`}
            >
              {isOn(b) ? 'Disable' : 'Enable'}
            </button>
          </div>
        ))}
      </div>
      {msg && (
        <div className={`text-sm ${msg.type === 'error' ? 'text-status-error' : 'text-status-success'}`}>{msg.text}</div>
      )}
    </div>
  );
}

// ── Claude ─────────────────────────────────────────────────────────────────────

type ClaudePurpose = 'oauth_token' | 'anthropic_api_key';

interface SecretMeta {
  id: string;
  purpose: string;
  accountId: string | null;
  workspaceId: string | null;
  createdAt: string | null;
  healthStatus?: 'healthy' | 'degraded' | 'revoked' | 'unknown';
  lastFailureAt?: string | null;
  lastFailureMessage?: string | null;
  consecutiveAuthFailures?: number;
  lastSuccessAt?: string | null;
  lastVerifiedAt?: string | null;
  lastVerificationError?: string | null;
}

function ClaudeCard({ teamId, scope, workspaceId, teamTargets }: { teamId: string; scope: Scope; workspaceId: string | null; teamTargets: TeamTarget[] }) {
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [purpose, setPurpose] = useState<ClaudePurpose>('oauth_token');
  const [value, setValue] = useState('');
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [replaceOpen, setReplaceOpen] = useState(false);

  const allTeams = scope === 'all_teams';

  const load = useCallback(async () => {
    // All-teams is an action (write to every team), not a per-team status view.
    if (!teamId || scope === 'all_teams') { setSecrets([]); return; }
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
  }, [teamId, scope]);

  useEffect(() => {
    setReplaceOpen(false);
    setValue('');
    void load();
  }, [load]);

  // Credentials matching the selected scope.
  const matching = secrets.filter(
    (s) =>
      (s.purpose === 'oauth_token' || s.purpose === 'anthropic_api_key') &&
      (scope === 'workspace' ? s.workspaceId === workspaceId : s.workspaceId === null),
  );

  async function save() {
    setBusy(true);
    setMsg(null);
    // Trim + strip a single pair of wrapping quotes before sending. The server
    // enforces this too, but sanitizing here keeps the UI honest for pasted tokens
    // like `"sk-ant-oat01-…"`. See sanitizeSecretValue in api/secrets/route.ts.
    const cleanValue = sanitizeToken(value);
    try {
      // Fan out across every team the operator manages — one team-wide row each.
      if (allTeams) {
        const results = await Promise.all(
          teamTargets.map((t) =>
            fetch('/api/secrets', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ value: cleanValue, purpose, teamId: t.teamId }),
            }).then((r) => r.ok).catch(() => false),
          ),
        );
        const ok = results.filter(Boolean).length;
        setValue('');
        setMsg({
          type: ok > 0 ? 'success' : 'error',
          text: `Claude credential saved for ${ok} of ${teamTargets.length} teams.`,
        });
        return;
      }
      const res = await fetch('/api/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          value: cleanValue,
          purpose,
          teamId,
          ...(scope === 'workspace' && workspaceId ? { workspaceId } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to save');
      setValue('');
      setReplaceOpen(false);
      setMsg({ type: 'success', text: 'Claude credential saved.' });
      await load();
    } catch (e) {
      setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Failed to save' });
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/secrets?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      setMsg({ type: 'success', text: 'Credential removed.' });
      setReplaceOpen(false);
      await load();
    } catch {
      setMsg({ type: 'error', text: 'Failed to remove credential' });
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (!matching.length) return;
    setVerifying(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/secrets/${matching[0].id}/verify`, { method: 'POST' });
      const data = await res.json();
      if (data.revoked) {
        // Reads OK but a worker run reported the OAuth session revoked. GET /v1/models
        // can't detect that, so don't show a green pass — direct the user to re-auth.
        setMsg({ type: 'error', text: 'Token reads OK, but a worker run reported it revoked (logged out / signed in elsewhere). Generate a fresh `claude setup-token` and paste it again.' });
      } else if (data.verified) {
        setMsg({ type: 'success', text: 'Credential verified against the Anthropic API.' });
      } else {
        setMsg({ type: 'error', text: `Verification failed: ${data.error ?? 'invalid credential'}` });
      }
      await load();
    } catch {
      setMsg({ type: 'error', text: 'Failed to verify credential' });
    } finally {
      setVerifying(false);
    }
  }

  const placeholder = purpose === 'oauth_token'
    ? 'sk-ant-oat01-… (output of `claude setup-token`)'
    : 'sk-ant-api03-… (Anthropic API key)';

  const inputForm = (
    <div className="space-y-2">
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
      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={busy || !value.trim()}
          className="h-9 px-4 rounded-lg bg-status-info text-white text-sm font-medium disabled:opacity-50"
        >
          {busy ? 'Saving…' : allTeams ? `Apply to all ${teamTargets.length} teams` : matching.length > 0 ? 'Replace' : 'Save credential'}
        </button>
        {replaceOpen && (
          <button onClick={() => { setReplaceOpen(false); setValue(''); }} className="text-xs text-text-tertiary">Cancel</button>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium text-text-primary">Setup token / API key</h3>
        <p className="text-xs text-text-secondary mt-0.5">
          A fallback to the one-tap connect: paste an OAuth token from <code className="bg-surface-3 px-1 rounded text-[11px]">claude setup-token</code> (seat-based)
          or an Anthropic API key (pay-per-token).
        </p>
      </div>

      {loading ? (
        <div className="text-sm text-text-tertiary">Loading…</div>
      ) : matching.length > 0 ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            {matching[0].healthStatus === 'revoked' ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-status-error/10 text-status-error border border-status-error/30">
                <span className="w-1.5 h-1.5 rounded-full bg-status-error" /> Revoked — re-auth required
              </span>
            ) : matching[0].healthStatus === 'degraded' ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-status-warning/10 text-status-warning border border-status-warning/30">
                <span className="w-1.5 h-1.5 rounded-full bg-status-warning" /> Degraded — auth failures detected
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-status-success/10 text-status-success border border-status-success/30">
                <span className="w-1.5 h-1.5 rounded-full bg-status-success" /> Connected
              </span>
            )}
            <span className="text-xs text-text-muted">{matching[0].workspaceId ? 'this workspace' : 'all workspaces'}</span>
          </div>

          <div className="bg-surface-3/50 rounded-lg p-3 space-y-1 text-xs text-text-secondary">
            {matching.map((s) => (
              <div key={s.id}>{s.purpose === 'oauth_token' ? 'OAuth setup token' : 'Anthropic API key'}</div>
            ))}
            {matching[0].createdAt && (
              <div>Connected: {new Date(matching[0].createdAt).toLocaleString()}</div>
            )}
            {matching[0].lastVerifiedAt && (
              <div>
                Last verified: {new Date(matching[0].lastVerifiedAt).toLocaleString()}
                {matching[0].lastVerificationError
                  ? <span className="text-status-error"> — failed: {matching[0].lastVerificationError}</span>
                  : <span className="text-status-success"> — passed</span>}
              </div>
            )}
            {(matching[0].healthStatus === 'revoked' || matching[0].healthStatus === 'degraded') && matching[0].lastFailureAt && (
              <div className="text-status-error">
                Last failure: {new Date(matching[0].lastFailureAt).toLocaleString()}
                {matching[0].lastFailureMessage && ` — ${matching[0].lastFailureMessage.slice(0, 120)}`}
              </div>
            )}
          </div>

          <CredActionRow>
            <CredAction onClick={verify} disabled={busy || verifying} tone="primary">
              {verifying ? 'Verifying…' : 'Verify'}
            </CredAction>
            {!replaceOpen && (
              <CredAction onClick={() => { setReplaceOpen(true); setValue(''); setMsg(null); }}>
                Replace
              </CredAction>
            )}
            {matching.map((s) => (
              <CredAction key={s.id} onClick={() => revoke(s.id)} disabled={busy} tone="danger">Revoke</CredAction>
            ))}
          </CredActionRow>

          {replaceOpen && inputForm}
        </div>
      ) : (
        <div className="space-y-3">
          {allTeams ? (
            <span className="text-xs text-text-muted">Applies the same Claude credential to all {teamTargets.length} teams you manage.</span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-surface-3 text-text-muted border border-border-default">
              <span className="w-1.5 h-1.5 rounded-full bg-text-muted" /> Not connected
            </span>
          )}
          {inputForm}
        </div>
      )}

      {msg && (
        <div className={`text-sm ${msg.type === 'error' ? 'text-status-error' : 'text-status-success'}`}>{msg.text}</div>
      )}
    </div>
  );
}

// ── Claude connected account (managed OAuth credential) ────────────────────────
//
// Stores ~/.claude/.credentials.json content as a managed credential. The server
// refreshes tokens centrally (with a rotation lock) and gives workers only the
// access_token — preventing the token family revocation cascade that occurs when
// multiple workers independently call Anthropic's refresh endpoint.

interface ClaudeCredentialStatus {
  connected: boolean;
  expired: boolean;
  lastRefreshedAt: string | null;
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
  scope: 'team' | 'workspace' | null;
}

function ClaudeConnectedAccountCard({ accessWorkspaceId, scope, teamTargets }: { accessWorkspaceId: string; scope: Scope; teamTargets: TeamTarget[] }) {
  const [status, setStatus] = useState<ClaudeCredentialStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteValue, setPasteValue] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // OAuth connect (authorization-code): buildd mints a claude_credential from a
  // short pasted code instead of the whole .credentials.json blob.
  const [oauth, setOauth] = useState<{ authorizeUrl: string; verifier: string; state: string } | null>(null);
  const [oauthCode, setOauthCode] = useState('');

  const allTeams = scope === 'all_teams';
  const base = `/api/workspaces/${accessWorkspaceId}/claude-credential`;
  const q = `?scope=${scope}`;

  async function startOAuth() {
    setBusy(true);
    setMsg(null);
    setOauthCode('');
    try {
      const res = await fetch(`${base}/oauth/start`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { setMsg({ type: 'error', text: data.error ?? 'Failed to start Claude login' }); return; }
      setOauth({ authorizeUrl: data.authorizeUrl, verifier: data.verifier, state: data.state });
      window.open(data.authorizeUrl, '_blank', 'noopener,noreferrer');
    } catch {
      setMsg({ type: 'error', text: 'Failed to start Claude login' });
    } finally {
      setBusy(false);
    }
  }

  async function submitOAuthCode() {
    if (!oauth || !oauthCode.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${base}/oauth/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: oauthCode.trim(), verifier: oauth.verifier, state: oauth.state, scope }),
      });
      const data = await res.json();
      if (!res.ok) { setMsg({ type: 'error', text: data.error ?? 'Exchange failed' }); return; }
      setOauth(null);
      setOauthCode('');
      if (typeof data.teams === 'number') {
        setMsg({ type: 'success', text: `Claude connected via OAuth for ${data.teams} of ${data.totalTeams} teams.` });
      } else {
        setStatus(data);
        setMsg({ type: 'success', text: 'Claude connected via OAuth (managed refresh enabled).' });
      }
    } catch {
      setMsg({ type: 'error', text: 'Failed to exchange code' });
    } finally {
      setBusy(false);
    }
  }

  const load = useCallback(async () => {
    if (!accessWorkspaceId || scope === 'all_teams') { setStatus(null); return; }
    setLoading(true);
    setMsg(null);
    try {
      const res = await fetch(`${base}${q}`);
      setStatus(res.ok ? await res.json() : null);
    } catch {
      setMsg({ type: 'error', text: 'Failed to load connected account status' });
    } finally {
      setLoading(false);
    }
  }, [base, q, accessWorkspaceId, scope]);

  useEffect(() => {
    setPasteOpen(false);
    setPasteValue('');
    setPasteError(null);
    setOauth(null);
    setOauthCode('');
    void load();
  }, [load]);

  function validate(raw: string): string | null {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return 'Must be valid JSON'; }
    if (!parsed || typeof parsed !== 'object') return 'Must be a JSON object';
    const root = parsed as Record<string, unknown>;
    if (typeof root.access_token !== 'string' || typeof root.refresh_token !== 'string') {
      return '.credentials.json must contain access_token and refresh_token';
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
      if (allTeams) {
        const results = await Promise.all(
          teamTargets.map((t) =>
            fetch(`/api/workspaces/${t.workspaceId}/claude-credential`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ credentialsJson: pasteValue, scope: 'team' }),
            }).then((r) => r.ok).catch(() => false),
          ),
        );
        const ok = results.filter(Boolean).length;
        setPasteValue('');
        setMsg({
          type: ok > 0 ? 'success' : 'error',
          text: `Connected account saved for ${ok} of ${teamTargets.length} teams.`,
        });
        return;
      }
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentialsJson: pasteValue, scope }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to connect');
      setStatus(data);
      setPasteValue('');
      setPasteOpen(false);
      setMsg({ type: 'success', text: 'Claude account connected (managed refresh enabled).' });
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
    if (!confirm('Remove this Claude connected account?')) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${base}${q}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) throw new Error('Delete failed');
      setStatus({ connected: false, expired: false, lastRefreshedAt: null, lastVerifiedAt: null, lastVerificationError: null, scope: null });
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
        <h3 className="text-sm font-medium text-text-primary">Claude</h3>
        <p className="text-xs text-text-secondary mt-0.5">
          Connect with Claude in one tap — approve in the browser and paste the short code back.
          Tokens are refreshed server-side; workers never rotate them directly.
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
            {status.lastRefreshedAt && <div>Last refreshed: {new Date(status.lastRefreshedAt).toLocaleString()}</div>}
            {status.lastVerifiedAt && (
              <div>
                Last verified: {new Date(status.lastVerifiedAt).toLocaleString()}
                {status.lastVerificationError
                  ? <span className="text-status-error"> — failed: {status.lastVerificationError}</span>
                  : <span className="text-status-success"> — passed</span>}
              </div>
            )}
          </div>

          <CredActionRow>
            {!allTeams && !oauth && (
              <CredAction onClick={startOAuth} disabled={busy} tone="primary">Reconnect with Claude</CredAction>
            )}
            <CredAction onClick={refresh} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh now'}</CredAction>
            {!pasteOpen && (
              <CredAction onClick={() => { setPasteOpen(true); setPasteValue(''); setPasteError(null); }}>Paste .credentials.json</CredAction>
            )}
            <CredAction onClick={revoke} disabled={busy} tone="danger">Revoke</CredAction>
          </CredActionRow>

          {oauth && (
            <ClaudeOAuthPanel authorizeUrl={oauth.authorizeUrl} code={oauthCode} onChange={setOauthCode} busy={busy}
              onSubmit={submitOAuthCode} onCancel={() => { setOauth(null); setOauthCode(''); }} />
          )}
          {pasteOpen && (
            <ClaudeCredentialsPasteForm value={pasteValue} onChange={setPasteValue} error={pasteError} busy={busy} onConnect={connect}
              onCancel={() => { setPasteOpen(false); setPasteValue(''); setPasteError(null); }} />
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {allTeams ? (
            <span className="text-xs text-text-muted">Paste once — applies the same connected account to all {teamTargets.length} teams you manage.</span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-surface-3 text-text-muted border border-border-default">
              <span className="w-1.5 h-1.5 rounded-full bg-text-muted" /> Not connected
            </span>
          )}
          {/* OAuth connect (short code) is the clean primary path — incl. all-teams fan-out. */}
          {oauth ? (
            <ClaudeOAuthPanel authorizeUrl={oauth.authorizeUrl} code={oauthCode} onChange={setOauthCode} busy={busy}
              onSubmit={submitOAuthCode} onCancel={() => { setOauth(null); setOauthCode(''); }} />
          ) : (
            <div className="flex items-center gap-3">
              <button onClick={startOAuth} disabled={busy} className="h-9 px-4 rounded-lg bg-status-info text-white text-sm font-medium disabled:opacity-50">
                Connect with Claude
              </button>
              <span className="text-xs text-text-muted">
                {allTeams ? `Approve once → applied to all ${teamTargets.length} teams` : 'Recommended — approve + paste a short code, no file'}
              </span>
            </div>
          )}
          <ClaudeCredentialsPasteForm value={pasteValue} onChange={setPasteValue} error={pasteError} busy={busy} onConnect={connect} allTeamsCount={allTeams ? teamTargets.length : undefined} />
        </div>
      )}

      {msg && (
        <div className={`text-sm ${msg.type === 'error' ? 'text-status-error' : 'text-status-success'}`}>{msg.text}</div>
      )}
    </div>
  );
}

function ClaudeCredentialsPasteForm({ value, onChange, error, busy, onConnect, onCancel, allTeamsCount }: {
  value: string; onChange: (v: string) => void; error: string | null; busy: boolean; onConnect: () => void; onCancel?: () => void; allTeamsCount?: number;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">Paste .credentials.json</div>
        {onCancel && <button onClick={onCancel} className="text-xs text-text-tertiary">Cancel</button>}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={'{\n  "access_token": "...",\n  "refresh_token": "...",\n  "expires_at": 1700000000\n}'}
        rows={6}
        className="w-full px-3 py-2 rounded-lg border bg-surface font-mono text-xs resize-y"
      />
      {error && <div className="text-sm text-status-error">{error}</div>}
      <button onClick={onConnect} disabled={busy || !value.trim()} className="h-9 px-4 rounded-lg bg-status-info text-white text-sm font-medium disabled:opacity-50">
        {busy ? 'Connecting…' : allTeamsCount ? `Connect for all ${allTeamsCount} teams` : 'Connect'}
      </button>
    </div>
  );
}

/** In-progress Claude OAuth connect: approve in the opened tab, paste the short code back. */
function ClaudeOAuthPanel({ authorizeUrl, code, onChange, busy, onSubmit, onCancel }: {
  authorizeUrl: string; code: string; onChange: (v: string) => void; busy: boolean; onSubmit: () => void; onCancel: () => void;
}) {
  return (
    <div className="rounded-lg border border-status-info/30 bg-status-info/5 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-text-primary">Finish connecting Claude</div>
        <button onClick={onCancel} className="text-xs text-text-tertiary">Cancel</button>
      </div>
      <ol className="text-xs text-text-secondary space-y-1 list-decimal list-inside">
        <li>Approve in the Claude tab we opened (<a href={authorizeUrl} target="_blank" rel="noopener noreferrer" className="text-status-info underline">reopen</a>).</li>
        <li>Copy the code shown after approving and paste it here:</li>
      </ol>
      <input
        type="text"
        value={code}
        onChange={(e) => onChange(e.target.value)}
        placeholder="paste the code (looks like abc…#def…)"
        className="w-full px-3 py-2 rounded-lg border bg-surface font-mono text-xs"
        onKeyDown={(e) => { if (e.key === 'Enter' && code.trim() && !busy) onSubmit(); }}
      />
      <button onClick={onSubmit} disabled={busy || !code.trim()} className="h-9 px-4 rounded-lg bg-status-info text-white text-sm font-medium disabled:opacity-50">
        {busy ? 'Connecting…' : 'Connect'}
      </button>
    </div>
  );
}

// ── Codex ──────────────────────────────────────────────────────────────────────

interface CodexStatus {
  connected: boolean;
  expired: boolean;
  accountId: string | null;
  lastRefreshedAt: string | null;
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
  scope: 'team' | 'workspace' | null;
}

function CodexCard({ accessWorkspaceId, scope, teamTargets }: { accessWorkspaceId: string; scope: Scope; teamTargets: TeamTarget[] }) {
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteValue, setPasteValue] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // Device-code login: buildd mints its own session (no pasted file to go stale).
  const [device, setDevice] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const devicePollRef = useRef<{ cancelled: boolean } | null>(null);

  const allTeams = scope === 'all_teams';
  const base = `/api/workspaces/${accessWorkspaceId}/codex-credential`;
  const q = `?scope=${scope}`;

  // Stop any in-flight device polling when scope/workspace changes or on unmount.
  useEffect(() => () => { if (devicePollRef.current) devicePollRef.current.cancelled = true; }, [accessWorkspaceId, scope]);

  async function startDeviceLogin() {
    setBusy(true);
    setMsg(null);
    setDevice(null);
    if (devicePollRef.current) devicePollRef.current.cancelled = true;
    try {
      const res = await fetch(`${base}/device/start`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setMsg({ type: 'error', text: data.error ?? 'Failed to start device login' });
        return;
      }
      setDevice({ userCode: data.userCode, verificationUri: data.verificationUri });
      const token = { cancelled: false };
      devicePollRef.current = token;
      void pollDeviceLogin(data.deviceAuthId, data.userCode, data.interval ?? 5, token);
    } catch {
      setMsg({ type: 'error', text: 'Failed to start device login' });
    } finally {
      setBusy(false);
    }
  }

  async function pollDeviceLogin(deviceAuthId: string, userCode: string, intervalSec: number, token: { cancelled: boolean }) {
    const deadline = Date.now() + 15 * 60 * 1000;
    while (!token.cancelled && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, Math.max(1, intervalSec) * 1000));
      if (token.cancelled) return;
      try {
        const res = await fetch(`${base}/device/poll`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceAuthId, userCode, scope }),
        });
        const data = await res.json();
        if (data.status === 'connected') {
          if (token.cancelled) return;
          setDevice(null);
          setStatus(data);
          setMsg({ type: 'success', text: 'Codex connected via device login. buildd now owns this session.' });
          return;
        }
        if (data.status === 'error') {
          if (token.cancelled) return;
          setDevice(null);
          setMsg({ type: 'error', text: data.error ?? 'Device login failed' });
          return;
        }
        // pending → keep polling
      } catch {
        // transient — keep polling
      }
    }
    if (!token.cancelled) { setDevice(null); setMsg({ type: 'error', text: 'Device login timed out. Try again.' }); }
  }

  const load = useCallback(async () => {
    // All-teams is an action (write to every team), not a per-team status view.
    if (!accessWorkspaceId || scope === 'all_teams') { setStatus(null); return; }
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
  }, [base, q, accessWorkspaceId, scope]);

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
      // Fan out across every team the operator manages — each team gets its own
      // team-wide Codex credential (authorized via a representative workspace).
      if (allTeams) {
        const results = await Promise.all(
          teamTargets.map((t) =>
            fetch(`/api/workspaces/${t.workspaceId}/codex-credential`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ authJson: pasteValue, scope: 'team' }),
            }).then((r) => r.ok).catch(() => false),
          ),
        );
        const ok = results.filter(Boolean).length;
        setPasteValue('');
        setMsg({
          type: ok > 0 ? 'success' : 'error',
          text: `Codex connected for ${ok} of ${teamTargets.length} teams.`,
        });
        return;
      }
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

  async function verify() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${base}/verify${q}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { setMsg({ type: 'error', text: data.error ?? 'Verification failed' }); return; }
      if (data.verified) setMsg({ type: 'success', text: 'Credential verified against the provider API.' });
      else setMsg({ type: 'error', text: `Verification failed: ${data.error ?? 'invalid credential'}` });
      if (data.status) setStatus(data.status);
    } catch {
      setMsg({ type: 'error', text: 'Failed to verify credential' });
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
      setStatus({ connected: false, expired: false, accountId: null, lastRefreshedAt: null, lastVerifiedAt: null, lastVerificationError: null, scope: null });
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
            {status.lastVerifiedAt && (
              <div>
                Last verified: {new Date(status.lastVerifiedAt).toLocaleString()}
                {status.lastVerificationError
                  ? <span className="text-status-error"> — failed: {status.lastVerificationError}</span>
                  : <span className="text-status-success"> — passed</span>}
              </div>
            )}
          </div>

          <CredActionRow>
            {!allTeams && !device && (
              <CredAction onClick={startDeviceLogin} disabled={busy} tone="primary">Re-auth via device login</CredAction>
            )}
            <CredAction onClick={verify} disabled={busy}>{busy ? 'Working…' : 'Verify'}</CredAction>
            <CredAction onClick={refresh} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh now'}</CredAction>
            {!pasteOpen && (
              <CredAction onClick={() => { setPasteOpen(true); setPasteValue(''); setPasteError(null); }}>Paste auth.json</CredAction>
            )}
            <CredAction onClick={revoke} disabled={busy} tone="danger">Revoke</CredAction>
          </CredActionRow>

          {device && (
            <DeviceLoginPanel userCode={device.userCode} verificationUri={device.verificationUri}
              onCancel={() => { if (devicePollRef.current) devicePollRef.current.cancelled = true; setDevice(null); }} />
          )}

          {pasteOpen && (
            <CodexPasteForm value={pasteValue} onChange={setPasteValue} error={pasteError} busy={busy} onConnect={connect}
              onCancel={() => { setPasteOpen(false); setPasteValue(''); setPasteError(null); }} />
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {allTeams ? (
            <span className="text-xs text-text-muted">Paste once — applies the same Codex login to all {teamTargets.length} teams you manage.</span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-surface-3 text-text-muted border border-border-default">
              <span className="w-1.5 h-1.5 rounded-full bg-text-muted" /> Not connected
            </span>
          )}
          {/* Device login mints a buildd-owned session — no pasted file to go stale. Not for all-teams fan-out. */}
          {!allTeams && (device ? (
            <DeviceLoginPanel userCode={device.userCode} verificationUri={device.verificationUri}
              onCancel={() => { if (devicePollRef.current) devicePollRef.current.cancelled = true; setDevice(null); }} />
          ) : (
            <div className="flex items-center gap-3">
              <button onClick={startDeviceLogin} disabled={busy}
                className="h-9 px-4 rounded-lg bg-status-info text-white text-sm font-medium disabled:opacity-50">
                Sign in with device code
              </button>
              <span className="text-xs text-text-muted">Recommended — buildd owns the session, no stale paste</span>
            </div>
          ))}
          <CodexPasteForm value={pasteValue} onChange={setPasteValue} error={pasteError} busy={busy} onConnect={connect} allTeamsCount={allTeams ? teamTargets.length : undefined} />
        </div>
      )}

      {msg && (
        <div className={`text-sm ${msg.type === 'error' ? 'text-status-error' : 'text-status-success'}`}>{msg.text}</div>
      )}
    </div>
  );
}

function CodexPasteForm({ value, onChange, error, busy, onConnect, onCancel, allTeamsCount }: {
  value: string; onChange: (v: string) => void; error: string | null; busy: boolean; onConnect: () => void; onCancel?: () => void; allTeamsCount?: number;
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
        {busy ? 'Connecting…' : allTeamsCount ? `Connect for all ${allTeamsCount} teams` : 'Connect'}
      </button>
    </div>
  );
}

/** Shown while a Codex device-code login is in progress (buildd polls in the background). */
function DeviceLoginPanel({ userCode, verificationUri, onCancel }: { userCode: string; verificationUri: string; onCancel: () => void }) {
  return (
    <div className="rounded-lg border border-status-info/30 bg-status-info/5 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-text-primary">Finish sign-in</div>
        <button onClick={onCancel} className="text-xs text-text-tertiary">Cancel</button>
      </div>
      <ol className="text-xs text-text-secondary space-y-1 list-decimal list-inside">
        <li>
          Open <a href={verificationUri} target="_blank" rel="noopener noreferrer" className="text-status-info underline">{verificationUri}</a>
        </li>
        <li>Enter this code:</li>
      </ol>
      <div className="font-mono text-lg tracking-[0.3em] text-text-primary bg-surface-3 rounded-md px-3 py-2 text-center select-all">
        {userCode}
      </div>
      <div className="flex items-center gap-2 text-xs text-text-muted">
        <span className="w-1.5 h-1.5 rounded-full bg-status-info animate-pulse" />
        Waiting for approval… buildd will connect automatically.
      </div>
      <p className="text-[11px] text-text-muted">
        Device-code login must be enabled in ChatGPT → Settings → Security. Signing in here logs Codex out on other devices for this account.
      </p>
    </div>
  );
}
