/**
 * Settings → Runners leads with the fleet: what runs your tasks. Each host
 * runner is one row (online or offline, busy of total slots on the same
 * `SlotMeter` Home's stat strip draws), then the cloud runner. The live slots
 * themselves stay on Home; this is the inventory.
 *
 * Model: lib/fleet-view.ts (`FleetSnapshot`, `fleetLabel`), loaded by
 * `loadFleetSnapshot` in lib/home-fleet.ts from the same heartbeats Home reads.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { FleetRunner, FleetSnapshot } from '@buildd/shared';
import { SlotMeter } from '@/components/fleet/SlotMeter';
import { fleetLabel, type HeadlinePart } from '@/lib/fleet-view';
import SettingsSection from '../SettingsSection';
import { StatusChip } from '../_components/ConnectionRow';

/** "3 of 8 slots busy." / "Fleet idle. 8 slots free." plus "1 offline." */
export function fleetOverviewHeadline(fleet: FleetSnapshot, teamName?: string | null): HeadlinePart[] {
  const offline = fleet.runners.filter(r => !r.online).length;
  const tail: HeadlinePart[] = offline > 0 ? [{ text: ` ${offline} offline.` }] : [];
  // Another team's runner can be online, so say whose fleet is empty.
  if (fleet.runners.length === 0) return [{ text: teamName ? `No runners online for ${teamName}.` : 'No runners online.' }];
  if (fleet.capacity === 0 && fleet.live === 0) return [{ text: 'All runners offline.' }];
  if (fleet.live > 0) {
    return [{ text: `${fleet.live} of ${fleet.capacity}`, tone: 'accent' }, { text: ' slots busy.' }, ...tail];
  }
  return [{ text: `Fleet idle. ${fleet.capacity} slot${fleet.capacity === 1 ? '' : 's'} free.` }, ...tail];
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
          <span title={runner.name} className="min-w-0 truncate font-mono text-[13px] font-semibold text-text-primary">{runner.name}</span>
          <StatusChip tone={runner.online ? 'ok' : 'warn'}>{runner.online ? 'Online' : 'Offline'}</StatusChip>
        </div>
        <div className="mt-1 truncate font-mono text-[11px] text-text-muted">
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
      action={fleet.runners.length > 0 ? <Link href="/app/home" className="btn btn-quiet">Live slots on Home ›</Link> : undefined}
    >
      <div data-testid="runners-fleet" className="space-y-3">
        <p data-testid="runners-fleet-headline" className="font-mono text-[18px] font-semibold leading-tight tracking-[-0.3px] text-text-primary md:text-[20px]">
          {headline.map((p, i) => <span key={i} className={p.tone === 'accent' ? 'text-accent-text' : undefined}>{p.text}</span>)}
        </p>
        {/* Home's empty-fleet box, same words. */}
        {fleet.runners.length === 0 && (
          <div data-testid="fleet-runner-empty" className="border border-dashed border-border-strong px-4 py-4 font-mono text-[12.5px] text-text-secondary md:px-5">
            Start one with <code className="text-text-primary">buildd</code> on any machine, signed in with a runner token below.
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
