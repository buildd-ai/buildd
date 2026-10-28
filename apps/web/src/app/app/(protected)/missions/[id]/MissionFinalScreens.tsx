/**
 * The screens as they stood when the mission merged, one per route and
 * viewport, newest round of each. A screen the automatic fix rounds did not
 * settle says so and links the follow-up `[surface fix]` filed for it, so
 * nothing left open at the merge goes unseen (spec 072de598 AC-14, AC-33).
 */
import Link from 'next/link';
import type { VisualReviewModel } from '@buildd/shared';
import type { ExhaustedFollowUp } from '@/lib/visual-review-exhausted';

const VIEWPORT_WORD = { mobile: 'Phone', desktop: 'Desktop' } as const;

export default function MissionFinalScreens({ model, followUps }: { model: VisualReviewModel; followUps: ExhaustedFollowUp[] }) {
  if (model.cells.length === 0) return null;
  const open = new Set((model.exhaustedFindings ?? []).map(f => f.key));
  return (
    <section data-testid="mission-final-screens" aria-label="Final screens" className="mt-3 flex flex-col gap-2 border-t border-border-default pt-3 text-meta">
      <h3 className="font-semibold text-text-primary">Final screens</h3>
      {followUps.length > 0 && (
        <ul data-testid="mission-final-screens-followups" className="flex flex-col gap-0.5 text-text-secondary">
          {followUps.map(f => (
            <li key={f.id}><Link href={`/app/tasks/${f.id}`} className="underline [overflow-wrap:anywhere]">{f.title}</Link></li>
          ))}
        </ul>
      )}
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {model.cells.map(c => (
          <li key={c.key} data-testid="mission-final-screen" data-open={open.has(c.key) ? 'true' : 'false'} className="flex flex-col gap-1">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={c.current.shot.src} alt={`${c.route}, ${VIEWPORT_WORD[c.viewport]}`} loading="lazy" className="w-full rounded border border-border-default" />
            <span className="font-mono text-eyebrow text-text-muted [overflow-wrap:anywhere]">{c.route} · {VIEWPORT_WORD[c.viewport]}</span>
            {open.has(c.key) && <span className="text-text-secondary">Still looks wrong; filed as a follow-up fix.</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
