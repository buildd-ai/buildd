'use client';

import { useEffect, useState } from 'react';
import ActivityView, { type ActivityMode } from '../../(protected)/tasks/ActivityView';
import { ACTIVITY_FIXTURE_NOW, ACTIVITY_SEQUENCE, activityFixture } from './activity-delivery-fixtures';

/**
 * Activity Now/History on fabricated data (activity-delivery-fixtures.ts).
 * `&step=0..7` walks task 34 through audit fail → repair → re-audit → land;
 * `&view=history` opens History. Task 34's evidence starts expanded.
 */
export default function ActivityDeliveryFixture() {
  const [step, setStep] = useState(4);
  const [mode, setMode] = useState<ActivityMode>('now');
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const n = Number(q.get('step'));
    if (Number.isFinite(n) && q.get('step') != null) setStep(n);
    if (q.get('view') === 'history') setMode('history');
  }, []);
  const data = activityFixture(step);
  const href = (view: ActivityMode, s = data.step) => `/app/dev/fixtures?state=activity-delivery&step=${s}${view === 'history' ? '&view=history' : ''}`;

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
        key={`${mode}-${data.step}`}
        mode={mode}
        now={data.now}
        history={data.history}
        nowMs={ACTIVITY_FIXTURE_NOW}
        hrefs={{ now: href('now'), history: href('history') }}
        openRowIds={['fx-t34']}
      />
      </div>
    </div>
  );
}
