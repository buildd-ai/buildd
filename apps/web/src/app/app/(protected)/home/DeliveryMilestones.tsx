/**
 * Home's "Moving toward delivery": 2–3 mission outcomes as a hairline list,
 * the same grammar as Agents and Landed beside it. Each row: the title
 * (wrapping, so a long one still says what it is), one status line (phase
 * glyph and word, landed n of m), one sentence (the exception when there is
 * one, else the evidence, which carries a repair's round) and the next
 * milestone. Home only lists missions on
 * the Build › Audit › Land track, so the phase word already says where on it
 * the mission is. Rendered from lib/delivery-projection.ts, the same
 * projection the other surfaces read; nothing here derives state.
 */
import Link from 'next/link';
import type { MissionDelivery } from '@/lib/delivery-projection';
import { DeliveryChip, TONE_TEXT } from '@/components/delivery/DeliveryParts';

export function DeliveryMilestones({ missions, openMissions }: { missions: readonly MissionDelivery[]; openMissions: number }) {
  if (missions.length === 0) return null;
  return (
    <section data-testid="home-delivery-milestones" aria-labelledby="home-delivery-heading" className="mb-8">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 id="home-delivery-heading" className="section-label">Moving toward delivery</h2>
        <Link href="/app/missions" className="inline-flex min-h-11 shrink-0 items-center whitespace-nowrap text-meta text-text-muted hover:text-text-primary md:min-h-0">{openMissions} open mission{openMissions === 1 ? '' : 's'} ›</Link>
      </div>
      <ul className="divide-y divide-border-default border-y border-border-default">
        {missions.map(m => (
          <li key={m.id}>
            <Link href={m.href} data-testid="home-delivery-row" data-kind={m.kind} className="group grid gap-1 py-3">
              <span className="line-clamp-3 break-words text-title font-semibold leading-snug text-text-primary group-hover:underline">{m.title}</span>
              <span className="flex flex-wrap items-center gap-x-2 font-mono text-meta text-text-muted">
                <DeliveryChip kind={m.kind} />
                {m.total > 0 && <span>· {m.landed} of {m.total} landed</span>}
              </span>
              {m.exception
                ? <span className={`font-convo text-body ${TONE_TEXT[m.exception.tone]}`}>{m.exception.text}</span>
                : <span className="font-convo text-body text-text-secondary">{m.evidence}</span>}
              <span className="text-meta text-text-secondary"><span className="text-text-muted">Next:</span> {m.next}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
