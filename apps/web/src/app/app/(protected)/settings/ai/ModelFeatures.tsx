'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  INFERENCE_CAPABILITIES,
  LIVE_SERVER_FEATURES,
  normalizeFeatureModes,
  resolveFeatureMode,
  type FeatureModes,
  type ServerFeature,
} from '@buildd/core/inference-policy';
import Switch from '@/components/ui/Switch';
import { defaultLine, featureState, interactiveState, OVERRIDE_OPTIONS, type OverrideValue } from './feature-copy';

/**
 * Settings → AI features.
 *
 * Interactive runs whenever a key resolves; its only control is the admin's
 * kill switch (`teams.chatDisabled`). Built-in decision calls have no control
 * and are not listed. Server-side features run where the billing model says
 * (team key → server-side, else the runner); overrides sit behind Advanced.
 */
export default function ModelFeatures({ teamId, canManage, hasTeamKey }: {
  teamId: string;
  canManage: boolean;
  /** A pay-per-token key the team's own work can spend (the billing model). */
  hasTeamKey: boolean;
}) {
  const [modes, setModes] = useState<FeatureModes | null>(null);
  const [chatDisabled, setChatDisabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/teams/${teamId}`);
      if (res.ok) {
        const data = await res.json();
        setModes(normalizeFeatureModes(data.team?.inferenceFeatureModes));
        setChatDisabled(data.team?.chatDisabled === true);
      }
    } catch {
      /* non-fatal: the page shows defaults */
    } finally {
      setLoaded(true);
    }
  }, [teamId]);

  useEffect(() => { void load(); }, [load]);

  async function patch(body: Record<string, unknown>, rollback: () => void) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/teams/${teamId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Could not save');
    } catch (e) {
      rollback();
      setErr(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  function setInteractive(on: boolean) {
    const prev = chatDisabled;
    setChatDisabled(!on);
    void patch({ chatDisabled: !on }, () => setChatDisabled(prev));
  }

  function setOverride(feature: ServerFeature, value: OverrideValue) {
    const prev = modes;
    const next = normalizeFeatureModes({ ...(modes ?? {}), [feature]: value });
    setModes(next);
    void patch({ inferenceFeatureModes: next }, () => setModes(prev));
  }

  return (
    <div className="space-y-8">
      <section aria-labelledby="ai-interactive-h">
        <h2 id="ai-interactive-h" className="section-label mb-3">Interactive</h2>
        <div className="card flex items-center justify-between gap-3 px-4 py-3 min-h-14" data-testid="interactive-switch">
          <span className="flex items-center gap-2 text-sm text-text-primary min-w-0">
            <span aria-hidden className={`w-2 h-2 shrink-0 ${chatDisabled ? 'bg-text-muted' : 'bg-status-success'}`} />
            <span id="ai-interactive-label">Interactive AI</span>
            <span className="text-xs text-text-muted">{interactiveState(chatDisabled)}</span>
          </span>
          {canManage && (
            <Switch labelledBy="ai-interactive-label" checked={!chatDisabled} onChange={setInteractive} disabled={busy || !loaded} />
          )}
        </div>
      </section>

      <section aria-labelledby="ai-server-h">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 mb-3">
          <h2 id="ai-server-h" className="section-label">Server-side features</h2>
          <span className="text-xs text-text-muted" data-testid="feature-default">{defaultLine(hasTeamKey)}</span>
        </div>
        <div className="card divide-y divide-border-default">
          {LIVE_SERVER_FEATURES.map((f) => {
            const d = INFERENCE_CAPABILITIES[f];
            const r = resolveFeatureMode(f, modes, hasTeamKey);
            return (
              <div key={f} className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 sm:gap-3 px-4 py-3" data-testid={`feature-${f}`}>
                <span className="min-w-0">
                  <span className="block text-sm text-text-primary">{d.label}</span>
                  <span className="block text-xs text-text-secondary">{d.description}</span>
                </span>
                <span className={`shrink-0 text-xs ${r.needsKey ? 'text-status-warning' : r.mode === 'server' ? 'text-text-primary' : 'text-text-secondary'}`}>
                  {featureState(r)}
                </span>
              </div>
            );
          })}
        </div>

        {canManage && (
          <details className="mt-3 group" data-testid="feature-advanced">
            <summary className="cursor-pointer select-none list-none text-xs text-text-secondary hover:text-text-primary min-h-11 md:min-h-0 flex items-center gap-1">
              <span aria-hidden className="inline-block w-3 group-open:rotate-90 transition-transform">▸</span>
              Advanced
            </summary>
            <div className="card divide-y divide-border-default mt-2">
              {LIVE_SERVER_FEATURES.map((f) => {
                const current: OverrideValue = modes?.[f] ?? 'default';
                return (
                  <div key={f} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-3 px-4 py-3" data-testid={`override-${f}`}>
                    <span id={`override-${f}-label`} className="text-sm text-text-primary">{INFERENCE_CAPABILITIES[f].label}</span>
                    <div role="radiogroup" aria-labelledby={`override-${f}-label`} className="flex sm:inline-flex border border-border-default shrink-0">
                      {OVERRIDE_OPTIONS.map((o, i) => {
                        const on = current === o.value;
                        return (
                          <button
                            key={o.value}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            data-value={o.value}
                            disabled={busy || !loaded}
                            onClick={() => { if (!on) setOverride(f, o.value); }}
                            className={`flex-1 sm:flex-none h-11 md:h-8 px-3 text-xs transition-colors disabled:opacity-50 ${i > 0 ? 'border-l border-border-default' : ''} ${
                              on ? 'bg-surface-3 text-text-primary font-medium' : 'bg-surface-1 text-text-secondary hover:text-text-primary'
                            }`}
                          >
                            {o.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </details>
        )}
      </section>

      {!canManage && <p className="text-xs text-text-muted">Only a team owner or admin can change these.</p>}
      {err && <p role="alert" className="text-sm text-status-error">{err}</p>}
    </div>
  );
}
