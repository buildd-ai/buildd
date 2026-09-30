'use client';

import { useCallback, useEffect, useState } from 'react';
import { Select } from '@/components/ui/Select';

/** Select value for the team-wide scope (a workspace id is never this). */
const ALL_WORKSPACES = '__all__';

/**
 * Settings → Model providers: where runner-spawned agents send model traffic
 * (docs/design/agent-model-endpoint.md §6). Anthropic is the default and means
 * no row. The key never comes back beyond last4.
 */

type Kind = 'gateway' | 'openrouter' | 'anthropic-compatible';
type Choice = 'anthropic' | Kind;

export interface MaskedAgentEndpointView {
  id: string;
  scope: 'team' | 'workspace';
  workspaceId: string | null;
  workspaceName: string | null;
  kind: Kind;
  baseUrl: string;
  authHeader: 'authorization' | 'x-api-key';
  models: Record<string, string>;
  last4: string;
  gatewayMissing: boolean;
  health: 'healthy' | 'revoked' | 'unknown';
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
}

export interface EndpointWorkspace { id: string; name: string }

const INPUT = 'w-full h-10 px-3 bg-surface-1 border border-border-default focus:border-primary outline-none font-mono text-xs';

const KIND_LABEL: Record<Kind, string> = {
  gateway: 'Team gateway',
  openrouter: 'OpenRouter',
  'anthropic-compatible': 'Anthropic-compatible URL',
};

async function errorText(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({} as Record<string, unknown>));
  return typeof body.error === 'string' ? body.error : `Request failed (HTTP ${res.status})`;
}

/** `native-id = alias`, one per line. Blank lines and `#` comments are skipped. */
export function parseAliasLines(text: string): { ok: true; models: Record<string, string> } | { ok: false; error: string } {
  const models: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    const from = eq > 0 ? line.slice(0, eq).trim() : '';
    const to = eq > 0 ? line.slice(eq + 1).trim() : '';
    if (!from || !to || /\s/.test(from) || /\s/.test(to)) return { ok: false, error: `Write each alias as model-id = alias: "${line}"` };
    models[from] = to;
  }
  return { ok: true, models };
}

export function aliasLines(models: Record<string, string>): string {
  return Object.entries(models).map(([k, v]) => `${k} = ${v}`).join('\n');
}

function healthLine(e: MaskedAgentEndpointView): string {
  if (e.gatewayMissing) return 'The team gateway it uses is not connected';
  if (e.health === 'healthy') return `Working${e.lastVerifiedAt ? `, checked ${new Date(e.lastVerifiedAt).toLocaleString()}` : ''}`;
  if (e.health === 'revoked') return `Rejected the key${e.lastVerificationError ? `: ${e.lastVerificationError}` : ''}`;
  return `Not confirmed${e.lastVerificationError ? `: ${e.lastVerificationError}` : ''}`;
}

export function endpointSummary(e: MaskedAgentEndpointView): string {
  const parts = [KIND_LABEL[e.kind]];
  if (e.baseUrl) parts.push(e.baseUrl);
  if (e.last4) parts.push(`key …${e.last4}`);
  return parts.join(' · ');
}

export default function AgentEndpointSection({ teamId, canManage, workspaces }: {
  teamId: string;
  canManage: boolean;
  workspaces: EndpointWorkspace[];
}) {
  const [endpoints, setEndpoints] = useState<MaskedAgentEndpointView[] | undefined>(undefined);
  const [hasGateway, setHasGateway] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [e, g] = await Promise.all([
        fetch(`/api/teams/${teamId}/agent-endpoint`, { cache: 'no-store' }),
        fetch(`/api/teams/${teamId}/litellm-gateway`, { cache: 'no-store' }),
      ]);
      if (!e.ok) throw new Error(await errorText(e));
      setEndpoints(((await e.json()) as { endpoints: MaskedAgentEndpointView[] }).endpoints ?? []);
      if (g.ok) setHasGateway(!!((await g.json()) as { gateway: unknown }).gateway);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load');
    }
  }, [teamId]);

  useEffect(() => { void load(); }, [load]);

  const team = endpoints?.find((e) => e.scope === 'team') ?? null;
  const scoped = endpoints?.filter((e) => e.scope === 'workspace') ?? [];
  const status = endpoints === undefined
    ? 'Loading…'
    : team
      ? endpointSummary(team)
      : 'Anthropic (default)';

  return (
    <section aria-labelledby="agent-endpoint-h" data-testid="agent-endpoint">
      <h2 id="agent-endpoint-h" className="section-label mb-3">Agent model endpoint</h2>
      <div className="card p-4 space-y-3 text-xs">
        <div className="space-y-1">
          <p className="text-sm text-text-primary" data-testid="agent-endpoint-status">{status}</p>
          {team && <p className="text-text-secondary" data-testid="agent-endpoint-health">{healthLine(team)}</p>}
        </div>
        {endpoints !== undefined && endpoints.length > 0 ? (
          <p className="notice notice-info text-xs" data-testid="agent-endpoint-metered">
            Agent runs are metered through this endpoint: they spend its key&apos;s budget, not a Claude seat, and the
            per-run dollar cap applies.
          </p>
        ) : (
          <p className="text-text-muted">
            Runner agents use the team&apos;s Anthropic key or Claude seat. Set an endpoint to send every agent run
            through one proxy instead, for host and cloud runners alike.
          </p>
        )}
        <p className="text-text-muted">
          A workspace&apos;s own Anthropic key or seat beats a team-wide endpoint. A runner with its own
          <span className="font-mono"> LLM_PROVIDER</span> keeps using it.
        </p>

        {scoped.length > 0 && (
          <ul className="border-t border-border-default pt-2 space-y-2" data-testid="agent-endpoint-workspaces">
            {scoped.map((e) => (
              <li key={e.id} className="space-y-0.5">
                <p className="text-text-primary"><span className="font-semibold">{e.workspaceName ?? 'Workspace'}</span>: {endpointSummary(e)}</p>
                <p className="text-text-secondary">{healthLine(e)}</p>
                {canManage && <RowActions endpoint={e} teamId={teamId} onChanged={load} />}
              </li>
            ))}
          </ul>
        )}
        {team && canManage && <RowActions endpoint={team} teamId={teamId} onChanged={load} />}
        {error && <p role="alert" className="text-status-error">{error}</p>}
        {canManage && endpoints !== undefined && (
          <Editor teamId={teamId} workspaces={workspaces} endpoints={endpoints} hasGateway={hasGateway} onChanged={load} />
        )}
        {!canManage && <p className="text-text-muted">Only a team owner or admin can change the agent endpoint.</p>}
      </div>
    </section>
  );
}

function RowActions({ endpoint, teamId, onChanged }: { endpoint: MaskedAgentEndpointView; teamId: string; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function verify() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/secrets/${endpoint.id}/verify`, { method: 'POST' });
      if (!res.ok) throw new Error(await errorText(res));
      await onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not verify');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setMsg(null);
    try {
      const qs = endpoint.workspaceId ? `?workspaceId=${encodeURIComponent(endpoint.workspaceId)}` : '';
      const res = await fetch(`/api/teams/${teamId}/agent-endpoint${qs}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await errorText(res));
      await onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not remove');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <button className="btn" onClick={verify} disabled={busy}>Verify</button>
      <button className="btn btn-quiet" onClick={remove} disabled={busy}>Remove</button>
      {msg && <span role="alert" className="text-status-error">{msg}</span>}
    </div>
  );
}

function Editor({ teamId, workspaces, endpoints, hasGateway, onChanged }: {
  teamId: string;
  workspaces: EndpointWorkspace[];
  endpoints: MaskedAgentEndpointView[];
  hasGateway: boolean;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<string>('');
  const [choice, setChoice] = useState<Choice>('anthropic');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [authHeader, setAuthHeader] = useState<'authorization' | 'x-api-key'>('authorization');
  const [aliases, setAliases] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const current = endpoints.find((e) => (scope ? e.workspaceId === scope : e.scope === 'team')) ?? null;

  function reset(forScope: string) {
    const e = endpoints.find((x) => (forScope ? x.workspaceId === forScope : x.scope === 'team')) ?? null;
    setScope(forScope);
    setChoice(e?.kind ?? 'anthropic');
    setBaseUrl(e?.kind === 'anthropic-compatible' ? e.baseUrl : '');
    setAuthHeader(e?.authHeader ?? 'authorization');
    setAliases(aliasLines(e?.models ?? {}));
    setApiKey('');
    setMsg(null);
  }

  const needsKey = choice === 'openrouter' || choice === 'anthropic-compatible';
  // Replacing an endpoint of the same kind still needs the key: it is never read back.
  const canSave = !busy && (choice === 'anthropic'
    ? !!current
    : choice === 'gateway'
      ? hasGateway
      : !!apiKey.trim() && (choice === 'openrouter' || !!baseUrl.trim()));

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      if (choice === 'anthropic') {
        const qs = scope ? `?workspaceId=${encodeURIComponent(scope)}` : '';
        const res = await fetch(`/api/teams/${teamId}/agent-endpoint${qs}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(await errorText(res));
      } else {
        const parsed = parseAliasLines(aliases);
        if (!parsed.ok) throw new Error(parsed.error);
        const body: Record<string, unknown> = { kind: choice };
        if (scope) body.workspaceId = scope;
        if (choice === 'openrouter') body.apiKey = apiKey.trim();
        if (choice === 'anthropic-compatible') Object.assign(body, { baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), authHeader });
        if (choice !== 'openrouter' && Object.keys(parsed.models).length > 0) body.models = parsed.models;
        const res = await fetch(`/api/teams/${teamId}/agent-endpoint`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(await errorText(res));
      }
      setApiKey('');
      setOpen(false);
      await onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setApiKey('');
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="pt-1">
        <button className="btn" onClick={() => { reset(''); setOpen(true); }}>Change</button>
      </div>
    );
  }

  const radio = (value: Choice, label: string, hint?: string, disabled = false) => (
    <label className={`flex items-start gap-2 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <input type="radio" name="agent-endpoint-kind" className="control-radio appearance-none mt-0.5" checked={choice === value}
        disabled={busy || disabled} onChange={() => setChoice(value)} />
      <span>
        <span className="block text-text-primary">{label}</span>
        {hint && <span className="block text-text-muted">{hint}</span>}
      </span>
    </label>
  );

  return (
    <div className="border-t border-border-default pt-3 space-y-3" data-testid="agent-endpoint-editor">
      <div className="space-y-1">
        <label className="field-label" htmlFor="agent-endpoint-scope">Applies to</label>
        <Select
          id="agent-endpoint-scope"
          testId="agent-endpoint-scope"
          value={scope || ALL_WORKSPACES}
          disabled={busy}
          onChange={(v) => reset(v === ALL_WORKSPACES ? '' : v)}
          options={[{ value: ALL_WORKSPACES, label: 'All workspaces' }, ...workspaces.map((w) => ({ value: w.id, label: w.name }))]}
        />
      </div>
      <div className="space-y-2">
        {radio('anthropic', 'Anthropic (default)', 'The team\'s Anthropic key or Claude seat.')}
        {radio('gateway', 'Use the team gateway', hasGateway ? 'The LiteLLM gateway above: same key, same URL.' : 'Connect a LiteLLM gateway first.', !hasGateway)}
        {radio('openrouter', 'OpenRouter')}
        {radio('anthropic-compatible', 'Anthropic-compatible URL', 'Any proxy that serves /v1/messages.')}
      </div>
      {choice === 'anthropic-compatible' && (
        <div className="space-y-2">
          <label className="field-label" htmlFor="agent-endpoint-url">Base URL</label>
          <input id="agent-endpoint-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://litellm.example.com" className={INPUT} spellCheck={false} />
          <div className="flex flex-wrap gap-4">
            {(['authorization', 'x-api-key'] as const).map((h) => (
              <label key={h} className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="agent-endpoint-header" className="control-radio appearance-none" checked={authHeader === h} disabled={busy}
                  onChange={() => setAuthHeader(h)} />
                <span className="font-mono">{h === 'authorization' ? 'Authorization: Bearer' : 'x-api-key'}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      {needsKey && (
        <div className="space-y-1">
          <label className="field-label" htmlFor="agent-endpoint-key">Key</label>
          <input id="agent-endpoint-key" type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" className={INPUT} />
          <p className="text-text-muted">buildd sends one short test request before saving. Stored encrypted. Nobody can read it back.</p>
        </div>
      )}
      {(choice === 'gateway' || choice === 'anthropic-compatible') && (
        <div className="space-y-1">
          <label className="field-label" htmlFor="agent-endpoint-aliases">Model aliases (optional)</label>
          <textarea id="agent-endpoint-aliases" rows={3} value={aliases} onChange={(e) => setAliases(e.target.value)}
            placeholder="native-model-id = proxy-alias" className="w-full px-3 py-2 bg-surface-1 border border-border-default focus:border-primary outline-none font-mono text-xs" spellCheck={false} />
          <p className="text-text-muted">One per line. Models without an alias are sent by their own id.</p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" onClick={save} disabled={!canSave}>{choice === 'anthropic' ? 'Use Anthropic' : 'Save'}</button>
        <button className="btn btn-quiet" onClick={() => { setOpen(false); setApiKey(''); setMsg(null); }} disabled={busy}>Cancel</button>
      </div>
      {msg && <p role="alert" className="text-status-error">{msg}</p>}
    </div>
  );
}
