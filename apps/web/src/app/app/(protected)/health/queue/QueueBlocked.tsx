import type { HealthQueueFilter, HealthQueueResponse, HealthQueueWaitingRow } from '@buildd/shared';
import { termWord } from '@buildd/shared';
import QueueRow from '@/components/health/QueueRow';
import Segmented from '@/components/ui/Segmented';
import { QUEUE_REASON_BAR, QUEUE_REASON_TERM } from '@/components/health/QueueTiles';
import { QUEUE_ANCHORS, REASON_OF, blockerDot, filterItems, rowAction } from './queue-board-model';

/**
 * Health › Queue's Blocked list (spec 4bc3e70e r8 R-5, R-6, R-20): QueueRow
 * rows in the read's order (Lane, Limit, Dependency, then lane position or
 * age), reason filter segments with counts, 50 rows a page. A row's action sits beside
 * it, never inside the link: Force start on a forceable Limit, Start anyway on
 * a Dependency.
 */
export interface QueueBlockedProps {
  view: HealthQueueResponse;
  onFilter: (f: HealthQueueFilter) => void;
  onPage: (page: number) => void;
  onStart: (row: HealthQueueWaitingRow) => void;
  /** Where a row leads: a Dependency row opens its sheet here, the rest their task. */
  hrefFor?: (row: HealthQueueWaitingRow) => string;
}

const taskHref = (row: HealthQueueWaitingRow) => `/app/tasks/${row.id}`;

const ACTION_LABEL = { force_start: 'Force start', start_anyway: 'Start anyway' } as const;

/** Every desktop row keeps the action column, so the columns line up whether or not a row has one. */
const ACTION_COL = 'md:w-28 md:flex md:justify-end';

function RowAction({ row, onStart }: { row: HealthQueueWaitingRow; onStart: (row: HealthQueueWaitingRow) => void }) {
  const action = rowAction(row);
  if (!action) return <span aria-hidden="true" className={`hidden shrink-0 ${ACTION_COL}`} />;
  return (
    <span className={`shrink-0 ${ACTION_COL}`}>
      <button
        type="button"
        onClick={() => onStart(row)}
        data-testid="queue-row-action"
        data-action={action}
        className="btn h-11 shrink-0 px-3 text-meta md:h-7"
      >
        {ACTION_LABEL[action]}
      </button>
    </span>
  );
}

function Rows({ rows, layout, onStart, hrefFor }: { rows: HealthQueueWaitingRow[]; layout: 'phone' | 'desktop'; onStart: QueueBlockedProps['onStart']; hrefFor: NonNullable<QueueBlockedProps['hrefFor']> }) {
  return (
    <ul className={layout === 'phone' ? 'md:hidden' : 'hidden md:block'} data-testid={`queue-blocked-${layout}`}>
      {rows.map(row => (
        <li key={row.id} data-testid="queue-blocked-row" data-reason={row.reason} className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1">
            <QueueRow
              title={row.title}
              mission={row.missionTitle}
              reason={REASON_OF[row.reason]}
              blockedBy={row.blockedBy}
              blockedByDot={row.reason === 'declared' ? blockerDot(row.blockerStatus) : undefined}
              age={row.age}
              href={hrefFor(row)}
              layout={layout}
            />
          </div>
          <RowAction row={row} onStart={onStart} />
        </li>
      ))}
    </ul>
  );
}

export default function QueueBlocked({ view, onFilter, onPage, onStart, hrefFor = taskHref }: QueueBlockedProps) {
  const { waiting, tiles } = view;
  return (
    <section id={QUEUE_ANCHORS.blocked} aria-labelledby="queue-blocked-h" className="min-w-0" data-testid="queue-waiting">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 id="queue-blocked-h" className="mr-1 text-eyebrow font-semibold text-text-muted">{termWord('queue.blocked')}</h2>
        <Segmented
          label="Reason"
          value={waiting.filter}
          onChange={onFilter}
          items={filterItems(tiles).map(item => ({
            value: item.value,
            label: (
              <span data-testid="queue-filter-chip" data-value={item.value} className="inline-flex items-center gap-1.5">
                {item.reason && <span aria-hidden="true" className={`h-2 w-2 ${QUEUE_REASON_BAR[item.reason]}`} />}
                {item.reason ? termWord(QUEUE_REASON_TERM[item.reason]) : 'All'}
                <span className="font-mono text-text-muted">{item.count}</span>
              </span>
            ),
          }))}
        />
      </div>
      {waiting.rows.length === 0 ? (
        <p className="py-3 text-body text-text-muted" data-testid="queue-waiting-empty">Nothing blocked.</p>
      ) : (
        <>
          <div aria-hidden="true" className="hidden md:flex gap-2 pb-1.5 font-mono text-eyebrow text-text-muted">
            <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto_minmax(0,1.5fr)_auto] gap-4">
              <span>Task</span><span>Mission</span><span>Reason</span><span>Waiting on</span><span className="text-right">Age</span>
            </span>
            <span className="w-28 shrink-0" />
          </div>
          <Rows rows={waiting.rows} layout="phone" onStart={onStart} hrefFor={hrefFor} />
          <Rows rows={waiting.rows} layout="desktop" onStart={onStart} hrefFor={hrefFor} />
        </>
      )}
      {waiting.pages > 1 && (
        <nav aria-label="Blocked pages" className="mt-3 flex items-center justify-end gap-2" data-testid="queue-pager">
          <button type="button" className="btn h-11 md:h-8" disabled={waiting.page <= 1} onClick={() => onPage(waiting.page - 1)}>Previous</button>
          <span className="font-mono text-meta text-text-muted">{waiting.page}/{waiting.pages}</span>
          <button type="button" className="btn h-11 md:h-8" disabled={waiting.page >= waiting.pages} onClick={() => onPage(waiting.page + 1)}>Next</button>
        </nav>
      )}
    </section>
  );
}
