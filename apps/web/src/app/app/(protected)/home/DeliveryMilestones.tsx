/**
 * Home's "Moving toward delivery": 2–3 mission outcomes, each with its chip,
 * one evidence sentence, the Build → Audit → Land track (`Lifecycle`), landed n of m and the
 * next milestone. Rendered from lib/delivery-projection.ts, the same
 * projection the other surfaces read; nothing here derives state.
 */
import Link from 'next/link';
import { DELIVERY_KIND, type MissionDelivery } from '@/lib/delivery-projection';
import { DeliveryChip, TONE_EDGE, TONE_TEXT } from '@/components/delivery/DeliveryParts';
import { lifecycleState } from '@/components/delivery/lifecycle-state';
import Lifecycle from '@/components/ui/Lifecycle';

export function DeliveryMilestones({ missions, openMissions }: { missions: readonly MissionDelivery[]; openMissions: number }) {
  if (missions.length === 0) return null;
  return (
    <section data-testid="home-delivery-milestones" aria-labelledby="home-delivery-heading" className="mb-8">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id="home-delivery-heading" className="section-label">Moving toward delivery</h2>
        <Link href="/app/missions" className="inline-flex min-h-11 items-center text-meta text-text-muted md:min-h-0">{openMissions} open mission{openMissions === 1 ? '' : 's'} ›</Link>
      </div>
      <div className="space-y-3">
        {missions.map(m => {
          const tone = DELIVERY_KIND[m.kind].tone;
          return (
            <Link
              key={m.id}
              href={m.href}
              data-testid="home-delivery-row"
              data-kind={m.kind}
              className={`grid gap-1.5 border border-border-default border-l-4 ${TONE_EDGE[tone]} bg-[var(--chat-surface)] px-3.5 py-3`}
            >
              <span className="flex items-start justify-between gap-2">
                <span className="line-clamp-2 min-w-0 break-words text-title font-semibold text-text-primary">{m.title}</span>
                <DeliveryChip kind={m.kind} />
              </span>
              <span className="font-convo text-body text-text-secondary">{m.evidence}</span>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Lifecycle state={lifecycleState(m.kind)} repairs={m.repairRounds} />
                {m.total > 0 && <span className="font-mono text-meta text-text-muted">{m.landed} of {m.total} landed</span>}
              </span>
              {m.exception && <span className={`text-meta ${TONE_TEXT[m.exception.tone]}`}>{m.exception.text}</span>}
              <span className="text-meta text-text-muted">Next: {m.next}</span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
