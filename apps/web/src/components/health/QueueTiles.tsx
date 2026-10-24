import Link from 'next/link';
import { runningOfCap, termWord } from '@buildd/shared';

export type QueueReason = 'lane' | 'limit' | 'dependency';

/** Reason order everywhere on Queue: Lane, Limit, Dependency (spec 4bc3e70e R-6). */
export const QUEUE_REASONS: readonly QueueReason[] = ['lane', 'limit', 'dependency'];

export const QUEUE_REASON_TERM = {
  lane: 'queue.lane',
  limit: 'queue.limit',
  dependency: 'queue.dependency',
} as const;

export const QUEUE_REASON_BAR: Record<QueueReason, string> = {
  lane: 'bg-text-muted',
  limit: 'bg-status-warning',
  dependency: 'bg-status-info',
};

export interface QueueTilesProps {
  /** The same numbers Capacity shows on Runners: slots busy and slots in total. */
  running: { used: number; total: number };
  queued: number;
  blocked: { lane: number; limit: number; dependency: number };
  scheduled: number;
  /** Where each tile goes: its rows. */
  hrefs: { running: string; queued: string; blocked: string; scheduled: string };
  /** Two columns on a phone, four on desktop. */
  layout?: 'phone' | 'desktop';
  className?: string;
}

const GRID = { phone: 'grid-cols-2', desktop: 'grid-cols-4' } as const;

/** `3 lane · 2 limit · 4 dependency`, zero parts left out. */
export function blockedSplitWords(b: QueueTilesProps['blocked']): string {
  return QUEUE_REASONS.filter(r => b[r] > 0)
    .map(r => `${b[r]} ${termWord(QUEUE_REASON_TERM[r]).toLowerCase()}`)
    .join(' · ');
}

function Tile({ href, value, label, children, testId }: { href: string; value: string; label: string; children?: React.ReactNode; testId: string }) {
  return (
    <Link
      href={href}
      data-testid={testId}
      className="flex min-h-[44px] flex-col gap-1 border border-border-default bg-surface-2 px-3 py-2.5 text-text-primary no-underline hover:border-border-strong"
    >
      <span className="font-mono text-[22px] font-semibold leading-[1.1]">{value}</span>
      <span className="text-sm text-text-muted">{label}</span>
      {children}
    </Link>
  );
}

/**
 * Health › Queue tiles (spec 4bc3e70e R-3): Running n with `/m slots in use`,
 * Queued, Blocked (stacked bar by reason and the split in words), Scheduled.
 * Each tile is a link to its rows. Words come from the terms catalog.
 */
export default function QueueTiles({ running, queued, blocked, scheduled, hrefs, layout = 'phone', className = '' }: QueueTilesProps) {
  const blockedTotal = blocked.lane + blocked.limit + blocked.dependency;
  const split = blockedSplitWords(blocked);
  return (
    <div data-testid="queue-tiles" data-layout={layout} className={`grid gap-2 ${GRID[layout]} ${className}`}>
      <Tile
        testId="queue-tile-running"
        href={hrefs.running}
        value={runningOfCap(running.used, running.total, 'short')}
        label={`Running · ${running.total === 1 ? '/1 slot' : `/${running.total} slots`} in use`}
      />
      <Tile testId="queue-tile-queued" href={hrefs.queued} value={String(queued)} label="Queued" />
      <Tile testId="queue-tile-blocked" href={hrefs.blocked} value={String(blockedTotal)} label={termWord('queue.blocked')}>
        {blockedTotal > 0 && (
          <>
            <span aria-hidden="true" data-testid="queue-blocked-bar" className="flex h-1.5 w-full overflow-hidden bg-surface-3">
              {QUEUE_REASONS.filter(r => blocked[r] > 0).map(r => (
                <span key={r} className={QUEUE_REASON_BAR[r]} style={{ width: `${(blocked[r] / blockedTotal) * 100}%` }} />
              ))}
            </span>
            <span data-testid="queue-blocked-split" className="text-xs text-text-muted">{split}</span>
          </>
        )}
      </Tile>
      <Tile testId="queue-tile-scheduled" href={hrefs.scheduled} value={String(scheduled)} label="Scheduled" />
    </div>
  );
}
