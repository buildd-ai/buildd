/**
 * Home's "Moving toward delivery": 2–3 mission outcomes drawn with the shared
 * mission row (ui/MissionRow), the same row the Missions portfolio uses:
 * title, the small strip (one cell per task), one state line (n of m landed),
 * Next, and the exception as a note when there is one. Home only lists
 * missions on the Build › Audit › Land track. Rendered from
 * lib/delivery-projection.ts, the same projection the other surfaces read;
 * nothing here derives state.
 */
import Link from 'next/link';
import type { MissionDelivery } from '@/lib/delivery-projection';
import { DELIVERY_KIND } from '@/lib/delivery-projection';
import { STATE_OF_KIND } from '@/lib/mission-sections';
import { lifecycleState } from '@/components/delivery/lifecycle-state';
import MissionRow from '@/components/ui/MissionRow';

export function DeliveryMilestones({ missions, openMissions }: { missions: readonly MissionDelivery[]; openMissions: number }) {
  if (missions.length === 0) return null;
  return (
    <section data-testid="home-delivery-milestones" aria-labelledby="home-delivery-heading" className="mb-8">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 id="home-delivery-heading" className="section-label">Moving toward delivery</h2>
        <Link href="/app/missions" className="inline-flex min-h-11 shrink-0 items-center whitespace-nowrap text-meta text-text-muted hover:text-text-primary md:min-h-0">{openMissions} open mission{openMissions === 1 ? '' : 's'} ›</Link>
      </div>
      <ul className="border-b border-border-default">
        {missions.map(m => {
          const state = STATE_OF_KIND[m.kind] ?? undefined;
          const stat = m.total > 0 ? `${m.landed} of ${m.total} landed` : undefined;
          const kind = DELIVERY_KIND[m.kind];
          return (
            <li key={m.id} data-testid="home-delivery-row" data-kind={m.kind}>
              <MissionRow
                href={m.href}
                title={m.title}
                strip={m.tasks.map(t => lifecycleState(t.delivery.kind))}
                state={state}
                stat={stat}
                meta={state ? undefined : `${kind.glyph} ${kind.label}${stat ? ` · ${stat}` : ''}`}
                next={m.next}
                note={m.exception?.text}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
