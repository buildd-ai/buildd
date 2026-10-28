import type { HealthQueueFilter, HealthQueueLane, HealthQueueResponse, HealthQueueWaitingRow } from '@buildd/shared';
import QueueTiles from '@/components/health/QueueTiles';
import IdleAlert from '@/components/ui/IdleAlert';
import QueueBlocked from './QueueBlocked';
import QueueLanes from './QueueLanes';
import QueueReady from './QueueReady';
import { queueTilesProps } from './queue-board-model';

/**
 * Health › Queue on the shared Health components (spec 4bc3e70e r8, R-3 to
 * R-8): QueueTiles, the shared IdleAlert, Blocked as QueueRow rows, Lanes with
 * each holder's StageMeter, Queued as DeliveryRow rows. Presentational: every
 * number and word comes from the view; the client (./QueueClient) owns
 * navigation and the sheets. Phone and desktop render the same sections; on
 * desktop Lanes sits beside the Blocked list.
 */
export interface QueueBoardProps {
  view: HealthQueueResponse;
  /** Epoch ms the rows' times are measured from. */
  now: number;
  onFilter: (f: HealthQueueFilter) => void;
  onPage: (page: number) => void;
  onOpenLane: (lane: HealthQueueLane) => void;
  /** A Blocked row's action: Force start or Start anyway (R-20). */
  onStart: (row: HealthQueueWaitingRow) => void;
  hrefFor?: (row: HealthQueueWaitingRow) => string;
}

/** R-4: idle capacity first, then a stuck lane; with nothing wrong, nothing renders. */
export function QueueAlert({ view }: { view: HealthQueueResponse }) {
  const stuck = view.lanes.filter(l => l.stuckFor);
  if (!view.idle && stuck.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="queue-alert">
      {view.idle && (
        <IdleAlert idleSlots={view.idle.slots} queuedTasks={view.idle.tasks} cause={view.idle.cause ?? ''} href="#queue-ready" />
      )}
      {stuck.map(l => (
        <p key={`${l.workspaceId}:${l.lane}`} role="status" data-testid="queue-stuck-lane" className="notice notice-warn flex min-h-11 items-center gap-2.5 text-body">
          <span aria-hidden="true" className="font-mono font-semibold">!</span>
          <span className="font-semibold">{l.name} lane stuck {l.stuckFor}</span>
        </p>
      ))}
    </div>
  );
}

export default function QueueBoard(props: QueueBoardProps) {
  const { view, now } = props;
  const tiles = queueTilesProps(view);
  return (
    <div data-testid="queue-board" className="flex min-w-0 flex-col gap-4">
      <QueueTiles {...tiles} layout="phone" className="md:hidden" />
      <QueueTiles {...tiles} layout="desktop" className="hidden md:grid" />
      <QueueAlert view={view} />
      {view.reasonsUnavailable && (
        <p className="text-body text-text-muted" data-testid="queue-reasons-unavailable">Could not read why tasks wait. Reload to try again.</p>
      )}
      {view.truncated && (
        <p className="text-meta text-text-muted" data-testid="queue-truncated">Partial queue. Counts are minimums.</p>
      )}
      <div className="grid min-w-0 gap-6 md:grid-cols-[minmax(0,1fr)_17rem] md:items-start">
        <QueueBlocked view={view} onFilter={props.onFilter} onPage={props.onPage} onStart={props.onStart} hrefFor={props.hrefFor} />
        <QueueLanes lanes={view.lanes} onOpenLane={props.onOpenLane} />
      </div>
      <QueueReady view={view} now={now} />
    </div>
  );
}
