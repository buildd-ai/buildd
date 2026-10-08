/**
 * Home's runners panel: runners × slots. Each busy slot row shows its live
 * worker (role square, task name + short label, progress); a couple of
 * recently finished slots keep their "idle · last …" row; every other quiet
 * slot folds into one "N idle slots" row, so ten slots with one agent on them
 * read as one agent, not nine rows of "idle". From xl up the shared
 * `SlotLanes` chart (via FleetLanes) draws the same rows beside the table at
 * the same height.
 *
 * With nothing running — or in `compact` mode (a member's Home) — the whole
 * panel is one summary line ("all 10 slots idle · last: … 25m ago") that
 * expands to the table.
 *
 * Model: lib/fleet-view.ts (`FleetSnapshot`, `fleetDisplayRows`, `fleetSummary`).
 */
import Link from 'next/link';
import type { CSSProperties } from 'react';
import type { FleetRunner, FleetSlot, FleetSnapshot } from '@buildd/shared';
import SteerButton from '@/components/chat/SteerButton';
import { SLOT_LANE_AXIS_PX, SLOT_LANE_ROW_PX } from '@/components/fleet/slot-lanes-layout';
import { fleetDisplayRows, fleetLabel, fleetSummary, type FleetDisplayRow } from '@/lib/fleet-view';
import { missionTaskHref } from '@/lib/mission-task-href';
import { roleDisplayName } from '@/lib/task-eyebrow';
import { shortDuration } from '@/lib/mission-list-card';
import { FleetLanes } from './FleetLanes';

function ago(ms: number, now: number): string {
  const m = Math.max(0, Math.round((now - ms) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/**
 * The worker's role initial. A task with no role gets an empty outlined square
 * — never a "?" (lib/task-eyebrow.ts: a missing role is not a word), and the
 * square still holds the row's alignment.
 */
function RoleSquare({ slug, name, color }: { slug: string | null; name: string | null; color: string | null }) {
  const label = roleDisplayName(slug, name);
  if (!label) {
    return <span aria-hidden="true" data-testid="fleet-role-square-empty" className="h-[18px] w-[18px] shrink-0 border border-border-default" />;
  }
  return (
    <span
      aria-hidden="true"
      title={label}
      className={`grid h-[18px] w-[18px] shrink-0 place-items-center font-mono text-meta font-bold text-white ${color ? '' : 'bg-text-muted'}`}
      style={color ? { backgroundColor: color } : undefined}
    >
      {label[0]?.toUpperCase()}
    </span>
  );
}

/** "last reconcile exports spec", "last PR #812", or nothing. The age is drawn by the caller. */
function LastRun({ last }: { last: NonNullable<FleetSlot['last']> }) {
  const what = last.label ?? (last.prNumber ? `PR #${last.prNumber}` : null);
  if (!what) return null;
  return (
    <>
      {' · last '}
      {last.fix && <span aria-label="retry">↻ </span>}
      <b className={`font-semibold ${last.failed ? 'text-status-error' : 'text-text-secondary'}`}>{what}</b>
    </>
  );
}

function SlotCell({ slot, now }: { slot: FleetSlot; now: number }) {
  const w = slot.worker;
  if (!w) {
    const last = slot.last;
    const named = !!last && !!(last.label ?? last.prNumber);
    return (
      <div className="flex min-w-0 items-center gap-2.5 font-mono text-meta text-text-muted">
        <span aria-hidden="true" className="h-[18px] w-[18px] shrink-0 border border-dashed border-border-strong" />
        {/* The label truncates; the age never does — it is the one fact a
            glance needs ("idle · last rates service · 4m"). */}
        <span className="min-w-0 truncate">
          idle
          {last && <LastRun last={last} />}
        </span>
        {named && last!.at != null && (
          <span data-testid="fleet-slot-last-at" className="-ml-2 shrink-0 whitespace-nowrap text-text-muted">
            {' · '}{ago(last!.at, now).replace(' ago', '')}
          </span>
        )}
      </div>
    );
  }
  const elapsedMs = w.startedAt ? Math.max(0, now - new Date(w.startedAt).getTime()) : null;
  // "37m", "5h", "2d": never "2856m".
  const mins = elapsedMs != null ? shortDuration(elapsedMs) : null;
  // Same minute the lanes chart draws as a "claimed" marker at NOW.
  const justClaimed = elapsedMs == null || elapsedMs < 60_000;
  const href = w.taskId ? missionTaskHref({ missionId: w.missionId, taskId: w.taskId, from: 'home', mode: 'sheet' }) : null;
  const body = (
    <>
      <div className="flex min-w-0 items-baseline gap-2 font-mono">
        <span className="shrink-0 text-body font-semibold text-text-primary">{w.label}</span>
        <span className="truncate text-meta text-text-secondary">{w.rest}</span>
      </div>
      {w.question ? (
        <div className="mt-1 flex items-center gap-1.5 font-mono text-meta font-bold uppercase tracking-[1px] text-status-warning">
          ? Needs input{mins != null && <span className="font-normal normal-case tracking-normal text-text-muted">· {mins}</span>}
        </div>
      ) : w.progress != null ? (
        <div className="mt-1.5 flex items-center gap-2.5 font-mono text-meta text-text-muted">
          <span className="relative h-[3px] w-full max-w-[150px] bg-border-default" aria-hidden="true">
            <span className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${w.progress}%` }} />
          </span>
          <span className="shrink-0 whitespace-nowrap">{`${Math.round(w.progress)}%`}{mins != null && ` · ${mins}`}</span>
        </div>
      ) : justClaimed ? (
        // Claimed this minute and nothing reported: not "— · 0m" under an empty track.
        <div data-testid="fleet-slot-claimed" className="mt-1 font-mono text-meta font-semibold uppercase tracking-[0.8px] text-accent-text">claimed</div>
      ) : mins != null ? (
        <div className="mt-1 font-mono text-meta tabular-nums text-text-muted">{mins}</div>
      ) : null}
    </>
  );
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      <RoleSquare slug={w.roleSlug} name={w.roleName} color={w.roleColor} />
      {href ? <Link href={href} className="block min-w-0 flex-1 hover:underline">{body}</Link> : <div className="min-w-0 flex-1">{body}</div>}
      {/* Waiting on you already has its own answer path; steering it is the question hero's job, not this one. */}
      {w.taskId && !w.question && <SteerButton taskId={w.taskId} />}
    </div>
  );
}

/** Runner column + slot column; each row is exactly one SlotLanes row tall. */
// Below md the runner is a full-width header row above its slots (a 120px
// column cut every real hostname); from md it is the left column the chart's
// rows line up with.
const TABLE_COLS = 'grid-cols-1 md:grid-cols-[170px_minmax(0,1fr)]';

/**
 * One square per slot, in the order the rows beside it list them
 * (`fleetDisplayRows`: busy and recent idle slots in slot order, then the folded rest) —
 * so the filled square is the row with the agent on it, not its slot index.
 */
function SlotMeterSquares({ runner, rows }: { runner: FleetRunner; rows: readonly FleetDisplayRow[] }) {
  const ordered = rows.flatMap(r => (r.kind === 'slot' ? [r.slot] : r.slots));
  const seen = new Set(ordered.map(s => s.index));
  const slots = [...ordered, ...runner.slots.filter(s => !seen.has(s.index))];
  return (
    <span className="mt-0.5 flex flex-wrap gap-[3px]" aria-label={`${runner.slots.filter(s => s.worker).length} of ${runner.maxSlots} slots busy`}>
      {slots.map(s => (
        <i key={s.index} className={`inline-block h-2.5 w-2.5 border ${s.worker ? 'border-accent bg-accent' : 'border-border-strong'}`} />
      ))}
    </span>
  );
}

function RunnerBlock({ runner, rows, first, now }: { runner: FleetRunner; rows: FleetDisplayRow[]; first: boolean; now: number }) {
  const roomy = rows.length >= 2;
  return (
    <div
      data-testid="fleet-runner"
      data-elastic={runner.elastic ? 'true' : undefined}
      className={`grid ${TABLE_COLS} ${first ? '' : 'border-t-[1.5px] border-t-[var(--fleet-border-mid)]'}`}
    >
      <div
        className="flex min-w-0 flex-row flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-default px-3 py-2 md:flex-col md:flex-nowrap md:items-start md:justify-center md:gap-1 md:border-r md:px-5 md:py-0 md:[grid-row:var(--runner-rows)]"
        style={{ '--runner-rows': `span ${rows.length}` } as CSSProperties}
      >
        {/* Wraps to two lines before it truncates; the title always has the whole name. */}
        <span title={runner.elastic && !roomy && runner.machine ? `${runner.name} · ${runner.machine}` : runner.name} className="min-w-0 font-mono text-title font-semibold leading-tight text-text-primary [overflow-wrap:anywhere] md:line-clamp-2">
          {runner.name}
        </span>
        {runner.elastic ? (
          // An elastic group has no fixed size to draw: its slots are its live
          // runs. The column is too narrow for "Cloudflare · elastic · 2
          // running" on one line, so the count gets its own. A one-run group
          // fits one 50px row like a one-row machine: name only on desktop
          // (its single row already is the run; the executor is in the title).
          <>
            {runner.machine && <span className={`max-w-full truncate font-mono text-meta text-text-muted ${roomy ? '' : 'md:hidden'}`}>{runner.machine}</span>}
            <b data-testid="fleet-elastic-running" className={`font-mono text-meta font-semibold tabular-nums text-accent-text ${roomy ? '' : 'md:hidden'}`}>{runner.elastic.running} running</b>
          </>
        ) : (
          <>
            {runner.machine && <span className={`truncate font-mono text-meta text-text-muted ${roomy ? '' : 'md:hidden'}`}>{runner.machine}</span>}
            <span className={roomy ? '' : 'md:hidden'}><SlotMeterSquares runner={runner} rows={rows} /></span>
          </>
        )}
        {!runner.online && <span className="font-mono text-meta text-status-warning">offline</span>}
      </div>
      {rows.map((row) => row.kind === 'slot' ? (
        <div
          key={row.slot.index}
          data-testid="fleet-slot"
          data-busy={row.slot.worker ? 'true' : 'false'}
          data-status={row.slot.worker?.status ?? 'idle'}
          style={{ height: SLOT_LANE_ROW_PX }}
          className={`flex items-center border-b border-border-default px-3 md:col-start-2 md:px-4 ${
            row.slot.worker ? `border-l-[3px] ${row.slot.worker.question ? 'border-l-status-warning bg-status-warning/10' : 'border-l-accent'}` : ''
          }`}
        >
          <SlotCell slot={row.slot} now={now} />
        </div>
      ) : (
        <div
          key="idle"
          data-testid="fleet-idle-slots"
          data-count={row.count}
          style={{ height: SLOT_LANE_ROW_PX }}
          className="flex items-center gap-2.5 border-b border-border-default px-3 font-mono text-meta text-text-muted md:col-start-2 md:px-4"
        >
          <span aria-hidden="true" className="h-[18px] w-[18px] shrink-0 border border-dashed border-border-strong" />
          {row.count} idle slots
        </div>
      ))}
    </div>
  );
}

function FleetTable({ fleet, now, timeZone }: { fleet: FleetSnapshot; now: number; timeZone?: string | null }) {
  return (
    <div className="card max-h-[640px] overflow-y-auto overflow-x-hidden p-0 xl:grid xl:grid-cols-[470px_minmax(0,1fr)]">
      <div className="min-w-0 xl:border-r xl:border-border-default">
        {/* Same height as the chart's axis band, so the rows line up. */}
        <div
          aria-hidden="true"
          className={`hidden border-b border-border-default font-mono text-meta font-semibold uppercase tracking-[1.5px] text-text-muted xl:grid ${TABLE_COLS}`}
          style={{ height: SLOT_LANE_AXIS_PX }}
        >
          <span className="flex items-center px-5">Runner</span>
          <span className="flex items-center px-4">Slot</span>
        </div>
        {fleet.runners.map((r, i) => (
          <RunnerBlock key={r.id} runner={r} rows={fleetDisplayRows(r, { since: fleet.window.from })} first={i === 0} now={now} />
        ))}
      </div>
      <div className="hidden min-w-0 xl:block">
        <FleetLanes fleet={fleet} now={now} timeZone={timeZone} />
      </div>
    </div>
  );
}

/** The one-line fleet: slots busy (or all idle) and the last thing that finished. */
function SummaryLine({ fleet, now }: { fleet: FleetSnapshot; now: number }) {
  const s = fleetSummary(fleet);
  const who = s.runnerNames.length === 1 ? s.runnerNames[0] : `${s.runnerNames.length} runners`;
  const running = fleet.runners.flatMap(r => r.slots.map(sl => sl.worker).filter(Boolean)).map(w => w!.label);
  return (
    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 font-mono text-meta text-text-secondary">
      <span title={s.runnerNames.join(', ')} className="max-w-[16rem] truncate font-semibold text-text-primary">{who}</span>
      {s.busy > 0 ? (
        <span>
          <b className="text-accent-text">{s.busy} of {s.slots} slots busy</b>
          {running.length > 0 && <span className="text-text-muted"> · {running.slice(0, 3).join(', ')}{running.length > 3 ? ` +${running.length - 3}` : ''}</span>}
        </span>
      ) : (
        <span>all {s.slots} slots idle</span>
      )}
      {s.busy === 0 && s.last && (
        <span className="min-w-0 truncate text-text-muted">
          last: <b className={`font-semibold ${s.last.failed ? 'text-status-error' : 'text-text-secondary'}`}>{s.last.label}</b> {s.last.failed ? '✕' : '✓'} {ago(s.last.at, now)}
        </span>
      )}
      {s.online < fleet.runners.length && <span className="text-status-warning">{fleet.runners.length - s.online} offline</span>}
    </span>
  );
}

export function FleetStrip({
  fleet,
  roles,
  now,
  timeZone,
  compact = false,
}: {
  fleet: FleetSnapshot;
  roles: Array<{ slug: string; name: string; color: string | null }>;
  now: number;
  timeZone?: string | null;
  /** Always start as the one-line summary (a member's Home). */
  compact?: boolean;
}) {
  const busy = fleet.runners.some(r => r.slots.some(s => s.worker));
  const collapsed = compact || !busy;
  const label = <span className="section-label text-text-muted">{fleetLabel(fleet)}</span>;

  if (fleet.runners.length === 0) {
    return (
      <section data-testid="home-fleet" className="mb-8">
        <div className="mb-3">{label}</div>
        <div className="border border-dashed border-border-strong px-5 py-4 font-mono text-meta text-text-secondary">
          No runners online. Run <code className="text-text-primary">buildd</code> on a machine where it is installed, or{' '}
          <Link href="/app/settings/runners" className="text-accent-text hover:underline">install it</Link>.
        </div>
      </section>
    );
  }

  if (collapsed) {
    return (
      <section data-testid="home-fleet" data-mode="summary" className="mb-8">
        <details className="group">
          <summary
            data-testid="fleet-summary"
            className="card flex min-h-11 cursor-pointer list-none items-center gap-3 px-4 py-2.5 md:px-5 [&::-webkit-details-marker]:hidden"
          >
            <span className="section-label hidden shrink-0 text-text-muted md:inline">Runners</span>
            <SummaryLine fleet={fleet} now={now} />
            <span className="shrink-0 font-mono text-meta text-text-muted">
              <span className="group-open:hidden">show ▸</span>
              <span className="hidden group-open:inline">hide ▾</span>
            </span>
          </summary>
          <div className="mt-3">
            <FleetTable fleet={fleet} now={now} timeZone={timeZone} />
          </div>
        </details>
      </section>
    );
  }

  return (
    <section data-testid="home-fleet" data-mode="panel" className="mb-8">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        {label}
        {roles.length > 0 && (
          <span className="hidden flex-wrap gap-3.5 font-mono text-meta text-text-secondary md:flex">
            {roles.map(r => (
              <span key={r.slug} className="inline-flex items-center gap-1.5">
                <i aria-hidden="true" className={`inline-block h-2.5 w-2.5 ${r.color ? '' : 'bg-text-muted'}`} style={r.color ? { backgroundColor: r.color } : undefined} />
                {r.name}
              </span>
            ))}
          </span>
        )}
      </div>
      <FleetTable fleet={fleet} now={now} timeZone={timeZone} />
    </section>
  );
}
