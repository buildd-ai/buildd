'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ScopeSelector } from '@/components/ScopeSelector';
import ConnectionRow, { StatusChip } from './_components/ConnectionRow';
import { useConfirm } from '@/components/useConfirm';
import StoredSeatNotice, { storedSeatKinds, type StoredSeatKind } from './StoredSeatNotice';
import { ROTATING_CREDENTIAL_ALL_TEAMS_ERROR } from '@/lib/rotating-credential-scope';

/** Settings → Models → Routing → Agent model endpoint (OpenRouter, LiteLLM). */
const AGENT_ENDPOINT_HREF = '/app/settings/models#agent-endpoint-h';

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
  const toneCls = tone === 'danger' ? 'btn-danger' : '';
  return (
    <button onClick={onClick} disabled={disabled} className={`btn ${toneCls}`}>
      {children}
    </button>
  );
}

/** Shape of a `POST .../{claude,codex}-credential/refresh` response body. */
interface RefreshResponseBody {
  status?: string;
  error?: string;
  detail?: string;
}

/**
 * Turn a credential-refresh response into the card's status message.
 *
 * `ok` is checked before `status` because the route can refuse outright: with
 * `BUILDD_ALLOW_CONTROL_PLANE_REFRESH` off it answers 503 with `error`/`detail`
 * explaining that refresh is runner-originated. Switching on `status` alone fell
 * through to "No credential to refresh." — wrong, and unhelpful, for a
 * credential that is connected and simply cannot be refreshed from here.
 *
 * A refusal renders the server's own text rather than a message keyed off the
 * status code, so the explanation stays accurate if the route rewords it.
 *
 * Exported for unit tests; both credential cards share it.
 */
export function refreshResultMessage(
  ok: boolean,
  data: RefreshResponseBody | null,
): { type: 'success' | 'error'; text: string } {
  if (!ok) {
    const text = [data?.error, data?.detail].filter(Boolean).join(' ');
    return { type: 'error', text: text || 'Failed to refresh token' };
  }
  if (data?.status === 'refreshed') return { type: 'success', text: 'Token refreshed.' };
  if (data?.status === 'locked') return { type: 'success', text: 'Token was refreshed recently.' };
  if (data?.status === 'error') return { type: 'error', text: 'Refresh failed. The credential may be invalid.' };
  return { type: 'error', text: 'No credential to refresh.' };
}

/**
 * Per-backend readiness from `GET /api/teams/[id]/backend-readiness`.
 * `strandedPending` is the whole point: pending tasks whose EFFECTIVE backend
 * (stored backend + the team's provider mask, resolved by the same function the
 * claim route uses) has no credential, so no runner can ever claim them.
 */
interface BackendStrandStat {
  backend: string;
  label: string;
  configured: boolean;
  enabledForTeam: boolean;
  receivesMaskedWork: boolean;
  strandedPending: number;
  sampleTasks: Array<{ id: string; title: string; workspaceName: string | null }>;
}

/**
 * The consequence of a missing credential, in tasks.
 *
 * A "not configured" chip is a shrug — it reads as an option the operator has
 * not taken up. The same fact with a count of work that can never be claimed is
 * a bug report, so this renders only when the backend is actually stranding
 * something. Claude is implicitly configured (it runs on the caller's own auth),
 * so a healthy fleet never sees this.
 */
function StrandedWorkNotice({ stat }: { stat?: BackendStrandStat | null }) {
  if (!stat || stat.strandedPending <= 0) return null;
  const n = stat.strandedPending;
  const plural = n === 1 ? '' : 's';
  const them = n === 1 ? 'it' : 'them';
  const shown = stat.sampleTasks.length;

  return (
    <div className="inset-panel border border-status-error/30 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <StatusChip tone="err">
          Stranding {n} pending task{plural}
        </StatusChip>
        <span className="text-xs text-text-muted">no runner can claim {them}</span>
      </div>
      <p className="text-xs text-text-secondary">
        {n === 1 ? 'This task is' : 'These tasks are'} routed to{' '}
        <strong className="text-text-primary">{stat.label}</strong>, which has no credential for this
        team. Connect it below
        {stat.enabledForTeam ? ', or disable it under Provider routing to reroute the work' : ''}.
        {stat.receivesMaskedWork ? ' Provider routing is also sending another backend\u2019s work here.' : ''}
      </p>
      {shown > 0 && (
        <ul className="space-y-0.5">
          {stat.sampleTasks.map((t) => (
            <li key={t.id} className="text-xs truncate">
              <a href={`/app/tasks/${t.id}`} className="text-text-secondary hover:text-primary">
                {t.title}
              </a>
              {t.workspaceName && <span className="text-text-muted"> · {t.workspaceName}</span>}
            </li>
          ))}
          {n > shown && (
            <li className="text-xs text-text-muted">
              +{n - shown} more
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** The row-level half of StrandedWorkNotice: visible while the row is folded. */
function StrandedChip({ stat }: { stat?: BackendStrandStat | null }) {
  if (!stat || stat.strandedPending <= 0) return null;
  return <StatusChip tone="err">Stranding {stat.strandedPending}</StatusChip>;
}

type RowKey = 'claude' | 'codex' | 'openai_key' | 'routing';

interface Workspace {
  id: string;
  name: string;
  teamId: string;
}

interface Props {
  workspaces: Workspace[];
  currentTeamId: string | null;
  /** Teams where the user may write team credentials: the only "All my teams" targets. Omitted = every team shown. */
  manageableTeamIds?: string[];
  /**
   * May write team-wide and workspace credentials in the active team
   * (`manage_team_credentials`). False: every row shows its status only (the
   * person's own key is under Keys on the same page). Defaults to true.
   */
  canManage?: boolean;
  /** May change provider routing, a team setting (`manage_team_settings`). Defaults to `canManage`. */
  canManageRouting?: boolean;
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
export default function AgentBackendsSection({ workspaces, currentTeamId, manageableTeamIds, canManage = true, canManageRouting = canManage }: Props) {
  const readOnly = !canManage;
  // Only workspaces in the active team can share a team-wide credential.
  const teamWorkspaces = useMemo(
    () => (currentTeamId ? workspaces.filter((w) => w.teamId === currentTeamId) : workspaces),
    [workspaces, currentTeamId],
  );

  // One representative workspace per distinct team the user manages — the fan-out
  // targets ("every team you manage"). Each write is still authorized per-team
  // server-side, so this can only touch teams the user actually belongs to.
  const teamTargets = useMemo<TeamTarget[]>(() => {
    const manageable = manageableTeamIds ? new Set(manageableTeamIds) : null;
    const byTeam = new Map<string, string>();
    for (const w of workspaces) {
      if (manageable && !manageable.has(w.teamId)) continue;
      if (!byTeam.has(w.teamId)) byTeam.set(w.teamId, w.id);
    }
    return Array.from(byTeam, ([teamId, workspaceId]) => ({ teamId, workspaceId }));
  }, [workspaces, manageableTeamIds]);
  const multiTeam = teamTargets.length > 1;

  const [scope, setScope] = useState<Scope>('team');
  // One row open at a time: on a phone two open credential forms are a scroll.
  const [open, setOpen] = useState<RowKey | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string>(teamWorkspaces[0]?.id ?? '');
  // The model key (Anthropic API key; OpenRouter / LiteLLM via an agent
  // endpoint) is the primary Claude path. A subscription sign-in only works on a
  // runner the person hosts and signs in on, so it is folded and says so.
  const [showSeat, setShowSeat] = useState(false);
  // Bumped to move focus to the key field (the row's Add key, or #agent-key).
  const [focusKey, setFocusKey] = useState(0);
  // True when the team already has a setup-token / API-key Claude credential — so the
  // primary Claude card can show "connected via …" instead of a misleading "Connect"
  // when Claude is actually working through the (collapsed) fallback path.
  const [claudeFallbackConnected, setClaudeFallbackConnected] = useState(false);
  // Subscription logins this team stores in buildd (moving to the runner).
  const [storedSeats, setStoredSeats] = useState<StoredSeatKind[]>([]);
  // Per-backend stranding, refetched whenever a credential/routing change could
  // have cleared it (`reloadKey`).
  const [strand, setStrand] = useState<BackendStrandStat[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const refreshStrand = useCallback(() => setReloadKey((k) => k + 1), []);

  // The Codex API is nested under a workspace; for team scope we still need a
  // workspace in the team to authorize + resolve the team id.
  const accessWorkspaceId = scope === 'workspace' ? workspaceId : teamWorkspaces[0]?.id ?? '';
  const teamId = currentTeamId ?? teamWorkspaces[0]?.teamId ?? '';

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    fetch(`/api/secrets?teamId=${teamId}`)
      .then((r) => (r.ok ? r.json() : { secrets: [] }))
      .then((d) => {
        if (cancelled) return;
        const has = (d.secrets || []).some((s: { purpose?: string }) => s.purpose === 'oauth_token' || s.purpose === 'anthropic_api_key');
        setClaudeFallbackConnected(has);
        setStoredSeats(storedSeatKinds(d.secrets));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [teamId, showSeat, open]);

  // Deep link from the getting-started checklist and the failed-task page:
  // /app/settings/models#agent-key opens the Claude row on the key field.
  useEffect(() => {
    if (typeof window === 'undefined' || window.location.hash !== '#agent-key') return;
    setOpen('claude');
    setFocusKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    fetch(`/api/teams/${teamId}/backend-readiness`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d?.backends) return;
        setStrand(d.backends as BackendStrandStat[]);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [teamId, reloadKey]);

  const strandFor = useCallback(
    (backend: string) => strand?.find((b) => b.backend === backend) ?? null,
    [strand],
  );

  if (teamWorkspaces.length === 0) return null;

  const toggle = (k: RowKey) => setOpen((cur) => (cur === k ? null : k));

  // Shared by the Claude and Codex rows (one is open at a time).
  const scopeControl = (
    <div className="space-y-2">
      <p className="text-xs text-text-secondary">
        One sign-in covers every workspace in the team{multiTeam ? <>, or copy a key to all {teamTargets.length} teams you manage</> : null}.
      </p>
      {/* Shared scope selector (also used by connectors/roles, see ScopeSelector). */}
      <ScopeSelector
        scope={scope}
        onScopeChange={setScope}
        workspaceId={workspaceId}
        onWorkspaceChange={setWorkspaceId}
        workspaces={teamWorkspaces}
        allowAllTeams={multiTeam}
        allTeamsCount={teamTargets.length}
      />
    </div>
  );

  return (
    <>
      {readOnly && (
        <p data-testid="credentials-read-only" className="px-4 py-3 text-xs text-text-secondary">
          Admins can change these.
        </p>
      )}
      <StoredSeatNotice kinds={storedSeats} />
      {/* Claude: the one-tap OAuth connect is the primary path. Setup token / API
          key is a collapsed fallback inside the same row. */}
      <ClaudeConnectedAccountCard
        accessWorkspaceId={accessWorkspaceId}
        scope={scope}
        teamTargets={teamTargets}
        fallbackConnected={claudeFallbackConnected}
        strand={strandFor('claude')}
        open={open === 'claude'}
        onToggle={() => toggle('claude')}
        onOpen={() => setOpen('claude')}
        readOnly={readOnly}
        onAddKey={() => { setOpen('claude'); setFocusKey((k) => k + 1); }}
        seatOpen={showSeat}
        onSeatToggle={() => setShowSeat((v) => !v)}
        scopeControl={scopeControl}
        keyForm={
          <div className="space-y-3">
            <ClaudeCard mode="api_key" teamId={teamId} scope={scope} workspaceId={scope === 'workspace' ? workspaceId : null} teamTargets={teamTargets} focusRequest={focusKey} />
            <p className="text-xs text-text-secondary">
              Using OpenRouter or a LiteLLM gateway instead?{' '}
              <a href={AGENT_ENDPOINT_HREF} className="text-accent-text hover:underline">Add it as the agent model endpoint</a>.
            </p>
          </div>
        }
      >
        <ClaudeCard mode="setup_token" teamId={teamId} scope={scope} workspaceId={scope === 'workspace' ? workspaceId : null} teamTargets={teamTargets} />
      </ClaudeConnectedAccountCard>
      <CodexCard
        accessWorkspaceId={accessWorkspaceId}
        scope={scope}
        teamTargets={teamTargets}
        strand={strandFor('codex')}
        onCredentialChange={refreshStrand}
        open={open === 'codex'}
        onToggle={() => toggle('codex')}
        onOpen={() => setOpen('codex')}
        scopeControl={scopeControl}
        readOnly={readOnly}
      />
      {/* A plain OpenAI API key is the simpler alternative to connecting ChatGPT
          above — same purpose (Codex agent tasks), stored like the Anthropic key. */}
      <OpenAiApiKeyCard
        teamId={teamId}
        scope={scope}
        workspaceId={scope === 'workspace' ? workspaceId : null}
        teamTargets={teamTargets}
        strand={strandFor('codex')}
        onCredentialChange={refreshStrand}
        open={open === 'openai_key'}
        onToggle={() => toggle('openai_key')}
        scopeControl={scopeControl}
        readOnly={readOnly}
      />
      {/* Team provider routing toggle (reversible mask over the resolution chain) */}
      <ProviderRoutingToggle
        teamId={teamId}
        workspaceId={teamWorkspaces[0]?.id ?? ''}
        onRoutingChange={refreshStrand}
        open={open === 'routing'}
        onToggle={() => toggle('routing')}
        readOnly={!canManageRouting}
      />
    </>
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
function ProviderRoutingToggle({
  teamId,
  workspaceId,
  onRoutingChange,
  open,
  onToggle,
  readOnly = false,
}: {
  teamId: string;
  workspaceId: string;
  onRoutingChange?: () => void;
  open: boolean;
  onToggle: () => void;
  /** Status only: changing routing is a team setting the person does not hold. */
  readOnly?: boolean;
}) {
  const [enabled, setEnabled] = useState<RoutingBackend[] | null>(null); // null = loading/all
  // Track which backends have credentials configured so we can block stranding toggles.
  // claude is always available (implicitly configured via account auth).
  const [configured, setConfigured] = useState<Record<RoutingBackend, boolean>>({ claude: true, codex: false });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!teamId) return;
    try {
      const fetches: [Promise<Response>, Promise<Response> | null] = [
        fetch(`/api/teams/${teamId}`),
        workspaceId ? fetch(`/api/workspaces/${workspaceId}/backends`) : null,
      ];
      const [teamRes, backendRes] = await Promise.all(fetches);
      if (teamRes.ok) {
        const data = await teamRes.json();
        const eb = data.team?.enabledBackends as RoutingBackend[] | null | undefined;
        setEnabled(eb && eb.length ? eb : ALL_BACKENDS); // null/empty => all enabled
      }
      if (backendRes?.ok) {
        const data = await backendRes.json();
        const map: Record<string, boolean> = {};
        for (const b of (data.backends ?? []) as { id: string; available: boolean }[]) map[b.id] = b.available;
        setConfigured({
          claude: map['claude'] ?? true, // claude is always configured
          codex: map['codex'] ?? false,
        });
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
      setMsg({ type: 'error', text: 'At least one provider must stay enabled.' });
      return;
    }
    // Refuse if no backend in the proposed enabled set has credentials configured.
    // This prevents stranding pending tasks in a permanently unclaimable state.
    const hasConfiguredBackend = next.some((id) => configured[id] ?? false);
    if (!hasConfiguredBackend) {
      const unconfigured = next.filter((id) => !(configured[id] ?? false));
      setMsg({
        type: 'error',
        text: `${unconfigured.map(backendLabel).join(' & ')} ${unconfigured.length === 1 ? 'has' : 'have'} no credentials configured. Enabling it alone would strand all pending tasks. Add ${unconfigured.map(backendLabel).join(' & ')} credentials first.`,
      });
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
      // The mask decides which backend each task effectively runs on, so a
      // toggle can create or clear stranded work. Recount.
      onRoutingChange?.();
      const off = ALL_BACKENDS.filter((x) => !next.includes(x));
      setMsg({
        type: 'success',
        text: off.length
          ? `${off.map(backendLabel).join(' & ')} disabled. Jobs run on ${next.map(backendLabel).join(' & ')}.`
          : 'Both providers enabled (default routing).',
      });
    } catch (e) {
      setEnabled(prev); // rollback optimistic update
      setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Failed to update' });
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
              <span className="text-xs text-text-muted">{isOn(b) ? 'enabled' : 'disabled · jobs reroute'}</span>
            </span>
            <button
              onClick={() => toggle(b)}
              disabled={busy || !loaded}
              className="btn"
            >
              {isOn(b) ? 'Disable' : 'Enable'}
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

/**
 * One stored Claude credential kind: `api_key` (an Anthropic API key, the
 * primary path) or `setup_token` (a `claude setup-token` seat, folded under the
 * self-hosted-runner sign-in). `focusRequest` changes move focus to the field.
 */
function ClaudeCard({ mode, teamId, scope, workspaceId, teamTargets, focusRequest = 0 }: { mode: 'api_key' | 'setup_token'; teamId: string; scope: Scope; workspaceId: string | null; teamTargets: TeamTarget[]; focusRequest?: number }) {
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const purpose: ClaudePurpose = mode === 'api_key' ? 'anthropic_api_key' : 'oauth_token';
  const inputRef = useRef<HTMLInputElement | null>(null);
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

  // Credentials of this kind matching the selected scope.
  const matching = secrets.filter(
    (s) =>
      s.purpose === purpose &&
      (scope === 'workspace' ? s.workspaceId === workspaceId : s.workspaceId === null),
  );

  // Focus the field once it is on screen (it waits for the credential list).
  useEffect(() => {
    if (!focusRequest || loading) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.scrollIntoView?.({ block: 'center' });
  }, [focusRequest, loading, matching.length]);

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
      setMsg({ type: 'success', text: mode === 'api_key' ? 'API key saved.' : 'Setup token saved.' });
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
        setMsg({ type: 'error', text: 'Revoked: a worker run was logged out. Run `claude setup-token` and paste the new token.' });
      } else if (data.verified) {
        setMsg({ type: 'success', text: 'Verified.' });
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
      <input
        ref={inputRef}
        id={mode === 'api_key' ? 'agent-key' : undefined}
        aria-label={mode === 'api_key' ? 'Anthropic API key' : 'Claude setup token'}
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        className="w-full h-10 px-3 bg-surface font-mono text-xs"
      />
      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={busy || !value.trim()}
          className="btn btn-primary"
        >
          {busy ? 'Saving…' : allTeams ? `Apply to all ${teamTargets.length} teams` : matching.length > 0 ? 'Replace' : mode === 'api_key' ? 'Save key' : 'Save token'}
        </button>
        {replaceOpen && (
          <button onClick={() => { setReplaceOpen(false); setValue(''); }} className="btn btn-quiet">Cancel</button>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium text-text-primary">{mode === 'api_key' ? 'Anthropic API key' : 'Setup token'}</h3>
        <p className="text-xs text-text-secondary mt-0.5">
          {mode === 'api_key'
            ? <>Agents run on your own key and you pay Anthropic per token. Create one in the Anthropic console.</>
            : <>An OAuth token from <code className="bg-surface-3 px-1 text-[11px]">claude setup-token</code>, for a runner you host.</>}
        </p>
      </div>

      {loading ? (
        <div className="text-sm text-text-tertiary">Loading…</div>
      ) : matching.length > 0 ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            {matching[0].healthStatus === 'revoked' ? (
              <StatusChip tone="err">Revoked · re-auth required</StatusChip>
            ) : matching[0].healthStatus === 'degraded' ? (
              <StatusChip tone="warn">Degraded · auth failures</StatusChip>
            ) : (
              <StatusChip tone="ok">Connected</StatusChip>
            )}
            <span className="text-xs text-text-muted">{matching[0].workspaceId ? 'this workspace' : 'all workspaces'}</span>
          </div>

          <div className="inset-panel space-y-1 text-xs text-text-secondary">
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
                  ? <span className="text-status-error"> · failed: {matching[0].lastVerificationError}</span>
                  : <span className="text-status-success"> · passed</span>}
              </div>
            )}
            {(matching[0].healthStatus === 'revoked' || matching[0].healthStatus === 'degraded') && matching[0].lastFailureAt && (
              <div className="text-status-error">
                Last failure: {new Date(matching[0].lastFailureAt).toLocaleString()}
                {matching[0].lastFailureMessage && ` · ${matching[0].lastFailureMessage.slice(0, 120)}`}
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
          ) : mode === 'setup_token' ? (
            <StatusChip tone="idle">Not connected</StatusChip>
          ) : null}
          {inputForm}
        </div>
      )}

      {msg && (
        <div className={`text-sm ${msg.type === 'error' ? 'text-status-error' : 'text-status-success'}`}>{msg.text}</div>
      )}
    </div>
  );
}

// ── OpenAI API key (Codex agent tasks) ──────────────────────────────────────────
//
// The simpler alternative to connecting ChatGPT in the Codex card above: one
// raw API key, stored exactly like the Anthropic key (`openai_api_key`
// purpose, see docs/credentials-architecture.md). Injected into Codex-backend
// tasks the same way `codex_credential` is, so either one makes Codex runnable.

function OpenAiApiKeyCard({
  teamId, scope, workspaceId, teamTargets, strand, onCredentialChange, open, onToggle, scopeControl, readOnly,
}: {
  teamId: string; scope: Scope; workspaceId: string | null; teamTargets: TeamTarget[]; strand?: BackendStrandStat | null;
  onCredentialChange?: () => void;
} & Omit<RowProps, 'onOpen'>) {
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [value, setValue] = useState('');
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [replaceOpen, setReplaceOpen] = useState(false);

  const allTeams = scope === 'all_teams';

  const load = useCallback(async () => {
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
    if (!open) return;
    setReplaceOpen(false);
    setValue('');
    void load();
  }, [load, open]);

  const matching = secrets.filter(
    (s) => s.purpose === 'openai_api_key' && (scope === 'workspace' ? s.workspaceId === workspaceId : s.workspaceId === null),
  );

  async function save() {
    setBusy(true);
    setMsg(null);
    const cleanValue = sanitizeToken(value);
    try {
      if (allTeams) {
        const results = await Promise.all(
          teamTargets.map((t) =>
            fetch('/api/secrets', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ value: cleanValue, purpose: 'openai_api_key', teamId: t.teamId }),
            }).then((r) => r.ok).catch(() => false),
          ),
        );
        const ok = results.filter(Boolean).length;
        setValue('');
        setMsg({ type: ok > 0 ? 'success' : 'error', text: `OpenAI API key saved for ${ok} of ${teamTargets.length} teams.` });
        onCredentialChange?.();
        return;
      }
      const res = await fetch('/api/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          value: cleanValue,
          purpose: 'openai_api_key',
          teamId,
          ...(scope === 'workspace' && workspaceId ? { workspaceId } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to save');
      setValue('');
      setReplaceOpen(false);
      setMsg({ type: 'success', text: 'OpenAI API key saved.' });
      await load();
      onCredentialChange?.();
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
      setMsg({ type: 'success', text: 'Key removed.' });
      setReplaceOpen(false);
      await load();
      onCredentialChange?.();
    } catch {
      setMsg({ type: 'error', text: 'Failed to remove key' });
    } finally {
      setBusy(false);
    }
  }

  const inputForm = (
    <div className="space-y-2">
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="sk-… (OpenAI API key)"
        className="w-full h-10 px-3 bg-surface font-mono text-xs"
      />
      <div className="flex items-center gap-3">
        <button onClick={save} disabled={busy || !value.trim()} className="btn btn-primary">
          {busy ? 'Saving…' : allTeams ? `Apply to all ${teamTargets.length} teams` : matching.length > 0 ? 'Replace' : 'Save key'}
        </button>
        {replaceOpen && (
          <button onClick={() => { setReplaceOpen(false); setValue(''); }} className="btn btn-quiet">Cancel</button>
        )}
      </div>
    </div>
  );

  return (
    <ConnectionRow
      testId="openai-key-row"
      title="OpenAI API key"
      chip={matching.length > 0 ? <StatusChip tone="ok">Connected</StatusChip> : <StatusChip tone="idle">Not connected</StatusChip>}
      meta="For Codex tasks, instead of a ChatGPT sign-in."
      open={open}
      onToggle={onToggle}
      readOnly={readOnly}
    >
      {scopeControl}
      <StrandedWorkNotice stat={strand} />
      {loading ? (
        <div className="text-sm text-text-tertiary">Loading…</div>
      ) : matching.length > 0 ? (
        <div className="space-y-3">
          <div className="inset-panel space-y-1 text-xs text-text-secondary">
            <div>Scope: {matching[0].workspaceId ? 'this workspace' : 'all workspaces'}</div>
            {matching[0].createdAt && <div>Connected: {new Date(matching[0].createdAt).toLocaleString()}</div>}
          </div>
          <CredActionRow>
            {!replaceOpen && (
              <CredAction onClick={() => { setReplaceOpen(true); setValue(''); setMsg(null); }}>Replace</CredAction>
            )}
            {matching.map((s) => (
              <CredAction key={s.id} onClick={() => revoke(s.id)} disabled={busy} tone="danger">Revoke</CredAction>
            ))}
          </CredActionRow>
          {replaceOpen && inputForm}
        </div>
      ) : (
        <div className="space-y-3">
          {allTeams && (
            <span className="text-xs text-text-muted">Applies the same key to all {teamTargets.length} teams you manage.</span>
          )}
          {inputForm}
        </div>
      )}
      {msg && <div className={`text-sm ${msg.type === 'error' ? 'text-status-error' : 'text-status-success'}`}>{msg.text}</div>}
    </ConnectionRow>
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
  healthStatus: 'healthy' | 'degraded' | 'revoked' | 'unknown' | null;
  scope: 'team' | 'workspace' | null;
}

// `strand` is rendered for symmetry with every other backend, and is registry-
// driven rather than hardcoded: Claude is `implicitlyConfigured` today (it runs
// on the caller's own auth), so its count is structurally 0 and the notice stays
// invisible — which is the point. No onCredentialChange: adding or revoking a
// Claude credential cannot change whether Claude can run work.
interface RowProps {
  open: boolean;
  onToggle: () => void;
  /** Open the row: its primary action needs the panel underneath. */
  onOpen: () => void;
  /** The shared "applies to" control, drawn at the top of the open row. */
  scopeControl: ReactNode;
  /** Status only: no toggle, action or controls (the person cannot change it). */
  readOnly?: boolean;
}

/**
 * The Claude row. Its body leads with `keyForm` (the model key, the primary
 * path); the subscription sign-in (OAuth connect, pasted .credentials.json and
 * `children`, the setup token) is folded under one disclosure labelled
 * self-hosted runner only, open by default only for a team already signed in.
 */
function ClaudeConnectedAccountCard({ accessWorkspaceId, scope, teamTargets, fallbackConnected = false, strand, open, onToggle, onOpen, readOnly, onAddKey, seatOpen, onSeatToggle, keyForm, scopeControl, children }: { accessWorkspaceId: string; scope: Scope; teamTargets: TeamTarget[]; fallbackConnected?: boolean; strand?: BackendStrandStat | null; onAddKey: () => void; seatOpen: boolean; onSeatToggle: () => void; keyForm: ReactNode; children?: ReactNode } & RowProps) {
  const { confirm, confirmDialog } = useConfirm();
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
      setStatus(data);
      setMsg({ type: 'success', text: 'Claude connected.' });
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
      setMsg({ type: 'success', text: 'Claude account connected.' });
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
      // A refusal (503, control-plane refresh disabled) carries its own explanation
      // in the body — surface it instead of guessing from `status`.
      const data = await res.json().catch(() => null) as RefreshResponseBody | null;
      setMsg(refreshResultMessage(res.ok, data));
      if (res.ok && data?.status === 'refreshed') await load();
    } catch {
      setMsg({ type: 'error', text: 'Failed to refresh token' });
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!(await confirm({ title: 'Remove Claude account?', message: 'Deletes the stored Claude connected account.', confirmLabel: 'Remove', variant: 'danger' }))) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${base}${q}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) throw new Error('Delete failed');
      setStatus({ connected: false, expired: false, lastRefreshedAt: null, lastVerifiedAt: null, lastVerificationError: null, healthStatus: null, scope: null });
      setMsg({ type: 'success', text: 'Credential removed.' });
    } catch {
      setMsg({ type: 'error', text: 'Failed to remove credential' });
    } finally {
      setBusy(false);
    }
  }

  const chip = loading || allTeams ? undefined : status?.connected
    ? (status.expired ? <StatusChip tone="warn">Expired</StatusChip> : <StatusChip tone="ok">Connected</StatusChip>)
    : fallbackConnected ? <StatusChip tone="ok">Connected</StatusChip> : <StatusChip tone="idle">Not connected</StatusChip>;
  const where = status?.scope === 'workspace' ? 'this workspace' : 'all workspaces';
  const meta = loading ? 'Checking…'
    : allTeams ? `Applies to all ${teamTargets.length} teams you manage`
    : status?.connected ? `Subscription sign-in · ${where}${status.lastVerifiedAt ? ` · verified ${new Date(status.lastVerifiedAt).toLocaleDateString()}` : ''}`
    : fallbackConnected ? 'API key or setup token'
    : 'API key: Anthropic, OpenRouter or LiteLLM';
  // An expired sign-in is reconnected; with nothing stored the next step is a key.
  const needsReconnect = !loading && !allTeams && !oauth && !!status?.connected && status.expired;
  const needsKey = !loading && !allTeams && !status?.connected && !fallbackConnected;
  const seatShown = seatOpen || !!status?.connected || !!oauth;

  return (
    <ConnectionRow
      testId="claude-row"
      title="Claude"
      chip={<>{chip}<StrandedChip stat={strand} /></>}
      meta={meta}
      open={open}
      onToggle={onToggle}
      readOnly={readOnly}
      action={needsReconnect ? (
        <button onClick={() => { onOpen(); void startOAuth(); }} disabled={busy} className="btn">
          Reconnect
        </button>
      ) : needsKey ? (
        <button onClick={onAddKey} className="btn">
          Add key
        </button>
      ) : undefined}
    >
      {scopeControl}

      <StrandedWorkNotice stat={strand} />

      {keyForm}

      <div className="border-t border-border-default pt-3">
        <button
          type="button"
          onClick={onSeatToggle}
          aria-expanded={seatShown}
          // .btn is nowrap + fixed 32px; this label is too long for a phone,
          // so let it wrap (it used to push /app/settings into a sideways pan).
          className="btn btn-quiet h-auto min-h-11 md:min-h-8 py-1.5 whitespace-normal text-left justify-start leading-snug max-w-full"
        >
          {seatShown ? '▾' : '▸'} Claude subscription sign-in · self-hosted runner only
        </button>
        {seatShown && (
        <div className="mt-3 space-y-3 pl-3 border-l-2 border-border-default">
        <p className="text-xs text-text-muted">
          A Claude Pro or Max login runs agents only on a runner you host and sign in on yourself. Buildd&apos;s cloud runner needs an API key.
        </p>
      {loading ? (
        <div className="text-sm text-text-tertiary">Loading…</div>
      ) : status?.connected ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            {status.expired ? (
              <StatusChip tone="warn">Expired · reconnect</StatusChip>
            ) : (
              <StatusChip tone="ok">Connected</StatusChip>
            )}
            <span className="text-xs text-text-muted">{status.scope === 'workspace' ? 'this workspace' : 'all workspaces'}</span>
            {status.expired && status.healthStatus === 'revoked' && fallbackConnected && (
              <StatusChip tone="ok">Workers using setup token as fallback</StatusChip>
            )}
          </div>

          <div className="inset-panel space-y-1 text-xs text-text-secondary">
            {status.lastRefreshedAt && <div>Last refreshed: {new Date(status.lastRefreshedAt).toLocaleString()}</div>}
            {status.lastVerifiedAt && (
              <div>
                Last verified: {new Date(status.lastVerifiedAt).toLocaleString()}
                {status.lastVerificationError
                  ? <span className="text-status-error"> · failed: {status.lastVerificationError}</span>
                  : <span className="text-status-success"> · passed</span>}
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
      ) : allTeams ? (
        <p data-testid="claude-seat-all-teams" className="text-xs text-text-muted">{ROTATING_CREDENTIAL_ALL_TEAMS_ERROR}</p>
      ) : (
        <div className="space-y-3">
          {fallbackConnected ? (
            <StatusChip tone="ok">Connected via setup token / API key</StatusChip>
          ) : (
            <StatusChip tone="idle">Not connected</StatusChip>
          )}
          {/* OAuth connect (short code) is the clean primary path. */}
          {oauth ? (
            <ClaudeOAuthPanel authorizeUrl={oauth.authorizeUrl} code={oauthCode} onChange={setOauthCode} busy={busy}
              onSubmit={submitOAuthCode} onCancel={() => { setOauth(null); setOauthCode(''); }} />
          ) : (
            <div className="space-y-1.5">
              <button onClick={startOAuth} disabled={busy} className="btn btn-primary">
                Connect with Claude
              </button>
              {/* Explanation sits under the button, not beside it: the label stays one
                  line at any width instead of wrapping inside the button box. */}
              <p className="text-xs text-text-muted">
                {fallbackConnected
                  ? 'Replaces the setup token. Approve in the browser, then paste the code.'
                  : 'Approve in the browser, then paste the code.'}
              </p>
            </div>
          )}
          {!pasteOpen ? (
            <button onClick={() => { setPasteOpen(true); setPasteValue(''); setPasteError(null); }} className="btn btn-quiet">
              Paste .credentials.json instead
            </button>
          ) : (
            <ClaudeCredentialsPasteForm value={pasteValue} onChange={setPasteValue} error={pasteError} busy={busy} onConnect={connect}
              onCancel={() => { setPasteOpen(false); setPasteValue(''); setPasteError(null); }} />
          )}
        </div>
      )}

      {msg && (
        <div className={`text-sm ${msg.type === 'error' ? 'text-status-error' : 'text-status-success'}`}>{msg.text}</div>
      )}
      {children && <div className="border-t border-border-default pt-3">{children}</div>}
        </div>
        )}
      </div>
      {confirmDialog}
    </ConnectionRow>
  );
}

function ClaudeCredentialsPasteForm({ value, onChange, error, busy, onConnect, onCancel }: {
  value: string; onChange: (v: string) => void; error: string | null; busy: boolean; onConnect: () => void; onCancel?: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">Paste .credentials.json</div>
        {onCancel && <button onClick={onCancel} className="btn btn-quiet">Cancel</button>}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={'{\n  "access_token": "...",\n  "refresh_token": "...",\n  "expires_at": 1700000000\n}'}
        rows={6}
        className="w-full px-3 py-2 bg-surface font-mono text-xs resize-y"
      />
      {error && <div className="text-sm text-status-error">{error}</div>}
      <button onClick={onConnect} disabled={busy || !value.trim()} className="btn btn-primary">
        {busy ? 'Connecting…' : 'Connect'}
      </button>
    </div>
  );
}

/** In-progress Claude OAuth connect: approve in the opened tab, paste the short code back. */
function ClaudeOAuthPanel({ authorizeUrl, code, onChange, busy, onSubmit, onCancel }: {
  authorizeUrl: string; code: string; onChange: (v: string) => void; busy: boolean; onSubmit: () => void; onCancel: () => void;
}) {
  return (
    <div className="card p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-text-primary">Finish connecting Claude</div>
        <button onClick={onCancel} className="btn btn-quiet">Cancel</button>
      </div>
      <ol className="text-xs text-text-secondary space-y-1 list-decimal list-inside">
        <li>Approve in the Claude tab buildd opened (<a href={authorizeUrl} target="_blank" rel="noopener noreferrer" className="text-accent-text underline">reopen</a>).</li>
        <li>Copy the code Claude shows and paste it here:</li>
      </ol>
      <input
        type="text"
        value={code}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Code (looks like abc…#def…)"
        className="w-full px-3 py-2 bg-surface font-mono text-xs"
        onKeyDown={(e) => { if (e.key === 'Enter' && code.trim() && !busy) onSubmit(); }}
      />
      <button onClick={onSubmit} disabled={busy || !code.trim()} className="btn btn-primary">
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

function CodexCard({ accessWorkspaceId, scope, teamTargets, strand, onCredentialChange, open, onToggle, onOpen, scopeControl, readOnly }: { accessWorkspaceId: string; scope: Scope; teamTargets: TeamTarget[]; strand?: BackendStrandStat | null; onCredentialChange?: () => void } & RowProps) {
  const { confirm, confirmDialog } = useConfirm();
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
          setMsg({ type: 'success', text: 'Codex connected.' });
          onCredentialChange?.();
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
      onCredentialChange?.();
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
      // A refusal (503, control-plane refresh disabled) carries its own explanation
      // in the body — surface it instead of guessing from `status`.
      const data = await res.json().catch(() => null) as RefreshResponseBody | null;
      setMsg(refreshResultMessage(res.ok, data));
      if (res.ok && data?.status === 'refreshed') await load();
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
    if (!(await confirm({ title: 'Remove Codex credential?', message: 'Deletes the stored Codex credential.', confirmLabel: 'Remove', variant: 'danger' }))) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${base}${q}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) throw new Error('Delete failed');
      setStatus({ connected: false, expired: false, accountId: null, lastRefreshedAt: null, lastVerifiedAt: null, lastVerificationError: null, scope: null });
      setMsg({ type: 'success', text: 'Credential removed.' });
      // Revoking can strand work that was fine a second ago — recount.
      onCredentialChange?.();
    } catch {
      setMsg({ type: 'error', text: 'Failed to remove credential' });
    } finally {
      setBusy(false);
    }
  }

  const chip = loading || allTeams ? undefined : status?.connected
    ? (status.expired ? <StatusChip tone="warn">Expired</StatusChip> : <StatusChip tone="ok">Connected</StatusChip>)
    : <StatusChip tone="idle">Not connected</StatusChip>;
  const where = status?.scope === 'workspace' ? 'this workspace' : 'all workspaces';
  const meta = loading ? 'Checking…'
    : allTeams ? `Applies to all ${teamTargets.length} teams you manage`
    : status?.connected ? `${status.accountId ? `${status.accountId} · ` : ''}${where}`
    : 'ChatGPT sign-in';
  const needsSignIn = !loading && !allTeams && !device && (!status?.connected || status.expired);

  return (
    <ConnectionRow
      testId="codex-row"
      title="Codex"
      chip={<>{chip}<StrandedChip stat={strand} /></>}
      meta={meta}
      open={open}
      onToggle={onToggle}
      readOnly={readOnly}
      action={needsSignIn ? (
        <button onClick={() => { onOpen(); void startDeviceLogin(); }} disabled={busy} className="btn">
          Sign in
        </button>
      ) : undefined}
    >
      {scopeControl}

      <StrandedWorkNotice stat={strand} />

      {loading ? (
        <div className="text-sm text-text-tertiary">Loading…</div>
      ) : status?.connected ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            {status.expired ? (
              <StatusChip tone="warn">Expired · refresh needed</StatusChip>
            ) : (
              <StatusChip tone="ok">Connected</StatusChip>
            )}
            <span className="text-xs text-text-muted">{status.scope === 'workspace' ? 'this workspace' : 'all workspaces'}</span>
          </div>

          <div className="inset-panel space-y-1 text-xs text-text-secondary">
            {status.accountId && <div>Account: <span className="font-mono text-text-primary">{status.accountId}</span></div>}
            {status.lastRefreshedAt && <div>Last refreshed: {new Date(status.lastRefreshedAt).toLocaleString()}</div>}
            {status.lastVerifiedAt && (
              <div>
                Last verified: {new Date(status.lastVerifiedAt).toLocaleString()}
                {status.lastVerificationError
                  ? <span className="text-status-error"> · failed: {status.lastVerificationError}</span>
                  : <span className="text-status-success"> · passed</span>}
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
      ) : allTeams ? (
        <p data-testid="codex-all-teams" className="text-xs text-text-muted">{ROTATING_CREDENTIAL_ALL_TEAMS_ERROR}</p>
      ) : (
        <div className="space-y-3">
          <StatusChip tone="idle">Not connected</StatusChip>
          {/* Device login mints a buildd-owned session — no pasted file to go stale. */}
          {device ? (
            <DeviceLoginPanel userCode={device.userCode} verificationUri={device.verificationUri}
              onCancel={() => { if (devicePollRef.current) devicePollRef.current.cancelled = true; setDevice(null); }} />
          ) : (
            <div className="space-y-1.5">
              <button onClick={startDeviceLogin} disabled={busy}
                className="btn btn-primary">
                Sign in with device code
              </button>
              <p className="text-xs text-text-muted">Recommended.</p>
            </div>
          )}
          <CodexPasteForm value={pasteValue} onChange={setPasteValue} error={pasteError} busy={busy} onConnect={connect} />
        </div>
      )}

      {msg && (
        <div className={`text-sm ${msg.type === 'error' ? 'text-status-error' : 'text-status-success'}`}>{msg.text}</div>
      )}
      {confirmDialog}
    </ConnectionRow>
  );
}

function CodexPasteForm({ value, onChange, error, busy, onConnect, onCancel }: {
  value: string; onChange: (v: string) => void; error: string | null; busy: boolean; onConnect: () => void; onCancel?: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">Paste <code className="font-mono text-[12px]">~/.codex/auth.json</code></div>
        {onCancel && <button onClick={onCancel} className="btn btn-quiet">Cancel</button>}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={'{\n  "access_token": "...",\n  "refresh_token": "...",\n  "account_id": "..."\n}'}
        rows={6}
        className="w-full px-3 py-2 bg-surface font-mono text-xs resize-y"
      />
      {error && <div className="text-sm text-status-error">{error}</div>}
      <button onClick={onConnect} disabled={busy || !value.trim()} className="btn btn-primary">
        {busy ? 'Connecting…' : 'Connect'}
      </button>
    </div>
  );
}

/** Shown while a Codex device-code login is in progress (buildd polls in the background). */
function DeviceLoginPanel({ userCode, verificationUri, onCancel }: { userCode: string; verificationUri: string; onCancel: () => void }) {
  return (
    <div className="card p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-text-primary">Finish sign-in</div>
        <button onClick={onCancel} className="btn btn-quiet">Cancel</button>
      </div>
      <ol className="text-xs text-text-secondary space-y-1 list-decimal list-inside">
        <li>
          Open <a href={verificationUri} target="_blank" rel="noopener noreferrer" className="text-accent-text underline">{verificationUri}</a>
        </li>
        <li>Enter this code:</li>
      </ol>
      <div className="font-mono text-lg tracking-[0.3em] text-text-primary inset-panel text-center select-all">
        {userCode}
      </div>
      <div className="flex items-center gap-2 text-xs text-text-muted">
        <span className="w-2 h-2 bg-accent animate-pulse" />
        Waiting for approval…
      </div>
      <p className="text-[11px] text-text-muted">
        Requires device-code login (ChatGPT → Settings → Security). Signs this account out of Codex elsewhere.
      </p>
    </div>
  );
}
