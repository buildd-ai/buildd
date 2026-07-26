import Link from 'next/link';
import InitiativeCard from './InitiativeCard';
import type { InitiativeListItem } from '@/lib/initiative-list';

/**
 * The Home initiative rail — a horizontally scrollable strip of durable-arc
 * summary cards that sits ABOVE the ephemeral mission feed. Purely additive: it
 * renders nothing when there are no initiatives (empty-collapse) and never
 * touches mission grouping, so it cannot hide an un-filed or scheduled mission.
 * Callers pass an already-sorted, already-capped list.
 */
export default function InitiativeRail({ initiatives }: { initiatives: InitiativeListItem[] }) {
  if (initiatives.length === 0) return null;

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <div className="section-label">Initiatives</div>
        <Link href="/app/initiatives" className="text-xs text-text-muted hover:text-text-secondary">
          {initiatives.length} arc{initiatives.length === 1 ? '' : 's'}
        </Link>
      </div>
      {/* Horizontal scroll on mobile; on desktop the cards sit in a row and wrap
          into the scroll only when they overflow. */}
      <div className="flex gap-3 overflow-x-auto pb-1 -mx-1 px-1 snap-x">
        {initiatives.map((initiative) => (
          <div key={initiative.id} className="snap-start shrink-0 w-[300px] max-w-[85vw]">
            <InitiativeCard initiative={initiative} />
          </div>
        ))}
      </div>
    </div>
  );
}
