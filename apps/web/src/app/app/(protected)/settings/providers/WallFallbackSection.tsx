'use client';

import { useCallback, useEffect, useState } from 'react';
import type { WallFallbackOption, WallFallbackSettingsResponse } from '@buildd/shared';
import { Select } from '@/components/ui/Select';
import Section from '@/components/ui/Section';

/** Sized and bordered like the inputs elsewhere on this page. */
const INPUT = 'w-full min-h-11 md:min-h-9 px-3 bg-surface-1 border-2 border-border-strong focus:border-primary outline-none font-mono text-base md:text-xs';

type Mode = 'wait' | 'api_key' | 'provider';
type ProviderId = Exclude<WallFallbackOption['id'], 'anthropic'>;

/**
 * Settings › Models: what a runner on a subscription login does when that
 * login hits its usage limit (packages/core/wall-fallback.ts, GET/PUT
 * /api/teams/[id]/wall-fallback). Wait and resume is the default. The team's
 * API key, or another provider the team set up, runs the work meanwhile,
 * metered per token, bounded by an optional daily cap; at the cap the work
 * waits again. Each choice names the stored credential it would use (last four
 * characters only), and one the team has not stored cannot be picked. Runners
 * on an API key are not affected.
 */
export default function WallFallbackSection({ teamId }: { teamId: string }) {
  const [data, setData] = useState<WallFallbackSettingsResponse | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [mode, setMode] = useState<Mode>('wait');
  const [provider, setProvider] = useState<ProviderId>('openrouter');
  const [cap, setCap] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const adopt = useCallback((d: WallFallbackSettingsResponse) => {
    setData(d);
    const f = d.setting.fallback;
    setMode(f === 'wait' ? 'wait' : f === 'anthropic' ? 'api_key' : 'provider');
    const firstProvider = d.options.find((o) => o.id !== 'anthropic' && o.available)?.id as ProviderId | undefined;
    setProvider(f !== 'wait' && f !== 'anthropic' ? f : firstProvider ?? 'openrouter');
    setCap(d.setting.maxCostPerDayUsd !== null ? String(d.setting.maxCostPerDayUsd) : '');
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetch(`/api/teams/${teamId}/wall-fallback`, { cache: 'no-store' }).catch(() => null);
      const body = res?.ok ? ((await res.json().catch(() => null)) as WallFallbackSettingsResponse | null) : null;
      if (!live) return;
      if (body) adopt(body);
      else setLoadErr(true);
    })();
    return () => { live = false; };
  }, [teamId, adopt]);

  if (loadErr) return null;
  if (!data) return null;

  const opt = (id: WallFallbackOption['id']) => data.options.find((o) => o.id === id);
  const apiKey = opt('anthropic');
  const providers = data.options.filter((o) => o.id !== 'anthropic');
  const anyProvider = providers.some((o) => o.available);
  const chosen: WallFallbackOption | undefined = mode === 'api_key' ? apiKey : mode === 'provider' ? opt(provider) : undefined;
  const capValue = cap.trim() === '' ? null : Number(cap);
  const capInvalid = capValue !== null && (!Number.isFinite(capValue) || capValue <= 0);
  const readOnly = !data.canManage;

  async function save() {
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      const fallback = mode === 'wait' ? 'wait' : mode === 'api_key' ? 'anthropic' : provider;
      const res = await fetch(`/api/teams/${teamId}/wall-fallback`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fallback, maxCostPerDayUsd: mode === 'wait' ? null : capValue }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<WallFallbackSettingsResponse> & { error?: string };
      if (!res.ok || !body.setting) throw new Error(body.error ?? 'Could not save. Try again.');
      adopt(body as WallFallbackSettingsResponse);
      setSaved(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const radio = (value: Mode, label: string, disabled: boolean, testId: string) => (
    <label className={`flex items-center gap-2 min-h-11 md:min-h-9 text-body ${disabled ? 'text-text-muted' : 'text-text-primary'}`}>
      <input
        type="radio"
        name="wall-fallback"
        value={value}
        checked={mode === value}
        onChange={() => { setMode(value); setSaved(false); setErr(null); }}
        disabled={readOnly || busy || disabled}
        data-testid={testId}
      />
      {label}
    </label>
  );

  return (
    <Section title="When the subscription limit is reached" id="subscription-limit" className="scroll-mt-20">
      <div className="space-y-3" data-testid="wall-fallback">
        <p className="text-body text-text-secondary" data-testid="wall-fallback-summary">{summaryLine(data)}</p>
        <fieldset className="space-y-1" aria-label="When the subscription limit is reached">
          {radio('wait', 'Wait and resume', false, 'wall-fallback-wait')}
          {radio('api_key', apiKey?.available ? "Use the team's API key" : "Use the team's API key (add an Anthropic key under Providers)", !apiKey?.available, 'wall-fallback-anthropic')}
          {radio('provider', anyProvider ? 'Use another provider' : 'Use another provider (connect OpenRouter, LiteLLM or an endpoint first)', !anyProvider, 'wall-fallback-provider')}
        </fieldset>

        {mode === 'provider' && (
          <div className="sm:max-w-72">
            <Select
              value={provider}
              onChange={(v) => { setProvider(v as ProviderId); setSaved(false); }}
              disabled={readOnly || busy}
              aria-label="Provider"
              sheetTitle="Provider"
              testId="wall-fallback-pick"
              options={providers.map((o) => ({ value: o.id, label: capitalize(o.label.replace(/^the team's /, '')), disabled: !o.available }))}
            />
          </div>
        )}

        {chosen && (
          <p className="text-meta text-text-secondary" data-testid="wall-fallback-uses">
            Uses {chosen.label}{chosen.last4 ? ` ending ${chosen.last4}` : ''}. Runs are labelled on the task with what they cost.
            {(chosen.id === 'anthropic' || chosen.id === 'endpoint') && ' Subscription runners then keep it for the limit: their other runs use their own login first.'}
          </p>
        )}

        {mode !== 'wait' && (
          <label className="block space-y-1 sm:max-w-72">
            <span className="text-meta text-text-secondary">Daily cap in USD (empty: no cap). At the cap, work waits for the reset.</span>
            <input
              inputMode="decimal"
              aria-label="Daily cap in USD"
              data-testid="wall-fallback-cap"
              value={cap}
              onChange={(e) => { setCap(e.target.value); setSaved(false); }}
              disabled={readOnly || busy}
              placeholder="No cap"
              className={INPUT}
            />
          </label>
        )}

        {!readOnly && (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => { void save(); }}
              disabled={busy || capInvalid || (mode !== 'wait' && !chosen?.available)}
              data-testid="wall-fallback-save"
            >
              Save
            </button>
            {capInvalid && <span className="text-meta text-status-error">The cap must be a dollar amount above zero.</span>}
            {saved && <span role="status" className="text-meta text-status-success">Saved.</span>}
          </div>
        )}
        {err && <p role="alert" className="text-meta text-status-error">{err}</p>}
        <p className="text-meta text-text-muted">Only runners signed in with a subscription fall back. Runners on an API key are not affected. A task pinned to the subscription always waits.</p>
      </div>
    </Section>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The saved choice, in one line. */
export function summaryLine(d: Pick<WallFallbackSettingsResponse, 'setting' | 'options' | 'spentTodayUsd'>): string {
  const f = d.setting.fallback;
  if (f === 'wait') return 'Runners wait for the reset and resume by themselves. Nothing extra is spent.';
  const label = d.options.find((o) => o.id === f)?.label ?? 'the chosen provider';
  const cap = d.setting.maxCostPerDayUsd;
  const capText = cap !== null
    ? ` up to $${cap.toFixed(2)} a day ($${d.spentTodayUsd.toFixed(2)} spent today), then work waits for the reset`
    : ' with no daily cap';
  return `Walled work runs on ${label},${capText}.`;
}
