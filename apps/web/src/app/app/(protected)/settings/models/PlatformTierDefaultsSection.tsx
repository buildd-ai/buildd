'use client';

/**
 * Settings › Models › Tiers › Platform defaults (platform operators only).
 *
 * The model each tier runs for every team that has no registry row of its
 * own, changed without a deploy. One row per tier: the effective model with
 * where it came from, its price and CLI floor, the stored platform row (who,
 * when, via UI or MCP, why), and the staleness suggestion with an Apply
 * control. Set, Clear and Revert each ask once before they write; a model
 * priced outside the tier's band asks a second time. Everything shown comes
 * from `GET /api/model-tiers/platform` and every change goes through
 * `PUT /api/model-tiers/platform`, the same route the MCP action calls, so
 * the browser never decides anything: a refused write shows the server's words.
 */
import { useCallback, useEffect, useState } from 'react';
import type { Tier } from '@buildd/core/model-tier-defaults';
import { getModelDisplayName } from '@buildd/core/model-display';
import type { PlatformTierDefaultsView, PlatformTierView } from '@/lib/admin/platform-tier-defaults';
import Chip, { type ChipTone } from '@/components/ui/Chip';
import Notice from '@/components/ui/Notice';
import { TIER_LABEL } from '@/lib/tier-limits-view';
import { MODEL_TIERS_CHANGED_EVENT } from './CellEditor';

const SOURCE: Record<string, { label: string; tone: ChipTone }> = {
  platform: { label: 'platform default', tone: 'info' },
  policy: { label: 'policy service', tone: 'muted' },
  catalog: { label: 'catalog pick', tone: 'muted' },
  default: { label: 'bundled fallback', tone: 'warning' },
};

const money = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

/** "$8 in / $40 out per MTok · Claude Code 2.1.321+ · certified", from the server's facts. */
export function factsLine(f: PlatformTierView['effective']['facts']): string {
  const parts = [f.price ? `${money(f.price.input)} in / ${money(f.price.output)} out per MTok` : 'price unknown'];
  parts.push(f.floor ? `Claude Code ${f.floor}+` : f.certified ? 'any current runner' : 'floor not certified');
  parts.push(f.certified ? (f.certification === 'baseline' ? 'certified (built-in table)' : 'certified') : f.certification);
  return parts.join(' · ');
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

type Op = 'set' | 'apply' | 'clear' | 'revert';
interface Pending { op: Op; tier: Tier; model?: string; bandChange?: boolean; text: string }

const INPUT = 'w-full min-h-11 px-3 py-2 border border-border-default bg-surface-1 text-base md:text-sm font-mono sm:w-64';
const LOAD_ERROR = 'Could not load the platform defaults';

export default function PlatformTierDefaultsSection() {
  const [data, setData] = useState<PlatformTierDefaultsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<Tier, string>>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/model-tiers/platform', { cache: 'no-store', credentials: 'include' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? LOAD_ERROR);
      setData((await r.json()) as PlatformTierDefaultsView);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : LOAD_ERROR);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  /** The first click asks; the confirm sends. A band refusal asks once more. */
  function ask(op: Op, tier: Tier, model?: string) {
    const label = TIER_LABEL[tier];
    const text =
      op === 'set' ? `Set ${label} to ${model} for every team without its own row?`
      : op === 'apply' ? `Move ${label} to the suggested model for every team without its own row?`
      : op === 'clear' ? `Remove the ${label} platform default? The tier follows the catalog again.`
      : `Revert the last ${label} change?`;
    setMsg(null);
    setPending({ op, tier, model, text });
  }

  async function send(p: Pending) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/model-tiers/platform', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ op: p.op, tier: p.tier, ...(p.model ? { model: p.model } : {}), confirm: true, confirmBandChange: p.bandChange === true, via: 'ui' }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string; after?: { model: string } | null };
      if (!res.ok) {
        if (body.code === 'spend_band_change') {
          // The server named the spend change; ask once more with that text.
          setPending({ ...p, bandChange: true, text: `${body.error ?? 'This model is outside the tier price band.'} Accept the spend change?` });
          return;
        }
        throw new Error(body.error ?? 'Could not save');
      }
      setPending(null);
      setDrafts((d) => ({ ...d, [p.tier]: '' }));
      setMsg({ tone: 'ok', text: body.after ? `${TIER_LABEL[p.tier]} now runs ${getModelDisplayName(body.after.model)} for every team without its own row.` : `${TIER_LABEL[p.tier]} follows the catalog again.` });
      await load();
      window.dispatchEvent(new CustomEvent(MODEL_TIERS_CHANGED_EVENT));
    } catch (e) {
      setPending(null);
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : 'Could not save' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="platform-tier-defaults" className="mt-6 scroll-mt-20" data-testid="platform-tier-defaults">
      <div className="border-t border-border-default py-3">
        <span className="block text-sm font-semibold text-text-primary">Platform defaults</span>
        <span className="block text-meta text-text-muted">
          The model each tier runs for every team without its own row. Pinned teams, workspaces and tasks keep their model.
        </span>
        <span className="block text-meta text-text-muted">Every change is audited and reverts in one step.</span>
      </div>

      {loadError && <Notice tone="err" data-testid="platform-tier-error">{loadError}</Notice>}
      {data && !data.catalogChecked && (
        <Notice tone="warn" data-testid="platform-tier-catalog-warning">The live model catalog could not be read, so no staleness check ran and no change can be verified right now.</Notice>
      )}

      {data?.tiers.map((t) => {
        const source = SOURCE[t.effective.source] ?? { label: t.effective.source, tone: 'muted' as ChipTone };
        const draft = drafts[t.tier] ?? '';
        return (
          <div key={t.tier} className="border-t border-border-default py-3" data-testid={`platform-tier-${t.tier}`}>
            <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
              <span className="text-sm text-text-primary">
                <span className="font-semibold">{TIER_LABEL[t.tier]}</span>{' '}
                <span className="font-mono" data-testid="platform-tier-model">{t.effective.model}</span>
              </span>
              <Chip tone={source.tone} dot={false} data-testid="platform-tier-source">{source.label}</Chip>
            </div>
            <span className="block text-meta text-text-muted" data-testid="platform-tier-facts">{factsLine(t.effective.facts)}</span>
            {t.platform && (
              <span className="block text-meta text-text-muted" data-testid="platform-tier-row">
                Set {shortDate(t.platform.setAt)} via {t.platform.setBy.via}{t.platform.reason ? `: ${t.platform.reason}` : ''}.{' '}
                {t.platform.previous ? `Revert restores ${getModelDisplayName(t.platform.previous.model)}.` : 'Revert removes the row.'}
              </span>
            )}

            {t.suggestion && (
              <Notice
                tone={t.suggestion.kind === 'missing' ? 'warn' : 'info'}
                className="mt-2"
                data-testid="platform-tier-suggestion"
                action={data.canWrite && t.suggestion.kind === 'newer' && t.suggestion.applicable ? { label: `Apply ${getModelDisplayName(t.suggestion.newer!)}`, onClick: () => ask('apply', t.tier) } : undefined}
              >
                {t.suggestion.why}
              </Notice>
            )}

            {data.canWrite && (
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  className={INPUT}
                  aria-label={`${TIER_LABEL[t.tier]} platform default model`}
                  placeholder="claude-…"
                  value={draft}
                  disabled={busy}
                  onChange={(e) => setDrafts((d) => ({ ...d, [t.tier]: e.target.value }))}
                  data-testid="platform-tier-input"
                />
                <div className="flex gap-2">
                  <button type="button" className="btn btn-sm" disabled={busy || !draft.trim()} onClick={() => ask('set', t.tier, draft.trim())} data-testid="platform-tier-set">Set</button>
                  {t.platform && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => ask('clear', t.tier)} data-testid="platform-tier-clear">Clear</button>}
                  {t.canRevert && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => ask('revert', t.tier)} data-testid="platform-tier-revert">Revert</button>}
                </div>
              </div>
            )}

            {pending?.tier === t.tier && (
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center" role="group" aria-label="Confirm the change" data-testid="platform-tier-confirm">
                <span className="text-sm text-text-primary">{pending.text}</span>
                <div className="flex gap-2">
                  <button type="button" className="btn btn-sm btn-ink" disabled={busy} onClick={() => void send(pending)} data-testid="platform-tier-confirm-yes">{pending.bandChange ? 'Accept and apply' : 'Confirm'}</button>
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setPending(null)} data-testid="platform-tier-confirm-no">Cancel</button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {msg && <span role={msg.tone === 'err' ? 'alert' : 'status'} className={`mt-2 block text-meta ${msg.tone === 'ok' ? 'text-status-success' : 'text-status-error'}`} data-testid="platform-tier-message">{msg.text}</span>}
    </section>
  );
}
