'use client';

/**
 * "Final screens": the latest shot per route, viewport and theme, shown once
 * the mission's PR has merged. Optional and read-only: no control here gates
 * the mission, a merge or a release. "File a fix" sends the same
 * needs-fix decision the review deck does, which files a `[surface fix]` task.
 */
import { useMemo, useState } from 'react';
import ShotImage, { VIEWPORT_LABEL, viewportAspect } from '@/components/visual-review/ShotImage';
import { createHttpVisualReviewTransport, type VisualReviewTransport } from '@/components/visual-review/review-transport';
import type { FinalScreen } from '@/lib/visual-review-final-screens';

type Filed = { state: 'idle' } | { state: 'busy' } | { state: 'filed' } | { state: 'error'; message: string };

export default function MissionFinalScreens({
  missionId,
  screens,
  transport,
}: {
  missionId: string;
  screens: readonly FinalScreen[];
  transport?: VisualReviewTransport;
}) {
  const t = useMemo(() => transport ?? createHttpVisualReviewTransport(missionId), [transport, missionId]);
  const [filed, setFiled] = useState<Record<string, Filed>>({});
  if (screens.length === 0) return null;

  async function fileFix(s: FinalScreen) {
    setFiled(f => ({ ...f, [s.key]: { state: 'busy' } }));
    try {
      await t.decide({ artifactIds: [s.shotId], decision: 'needs_fix', expected: { [s.shotId]: s.agentVerdict } });
      setFiled(f => ({ ...f, [s.key]: { state: 'filed' } }));
    } catch (e) {
      setFiled(f => ({ ...f, [s.key]: { state: 'error', message: e instanceof Error ? e.message : 'Could not file the fix.' } }));
    }
  }

  return (
    <section data-testid="mission-final-screens" aria-label="Final screens" className="mt-6">
      <h2 className="text-eyebrow font-mono uppercase text-text-muted">Final screens</h2>
      <ul className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        {screens.map(s => {
          const f = filed[s.key] ?? { state: 'idle' as const };
          const hasFix = s.fixTaskId != null || f.state === 'filed';
          const label = [s.route, VIEWPORT_LABEL[s.viewport], s.theme !== 'default' ? s.theme : null, s.state].filter(Boolean).join(' · ');
          return (
            <li key={s.key} data-testid="final-screen" data-key={s.key} className="flex min-w-0 flex-col gap-1.5">
              <div className={`${viewportAspect(s.viewport)} overflow-hidden border border-border-default bg-surface-2`}>
                <ShotImage shot={{ id: s.shotId, src: s.src }} alt={label} className="h-full w-full object-cover object-top" />
              </div>
              <p className="font-mono text-meta text-text-secondary [overflow-wrap:anywhere]">{label}</p>
              {hasFix ? (
                <p data-testid="final-screen-filed" className="text-meta text-text-muted">Fix filed</p>
              ) : (
                <button
                  type="button"
                  data-testid="final-screen-file-fix"
                  disabled={f.state === 'busy'}
                  onClick={() => fileFix(s)}
                  className="min-h-11 self-start text-meta text-text-secondary underline disabled:opacity-50 md:min-h-0"
                >
                  {f.state === 'busy' ? 'Filing…' : 'File a fix'}
                </button>
              )}
              {f.state === 'error' && <p role="alert" className="text-meta text-status-error">{f.message}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
