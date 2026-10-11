'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import StatePill from '@/components/ui/StatePill';
import Notice from '@/components/ui/Notice';
import PrimaryAction from '@/components/ui/PrimaryAction';
import { formatInZone } from '@/lib/zoned-time';
import type { IncidentOptionView, IncidentProjection } from '@/lib/incident-view';

const RETRY = 'That did not go through. Try again.';

export interface IncidentRecoveryPanelProps {
  incidentId: string;
  projection: IncidentProjection;
  timeZone: string;
  /** Fixtures: render the options without posting anywhere. */
  readOnly?: boolean;
  /** Fixtures: the clock durations are measured against. Default: now. */
  now?: string;
}

function when(iso: string | null, tz: string): string | null {
  return iso ? formatInZone(iso, tz, 'datetime-short') : null;
}

function since(iso: string | null, nowMs: number): string | null {
  if (!iso) return null;
  const m = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.round(h / 24)}d`;
}

/**
 * Where an incident's recovery stands, and the one choice it needs if any.
 * Every word comes from the shared projection (lib/incident-view.ts); a click
 * goes to the re-check route, and a 409 replaces this projection with the
 * fresh one instead of acting on a stale screen.
 */
export default function IncidentRecoveryPanel({ incidentId, projection: initial, timeZone, readOnly = false, now }: IncidentRecoveryPanelProps) {
  const router = useRouter();
  const [projection, setProjection] = useState(initial);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'warn' | 'err' | 'info'; text: string } | null>(null);
  const p = projection;
  const nowMs = now ? Date.parse(now) : Date.now();

  async function choose(o: IncidentOptionView) {
    if (readOnly || o.mode !== 'post') return;
    setPending(o.capability);
    setNotice(null);
    try {
      const res = await fetch(`/api/health/incidents/${incidentId}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ capability: o.capability, generation: p.generation, evidenceRevision: p.evidenceRevision }),
      });
      const body = await res.json().catch(() => null);
      if (body?.projection) setProjection(body.projection as IncidentProjection);
      if (res.status === 409) setNotice({ tone: 'warn', text: 'This changed since you opened it. Here is where it stands now.' });
      else if (!res.ok) setNotice({ tone: 'err', text: typeof body?.error === 'string' && res.status < 500 ? body.error : RETRY });
      else router.refresh();
    } catch {
      setNotice({ tone: 'err', text: RETRY });
    } finally {
      setPending(null);
    }
  }

  const facts: Array<[string, string | null]> = [
    ['Owner', p.ownerLabel],
    ['Waiting', p.phase === 'recovered' ? null : since(p.waitingSince, nowMs)],
    ['Last checked', when(p.lastCheckedAt, timeZone)],
    ['Next check', when(p.nextCheckAt, timeZone)],
    ['Next step', p.nextAction],
  ];
  const recommended = p.options.find(o => o.recommended && o.mode === 'post');

  return (
    <section aria-label="Recovery" className="space-y-3" data-testid="incident-recovery" data-phase={p.phase}>
      <div className="flex flex-wrap items-center gap-2">
        {pending
          ? <StatePill state="recovering" label="Checking current status" data-testid="incident-state" />
          : <StatePill state={p.pill} label={p.stateWord} data-testid="incident-state" />}
        {p.dismissed && <span className="text-meta text-text-muted">Dismissed; Buildd keeps checking</span>}
      </div>
      <p className="text-body text-text-primary" data-testid="incident-sentence">{p.sentence}</p>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-meta">
        {facts.filter(([, v]) => v).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-text-muted">{k}</dt>
            <dd className="text-text-secondary font-mono">{v}</dd>
          </div>
        ))}
      </dl>

      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      {p.options.length > 0 && (
        <div className="space-y-2" data-testid="incident-options">
          {p.options.map(o => (
            <div key={o.capability} className="flex flex-col gap-1 md:flex-row md:items-center md:gap-3">
              {o === recommended ? (
                <PrimaryAction onClick={() => choose(o)} pending={pending === o.capability} disabled={!!pending} fullWidthOnMobile data-testid={`incident-option-${o.capability}`}>
                  {o.label}
                </PrimaryAction>
              ) : o.mode === 'post' ? (
                <button type="button" className="btn btn-lg h-11 md:h-10 w-full md:w-auto" onClick={() => choose(o)} disabled={!!pending} data-testid={`incident-option-${o.capability}`}>
                  {o.label}
                </button>
              ) : o.mode === 'link' && o.href ? (
                <a className="btn btn-lg h-11 md:h-10 w-full md:w-auto" href={o.href} data-testid={`incident-option-${o.capability}`}>
                  {o.label}
                </a>
              ) : (
                <button type="button" className="btn btn-lg h-11 md:h-10 w-full md:w-auto" disabled aria-disabled="true" data-testid={`incident-option-${o.capability}`}>
                  {o.label}
                </button>
              )}
              <span className="text-meta text-text-muted">{o.mode === 'unavailable' ? o.unavailableReason : o.effect}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
