import Link from 'next/link';
import type { HealthQueueFilter, HealthQueueLane, HealthQueueReason, HealthQueueResponse, HealthQueueWaitingRow } from '@buildd/shared';
import Card from '@/components/ui/Card';
import Chip, { type ChipTone } from '@/components/ui/Chip';
import Section from '@/components/ui/Section';
import Segmented from '@/components/ui/Segmented';

/**
 * Health › Queue's sections (spec "Health › Queue", R-3 to R-9), the same on
 * phone and desktop: tiles, the alert line, Lanes, Waiting, Ready, Parked.
 * Presentational: every number and word comes from the view; the client
 * (./QueueClient) owns navigation and the sheets.
 */

export const REASON_TONE: Record<HealthQueueReason, ChipTone> = { lane: 'info', limit: 'warning', declared: 'muted' };
const REASON_BAR: Record<HealthQueueReason, string> = { lane: 'bg-status-info', limit: 'bg-status-warning', declared: 'bg-[var(--q)]' };
const REASON_LABEL: Record<HealthQueueReason, string> = { lane: 'Lane', limit: 'Limit', declared: 'Declared' };
const REASONS: HealthQueueReason[] = ['lane', 'limit', 'declared'];

export interface QueueBoardProps {
  view: HealthQueueResponse;
  onFilter: (f: HealthQueueFilter) => void;
  onPage: (page: number) => void;
  onOpenLane: (lane: HealthQueueLane) => void;
  onOpenRow: (row: HealthQueueWaitingRow) => void;
  onForce: (row: HealthQueueWaitingRow) => void;
}

function Tile({ label, href, testId, children }: { label: string; href: string; testId: string; children: React.ReactNode }) {
  return (
    <Card as="a" href={href} interactive padding="sm" data-testid={testId} className="block min-w-0">
      <div className="text-meta text-text-muted">{label}</div>
      {children}
    </Card>
  );
}

function Count({ children }: { children: React.ReactNode }) {
  return <div className="font-mono text-heading font-semibold text-text-primary">{children}</div>;
}

export function QueueTiles({ view }: { view: HealthQueueResponse }) {
  const { tiles } = view;
  const total = tiles.waiting || 1;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-2" data-testid="queue-tiles">
      <Tile label="Running" href="/app/health/runners" testId="queue-tile-running">
        <Count>{tiles.running}/{tiles.slots}</Count>
        <div className="text-meta text-text-muted">slots</div>
      </Tile>
      <Tile label="Ready" href="#queue-ready" testId="queue-tile-ready">
        <Count>{tiles.ready}</Count>
      </Tile>
      <Tile label="Waiting" href="#queue-waiting" testId="queue-tile-waiting">
        <Count>{tiles.waiting}</Count>
        {tiles.waiting > 0 && (
          <div className="mt-1 flex h-1.5 overflow-hidden rounded-sm bg-[var(--q-tint)]" data-testid="queue-reason-bar" aria-label={REASONS.map(r => `${REASON_LABEL[r]} ${tiles.waitingByReason[r]}`).join(', ')}>
            {REASONS.filter(r => tiles.waitingByReason[r] > 0).map(r => (
              <span key={r} className={REASON_BAR[r]} style={{ width: `${(tiles.waitingByReason[r] / total) * 100}%` }} />
            ))}
          </div>
        )}
      </Tile>
      <Tile label="Parked" href="#queue-parked" testId="queue-tile-parked">
        <Count>{tiles.parked}</Count>
      </Tile>
    </div>
  );
}

export function QueueAlert({ view }: { view: HealthQueueResponse }) {
  if (view.alert) {
    return <p role="status" data-testid="queue-alert" className="mt-3 text-body font-semibold text-status-warning">{view.alert}</p>;
  }
  // R-4: the phone says so; the desktop shows nothing.
  return <p data-testid="queue-calm" className="mt-3 text-body text-text-muted md:hidden">Nothing held that could run</p>;
}

export function QueueLanes({ lanes, onOpenLane }: { lanes: HealthQueueLane[]; onOpenLane: (l: HealthQueueLane) => void }) {
  if (lanes.length === 0) return null;
  return (
    <Section title="Lanes" count={lanes.length} id="queue-lanes">
      <Card padding="sm" className="divide-y divide-[var(--line-soft)]" data-testid="queue-lanes">
        {lanes.map(l => (
          <button
            key={`${l.workspaceId}:${l.lane}`}
            type="button"
            onClick={() => onOpenLane(l)}
            data-testid="queue-lane-row"
            className="flex w-full min-h-11 items-center gap-3 py-2 text-left hover:bg-card-hover"
          >
            <span className="w-20 shrink-0 text-title font-semibold text-text-primary">{l.name}</span>
            <span className="min-w-0 flex-1 truncate text-body text-text-secondary">
              {l.holder ? l.holder.title : 'Free'}
            </span>
            {l.holder?.state && <Chip tone={l.stuckFor ? 'error' : 'running'} variant="soft">{l.stuckFor ? `Stuck ${l.stuckFor}` : l.holder.state}</Chip>}
            <span className="shrink-0 font-mono text-meta text-text-muted">{l.waiters.length} waiting</span>
          </button>
        ))}
      </Card>
    </Section>
  );
}

function WaitingRow({ row, onOpenRow, onForce, onOpenLane }: { row: HealthQueueWaitingRow; onOpenRow: () => void; onForce: () => void; onOpenLane: () => void }) {
  const open = row.reason === 'declared' ? onOpenRow : row.reason === 'lane' ? onOpenLane : null;
  return (
    <div
      data-testid="queue-waiting-row"
      data-reason={row.reason}
      className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 py-2 md:grid-cols-[minmax(0,2fr)_6rem_minmax(0,1.5fr)_3rem_7rem] md:items-center"
    >
      <Link href={`/app/tasks/${row.id}`} className="min-w-0 truncate text-body font-medium text-text-primary hover:underline col-span-2 md:col-span-1">
        {row.title}
      </Link>
      <span className="row-start-2 md:row-start-auto"><Chip tone={REASON_TONE[row.reason]} variant="soft">{row.badge}</Chip></span>
      {open ? (
        <button type="button" onClick={open} className="row-start-3 min-w-0 truncate text-left text-body text-text-secondary hover:text-text-primary hover:underline md:row-start-auto" data-testid="queue-blocked-by">
          {row.blockedBy}
        </button>
      ) : (
        <span className="row-start-3 min-w-0 truncate text-body text-text-secondary md:row-start-auto" data-testid="queue-blocked-by">{row.blockedBy}</span>
      )}
      <span className="row-start-2 justify-self-end font-mono text-meta text-text-muted md:row-start-auto md:justify-self-start">{row.age}</span>
      <span className="row-start-3 justify-self-end md:row-start-auto">
        {row.forceable && (
          <button type="button" className="btn h-11 md:h-6 md:px-2" onClick={onForce} data-testid="queue-force-start">Force start</button>
        )}
      </span>
    </div>
  );
}

export function QueueWaiting({ view, onFilter, onPage, onOpenRow, onForce, onOpenLane }: QueueBoardProps) {
  const { waiting, tiles } = view;
  const laneOf = (row: HealthQueueWaitingRow) => view.lanes.find(l => l.workspaceId === row.workspaceId && l.lane === row.lane) ?? null;
  const items = [
    { value: 'all' as const, label: `All ${tiles.waiting}` },
    { value: 'declared' as const, label: `Declared ${tiles.waitingByReason.declared}` },
    { value: 'lane' as const, label: `Lane ${tiles.waitingByReason.lane}` },
    { value: 'limit' as const, label: `Limit ${tiles.waitingByReason.limit}` },
  ];
  return (
    <section id="queue-waiting" aria-labelledby="queue-waiting-h" className="py-4" data-testid="queue-waiting">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="queue-waiting-h" className="text-eyebrow font-semibold text-text-muted">Waiting</h2>
        <Segmented label="Reason" items={items} value={waiting.filter} onChange={onFilter} />
      </div>
      {waiting.rows.length === 0 ? (
        <p className="text-body text-text-muted" data-testid="queue-waiting-empty">Nothing waiting.</p>
      ) : (
        <Card padding="sm">
          <div className="hidden md:grid grid-cols-[minmax(0,2fr)_6rem_minmax(0,1.5fr)_3rem_7rem] gap-x-3 pb-1 text-meta text-text-muted border-b border-[var(--line-soft)]">
            <span>Task</span><span>Reason</span><span>Blocked by</span><span>Age</span><span />
          </div>
          <div className="divide-y divide-[var(--line-soft)]">
            {waiting.rows.map(row => {
              const lane = laneOf(row);
              return (
                <WaitingRow
                  key={row.id}
                  row={row}
                  onOpenRow={() => onOpenRow(row)}
                  onForce={() => onForce(row)}
                  onOpenLane={() => { if (lane) onOpenLane(lane); }}
                />
              );
            })}
          </div>
        </Card>
      )}
      {waiting.pages > 1 && (
        <nav aria-label="Waiting pages" className="mt-3 flex items-center justify-end gap-2" data-testid="queue-pager">
          <button type="button" className="btn h-11 md:h-8" disabled={waiting.page <= 1} onClick={() => onPage(waiting.page - 1)}>Previous</button>
          <span className="font-mono text-meta text-text-muted">{waiting.page}/{waiting.pages}</span>
          <button type="button" className="btn h-11 md:h-8" disabled={waiting.page >= waiting.pages} onClick={() => onPage(waiting.page + 1)}>Next</button>
        </nav>
      )}
    </section>
  );
}

function SimpleList({ id, title, count, rows, testId }: { id: string; title: string; count: number; rows: Array<{ id: string; title: string; note: string; muted?: boolean }>; testId: string }) {
  return (
    <Section title={title} count={count} id={id}>
      {rows.length > 0 && (
        <Card padding="sm" className="divide-y divide-[var(--line-soft)]" data-testid={testId}>
          {rows.map(r => (
            <div key={r.id} className="flex min-h-11 items-center gap-3 py-2">
              <Link href={`/app/tasks/${r.id}`} className="min-w-0 flex-1 truncate text-body text-text-primary hover:underline">{r.title}</Link>
              <span className={`shrink-0 text-meta ${r.muted ? 'text-status-warning' : 'text-text-muted'}`}>{r.note}</span>
            </div>
          ))}
        </Card>
      )}
    </Section>
  );
}

export default function QueueBoard(props: QueueBoardProps) {
  const { view } = props;
  return (
    <div data-testid="queue-board">
      <QueueTiles view={view} />
      <QueueAlert view={view} />
      {view.reasonsUnavailable && (
        <p className="mt-3 text-body text-text-muted" data-testid="queue-reasons-unavailable">Could not read why tasks wait. Reload to try again.</p>
      )}
      {view.truncated && (
        <p className="mt-3 text-meta text-text-muted" data-testid="queue-truncated">Showing the first part of the queue; counts are at least these.</p>
      )}
      <QueueLanes lanes={view.lanes} onOpenLane={props.onOpenLane} />
      <QueueWaiting {...props} />
      <SimpleList id="queue-ready" title="Ready" count={view.tiles.ready} testId="queue-ready" rows={view.ready.map(r => ({ id: r.id, title: r.title, note: r.note, muted: r.noRunner }))} />
      <SimpleList id="queue-parked" title="Parked" count={view.tiles.parked} testId="queue-parked" rows={view.parked.map(r => ({ id: r.id, title: r.title, note: r.starts }))} />
    </div>
  );
}
