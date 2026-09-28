'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Settings → Model providers: the team's LiteLLM gateway and which model
 * answers decision calls. The gateway key never comes back beyond last4.
 * See @buildd/core/litellm-gateway and @buildd/core/decision-model.
 */

interface MaskedGateway {
  baseURL: string;
  last4: string;
  health: 'healthy' | 'revoked' | 'unknown';
  lastVerificationError: string | null;
}

type DecisionModel = { endpoint: 'systemone' | 'chat'; model: string; via: 'openrouter' | 'litellm' } | null;

const INPUT = 'w-full h-10 px-3 bg-surface-1 border border-border-default focus:border-primary outline-none font-mono text-xs';

async function errorText(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({} as Record<string, unknown>));
  return typeof body.error === 'string' ? body.error : `Request failed (HTTP ${res.status})`;
}

export default function GatewayAndDecisionModel({ teamId, canManage }: { teamId: string; canManage: boolean }) {
  const [gateway, setGateway] = useState<MaskedGateway | null | undefined>(undefined);
  const [decision, setDecision] = useState<DecisionModel | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [g, t] = await Promise.all([
        fetch(`/api/teams/${teamId}/litellm-gateway`, { cache: 'no-store' }),
        fetch(`/api/teams/${teamId}`, { cache: 'no-store' }),
      ]);
      if (!g.ok) throw new Error(await errorText(g));
      setGateway(((await g.json()) as { gateway: MaskedGateway | null }).gateway);
      if (t.ok) {
        const team = (await t.json()) as { team?: { decisionModel?: DecisionModel }; decisionModel?: DecisionModel };
        setDecision(team.team?.decisionModel ?? team.decisionModel ?? null);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load');
    }
  }, [teamId]);

  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <GatewaySection teamId={teamId} canManage={canManage} gateway={gateway} error={error} onChanged={load} />
      <DecisionModelSection teamId={teamId} canManage={canManage} value={decision} hasGateway={!!gateway} onChanged={load} />
    </>
  );
}

function GatewaySection({ teamId, canManage, gateway, error, onChanged }: {
  teamId: string;
  canManage: boolean;
  gateway: MaskedGateway | null | undefined;
  error: string | null;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/teams/${teamId}/litellm-gateway`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, apiKey }),
      });
      if (!res.ok) throw new Error(await errorText(res));
      setEditing(false);
      setApiKey('');
      await onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      const res = await fetch(`/api/teams/${teamId}/litellm-gateway`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await errorText(res));
      await onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not remove');
    } finally {
      setBusy(false);
    }
  }

  const status = gateway === undefined
    ? 'Loading…'
    : gateway
      ? `${gateway.baseURL} · key …${gateway.last4}${gateway.health === 'revoked' ? ' · rejected' : ''}`
      : 'Not connected';

  return (
    <section aria-labelledby="gateway-h" data-testid="litellm-gateway">
      <h2 id="gateway-h" className="section-label mb-3">LiteLLM gateway</h2>
      <div className="card p-4 space-y-2 text-xs">
        <p className="text-sm text-text-primary" data-testid="litellm-gateway-status">{status}</p>
        <p className="text-text-muted">
          Used when a tier&apos;s provider has no key here: chat, goal grading and decisions call the same model as
          <span className="font-mono"> provider/model</span> on your proxy.
        </p>
        {error && <p role="alert" className="text-status-error">{error}</p>}
        {canManage && editing && (
          <div className="pt-2 space-y-2">
            <label className="field-label" htmlFor="gateway-url">Gateway URL</label>
            <input id="gateway-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://litellm.example.com/v1" className={INPUT} spellCheck={false} />
            <label className="field-label" htmlFor="gateway-key">Gateway key</label>
            <input id="gateway-key" type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" className={INPUT} />
            <p className="text-text-muted">buildd checks the key against the gateway&apos;s /models before saving. Stored encrypted. Nobody can read it back.</p>
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn btn-primary" onClick={save} disabled={busy || !baseUrl.trim() || !apiKey.trim()}>Save</button>
              <button className="btn btn-quiet" onClick={() => { setEditing(false); setApiKey(''); setMsg(null); }} disabled={busy}>Cancel</button>
            </div>
          </div>
        )}
        {canManage && !editing && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button className="btn" onClick={() => { setEditing(true); setBaseUrl(gateway?.baseURL ?? ''); setMsg(null); }} disabled={busy || gateway === undefined}>
              {gateway ? 'Replace' : 'Connect'}
            </button>
            {gateway && <button className="btn btn-quiet" onClick={remove} disabled={busy}>Remove</button>}
          </div>
        )}
        {msg && <p role="alert" className="text-status-error">{msg}</p>}
      </div>
    </section>
  );
}

function DecisionModelSection({ teamId, canManage, value, hasGateway, onChanged }: {
  teamId: string;
  canManage: boolean;
  value: DecisionModel | undefined;
  hasGateway: boolean;
  onChanged: () => Promise<void>;
}) {
  const [custom, setCustom] = useState(false);
  const [model, setModel] = useState('');
  const [via, setVia] = useState<'openrouter' | 'litellm'>('openrouter');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (value === undefined) return;
    setCustom(value !== null);
    setModel(value?.model ?? '');
    setVia(value?.via ?? (hasGateway ? 'litellm' : 'openrouter'));
  }, [value, hasGateway]);

  async function save(next: DecisionModel) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/teams/${teamId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decisionModel: next }),
      });
      if (!res.ok) throw new Error(await errorText(res));
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const current = value ? `${value.model} via ${value.via === 'litellm' ? 'LiteLLM' : 'OpenRouter'}` : 'Jev (default)';

  return (
    <section aria-labelledby="decision-model-h" data-testid="decision-model">
      <h2 id="decision-model-h" className="section-label mb-3">Decision model</h2>
      <div className="card p-4 space-y-2 text-xs">
        <p className="text-sm text-text-primary" data-testid="decision-model-current">{value === undefined ? 'Loading…' : current}</p>
        <p className="text-text-muted">
          Answers buildd&apos;s quick labelled checks (task categories, heartbeat triage). Any model that returns token
          logprobs works, including open-weights models. Thresholds were measured on Jev, so another model&apos;s picks are
          recorded but not applied until it has its own eval.
        </p>
        {canManage && value !== undefined && (
          <div className="pt-1 space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="decision-model" className="control-radio appearance-none" checked={!custom} disabled={busy}
                onChange={() => { setCustom(false); void save(null); }} />
              <span className="text-text-primary">Jev on OpenRouter</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="decision-model" className="control-radio appearance-none" checked={custom} disabled={busy}
                onChange={() => setCustom(true)} />
              <span className="text-text-primary">Another model</span>
            </label>
            {custom && (
              <div className="pl-6 space-y-2">
                <label className="field-label" htmlFor="decision-model-id">Model id</label>
                <input id="decision-model-id" value={model} onChange={(e) => setModel(e.target.value)} placeholder="qwen3-8b" className={INPUT} spellCheck={false} />
                <div className="flex flex-wrap gap-4">
                  {(['openrouter', 'litellm'] as const).map((v) => (
                    <label key={v} className="flex items-center gap-2 cursor-pointer">
                      <input type="radio" name="decision-via" className="control-radio appearance-none" checked={via === v} disabled={busy || (v === 'litellm' && !hasGateway)}
                        onChange={() => setVia(v)} />
                      <span>{v === 'litellm' ? 'LiteLLM gateway' : 'OpenRouter'}</span>
                    </label>
                  ))}
                </div>
                <button className="btn btn-primary" disabled={busy || !model.trim()} onClick={() => save({ endpoint: 'chat', model: model.trim(), via })}>Save</button>
              </div>
            )}
          </div>
        )}
        {err && <p role="alert" className="text-status-error">{err}</p>}
      </div>
    </section>
  );
}
