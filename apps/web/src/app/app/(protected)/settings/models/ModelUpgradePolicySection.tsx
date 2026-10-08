'use client';

import { useCallback, useEffect, useState } from 'react';
import { Select } from '@/components/ui/Select';
import Chip from '@/components/ui/Chip';
import { getModelDisplayName } from '@buildd/core/model-display';
import type { ModelUpgradeMode, ModelUpgradePolicy, PolicySource, TierAdoption } from '@buildd/core/model-upgrade-policy';

const MODE_OPTIONS: Array<{ value: ModelUpgradeMode; label: string; description: string }> = [
  { value: 'latest-compatible', label: 'Latest compatible', description: 'Move to each new model as soon as Buildd certifies it' },
  { value: 'soak', label: 'Soak first', description: 'Move once a model has run cleanly for a while' },
  { value: 'manual', label: 'Manual', description: 'Never move on its own; you adopt new models' },
];

const SOURCE_TEXT: Record<PolicySource, string> = {
  team: 'Set for this team.',
  workspace: 'Set on a workspace.',
  default: 'Default: nothing set yet.',
};

interface PolicyResponse {
  policy: ModelUpgradePolicy;
  source: PolicySource;
  tiers: TierAdoption[];
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Why a newer certified model is not in use, in plain words. */
export function withheldText(t: TierAdoption): string | null {
  if (!t.newer || !t.withheld) return null;
  switch (t.withheld.reason) {
    case 'pinned': return 'This tier is pinned to a specific model.';
    case 'manual': return 'Your upgrade policy is manual.';
    case 'soak': return `Soaking, moves automatically ${shortDate(t.withheld.eligibleAt)}.`;
  }
}

/**
 * Settings → Models → Model upgrades: how catalog-resolved tiers move to newly
 * certified models (packages/core/model-upgrade-policy.ts), and per tier what
 * runs, why, and what newer certified model exists. Pinned tiers are edited in
 * the tier table above; this section only explains them.
 */
export default function ModelUpgradePolicySection({ teamId, isAdmin }: { teamId: string; isAdmin: boolean }) {
  const [data, setData] = useState<PolicyResponse | null>(null);
  const [soakHours, setSoakHours] = useState('72');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/model-tiers/policy?teamId=${teamId}`).catch(() => null);
    if (!r?.ok) return;
    const d = (await r.json()) as PolicyResponse;
    setData(d);
    if (d.policy.mode === 'soak' && d.policy.soakHours) setSoakHours(String(d.policy.soakHours));
  }, [teamId]);

  useEffect(() => { void load(); }, [load]);

  async function send(url: string, init: RequestInit, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Could not save');
      setMsg({ tone: 'ok', text: ok });
      await load();
    } catch (e) {
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : 'Could not save' });
    } finally {
      setBusy(false);
    }
  }

  const setMode = (mode: ModelUpgradeMode, hours = soakHours) =>
    send('/api/model-tiers/policy', {
      method: 'PUT',
      body: JSON.stringify({ teamId, mode, ...(mode === 'soak' ? { soakHours: Number(hours) || 72 } : {}) }),
    }, 'Saved');

  const disabled = !isAdmin || busy || !data;
  const mode = data?.policy.mode ?? 'latest-compatible';
  const withheld = data?.tiers.filter((t) => t.newer && t.withheld && t.withheld.reason === 'manual') ?? [];

  return (
    <section id="model-upgrades" className="mt-6 max-w-5xl scroll-mt-20" data-testid="model-upgrade-policy">
      <h2 className="font-mono text-body text-text-primary">Model upgrades</h2>
      <p className="mt-1 text-meta text-text-secondary">
        When your tiers move to a model Buildd has certified. Pinned tiers never move.
      </p>

      <div className="card mt-3 flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:gap-4">
        <span id="model-upgrade-mode-label" className="font-mono text-body text-text-primary">Upgrade policy</span>
        <Select
          aria-labelledby="model-upgrade-mode-label"
          testId="model-upgrade-mode"
          className="w-full sm:w-56"
          options={MODE_OPTIONS}
          value={mode}
          disabled={disabled}
          onChange={(v: string) => void setMode(v as ModelUpgradeMode)}
        />
        {mode === 'soak' && (
          <label className="flex items-center gap-2 text-meta text-text-secondary">
            for
            <input
              type="number"
              min={1}
              className="input w-20"
              value={soakHours}
              disabled={disabled}
              onChange={(e) => setSoakHours(e.target.value)}
              onBlur={() => { if (Number(soakHours) !== data?.policy.soakHours) void setMode('soak', soakHours); }}
              data-testid="model-upgrade-soak-hours"
            />
            hours
          </label>
        )}
        <span className="text-meta text-text-muted sm:ml-auto" data-testid="model-upgrade-source">
          {data ? SOURCE_TEXT[data.source] : ''}
        </span>
      </div>

      {data && (
        <ul className="mt-2 flex flex-col gap-1" data-testid="model-upgrade-tiers">
          {data.tiers.map((t) => (
            <li key={t.tier} className="card flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:gap-3">
              <span className="w-28 font-mono text-meta text-text-muted">{t.tier}</span>
              <span className="text-body text-text-primary">{getModelDisplayName(t.model)}</span>
              {t.deprecated && (
                <Chip tone={t.deprecated.retired ? 'error' : 'warning'} variant="soft">
                  {t.deprecated.retired ? 'Retired' : 'Deprecated'}
                  {t.deprecated.retiresAt && !t.deprecated.retired ? ` · retires ${shortDate(t.deprecated.retiresAt)}` : ''}
                </Chip>
              )}
              <span className="text-meta text-text-secondary sm:ml-auto">
                {t.newer
                  ? `${getModelDisplayName(t.newer.model)} is available. ${withheldText(t) ?? 'Older runners stay on the previous model.'}`
                  : t.why}
              </span>
            </li>
          ))}
        </ul>
      )}

      {isAdmin && mode === 'manual' && withheld.length > 0 && (
        <button
          type="button"
          className="btn btn-primary mt-3"
          disabled={busy}
          data-testid="model-upgrade-adopt"
          onClick={() => void send('/api/model-tiers/policy/adopt', { method: 'POST', body: JSON.stringify({ teamId }) }, 'Adopted')}
        >
          Adopt {withheld.length === 1 ? getModelDisplayName(withheld[0].newer!.model) : `${withheld.length} newer models`}
        </button>
      )}
      {msg && <span role="status" className={`mt-1 block text-meta ${msg.tone === 'ok' ? 'text-status-success' : 'text-status-error'}`}>{msg.text}</span>}
    </section>
  );
}
