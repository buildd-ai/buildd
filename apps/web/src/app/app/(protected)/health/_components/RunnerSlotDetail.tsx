'use client';

import type { FleetSnapshot } from '@buildd/shared';
import type { RunnerHeartbeat } from '@/lib/runner-heartbeats-shared';
import { observedAgo } from '@/lib/health-metric-grammar';
import RunnerSlotsControl from '@/components/RunnerSlotsControl';
import RunnerPauseControl from '@/components/RunnerPauseControl';

interface RunnerSlotDetailProps {
  fleetRow: FleetSnapshot['runners'][number] | null;
  runner: RunnerHeartbeat;
  online: boolean;
  lastHeartbeatAt: string | null;
  now: number;
  seesTeamWork: boolean;
  ownerLabel: string;
  route: { claude: string; codex: string };
}

function timeAgo(iso: string | null, now: number): string {
  if (!iso) return 'never';
  const seconds = Math.floor((now - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function RunnerSlotDetail({
  fleetRow,
  runner,
  online,
  lastHeartbeatAt,
  now,
  seesTeamWork,
  ownerLabel,
  route,
}: RunnerSlotDetailProps) {
  const hidden = (mine: boolean | null | undefined) => !seesTeamWork && mine !== true && mine !== undefined;
  const allSlots = fleetRow?.slots ?? [];
  // Running tasks only: an idle slot is capacity, already shown by the pips (spec 97b1bd0b R-18).
  const slots = allSlots.filter(s => s.worker);
  const failed = allSlots.filter(s => !s.worker && s.last?.failed);

  return (
    <div data-testid="health-runner-detail" className="pt-3 space-y-2">
      <dl data-testid="health-runner-dimensions" className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-text-muted">Owner</dt>
        <dd data-testid="health-runner-owner" className="text-text-primary">{ownerLabel}</dd>
        <dt className="text-text-muted">Work</dt>
        <dd className="text-text-primary">Per slot</dd>
        <dt className="text-text-muted">Route</dt>
        <dd data-testid="health-runner-route" className="text-text-primary">Claude: {route.claude} · Codex: {route.codex}</dd>
      </dl>
      <p className="text-meta font-medium text-text-secondary">Slots</p>
      <RunnerSlotsControl
        runnerId={runner.id}
        active={fleetRow ? fleetRow.slots.filter(s => s.worker).length : runner.activeWorkerCount}
        reported={fleetRow?.maxSlots ?? runner.maxConcurrentWorkers}
        online={online}
        info={runner.slots ? { desired: runner.slots.desired, origin: runner.slots.origin, setBy: runner.slots.setBy, setAt: runner.slots.setAt } : null}
        canEdit={runner.slots?.canEdit ?? false}
      />
      {/* Pause: nothing new starts, running work finishes; a state of its own, not 0 slots (spec 97b1bd0b R-18). */}
      <RunnerPauseControl
        runnerId={runner.id}
        active={fleetRow ? fleetRow.slots.filter(s => s.worker).length : runner.activeWorkerCount}
        online={online}
        info={runner.pause ?? null}
        canEdit={runner.slots?.canEdit ?? false}
      />
      {slots.length === 0 ? (
        <p className="text-xs text-text-muted">{allSlots.length === 0 ? 'No slot detail reported for this runner.' : 'No tasks running.'}</p>
      ) : (
        <ul className="space-y-1">
          {slots.map(s => (
            <li key={s.index} data-testid="health-runner-slot" className="flex items-baseline gap-2 text-xs min-w-0">
              <span className="font-mono text-text-muted shrink-0">#{s.index + 1}</span>
              <span className="text-text-primary truncate">
                {s.worker!.question ? 'Waiting · ' : 'Working · '}{hidden(s.worker!.mine) ? (s.worker!.mine === null ? 'Unattributed work' : 'A teammate\'s work') : (s.worker!.name ?? s.worker!.title ?? s.worker!.label)}{s.worker!.startedAt ? ` · ${timeAgo(s.worker!.startedAt, now).replace(' ago', '')}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p data-testid="health-runner-connectivity" className="text-xs text-text-muted">
        {online ? 'Connected' : 'Offline'} · {online ? 'seen' : 'last seen'} {observedAgo(lastHeartbeatAt, now) ?? (online ? 'just now' : 'never')}
      </p>
      <p data-testid="health-runner-failures" className={`text-xs ${failed.length > 0 ? 'text-status-warning' : 'text-text-muted'}`}>
        {failed.length > 0
          ? <>Failed: {failed.length} {failed.length === 1 ? 'slot' : 'slots'} last ended in failure · <a href="/app/health/failures" className="underline hover:text-text-primary">Failures</a></>
          : 'Failed: none on these slots'}
      </p>
    </div>
  );
}
