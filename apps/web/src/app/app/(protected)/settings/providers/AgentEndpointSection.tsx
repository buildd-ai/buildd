'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Select } from '@/components/ui/Select';
import Chip, { type ChipTone } from '@/components/ui/Chip';
import { EndpointModelMap } from './EndpointModelMap';

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
  /** Every model buildd asks for and the name sent (absent from an older server). */
  mapping?: Array<{ model: string; tiers: string[]; sent: string }>;
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

function health(e: MaskedAgentEndpointView): { tone: ChipTone; label: string; detail: string | null } {
  if (e.gatewayMissing) return { tone: 'error', label: 'Gateway missing', detail: 'The team gateway it uses is not connected.' };
  if (e.health === 'healthy') return { tone: 'success', label: 'Working', detail: null };
  if (e.health === 'revoked') return { tone: 'error', label: 'Key rejected', detail: e.lastVerificationError };
  return { tone: 'warning', label: 'Not confirmed', detail: e.lastVerificationError };
}

export function endpointSummary(e: MaskedAgentEndpointView): string {
  const parts = [KIND_LABEL[e.kind]];
  if (e.baseUrl) parts.push(e.baseUrl);
  if (e.last4) parts.push(`key …${e.last4}`);
  return parts.join(' · ');
}

const scopeName = (e: MaskedAgentEndpointView) => (e.scope === 'team' ? 'All workspaces' : e.workspaceName ?? 'Workspace');

export default function AgentEndpointSection({ teamId, canManage, workspaces }: {
  teamId: string;
  canManage: boolean;
  workspaces: EndpointWorkspace[];
}) {
  const [endpoints, setEndpoints] = useState<MaskedAgentEndpointView[] | undefined>(undefined);
  const [hasGateway, setHasGateway] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The scope being edited ('' = team-wide), or null when no editor is open.
  const [editing, setEditing] = useState<string | null>(null);

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
  // Team-wide first, then workspaces by name (the server's order).
  const routes = endpoints ?? [];

  return (
    <section aria-labelledby="agent-endpoint-h" data-testid="agent-endpoint">
      <h2 id="agent-endpoint-h" className="section-label mb-3">Agent model endpoint</h2>
      <div className="card p-4 space-y-3 text-xs">
        {endpoints === undefined && <p className="text-sm text-text-primary" data-testid="agent-endpoint-status">Loading…</p>}
        {endpoints !== undefined && routes.length === 0 && (
          <div className="space-y-1">
            <p className="text-sm text-text-primary" data-testid="agent-endpoint-status">Anthropic (default)</p>
            <p className="text-text-muted">
              Agent runs use the team&apos;s Anthropic key or Claude seat. An endpoint routes them through a proxy.
            </p>
          </div>
        )}
        {routes.map((e) => (
          <RouteCard key={e.id} endpoint={e} teamId={teamId} canManage={canManage && editing === null}
            onEdit={() => setEditing(e.workspaceId ?? '')} onChanged={load} />
        ))}
        {routes.length > 0 && !team && (
          <p className="text-text-secondary" data-testid="agent-endpoint-default">All other workspaces: Anthropic (default).</p>
        )}
        {routes.length > 0 && (
          <p className="text-text-muted" data-testid="agent-endpoint-metered">
            Endpoint runs are metered on its key, not a Claude seat. The per-run dollar cap applies.
          </p>
        )}
        <p className="text-text-muted">
          A workspace&apos;s own Anthropic key or seat overrides a team endpoint. So does a runner&apos;s own
          <span className="font-mono"> LLM_PROVIDER</span> keeps using it.
        </p>
        {error && <p role="alert" className="text-status-error">{error}</p>}
        {canManage && endpoints !== undefined && (editing !== null ? (
          <Editor teamId={teamId} workspaces={workspaces} endpoints={endpoints} hasGateway={hasGateway} initialScope={editing}
            onClose={() => setEditing(null)} onChanged={load} />
        ) : (
          <div className="pt-1">
            <button className="btn" onClick={() => setEditing(team ? (workspaces.find((w) => !routes.some((r) => r.workspaceId === w.id))?.id ?? '') : '')}>
              {routes.length === 0 ? 'Set up an endpoint' : 'Add an endpoint'}
            </button>
          </div>
        ))}
        {!canManage && <p className="text-text-muted">Only a team owner or admin can change the agent endpoint.</p>}
      </div>
    </section>
  );
}

/** One saved endpoint: what it is, where it applies, whether it works, what it sends, and its actions. */
function RouteCard({ endpoint: e, teamId, canManage, onEdit, onChanged }: {
  endpoint: MaskedAgentEndpointView;
  teamId: string;
  canManage: boolean;
  onEdit: () => void;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const h = health(e);

  async function run(label: string, url: string, method: 'POST' | 'DELETE') {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(url, { method });
      if (!res.ok) throw new Error(await errorText(res));
      await onChanged();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : `Could not ${label}`);
    } finally {
      setBusy(false);
    }
  }

  const detail = [e.baseUrl, e.last4 ? `key …${e.last4}` : ''].filter(Boolean).join(' · ');
  const removeUrl = `/api/teams/${teamId}/agent-endpoint${e.workspaceId ? `?workspaceId=${encodeURIComponent(e.workspaceId)}` : ''}`;

  return (
    <div className="space-y-2 border-b border-border-default pb-3" data-testid="agent-endpoint-route" data-scope={e.scope}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-text-primary" data-testid="agent-endpoint-heading">{KIND_LABEL[e.kind]} · {scopeName(e)}</p>
        <Chip tone={h.tone} data-testid="agent-endpoint-health">{h.label}</Chip>
        {e.lastVerifiedAt && <span className="text-text-muted">checked {new Date(e.lastVerifiedAt).toLocaleString()}</span>}
      </div>
      {detail && <p className="font-mono text-text-secondary break-all" data-testid="agent-endpoint-detail">{detail}</p>}
      <p className="text-text-muted">
        {e.scope === 'team' ? 'Used by every workspace without its own endpoint.' : 'This workspace only. Overrides the team-wide setting.'}
      </p>
      {h.detail && <p className="text-text-secondary">{h.detail}</p>}
      {e.kind !== 'openrouter' && e.mapping && e.mapping.length > 0 && (
        <ul className="border-t border-border-default" data-testid="agent-endpoint-mapping" aria-label="Model mapping">
          {e.mapping.map((m) => (
            <li key={m.model} data-testid="endpoint-mapping-row" data-model={m.model}
              className="flex flex-col md:flex-row md:items-center gap-1 md:gap-2 py-1.5 border-b border-border-default">
              <div className="md:w-60 min-w-0">
                <p className="font-mono text-text-primary truncate" title={m.model}>{m.model}</p>
                <p className="text-text-muted">{m.tiers.length > 0 ? m.tiers.join(', ') : 'saved alias'}</p>
              </div>
              {m.sent === m.model
                ? <p className="flex-1 min-w-0 text-text-muted">sent as is</p>
                : <p className="flex-1 min-w-0 font-mono text-text-primary truncate" title={m.sent}><span className="font-sans text-text-muted">sent as </span>{m.sent}</p>}
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <div className="flex flex-wrap items-center gap-2 pt-1" data-testid="agent-endpoint-actions">
          <button className="btn" onClick={onEdit} disabled={busy}>Edit</button>
          <button className="btn btn-quiet" onClick={() => run('verify', `/api/secrets/${e.id}/verify`, 'POST')} disabled={busy}>Verify</button>
          <button className="btn btn-quiet" onClick={() => run('remove', removeUrl, 'DELETE')} disabled={busy}>Remove</button>
          {msg && <span role="alert" className="text-status-error">{msg}</span>}
        </div>
      )}
    </div>
  );
}

function Editor({ teamId, workspaces, endpoints, hasGateway, initialScope, onClose, onChanged }: {
  teamId: string;
  workspaces: EndpointWorkspace[];
  endpoints: MaskedAgentEndpointView[];
  hasGateway: boolean;
  /** '' = team-wide, else a workspace id. */
  initialScope: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const initial = endpoints.find((x) => (initialScope ? x.workspaceId === initialScope : x.scope === 'team')) ?? null;
  const [scope, setScope] = useState<string>(initialScope);
  const [choice, setChoice] = useState<Choice>(initial?.kind ?? 'anthropic');
  const [baseUrl, setBaseUrl] = useState(initial?.kind === 'anthropic-compatible' ? initial.baseUrl : '');
  const [apiKey, setApiKey] = useState('');
  const [authHeader, setAuthHeader] = useState<'authorization' | 'x-api-key'>(initial?.authHeader ?? 'authorization');
  const [aliases, setAliases] = useState(aliasLines(initial?.models ?? {}));
  // The rows' mapping when the endpoint listed its models; null = typed aliases.
  const [listMapping, setListMapping] = useState<Record<string, string> | null>(null);
  const [manual, setManual] = useState(false);
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
    setListMapping(null);
    setManual(false);
    setApiKey('');
    setMsg(null);
  }

  // What to ask the server to list: the team gateway, or a URL plus a key (or
  // the saved key, which the server uses only for the same endpoint).
  const modelsRequest = useMemo((): Record<string, unknown> | null => {
    if (choice === 'gateway') return hasGateway ? { kind: 'gateway' } : null;
    if (choice !== 'anthropic-compatible') return null;
    const url = baseUrl.trim();
    const key = apiKey.trim();
    if (!url || (!key && current?.kind !== 'anthropic-compatible')) return null;
    return key ? { kind: choice, baseUrl: url, apiKey: key, authHeader } : { kind: choice, baseUrl: url, authHeader };
  }, [choice, hasGateway, baseUrl, apiKey, authHeader, current?.kind]);

  const needsKey = choice === 'openrouter' || choice === 'anthropic-compatible';
  // A blank key keeps the saved one (the server reuses it for the same kind and
  // URL at this scope only; it is never read back). A new endpoint, another
  // kind or another URL needs the key typed.
  const sameUrl = choice === 'openrouter' || baseUrl.trim().replace(/\/+$/, '') === (current?.baseUrl ?? '');
  const keepsKey = needsKey && current?.kind === choice && !!current.last4 && sameUrl;
  const canSave = !busy && (choice === 'anthropic'
    ? !!current
    : choice === 'gateway'
      ? hasGateway
      : (!!apiKey.trim() || keepsKey) && (choice === 'openrouter' || !!baseUrl.trim()));

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      if (choice === 'anthropic') {
        const qs = scope ? `?workspaceId=${encodeURIComponent(scope)}` : '';
        const res = await fetch(`/api/teams/${teamId}/agent-endpoint${qs}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(await errorText(res));
      } else {
        let models = listMapping;
        if (!models) {
          const parsed = parseAliasLines(aliases);
          if (!parsed.ok) throw new Error(parsed.error);
          models = parsed.models;
        }
        const body: Record<string, unknown> = { kind: choice };
        if (scope) body.workspaceId = scope;
        if (choice === 'anthropic-compatible') Object.assign(body, { baseUrl: baseUrl.trim(), authHeader });
        if (needsKey && apiKey.trim()) body.apiKey = apiKey.trim();
        if (choice !== 'openrouter' && Object.keys(models).length > 0) body.models = models;
        const res = await fetch(`/api/teams/${teamId}/agent-endpoint`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(await errorText(res));
      }
      setApiKey('');
      onClose();
      await onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setApiKey('');
      setBusy(false);
    }
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
          <input id="agent-endpoint-key" type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={current && current.kind === choice && current.last4 ? `Saved key …${current.last4}, leave blank to keep` : 'sk-…'} className={INPUT} />
          <p className="text-text-muted">Tested on save. Encrypted, write-only.</p>
        </div>
      )}
      {(choice === 'gateway' || choice === 'anthropic-compatible') && (
        <EndpointModelMap teamId={teamId} workspaceId={scope} request={modelsRequest} disabled={busy} onMapping={setListMapping} />
      )}
      {(choice === 'gateway' || choice === 'anthropic-compatible') && listMapping === null && (manual ? (
        <div className="space-y-1">
          <label className="field-label" htmlFor="agent-endpoint-aliases">Model names (optional)</label>
          <textarea id="agent-endpoint-aliases" rows={3} value={aliases} onChange={(e) => setAliases(e.target.value)}
            placeholder="native-model-id = proxy-alias" className="w-full px-3 py-2 bg-surface-1 border border-border-default focus:border-primary outline-none font-mono text-xs" spellCheck={false} />
          <p className="text-text-muted">One per line. Unlisted models are sent by their own id.</p>
        </div>
      ) : (
        <div>
          <button className="btn btn-quiet" onClick={() => setManual(true)} disabled={busy}>Enter model names manually</button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" onClick={save} disabled={!canSave}>{choice === 'anthropic' ? 'Use Anthropic' : 'Save'}</button>
        <button className="btn btn-quiet" onClick={() => { setApiKey(''); setMsg(null); onClose(); }} disabled={busy}>Cancel</button>
      </div>
      {msg && <p role="alert" className="text-status-error">{msg}</p>}
    </div>
  );
}
