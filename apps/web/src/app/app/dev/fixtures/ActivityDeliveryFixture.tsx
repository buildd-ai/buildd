'use client';

import { useEffect, useState } from 'react';
import ActivityView, { type ActivityMode } from '../../(protected)/tasks/ActivityView';
import type { ActivityNow, ActivityOutcome } from '@/lib/activity-delivery';
import { ACTIVITY_FIXTURE_NOW, ACTIVITY_SEQUENCE, activityFixture, activityScaleFixture } from './activity-delivery-fixtures';

/**
 * Activity Now/History on fabricated data (activity-delivery-fixtures.ts).
 * `&step=0..7` walks task 34 through audit fail → repair → re-audit → land;
 * `&view=history` opens History. Task 34's evidence starts expanded.
 * `&data=scale` swaps in a busy workspace's 30 days (`&data=quiet`: the same, with
 * nothing retried still in motion, so Had retries is empty in Now only), `&outcome=retries|landed|exceptions`
 * starts with that filter, `&error=1` shows a failed load.
 */
export default function ActivityDeliveryFixture() {
  const [step, setStep] = useState(4);
  const [mode, setMode] = useState<ActivityMode>('now');
  const [variant, setVariant] = useState<{ scale: boolean; quiet: boolean; outcome: ActivityOutcome | null; error: boolean }>({ scale: false, quiet: false, outcome: null, error: false });
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const n = Number(q.get('step'));
    if (Number.isFinite(n) && q.get('step') != null) setStep(n);
    if (q.get('view') === 'history') setMode('history');
    const o = q.get('outcome');
    setVariant({ scale: q.get('data') === 'scale' || q.get('data') === 'quiet', quiet: q.get('data') === 'quiet', outcome: o === 'retries' || o === 'landed' || o === 'exceptions' ? o : null, error: q.get('error') === '1' });
  }, []);
  const seq = activityFixture(step);
  const scale = variant.scale ? activityScaleFixture() : null;
  const data = scale ? { ...scale, step: seq.step, now: variant.quiet ? quietNow(scale.now) : scale.now } : seq;
  const extra = `${variant.scale ? `&data=${variant.quiet ? 'quiet' : 'scale'}` : ''}${variant.outcome ? `&outcome=${variant.outcome}` : ''}${variant.error ? '&error=1' : ''}`;
  const href = (view: ActivityMode, s = data.step) => `/app/dev/fixtures?state=activity-delivery&step=${s}${view === 'history' ? '&view=history' : ''}${extra}`;

  return (
    <div className="flex h-screen flex-col">
      <nav aria-label="Fixture sequence" data-testid="activity-fixture-steps" className="flex gap-1 overflow-x-auto border-b border-dashed border-border-strong bg-surface-2 px-2 py-1 text-meta">
        {ACTIVITY_SEQUENCE.map((label, i) => (
          <a key={label} href={href(mode, i)} aria-current={i === data.step ? 'step' : undefined} className={`shrink-0 whitespace-nowrap px-2 py-1 ${i === data.step ? 'border border-accent text-accent-text' : 'text-text-muted'}`}>
            {i} · {label}
          </a>
        ))}
      </nav>
      <div className="min-h-0 flex-1">
      <ActivityView
        // `extra` is in the key: the query string is read after mount, and a starting filter needs a fresh view.
        key={`${mode}-${data.step}-${extra}`}
        mode={mode}
        now={data.now}
        history={data.history}
        latest={data.latest}
        nowMs={ACTIVITY_FIXTURE_NOW}
        hrefs={{ now: href('now'), history: href('history') }}
        openRowIds={['fx-t34']}
        loadError={variant.error}
        initialFilters={variant.outcome ? { outcome: variant.outcome } : undefined}
      />
      </div>
    </div>
  );
}

/** Now without the retried deliveries: what a workspace looks like once its retries have landed. */
function quietNow(now: ActivityNow): ActivityNow {
  const groups = now.groups.map(g => ({ ...g, rows: g.rows.filter(r => r.delivery.repairRounds === 0) })).filter(g => g.rows.length > 0);
  const rows = groups.flatMap(g => g.rows);
  return { groups, inMotion: rows.filter(r => r.delivery.kind !== 'waiting').length, liveAgents: rows.filter(r => r.live).length };
}
