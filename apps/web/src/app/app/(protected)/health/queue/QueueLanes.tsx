import type { HealthQueueLane } from '@buildd/shared';
import StageMeter from '@/components/ui/StageMeter';

/**
 * Health › Queue's Lanes card (spec 4bc3e70e r8 R-8): each lane in use with
 * its holder's StageMeter, the holder's title and how many wait behind it.
 * Hidden when no lane is in use (AC-5). Opening one shows its full order.
 */
export default function QueueLanes({ lanes, onOpenLane }: { lanes: HealthQueueLane[]; onOpenLane: (l: HealthQueueLane) => void }) {
  if (lanes.length === 0) return null;
  return (
    <section aria-labelledby="queue-lanes-h" className="min-w-0" data-testid="queue-lanes">
      <h2 id="queue-lanes-h" className="mb-2 text-eyebrow font-semibold text-text-muted">
        Lanes <span className="font-mono">{lanes.length}</span>
      </h2>
      <ul className="card divide-y divide-[var(--line-soft)] p-0">
        {lanes.map(l => (
          <li key={`${l.workspaceId}:${l.lane}`}>
            <button
              type="button"
              onClick={() => onOpenLane(l)}
              data-testid="queue-lane-row"
              className="grid w-full min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-card-hover"
            >
              <span className="font-mono text-meta text-text-secondary">{l.name.toLowerCase()}</span>
              {l.waiters.length > 0
                ? <span className="font-mono text-meta text-text-muted" data-testid="queue-lane-waiting">+{l.waiters.length}</span>
                : <span />}
              <span className="col-span-2 flex min-w-0 items-center gap-2">
                {l.holder?.meter && <StageMeter state={l.holder.meter.state} stage="build" data-testid="queue-lane-meter" />}
                <span className={`min-w-0 truncate text-body ${l.holder ? 'text-text-primary' : 'text-text-muted'}`}>
                  {l.holder ? l.holder.title : 'Free'}
                </span>
                {l.stuckFor && <span className="shrink-0 font-mono text-meta text-status-error">stuck {l.stuckFor}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
