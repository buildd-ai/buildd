'use client';

import { useCallback, useEffect, useState } from 'react';
import { keyHealthPill, keyHealthTone, type KeyHealth } from '@/lib/provider-keys-client';
import { STATUS_TONE_SQUARE } from '@/lib/status-tone';
import { StatusChip } from '../_components/ConnectionRow';
import { Select } from '@/components/ui/Select';

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

/** The gateway's health in a provider key's words, so its card reads like theirs. */
const GATEWAY_HEALTH: Record<MaskedGateway['health'], KeyHealth> = { healthy: 'ok', revoked: 'failing', unknown: 'unknown' };

type DecisionVia = 'openrouter' | 'litellm' | 'cloudflare';
type DecisionModel = { endpoint: 'systemone' | 'chat'; model: string; via: DecisionVia } | null;

/** The System One models Cloudflare serves: Clef on Workers AI, Jev through the AI Gateway. */
const CLOUDFLARE_MODELS = [
  { id: 'clef', label: 'Clef' },
  { id: 'clef-flash', label: 'Clef Flash' },
  { id: 'typesafe/jev-1.13', label: 'Jev (through the AI Gateway)' },
] as const;

const VIA_LABEL: Record<DecisionVia, string> = { openrouter: 'OpenRouter', litellm: 'LiteLLM', cloudflare: 'Cloudflare' };

const INPUT = 'w-full h-10 px-3 bg-surface-1 border border-border-default focus:border-primary outline-none font-mono text-xs';

async function errorText(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({} as Record<string, unknown>));
  return typeof body.error === 'string' ? body.error : "That didn’t go through. Try again.";
}

/** Both parts together; the decision model reloads when the gateway changes. */
export default function GatewayAndDecisionModel({ teamId, canManage }: { teamId: string; canManage: boolean }) {
  const [rev, setRev] = useState(0);
  return (
    <>
      <GatewayCard teamId={teamId} canManage={canManage} onChanged={() => setRev((r) => r + 1)} />
      <DecisionModelPicker teamId={teamId} canManage={canManage} rev={rev} />
    </>
  );
}

function useGateway(teamId: string, rev = 0) {
  const [gateway, setGateway] = useState<MaskedGateway | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const g = await fetch(`/api/teams/${teamId}/litellm-gateway`, { cache: 'no-store' });
      if (!g.ok) throw new Error(await errorText(g));
      setGateway(((await g.json()) as { gateway: MaskedGateway | null }).gateway);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load');
    }
  }, [teamId]);
  useEffect(() => { void load(); }, [load, rev]);
  return { gateway, error, load };
}

/**
 * The gateway as one more provider card under Team keys: it is where agents,
 * chat and decisions reach models when a provider has no key of its own.
 */
export function GatewayCard({ teamId, canManage, onChanged }: { teamId: string; canManage: boolean; onChanged?: () => void }) {
  const { gateway, error, load } = useGateway(teamId);
  return (
    <GatewaySection teamId={teamId} canManage={canManage} gateway={gateway} error={error}
      onChanged={async () => { await load(); onChanged?.(); }} />
  );
}

/** Which model answers decision calls. `rev` reloads it after the gateway changes. */
export function DecisionModelPicker({ teamId, canManage, rev = 0 }: { teamId: string; canManage: boolean; rev?: number }) {
  const { gateway } = useGateway(teamId, rev);
  const [decision, setDecision] = useState<DecisionModel | undefined>(undefined);
  const load = useCallback(async () => {
    const t = await fetch(`/api/teams/${teamId}`, { cache: 'no-store' }).catch(() => null);
    if (!t?.ok) return;
    const team = (await t.json()) as { team?: { decisionModel?: DecisionModel }; decisionModel?: DecisionModel };
    setDecision(team.team?.decisionModel ?? team.decisionModel ?? null);
  }, [teamId]);
  useEffect(() => { void load(); }, [load]);
  return <DecisionModelSection teamId={teamId} canManage={canManage} value={decision} hasGateway={!!gateway} onChanged={load} />;
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

  const pill = gateway === undefined
    ? { tone: 'idle' as const, label: 'loading' }
    : keyHealthPill(gateway ? { health: GATEWAY_HEALTH[gateway.health] } : null);
  const tone = gateway === undefined ? 'muted' : keyHealthTone(gateway ? { health: GATEWAY_HEALTH[gateway.health] } : null);

  return (
    <div className="card" data-testid="litellm-gateway">
      {/* The same header as a provider key card (ProviderKeyCard). */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 min-w-0 px-3 py-2.5 border-b border-border-default">
        <span aria-hidden className={`w-2.5 h-2.5 shrink-0 ${STATUS_TONE_SQUARE[tone]}`} />
        <b className="min-w-0 break-words text-body font-semibold text-text-primary">LiteLLM gateway</b>
        <span className="shrink-0 ml-auto inline-flex" data-testid="litellm-gateway-health"><StatusChip tone={pill.tone}>{pill.label}</StatusChip></span>
      </div>
      <div className="px-3 pt-2 pb-3 space-y-1.5 text-xs">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-text-muted shrink-0">Team key</span>
          {gateway
            ? <span className="min-w-0 text-right font-mono text-text-primary break-all" data-testid="litellm-gateway-status">{gateway.baseURL} <span className="whitespace-nowrap">· key …{gateway.last4}</span></span>
            : <span className="text-text-muted" data-testid="litellm-gateway-status">{gateway === undefined ? '' : 'none'}</span>}
        </div>
        {gateway?.health === 'revoked' && gateway.lastVerificationError && (
          <p className="text-status-error break-words">Last check failed: {gateway.lastVerificationError}</p>
        )}
        <p className="text-text-muted">
          For providers with no key here: chat, goal grading, decisions and agent runs call
          <span className="font-mono"> provider/model</span> on your proxy.
        </p>
        {error && <p role="alert" className="text-status-error">{error}</p>}
        {canManage && editing && (
          <div className="pt-2 space-y-2">
            <label className="field-label" htmlFor="gateway-url">Gateway URL</label>
            <input id="gateway-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://litellm.example.com/v1" className={INPUT} spellCheck={false} />
            <label className="field-label" htmlFor="gateway-key">Gateway key</label>
            <input id="gateway-key" type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" className={INPUT} />
            <p className="text-text-muted">Checked against /models on save. Encrypted, write-only.</p>
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn btn-primary" onClick={save} disabled={busy || !baseUrl.trim() || !apiKey.trim()}>Save</button>
              <button className="btn btn-quiet" onClick={() => { setEditing(false); setApiKey(''); setMsg(null); }} disabled={busy}>Cancel</button>
            </div>
          </div>
        )}
        {canManage && !editing && (
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <button className="btn" onClick={() => { setEditing(true); setBaseUrl(gateway?.baseURL ?? ''); setMsg(null); }} disabled={busy || gateway === undefined}>
              {gateway ? 'Replace' : 'Connect'}
            </button>
            {gateway && <button className="btn btn-quiet" onClick={remove} disabled={busy}>Remove</button>}
          </div>
        )}
        {msg && <p role="alert" className="text-status-error">{msg}</p>}
      </div>
    </div>
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
  const [via, setVia] = useState<DecisionVia>('openrouter');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (value === undefined) return;
    setCustom(value !== null);
    setModel(value?.model ?? (value?.via === 'cloudflare' ? CLOUDFLARE_MODELS[0].id : ''));
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

  const current = value ? `${value.model} via ${VIA_LABEL[value.via]}` : 'Jev (default)';
  const onCloudflare = via === 'cloudflare';
  const pickVia = (v: DecisionVia) => {
    setVia(v);
    if (v === 'cloudflare' && !CLOUDFLARE_MODELS.some((m) => m.id === model)) setModel(CLOUDFLARE_MODELS[0].id);
    if (v !== 'cloudflare' && CLOUDFLARE_MODELS.some((m) => m.id === model)) setModel('');
  };

  return (
    <section aria-labelledby="decision-model-h" data-testid="decision-model">
      <h2 id="decision-model-h" className="section-label mb-3">Decision model</h2>
      <div className="card p-4 space-y-2 text-xs">
        <p className="text-sm text-text-primary" data-testid="decision-model-current">{value === undefined ? 'Loading…' : current}</p>
        <p className="text-text-muted">
          Labels tasks by category. Needs a model that returns token logprobs. Another model&apos;s picks are
          recorded, not applied, until it has been evaluated.
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
                <div className="flex flex-wrap gap-4">
                  {(['openrouter', 'litellm', 'cloudflare'] as const).map((v) => (
                    <label key={v} className="flex items-center gap-2 cursor-pointer">
                      <input type="radio" name="decision-via" className="control-radio appearance-none" checked={via === v} disabled={busy || (v === 'litellm' && !hasGateway)}
                        onChange={() => pickVia(v)} />
                      <span>{v === 'litellm' ? 'LiteLLM gateway' : v === 'cloudflare' ? 'Cloudflare' : 'OpenRouter'}</span>
                    </label>
                  ))}
                </div>
                {onCloudflare ? (
                  <>
                    <label className="field-label" htmlFor="decision-model-cf">Model</label>
                    <Select id="decision-model-cf" testId="decision-model-cf" value={model} onChange={setModel} disabled={busy}
                      options={CLOUDFLARE_MODELS.map((m) => ({ value: m.id, label: m.label }))} />
                    <p className="text-text-muted">
                      Uses the team&apos;s Cloudflare credential. Clef runs on Workers AI, through the AI Gateway when one is set.
                      Jev needs the AI Gateway and still spends the team&apos;s OpenRouter key.
                    </p>
                  </>
                ) : (
                  <>
                    <label className="field-label" htmlFor="decision-model-id">Model id</label>
                    <input id="decision-model-id" value={model} onChange={(e) => setModel(e.target.value)} placeholder="qwen3-8b" className={INPUT} spellCheck={false} />
                  </>
                )}
                <button className="btn btn-primary" disabled={busy || !model.trim()}
                  onClick={() => save({ endpoint: onCloudflare ? 'systemone' : 'chat', model: model.trim(), via })}>Save</button>
              </div>
            )}
          </div>
        )}
        {err && <p role="alert" className="text-status-error">{err}</p>}
      </div>
    </section>
  );
}
