/**
 * Settings → Runners leads with the fleet: what runs your tasks. Each host
 * runner is one row (online or offline, busy of total slots on the same
 * `SlotMeter` Home's stat strip draws), then the cloud runner. The live slots
 * themselves stay on Home; this is the inventory.
 *
 * Model: lib/fleet-view.ts (`FleetSnapshot`, `fleetLabel`), loaded by
 * `loadFleetSnapshot` in lib/home-fleet.ts from the same heartbeats Home reads.
 */
import RunnerInstallSteps from '@/components/RunnerInstallSteps';
import type { ReactNode } from 'react';
import type { FleetRunner, FleetSnapshot } from '@buildd/shared';
import { SlotMeter } from '@/components/fleet/SlotMeter';
import { fleetLabel, type HeadlinePart } from '@/lib/fleet-view';
import SettingsSection from '../SettingsSection';
import { StatusChip } from '../_components/ConnectionRow';

const busyOn = (r: FleetRunner) => r.slots.filter(s => s.worker).length;
const runs = (n: number) => `${n} run${n === 1 ? '' : 's'}`;

/**
 * "3 of 8 slots busy." / "No agents working. 8 slots free." plus "1 offline."
 * Busy counts online runners only, the same set capacity counts: an offline
 * runner's last heartbeat can still list workers, and those are said apart.
 */
export function fleetOverviewHeadline(fleet: FleetSnapshot, teamName?: string | null): HeadlinePart[] {
  // Another team's runner can be online, so say whose fleet is empty.
  if (fleet.runners.length === 0) return [{ text: teamName ? `No runners online for ${teamName}.` : 'No runners online.' }];
  const offline = fleet.runners.filter(r => !r.online);
  const busy = fleet.runners.filter(r => r.online).reduce((n, r) => n + busyOn(r), 0);
  const stale = offline.reduce((n, r) => n + busyOn(r), 0);
  if (offline.length === fleet.runners.length) {
    if (stale === 0) return [{ text: 'All runners offline.' }];
    const where = offline.length === 1 ? 'it at its' : 'them at their';
    return [{ text: `All runners offline. ${runs(stale)} ${stale === 1 ? 'was' : 'were'} on ${where} last check-in.` }];
  }
  const tail: HeadlinePart[] = offline.length === 0 ? []
    : [{ text: stale > 0 ? ` ${offline.length} offline, with ${runs(stale)} at ${offline.length === 1 ? 'its' : 'their'} last check-in.` : ` ${offline.length} offline.` }];
  if (busy > 0) return [{ text: `${busy} of ${fleet.capacity} slots busy.` }, ...tail];
  return [{ text: `No agents working. ${fleet.capacity} slot${fleet.capacity === 1 ? '' : 's'} free.` }, ...tail];
}

function RunnerRow({ runner }: { runner: FleetRunner }) {
  const busy = runner.slots.filter(s => s.worker).length;
  const waiting = runner.slots.filter(s => s.worker?.question).length;
  return (
    <li
      data-testid="fleet-runner-row"
      data-online={runner.online ? 'true' : 'false'}
      data-elastic={runner.elastic ? 'true' : undefined}
      className="flex min-h-14 items-center gap-3 px-4 py-2.5"
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2.5">
          <span title={runner.name} className="min-w-0 truncate text-sm font-semibold text-text-primary">{runner.name}</span>
          <StatusChip tone={runner.online ? 'ok' : 'warn'}>{runner.online ? 'Online' : 'Offline'}</StatusChip>
        </div>
        <div className="mt-0.5 truncate text-xs text-text-muted">
          {runner.machine ?? 'Host runner'}
          {waiting > 0 && <span className="text-status-warning"> · {waiting} need input</span>}
        </div>
      </div>
      {runner.elastic ? (
        // Elastic: as many slots as runs, so there is no meter to fill.
        <span data-testid="fleet-runner-running" className="shrink-0 font-mono text-[12px] tabular-nums text-text-secondary">
          <b className="text-accent-text">{runner.elastic.running}</b> running
        </span>
      ) : (
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <span data-testid="fleet-runner-busy" className="font-mono text-[12px] tabular-nums text-text-secondary">
            <b className={busy > 0 ? 'text-accent-text' : 'text-text-primary'}>{busy}</b>/{runner.maxSlots} busy
          </span>
          <SlotMeter live={busy} max={runner.maxSlots} />
        </div>
      )}
    </li>
  );
}

export default function FleetOverview({ fleet, cloud, teamName }: { fleet: FleetSnapshot; cloud?: ReactNode; teamName?: string | null }) {
  const headline = fleetOverviewHeadline(fleet, teamName);
  return (
    <SettingsSection
      title={fleetLabel(fleet)}
      bare
    >
      <div data-testid="runners-fleet" className="space-y-3">
        <p data-testid="runners-fleet-headline" className="text-base font-semibold text-text-primary">
          {headline.map((p, i) => <span key={i} className={p.tone === 'accent' ? 'text-accent-text' : undefined}>{p.text}</span>)}
        </p>
        {/* The one install instruction (lib/runner-install.ts). */}
        {fleet.runners.length === 0 && (
          <div data-testid="fleet-runner-empty" className="py-2 text-text-secondary">
            <p className="text-body mb-3">Start a runner on any machine:</p>
            <RunnerInstallSteps />
          </div>
        )}
        {(fleet.runners.length > 0 || cloud) && (
          <ul className="card divide-y divide-border-default p-0">
            {fleet.runners.map(r => <RunnerRow key={r.id} runner={r} />)}
            {cloud}
          </ul>
        )}
      </div>
    </SettingsSection>
  );
}
