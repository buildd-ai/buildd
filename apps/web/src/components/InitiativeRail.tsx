import Link from 'next/link';
import { initiativeStatusChip, deriveInitiativeDisplayStatus } from '@/lib/initiative-presentation';
import type { InitiativeListItem } from '@/lib/initiative-list';

/**
 * The Home initiative rail — a horizontally scrollable strip of durable-arc
 * summary cards that sits ABOVE the ephemeral mission feed. Purely additive: it
 * renders nothing when there are no initiatives (empty-collapse) and never
 * touches mission grouping, so it cannot hide an un-filed or scheduled mission.
 * Callers pass an already-sorted, already-capped list.
 *
 * Mobile card spec: 160pt wide; 4pt accent left border for active/blocked;
 * initiative name (single line, truncate); rollup %; status chip.
 */
export default function InitiativeRail({ initiatives }: { initiatives: InitiativeListItem[] }) {
  if (initiatives.length === 0) return null;

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <div className="section-label">Initiatives</div>
        <Link href="/app/initiatives" className="text-xs text-text-muted hover:text-text-secondary pr-1">
          {initiatives.length} arc{initiatives.length === 1 ? '' : 's'}
        </Link>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2 -mx-4 px-4 snap-x snap-mandatory scroll-pl-4">
        {initiatives.map((initiative) => {
          const displayStatus = deriveInitiativeDisplayStatus({ status: initiative.status, rollupStatus: initiative.progress.status });
          const chip = initiativeStatusChip(displayStatus);
          const showAccent = displayStatus === 'active' || displayStatus === 'blocked';
          return (
            <Link
              key={initiative.id}
              href={`/app/initiatives/${initiative.id}`}
              className="snap-start shrink-0 w-[160px] card flex overflow-hidden hover:border-border-hover transition-colors"
            >
              {showAccent && <div className="w-1 self-stretch bg-primary shrink-0" aria-hidden />}
              <div className="flex-1 py-3 px-3 min-w-0">
                <div className="font-mono text-[14px] font-semibold text-text-primary line-clamp-2 mb-1.5 leading-snug">
                  {initiative.title}
                </div>
                <div className="font-mono text-[11px] font-semibold text-accent-text mb-1.5">
                  {initiative.progress.progress}%
                </div>
                <span
                  className={`inline-block text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 border ${chip.className}`}
                >
                  {chip.label}
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
