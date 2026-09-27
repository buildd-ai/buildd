'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import Switch, { SWITCH_HIT_AREA } from '@/components/ui/Switch';
import { useMoveToTeam, type MoveTeam } from '@/components/MoveToTeamDialog';
import type { WorkspaceRow } from './rows';

const CELL = 'md:table-cell md:px-3 md:py-2.5 md:align-middle';
const HEAD = 'px-3 py-2 text-left section-label font-normal';
/** Label shown before a value on phones, where the header row is hidden. */
const MOBILE_LABEL = 'md:hidden text-xs text-text-muted';
const VALUE_LINK =
  'inline-flex min-h-11 md:min-h-0 items-center text-[13px] text-text-primary underline decoration-border-default underline-offset-4 hover:decoration-current';

function CiSwitch({ row }: { row: WorkspaceRow }) {
  const [on, setOn] = useState(row.enforceGreenCI);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    if (saving) return;
    setOn(next);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gitConfig: { enforceGreenCI: next } }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Save failed');
      }
    } catch (e) {
      setOn(!next);
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <span className="flex items-center justify-between md:justify-start gap-3 min-h-11 md:min-h-0">
      <span className={MOBILE_LABEL}>Require green CI</span>
      <span className="flex items-center gap-2">
        {error && <span className="text-xs text-status-error" role="alert">{error}</span>}
        <Switch
          checked={on}
          onChange={toggle}
          disabled={!row.canEdit || saving}
          label={`Require green CI for ${row.name}`}
          className={SWITCH_HIT_AREA}
        />
      </span>
    </span>
  );
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
    <div ref={ref} className="relative">
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
          <button
            type="button"
            onClick={() => { setOpen(false); onMove(); }}
            className="w-full min-h-11 md:min-h-9 px-3 text-left text-[13px] text-text-primary hover:bg-surface-3 whitespace-nowrap"
          >
            Move to team&hellip;
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Settings → Workspaces: one row per workspace. A table from `md` up; below
 * that the same markup stacks into one card per workspace, so a phone never
 * scrolls sideways.
 */
export default function WorkspacesTable({ rows, moveTeams }: { rows: WorkspaceRow[]; moveTeams: MoveTeam[] }) {
  const move = useMoveToTeam();
  const anyMenu = rows.some((r) => r.canMove);

  return (
    <>
      <table className="block md:table w-full border-collapse md:bg-card md:border-2 md:border-border-strong md:shadow-[var(--card-shadow)]">
        <thead className="hidden md:table-header-group">
          <tr className="border-b border-border-default">
            <th scope="col" className={HEAD}>Workspace</th>
            <th scope="col" className={HEAD}>Team</th>
            <th scope="col" className={HEAD}>Git workflow</th>
            <th scope="col" className={HEAD}>Merge policy</th>
            <th scope="col" className={HEAD}>Green CI</th>
            {anyMenu && <th scope="col" className={HEAD}><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody className="block md:table-row-group space-y-4 md:space-y-0">
          {rows.map((row) => (
            <tr
              key={row.id}
              data-testid="workspace-row"
              className="card md:shadow-none md:border-x-0 md:border-t-0 md:bg-transparent grid grid-cols-[1fr_auto] gap-x-3 px-4 py-3 md:table-row md:h-[3.25rem] md:p-0 md:border-b md:border-border-default md:last:border-b-0"
            >
              <th scope="row" className={`${CELL} block min-w-0 text-left font-normal`}>
                <span className="block text-sm font-semibold text-text-primary break-words">{row.name}</span>
                <span className="block md:hidden text-xs text-text-muted mt-0.5">{row.teamName}</span>
              </th>
              <td className={`${CELL} hidden md:table-cell text-[13px] text-text-secondary`}>{row.teamName}</td>
              <td className={`${CELL} col-span-2 flex md:table-cell items-center justify-between gap-3 border-t border-border-default md:border-0 mt-2 md:mt-0`}>
                <span className={MOBILE_LABEL}>Git workflow</span>
                <Link href={`/app/workspaces/${row.id}/config`} className={VALUE_LINK}>{row.gitWorkflow}</Link>
              </td>
              <td className={`${CELL} col-span-2 flex md:table-cell items-center justify-between gap-3 border-t border-border-default md:border-0`}>
                <span className={MOBILE_LABEL}>Merge policy</span>
                <Link href={`/app/settings/workspace/${row.id}`} className={VALUE_LINK}>{row.mergePolicy}</Link>
              </td>
              <td className={`${CELL} block col-span-2 border-t border-border-default md:border-0`}>
                <CiSwitch row={row} />
              </td>
              {anyMenu && (
                <td className={`${CELL} block col-start-2 row-start-1 -mr-2 -mt-2 md:m-0 md:w-12 md:text-right`}>
                  {row.canMove && <RowMenu row={row} onMove={() => move.start({ id: row.id, name: row.name, teamId: row.teamId }, moveTeams)} />}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {move.ui}
    </>
  );
}
