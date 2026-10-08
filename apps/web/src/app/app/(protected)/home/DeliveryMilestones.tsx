/**
 * Home's "Moving toward delivery": 2–3 mission outcomes, each with its chip,
 * one evidence sentence, the Build › Audit › Land track, landed n of m and the
 * next milestone. Rendered from lib/delivery-projection.ts, the same
 * projection the other surfaces read; nothing here derives state.
 */
import Link from 'next/link';
import {
  DELIVERY_KIND, DELIVERY_STAGES, deliveryStageIndex, repairBadge,
  type DeliveryKind, type DeliveryTone, type MissionDelivery,
} from '@/lib/delivery-projection';

const TONE_TEXT: Record<DeliveryTone, string> = {
  success: 'text-status-success', info: 'text-status-info', warning: 'text-status-warning',
  ink: 'text-text-primary', muted: 'text-text-muted', error: 'text-status-error',
};
const TONE_EDGE: Record<DeliveryTone, string> = {
  success: 'border-l-status-success', info: 'border-l-status-info', warning: 'border-l-status-warning',
  ink: 'border-l-accent', muted: 'border-l-border-default', error: 'border-l-status-error',
};

export function DeliveryChip({ kind }: { kind: DeliveryKind }) {
  const k = DELIVERY_KIND[kind];
  return (
    <span data-testid="delivery-chip" data-kind={kind} className={`inline-flex shrink-0 items-center gap-1 border border-border-default px-1.5 font-mono text-meta ${TONE_TEXT[k.tone]}`}>
      <span aria-hidden="true">{k.glyph}</span>{k.label}
    </span>
  );
}

/** Build › Audit › Land in words: ✓ for passed stages, the current one underlined. Repair shows as `Audit ↻N`. */
export function DeliveryTrack({ kind, rounds }: { kind: DeliveryKind; rounds: number }) {
  const at = deliveryStageIndex(kind);
  const current = DELIVERY_STAGES[Math.max(0, Math.min(2, at))];
  return (
    <span className="inline-flex flex-wrap items-center gap-1 font-mono text-meta" aria-label={at < 0 ? 'Not started' : at > 2 ? 'Landed' : `Stage: ${current}`}>
      {DELIVERY_STAGES.map((name, i) => {
        const done = at > i;
        const cur = at === i;
        const text = done ? `✓ ${name}` : cur && i === 1 && rounds > 0 ? `${name} ${repairBadge(rounds)}` : name;
        return (
          <span key={name} className="inline-flex items-center gap-1">
            {i > 0 && <span aria-hidden="true" className="text-text-muted">›</span>}
            <span className={done ? 'text-text-secondary' : cur ? 'font-semibold text-text-primary underline underline-offset-4' : 'text-text-muted'}>{text}</span>
          </span>
        );
      })}
    </span>
  );
}

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
                <DeliveryTrack kind={m.kind} rounds={m.repairRounds} />
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
