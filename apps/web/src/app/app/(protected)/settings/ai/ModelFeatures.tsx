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
import { defaultLine, featureState, OVERRIDE_OPTIONS, type OverrideValue } from './feature-copy';

/**
 * Settings → AI features.
 *
 * Chat is always on (it runs whenever a key resolves), so it has no control
 * here. Built-in decision calls have no control and are not listed. Each
 * feature is one row: Auto follows the billing model (team key → server, else
 * the runner), and admins can pin Server or Runner inline.
 */
export default function ModelFeatures({ teamId, canManage, hasTeamKey }: {
  teamId: string;
  canManage: boolean;
  /** A pay-per-token key the team's own work can spend (the billing model). */
  hasTeamKey: boolean;
}) {
  const [modes, setModes] = useState<FeatureModes | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/teams/${teamId}`);
      if (res.ok) {
        const data = await res.json();
        setModes(normalizeFeatureModes(data.team?.inferenceFeatureModes));
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

  function setOverride(feature: ServerFeature, value: OverrideValue) {
    const prev = modes;
    const next = normalizeFeatureModes({ ...(modes ?? {}), [feature]: value });
    setModes(next);
    void patch({ inferenceFeatureModes: next }, () => setModes(prev));
  }

  return (
    <div className="space-y-8">
      <section aria-labelledby="ai-features-h">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 mb-3">
          <h2 id="ai-features-h" className="section-label">Where it runs</h2>
          <span className="text-xs text-text-muted" data-testid="feature-default">{defaultLine(hasTeamKey)}</span>
        </div>
        <div className="card divide-y divide-border-default">
          {LIVE_SERVER_FEATURES.map((f) => {
            const d = INFERENCE_CAPABILITIES[f];
            const r = resolveFeatureMode(f, modes, hasTeamKey);
            const current: OverrideValue = modes?.[f] ?? 'default';
            return (
              <div key={f} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-4 px-4 py-3" data-testid={`feature-${f}`}>
                <span className="min-w-0">
                  <span id={`feature-${f}-label`} className="block text-sm text-text-primary">{d.label}</span>
                  <span className="block text-xs text-text-secondary">{d.description}</span>
                  {canManage && r.needsKey && (
                    <span className="block mt-1 text-xs text-status-warning">Needs a team key</span>
                  )}
                </span>
                {canManage ? (
                  <div role="radiogroup" aria-labelledby={`feature-${f}-label`} className="flex sm:inline-flex border border-border-strong shrink-0">
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
                          className={`flex-1 sm:flex-none h-11 md:h-8 px-3 text-xs transition-colors disabled:opacity-50 ${i > 0 ? 'border-l border-border-strong' : ''} ${
                            on ? 'bg-text-primary text-surface-1 font-medium' : 'bg-surface-1 text-text-secondary hover:text-text-primary'
                          }`}
                        >
                          {o.label}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <span className={`shrink-0 text-xs ${r.needsKey ? 'text-status-warning' : 'text-text-primary'}`}>
                    {featureState(r)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {!canManage && <p className="text-xs text-text-muted">Only a team owner or admin can change these.</p>}
      {err && <p role="alert" className="text-sm text-status-error">{err}</p>}
    </div>
  );
}
