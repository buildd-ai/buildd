'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { TonePill } from '@/components/ui/StatePill';
import Disclosure from '@/components/ui/Disclosure';
import { useMoveToTeam, type MoveTeam } from '@/components/MoveToTeamDialog';
import { groupWorkspaceRows, type WorkspaceRow } from './list-groups';

/** Workspace · runs on · last activity · open · menu. Below md the row stacks. */
const GRID = 'md:grid md:grid-cols-[minmax(0,1fr)_9.5rem_6.5rem_4rem_2.75rem] md:items-center md:gap-x-4';
const EXECUTOR_LABEL = { cloud: 'Cloud', host: 'Host', any: 'Any runner' } as const;

function runsOn(row: WorkspaceRow): string {
  const label = EXECUTOR_LABEL[row.runsOn.executor];
  return row.runsOn.size ? `${label} · ${row.runsOn.size}` : label;
}

function ago(iso: string | null, now: Date): string {
  if (!iso) return 'No tasks';
  const mins = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 60000));
  if (mins < 60) return mins < 1 ? 'Just now' : `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function RowMenu({ row, onMove }: { row: WorkspaceRow; onMove: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative z-10">
      <button
        ref={triggerRef}
        type="button"
        data-testid="workspace-row-menu"
        aria-label={`Actions for ${row.name}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="flex h-11 w-11 md:h-8 md:w-8 items-center justify-center text-text-secondary hover:text-text-primary"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <rect x="7" y="2" width="2.5" height="2.5" />
          <rect x="7" y="6.75" width="2.5" height="2.5" />
          <rect x="7" y="11.5" width="2.5" height="2.5" />
        </svg>
      </button>
      {open && (
        <div id={panelId} className="absolute right-0 top-full z-20 mt-1 min-w-44 card p-1">
          <Link
            href={`/app/workspaces/${row.id}`}
            className="flex items-center w-full min-h-11 md:min-h-9 px-3 text-body text-text-primary hover:bg-surface-3 whitespace-nowrap"
          >
            Open
          </Link>
          {row.canMove && (
            <button
              type="button"
              onClick={() => { setOpen(false); onMove(); }}
              className="w-full min-h-11 md:min-h-9 px-3 text-left text-body text-text-primary hover:bg-surface-3 whitespace-nowrap"
            >
              Move to team&hellip;
            </button>
          )}
          <Link
            href={`/app/settings/workspace/${row.id}`}
            className="flex items-center w-full min-h-11 md:min-h-9 px-3 text-body text-text-primary hover:bg-surface-3 whitespace-nowrap"
          >
            Settings
          </Link>
        </div>
      )}
    </div>
  );
}

function HealthChips({ row }: { row: WorkspaceRow }) {
  const { redPrs, stuckTasks } = row.health;
  if (redPrs === 0 && stuckTasks === 0) return null;
  const href = `/app/tasks?workspace=${encodeURIComponent(row.id)}`;
  return (
    <>
      {redPrs > 0 && (
        <Link href={href} className="relative z-10 inline-flex" data-testid="workspace-health-red">
          <TonePill tone="bad">{redPrs === 1 ? '1 red PR' : `${redPrs} red PRs`}</TonePill>
        </Link>
      )}
      {stuckTasks > 0 && (
        <Link href={href} className="relative z-10 inline-flex" data-testid="workspace-health-stuck">
          <TonePill tone="act">{`${stuckTasks} stuck`}</TonePill>
        </Link>
      )}
    </>
  );
}

function Row({ row, now, onMove }: { row: WorkspaceRow; now: Date; onMove: (row: WorkspaceRow) => void }) {
  const chips = row.differs.length > 0 || row.health.redPrs > 0 || row.health.stuckTasks > 0;
  return (
    <li
      data-testid="workspace-row"
      className={`relative ${GRID} grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-4 py-3 md:px-3 md:py-2.5 hover:bg-card-hover`}
    >
      <div className="min-w-0">
        {/* The whole row opens the workspace; chips and the menu sit above this link. */}
        <Link
          href={`/app/workspaces/${row.id}`}
          className="block text-title font-semibold text-text-primary break-words after:absolute after:inset-0 after:content-['']"
        >
          {row.name}
        </Link>
        {chips && (
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {row.differs.map((d) => (
              <Link key={d.key} href={d.href} className="relative z-10 inline-flex" data-testid={`workspace-differs-${d.key}`}>
                <TonePill tone="q">{d.label}</TonePill>
              </Link>
            ))}
            <HealthChips row={row} />
          </div>
        )}
        <p className="md:hidden text-meta text-text-muted mt-1.5">
          {runsOn(row)} · <span suppressHydrationWarning>{ago(row.lastActivityAt, now)}</span> · {row.openTasks} open
        </p>
      </div>
      <span className="hidden md:block text-body text-text-secondary" data-testid="workspace-runs-on">
        <span className="sr-only">Runs on </span>{runsOn(row)}
      </span>
      <span className="hidden md:block text-body text-text-secondary" suppressHydrationWarning>
        <span className="sr-only">Last task </span>{ago(row.lastActivityAt, now)}
      </span>
      <span className="hidden md:block text-body text-text-secondary tabular-nums">
        {row.openTasks}<span className="sr-only"> open tasks</span>
      </span>
      <div className="col-start-2 row-start-1 -mr-2 -mt-2 md:m-0 md:col-auto md:row-auto md:justify-self-end">
        <RowMenu row={row} onMove={() => onMove(row)} />
      </div>
    </li>
  );
}

function ColumnLabels() {
  return (
    <div aria-hidden="true" className={`hidden ${GRID} px-3 pb-1.5 text-meta text-text-muted`}>
      <span>Workspace</span>
      <span>Runs on</span>
      <span>Last task</span>
      <span>Open</span>
      <span />
    </div>
  );
}

function RowList({ rows, now, onMove }: { rows: WorkspaceRow[]; now: Date; onMove: (row: WorkspaceRow) => void }) {
  return (
    <ul className="divide-y divide-border-default border-y border-border-default">
      {rows.map((row) => <Row key={row.id} row={row} now={now} onMove={onMove} />)}
    </ul>
  );
}

/**
 * Settings → Workspaces: a list per team (team headings only when the rows
 * span more than one team), most recently active first. A row shows only the
 * settings that differ from the defaults, where its work runs, its last task,
 * open tasks and a health hint; the whole row opens the workspace. Workspaces
 * with no task in 30 days fold under "Inactive (N)". A header row labels the
 * columns from md; below that each row stacks, so a phone never scrolls sideways.
 */
export default function WorkspacesTable({
  rows,
  moveTeams,
  defaults,
  now: nowIso,
}: {
  rows: WorkspaceRow[];
  moveTeams: MoveTeam[];
  /** What a workspace with no settings of its own gets (rows.ts WORKSPACE_DEFAULTS). */
  defaults: { gitWorkflow: string; mergePolicy: string };
  /** The server's clock (ISO), so the server render and hydration agree on what is inactive. */
  now?: string;
}) {
  const move = useMoveToTeam();
  const now = nowIso ? new Date(nowIso) : new Date();
  const { showTeamHeadings, groups } = groupWorkspaceRows(rows, now);
  const onMove = (row: WorkspaceRow) => move.start({ id: row.id, name: row.name, teamId: row.teamId }, moveTeams);

  return (
    <>
      <p className="text-meta text-text-muted mb-4" data-testid="workspace-defaults">
        Default: {defaults.gitWorkflow} · {defaults.mergePolicy}
      </p>
      <div className="space-y-6">
        {groups.map((g, i) => (
          <section key={g.teamId} aria-label={showTeamHeadings ? g.teamName ?? undefined : undefined} data-testid="workspace-team-group">
            {showTeamHeadings && g.teamName && <h3 className="section-label mb-2">{g.teamName}</h3>}
            {/* Column labels once, under the first team heading; md and up only. */}
            {i === 0 && g.active.length > 0 && <ColumnLabels />}
            {g.active.length > 0 && <RowList rows={g.active} now={now} onMove={onMove} />}
            {g.inactive.length > 0 && (
              <Disclosure summary={`Inactive (${g.inactive.length})`} className={g.active.length > 0 ? 'mt-2' : ''}>
                <div className="mt-1" data-testid="workspace-inactive">
                  <RowList rows={g.inactive} now={now} onMove={onMove} />
                </div>
              </Disclosure>
            )}
          </section>
        ))}
      </div>

      {move.ui}
    </>
  );
}
