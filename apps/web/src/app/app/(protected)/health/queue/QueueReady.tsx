import Link from 'next/link';
import type { HealthQueueResponse } from '@buildd/shared';
import DeliveryRow from '@/components/ui/DeliveryRow';
import { QUEUE_ANCHORS, readyDelivery } from './queue-board-model';

/**
 * Health › Queue's Queued and Scheduled lists (spec 4bc3e70e r8 R-7): Queued
 * tasks as DeliveryRow rows in claim order, each with when it starts or why no
 * runner takes it; Scheduled one line per task with its start time.
 */
export default function QueueReady({ view, now }: { view: HealthQueueResponse; now: number }) {
  return (
    <>
      <section id={QUEUE_ANCHORS.queued} aria-labelledby="queue-queued-h" className="min-w-0" data-testid="queue-ready">
        <h2 id="queue-queued-h" className="mb-1 text-eyebrow font-semibold text-text-muted">
          Queued <span className="font-mono">{view.tiles.ready}</span>
        </h2>
        {view.ready.length === 0 ? (
          <p className="py-2 text-body text-text-muted">Nothing queued.</p>
        ) : (
          <ol>
            {view.ready.map(r => (
              <li key={r.id} data-testid="queue-ready-row" className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                <DeliveryRow delivery={readyDelivery(r)} now={now} />
                <span
                  data-testid="queue-ready-note"
                  className={`flex max-w-[8rem] self-stretch items-center justify-end border-t border-border-default text-right font-mono text-chip [overflow-wrap:anywhere] md:max-w-[16rem] ${r.noRunner ? 'text-status-warning' : 'text-text-muted'}`}
                >
                  {r.note}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
      {view.parked.length > 0 && (
        <section id={QUEUE_ANCHORS.scheduled} aria-labelledby="queue-scheduled-h" className="min-w-0" data-testid="queue-parked">
          <h2 id="queue-scheduled-h" className="mb-1 text-eyebrow font-semibold text-text-muted">
            Scheduled <span className="font-mono">{view.tiles.parked}</span>
          </h2>
          <ul>
            {view.parked.map(p => (
              <li key={p.id} className="flex min-h-11 min-w-0 items-center gap-3 border-t border-border-default">
                <Link href={`/app/tasks/${p.id}`} className="min-w-0 flex-1 truncate text-body text-text-primary hover:underline">{p.title}</Link>
                <span className="shrink-0 font-mono text-chip text-text-muted">{p.starts}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
