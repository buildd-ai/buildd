import Link from 'next/link';
import type { OverviewStatusRow, OverviewTone } from '@/lib/health-overview';

const TONE_TEXT: Record<OverviewTone, string> = {
  ok: 'text-status-success',
  warning: 'text-status-warning',
  error: 'text-status-error',
  muted: 'text-text-muted',
};

/** The one status sentence at the top of Health → Overview. */
export function OverviewHeadline({ tone, text }: { tone: 'ok' | 'attention'; text: string }) {
  return (
    <p
      data-testid="health-overview-headline"
      className={`text-lede font-semibold mb-6 ${tone === 'ok' ? 'text-status-success' : 'text-text-primary'}`}
    >
      {text}
    </p>
  );
}

/** Runners, credentials and budget as short rows; each opens Runners & capacity. */
export function OverviewStatusRows({ rows }: { rows: OverviewStatusRow[] }) {
  return (
    <section data-testid="health-overview-status" className="mb-6" aria-labelledby="health-overview-status-h">
      <h2 id="health-overview-status-h" className="section-label mb-3">At a glance</h2>
      <ul className="border-y border-border-default divide-y divide-border-default">
        {rows.map(row => (
          <li key={row.key}>
            <Link
              href={row.href}
              data-testid={`health-overview-row-${row.key}`}
              className="flex items-center justify-between gap-3 px-4 py-3 min-h-11 hover:bg-surface-2 transition-colors"
            >
              <span className="text-body text-text-primary">{row.label}</span>
              <span className={`text-body text-right ${TONE_TEXT[row.tone]}`}>{row.value}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
