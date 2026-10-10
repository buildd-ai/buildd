'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  INFERENCE_CAPABILITIES,
  OPT_IN_CAPABILITIES,
  normalizeDecisionShadows,
  type InferenceCapability,
} from '@buildd/core/inference-policy';
import Switch, { SWITCH_HIT_AREA } from '@/components/ui/Switch';

/**
 * `task_role_apply` is a second id for task role routing: either one stored
 * turns it on. One row stands for both.
 */
const ROLE_ROUTING = 'task_role_shadow';
const ROLE_ROUTING_ALIAS = 'task_role_apply';

/** The opt-in decisions listed, one row each. */
export const LISTED_DECISIONS: readonly InferenceCapability[] = OPT_IN_CAPABILITIES.filter(c => c !== ROLE_ROUTING_ALIAS);

/**
 * Settings → Models → Features: the opt-in decision features, one switch each.
 * Platform owner only (models/page.tsx); the list moved to the admin app.
 *
 * Chat is always on and built-in decision calls have no control, so neither is
 * listed. Goal grading has no control either: Auto is the behaviour.
 */
export default function DecisionFeatures({ teamId, canManage }: {
  teamId: string;
  canManage: boolean;
}) {
  const [shadows, setShadows] = useState<string[] | null>(null);
  const [decisionsLoaded, setDecisionsLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setDecisionsLoaded(false);
    try {
      const res = await fetch(`/api/teams/${teamId}`);
      if (res.ok) {
        const data = await res.json();
        const normalized = normalizeDecisionShadows(data.team?.enabledDecisionShadows ?? null);
        setShadows(normalized.ok ? normalized.value : null);
        setDecisionsLoaded(normalized.ok);
      }
    } catch {
      /* non-fatal: the switches stay disabled */
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

  const isOn = (capability: string) =>
    (shadows?.includes(capability) ?? false) ||
    (capability === ROLE_ROUTING && (shadows?.includes(ROLE_ROUTING_ALIAS) ?? false));

  function setDecision(capability: string, enabled: boolean) {
    const prev = shadows;
    // Turning role routing off clears its alias too, or it would stay on.
    const off = capability === ROLE_ROUTING ? [ROLE_ROUTING, ROLE_ROUTING_ALIAS] : [capability];
    const values = enabled ? [...(shadows ?? []), capability] : (shadows ?? []).filter(c => !off.includes(c));
    const next = values.length ? values : null;
    setShadows(next);
    void patch({ enabledDecisionShadows: next }, () => setShadows(prev));
  }

  return (
    <div className="space-y-8">
      <section aria-labelledby="ai-decisions-h">
        <h3 id="ai-decisions-h" className="text-sm font-semibold text-text-primary mb-3">Decision features</h3>
        <div className="border-y border-border-default divide-y divide-border-default">
          {LISTED_DECISIONS.map(capability => {
            const descriptor = INFERENCE_CAPABILITIES[capability];
            const enabled = isOn(capability);
            return (
              <div key={capability} data-testid={`decision-${capability}`} className="flex items-center justify-between gap-4 py-4">
                <span className="min-w-0">
                  <span id={`decision-${capability}-label`} className="block text-body text-text-primary">{descriptor.label}</span>
                  <span className="block text-meta text-text-secondary">{descriptor.description}</span>
                  <span className="block mt-1 text-meta text-text-muted">{descriptor.costHint}</span>
                </span>
                {canManage ? (
                  <Switch checked={enabled} labelledBy={`decision-${capability}-label`} disabled={busy || !decisionsLoaded}
                    className={SWITCH_HIT_AREA} onChange={next => setDecision(capability, next)} />
                ) : (
                  <span className="shrink-0 text-meta text-text-primary">{enabled ? 'On' : 'Off'}</span>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {err && <p role="alert" className="text-sm text-status-error">{err}</p>}
    </div>
  );
}
