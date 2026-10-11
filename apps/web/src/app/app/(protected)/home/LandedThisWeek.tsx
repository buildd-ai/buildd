/** Home's "Landed this week": missions that finished in the last seven days, newest first. */
import Link from 'next/link';

export interface LandedMission {
  id: string;
  title: string;
  href: string;
  completedAt: string;
  prs: number;
}

function day(iso: string, tz?: string | null): string {
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', ...(tz ? { timeZone: tz } : {}) });
}

export function LandedThisWeek({ missions, timeZone, idPrefix = 'home' }: { missions: readonly LandedMission[]; timeZone?: string | null; idPrefix?: string }) {
  if (missions.length === 0) return null;
  return (
    <section data-testid="home-landed" aria-labelledby={`${idPrefix}-landed-h`} style={{ gridArea: 'landed' }} className="min-w-0">
      <h2 id={`${idPrefix}-landed-h`} className="section-label mb-3">Landed this week</h2>
      <ul className="divide-y divide-border-default border-t border-border-default">
        {missions.map(m => (
          <li key={m.id}>
            <Link href={m.href} className="flex min-h-11 items-baseline gap-2.5 py-2 hover:underline md:min-h-0">
              <span aria-hidden="true" className="shrink-0 text-status-success">■</span>
              <span className="min-w-0 flex-1 truncate text-body text-text-primary">{m.title}</span>
              <span className="shrink-0 font-mono text-meta text-text-muted">{m.prs > 0 ? `${m.prs} PR${m.prs === 1 ? '' : 's'} · ` : ''}{day(m.completedAt, timeZone)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
