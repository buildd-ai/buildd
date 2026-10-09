/**
 * Health › Runners' first block: what is running now, in words. Per runner
 * "N of M busy", then one row per running task (name, mission, how long, its
 * state as a word), the same row shape as Home's Agents panel. People's own
 * sessions are their own group. The per-slot timeline sits below, folded.
 * Server-safe (no hooks).
 */
import Link from 'next/link';
import type { FleetRunner, FleetSlotWorker, FleetSnapshot } from '@buildd/shared';
import { elapsedLabel } from '@/lib/home-agents';
import { readableRunName } from '@/lib/run-name';
import type { LaneMission } from './runner-lanes';

function workerName(w: FleetSlotWorker): string {
  if (/_/.test(`${w.label} ${w.rest}`)) return readableRunName({ label: null, title: w.title ?? `${w.label} ${w.rest}` });
  return readableRunName({ label: w.rest || w.label, title: w.title ?? null });
}

const stateWord = (w: FleetSlotWorker) => (w.status === 'waiting_input' || w.question ? 'Needs input' : 'Working');

function Group({ runner, now, missions, heading }: { runner: FleetRunner; now: number; missions: Readonly<Record<string, LaneMission>>; heading?: string }) {
  const running = runner.slots.flatMap(s => (s.worker ? [s.worker] : []));
  const busy = runner.interactive ? `${running.length} claimed` : `${running.length} of ${runner.maxSlots} busy`;
  return (
    <section data-testid="running-now-group" className="py-3 first:pt-0">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-body font-semibold text-text-primary">{heading ?? runner.name}</h3>
        <span className="text-meta text-text-muted">{runner.online ? busy : 'Offline'}</span>
      </div>
      {running.length > 0 && (
        <ul className="mt-1 divide-y divide-border-default">
          {running.map(w => {
            const mission = w.missionId ? missions[w.missionId]?.title : null;
            const name = workerName(w);
            return (
              <li key={w.workerId} data-testid="running-now-row" className="flex items-baseline gap-3 py-2">
                <span className="min-w-0 flex-1">
                  {w.taskId
                    ? <Link href={`/app/tasks/${w.taskId}`} className="block truncate text-body font-medium text-text-primary hover:underline">{name}</Link>
                    : <span className="block truncate text-body font-medium text-text-primary">{name}</span>}
                  {mission && <span className="block truncate text-meta text-text-muted">{mission}</span>}
                </span>
                <span className={`shrink-0 text-meta ${stateWord(w) === 'Working' ? 'text-text-secondary' : 'text-accent-text'}`}>{stateWord(w)}</span>
                <span className="w-14 shrink-0 text-right font-mono text-meta tabular-nums text-text-muted">
                  {w.startedAt ? elapsedLabel(now - new Date(w.startedAt).getTime()) : ''}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function RunningNow({ fleet, now, missions = {} }: { fleet: FleetSnapshot; now: number; missions?: Readonly<Record<string, LaneMission>> }) {
  const sessions = fleet.sessions && fleet.sessions.slots.some(s => s.worker) ? fleet.sessions : null;
  return (
    <div data-testid="running-now" className="divide-y divide-border-default">
      {fleet.runners.map(r => <Group key={r.id} runner={r} now={now} missions={missions} />)}
      {sessions && <Group runner={sessions} now={now} missions={missions} heading="Your sessions" />}
    </div>
  );
}
