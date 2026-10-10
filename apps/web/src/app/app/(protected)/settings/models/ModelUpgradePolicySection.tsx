'use client';

import { useCallback, useEffect, useState } from 'react';
import { MODEL_TIERS_CHANGED_EVENT } from './CellEditor';
import { Select } from '@/components/ui/Select';
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

export interface PolicyResponse {
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
 * One tier's upgrade state as a muted line under its name in the tier table:
 * a newer certified model (and why it is not in use), or a deprecation. Null
 * when there is nothing to say: what runs and why is already the table's cell.
 */
export function upgradeNote(t: TierAdoption): string | null {
  const parts: string[] = [];
  if (t.deprecated) {
    parts.push(t.deprecated.retired
      ? `${getModelDisplayName(t.model)} is retired.`
      : `${getModelDisplayName(t.model)} is deprecated${t.deprecated.retiresAt ? `, retires ${shortDate(t.deprecated.retiresAt)}` : ''}.`);
  }
  if (t.newer) parts.push(`${getModelDisplayName(t.newer.model)} is available. ${withheldText(t) ?? 'Older runners stay on the previous model.'}`);
  return parts.length ? parts.join(' ') : null;
}

/**
 * Settings → Models → Tiers → Upgrade policy: how catalog-resolved tiers move
 * to newly certified models (packages/core/model-upgrade-policy.ts). One row:
 * the policy. What each tier runs, and any newer model, is in the tier table
 * above (`upgradeNote`), so this does not list the tiers a second time.
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
  // A tier edit above changes what is pinned and why; revalidate rather than wait for a reload.
  useEffect(() => {
    const onChanged = () => { void load(); };
    window.addEventListener(MODEL_TIERS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(MODEL_TIERS_CHANGED_EVENT, onChanged);
  }, [load]);

  async function send(url: string, init: RequestInit, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Could not save');
      setMsg({ tone: 'ok', text: ok });
      await load();
      // The tier table shows each tier's model and upgrade note; let it reload.
      window.dispatchEvent(new CustomEvent(MODEL_TIERS_CHANGED_EVENT));
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

  const disabled = busy || !data;
  const mode = data?.policy.mode ?? 'latest-compatible';
  const withheld = data?.tiers.filter((t) => t.newer && t.withheld && t.withheld.reason === 'manual') ?? [];

  return (
    <section id="model-upgrades" className="mt-6 scroll-mt-20" data-testid="model-upgrade-policy">
      <div className="flex flex-col gap-2 border-t border-border-default py-3 sm:flex-row sm:items-center sm:gap-4">
        <span className="min-w-0 flex-1">
          <span id="model-upgrade-mode-label" className="block text-sm font-semibold text-text-primary">Upgrade policy</span>
          <span className="block text-meta text-text-muted">
            When your tiers move to a model Buildd has certified. Pinned tiers never move.{' '}
            <span data-testid="model-upgrade-source">{data ? SOURCE_TEXT[data.source] : ''}</span>
          </span>
        </span>
        {!isAdmin ? (
          // Read-only: the value, no control (the page says who manages it).
          <span className="text-sm text-text-primary sm:text-right" data-testid="model-upgrade-mode-value">
            {!data ? '…' : `${MODE_OPTIONS.find((o) => o.value === mode)?.label ?? mode}${mode === 'soak' ? ` for ${soakHours} hours` : ''}`}
          </span>
        ) : (<>
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
        </>)}
      </div>

      {isAdmin && mode === 'manual' && withheld.length > 0 && (
        <button
          type="button"
          className="btn mt-1"
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
