import Link from 'next/link';

export interface InitiativeStripItem {
  id: string;
  title: string;
  status: string;
  progress: number;
  completedMissions: number;
  totalMissions: number;
  rollupStatus: 'empty' | 'active' | 'blocked' | 'paused' | 'completed';
}

const ROLLUP_ACCENT: Record<InitiativeStripItem['rollupStatus'], string> = {
  blocked: 'bg-status-warning',
  active: 'bg-status-info',
  completed: 'bg-status-success',
  paused: 'bg-text-muted',
  empty: 'bg-text-muted',
};

/**
 * A compact strip of initiatives shown above the missions list. Initiatives live
 * inside the Missions surface (no dedicated nav tab); each card drills down to
 * /app/initiatives/[id]. When empty, shows only the create affordance.
 */
export function InitiativesStrip({ initiatives }: { initiatives: InitiativeStripItem[] }) {
  return (
    <div className="mb-6">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-xs font-medium text-text-secondary uppercase tracking-wide">Initiatives</h2>
        <Link href="/app/initiatives/new" className="text-[11px] text-text-muted hover:text-text-secondary transition-colors">
          + New
        </Link>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {initiatives.map((i) => (
          <Link
            key={i.id}
            href={`/app/initiatives/${i.id}`}
            className="card p-3 hover:border-border-hover transition-colors block"
          >
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <span className="text-sm font-medium text-text-primary truncate">{i.title}</span>
              <span className="text-[11px] text-text-muted shrink-0">{i.progress}%</span>
            </div>
            <div className="h-1 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden mb-1.5">
              <div
                className={`h-full ${ROLLUP_ACCENT[i.rollupStatus]} transition-all`}
                style={{ width: `${i.progress}%` }}
              />
            </div>
            <div className="flex items-center gap-2 text-[11px] text-text-muted">
              <span className="capitalize">{i.rollupStatus}</span>
              <span>·</span>
              <span>{i.completedMissions}/{i.totalMissions} missions</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
