/**
 * Home's FLEET panel: runners × slots. Each slot row shows its live worker
 * (role square, task name + short label, progress) or "idle · last …"; from xl
 * up the shared `SlotLanes` chart (via FleetLanes) draws that slot's day beside
 * it at the same row height, so row N on the left is row N on the chart.
 *
 * Model: lib/fleet-view.ts (`FleetSnapshot`). Role colours come from the roles.
 */
import Link from 'next/link';
import type { FleetRunner, FleetSlot, FleetSnapshot } from '@buildd/shared';
import { SLOT_LANE_AXIS_PX, SLOT_LANE_ROW_PX } from '@/components/fleet/slot-lanes-layout';
import { missionTaskHref } from '@/lib/mission-task-href';
import { FleetLanes } from './FleetLanes';

function RoleSquare({ name, color }: { name: string | null; color: string | null }) {
  return (
    <span
      aria-hidden="true"
      className={`grid h-[18px] w-[18px] shrink-0 place-items-center font-mono text-[11px] font-bold text-white ${color ? '' : 'bg-text-muted'}`}
      style={color ? { backgroundColor: color } : undefined}
    >
      {(name ?? '?')[0]?.toUpperCase()}
    </span>
  );
}

function SlotCell({ slot, now }: { slot: FleetSlot; now: number }) {
  const w = slot.worker;
  if (!w) {
    return (
      <div className="flex min-w-0 items-center gap-2.5 font-mono text-[12.5px] text-text-muted">
        <span aria-hidden="true" className="h-[18px] w-[18px] shrink-0 border border-dashed border-border-strong" />
        <span className="truncate">
          idle
          {slot.last && (
            <> · last <b className="font-semibold text-text-secondary">{slot.last.label}</b>{slot.last.prNumber ? ` #${slot.last.prNumber}` : slot.last.fix ? ' fix' : ''}</>
          )}
        </span>
      </div>
    );
  }
  const mins = w.startedAt ? Math.max(0, Math.round((now - new Date(w.startedAt).getTime()) / 60_000)) : null;
  const href = w.taskId ? missionTaskHref({ missionId: w.missionId, taskId: w.taskId, from: 'home', mode: 'sheet' }) : null;
  const body = (
    <>
      <div className="flex min-w-0 items-baseline gap-2 font-mono">
        <span className="shrink-0 text-[13px] font-semibold text-text-primary">{w.label}</span>
        <span className="truncate text-[12px] text-text-secondary">{w.rest}</span>
      </div>
      {w.question ? (
        <div className="mt-1 flex items-center gap-1.5 font-mono text-[11px] font-bold uppercase tracking-[1px] text-status-warning">
          ? Waiting on you{mins != null && <span className="font-normal normal-case tracking-normal text-text-muted">· {mins}m</span>}
        </div>
      ) : (
        <div className="mt-1.5 flex items-center gap-2.5 font-mono text-[11px] text-text-muted">
          <span className="relative h-[3px] w-full max-w-[150px] bg-border-default" aria-hidden="true">
            <span className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${w.progress ?? 0}%` }} />
          </span>
          <span className="shrink-0 whitespace-nowrap">{w.progress != null ? `${Math.round(w.progress)}%` : '—'}{mins != null && ` · ${mins}m`}</span>
        </div>
      )}
    </>
  );
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      <RoleSquare name={w.roleName ?? w.roleSlug} color={w.roleColor} />
      {href ? <Link href={href} className="block min-w-0 flex-1 hover:underline">{body}</Link> : <div className="min-w-0 flex-1">{body}</div>}
    </div>
  );
}

/** Runner column + slot column; each slot row is exactly one SlotLanes row tall. */
const TABLE_COLS = 'grid-cols-[96px_minmax(0,1fr)] md:grid-cols-[150px_minmax(0,1fr)]';

function RunnerBlock({ runner, first, now }: { runner: FleetRunner; first: boolean; now: number }) {
  return (
    <div
      data-testid="fleet-runner"
      className={`grid ${TABLE_COLS} ${first ? '' : 'border-t-[1.5px] border-t-[var(--fleet-border-mid)]'}`}
    >
      <div className="flex flex-col justify-center gap-1 border-b border-r border-border-default px-3 md:px-5" style={{ gridRow: `span ${runner.slots.length}` }}>
        <span className="truncate font-mono text-[14px] font-semibold text-text-primary md:text-[16px]">{runner.name}</span>
        {runner.machine && <span className="truncate font-mono text-[11px] text-text-muted md:text-[12px]">{runner.machine}</span>}
        <span className="mt-0.5 flex gap-[3px]" aria-label={`${runner.slots.filter(s => s.worker).length} of ${runner.maxSlots} slots busy`}>
          {runner.slots.map(s => (
            <i key={s.index} className={`inline-block h-2.5 w-2.5 border ${s.worker ? 'border-accent bg-accent' : 'border-border-strong'}`} />
          ))}
        </span>
        {!runner.online && <span className="font-mono text-[11px] text-status-warning">offline</span>}
      </div>
      {runner.slots.map((slot) => (
        <div
          key={slot.index}
          data-testid="fleet-slot"
          data-busy={slot.worker ? 'true' : 'false'}
          data-status={slot.worker?.status ?? 'idle'}
          style={{ height: SLOT_LANE_ROW_PX }}
          className={`col-start-2 flex items-center border-b border-border-default px-3 md:px-4 ${
            slot.worker ? `border-l-[3px] ${slot.worker.question ? 'border-l-status-warning bg-status-warning/10' : 'border-l-accent'}` : ''
          }`}
        >
          <SlotCell slot={slot} now={now} />
        </div>
      ))}
    </div>
  );
}

export function FleetStrip({
  fleet,
  roles,
  now,
  timeZone,
}: {
  fleet: FleetSnapshot;
  roles: Array<{ slug: string; name: string; color: string | null }>;
  now: number;
  timeZone?: string | null;
}) {
  const slotsPerRunner = new Set(fleet.runners.map(r => r.maxSlots));
  return (
    <section data-testid="home-fleet" className="mb-8">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className="section-label text-text-muted">
          Fleet · {fleet.runners.length} runner{fleet.runners.length === 1 ? '' : 's'}
          {slotsPerRunner.size === 1 && fleet.runners.length > 0 ? ` × ${[...slotsPerRunner][0]} slots` : ''}
        </span>
        {roles.length > 0 && (
          <span className="hidden flex-wrap gap-3.5 font-mono text-[12px] text-text-secondary md:flex">
            {roles.map(r => (
              <span key={r.slug} className="inline-flex items-center gap-1.5">
                <i aria-hidden="true" className={`inline-block h-2.5 w-2.5 ${r.color ? '' : 'bg-text-muted'}`} style={r.color ? { backgroundColor: r.color } : undefined} />
                {r.name}
              </span>
            ))}
          </span>
        )}
      </div>
      {fleet.runners.length === 0 ? (
        <div className="border border-dashed border-border-strong px-5 py-4 font-mono text-[12.5px] text-text-secondary">
          No runners online. Start one with <code className="text-text-primary">buildd</code> on any machine.
        </div>
      ) : (
        <div className="card overflow-hidden p-0 xl:grid xl:grid-cols-[470px_minmax(0,1fr)]">
          <div className="min-w-0 xl:border-r xl:border-border-default">
            {/* Same height as the chart's axis band, so the rows line up. */}
            <div
              aria-hidden="true"
              className={`hidden border-b border-border-default font-mono text-[11px] font-semibold uppercase tracking-[1.5px] text-text-muted xl:grid ${TABLE_COLS}`}
              style={{ height: SLOT_LANE_AXIS_PX }}
            >
              <span className="flex items-center px-5">Runner</span>
              <span className="flex items-center px-4">Slot</span>
            </div>
            {fleet.runners.map((r, i) => <RunnerBlock key={r.id} runner={r} first={i === 0} now={now} />)}
          </div>
          <div className="hidden min-w-0 xl:block">
            <FleetLanes fleet={fleet} now={now} timeZone={timeZone} />
          </div>
        </div>
      )}
    </section>
  );
}
