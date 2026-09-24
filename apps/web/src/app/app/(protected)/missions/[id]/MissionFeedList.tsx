'use client';

/**
 * The one task list on the mission page (docs/design/mission-feed-mobile-continuity.md,
 * "Grouping rules", W2, W3). It replaces both the flight-strip navigator's list
 * and the mobile rail.
 *
 * - The model is `buildMissionFeedGroups`: NEEDS YOU and MOVING NOW pinned,
 *   then phases in pulse order. Every deliverable is a row exactly once; a
 *   pinned row leaves a slot marker in its phase (L-1, AC-2, AC-3).
 * - Folded rows stay in the DOM, `hidden`. A `#t-` arrival or a pulse focus can
 *   then always find its row, and the focus store's reveal unfolds it.
 * - Rows are `MissionTaskRow`: a real link to `?task=`, intercepted by the
 *   sheet owner's delegated handler. No row opts out (AC-10).
 * - Freeze rule: while the sheet is open or a finger was just down, the list
 *   renders the last task set committed before the freeze
 *   (`createFreezeGate`). When it lifts, moved rows slide into place over
 *   {@link FLIP_MS} instead of jumping.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import MissionTaskRow from '@/components/missions/MissionTaskRow';
import { useMissionFocusSnapshot, useMissionFocusStore } from '@/components/missions/mission-focus-context';
import { buildMissionFeedGroups, type FeedGroup, type FeedPhaseItem, type FeedRow } from '@/lib/mission-feed-groups';
import type { MissionFeedTaskInput } from '@/lib/mission-pulse';
import { missionTaskAnchorId, type MissionOrigin } from '@/lib/mission-task-href';
import { LIVE_WORKER_STATUSES } from '@/lib/task-presentation';
import { useMissionLiveLines } from './MissionLiveStore';

const LIVE_STATUSES: ReadonlySet<string> = new Set(LIVE_WORKER_STATUSES);

/** Duration of the reorder slide once a freeze lifts. */
export const FLIP_MS = 200;

// useLayoutEffect warns under SSR; the measurement is client-only anyway.
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * FLIP offsets: for every row present in both measurements whose top moved by
 * at least a pixel, `prev - next` — the translate that puts it back where it
 * was, before animating to zero.
 */
export function flipDeltas(prev: ReadonlyMap<string, number>, next: ReadonlyMap<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, top] of next) {
    const before = prev.get(id);
    if (before === undefined) continue;
    const d = before - top;
    if (Math.abs(d) >= 1) out.set(id, d);
  }
  return out;
}

/**
 * The ids whose focus unfolds a phase: its own rows only. A slot's task lives
 * in a pinned group, so focusing it must not force its home phase open.
 */
export function phaseRevealIds(items: readonly FeedPhaseItem[]): string[] {
  return items.flatMap(i => (i.type === 'row' ? [i.row.taskId] : []));
}

export interface MissionFeedListProps {
  missionId: string;
  /** Every mission task, any class — `buildMissionFeedGroups` folds attempts and bookkeeping. */
  tasks: MissionFeedTaskInput[];
  /** Server render time, for the rows' elapsed text (hydration-stable). */
  now: number;
  from?: MissionOrigin | null;
  initiativeId?: string | null;
  /** Review-worthy records per task (`selectMissionRecords`). */
  recordsCountByTask?: Readonly<Record<string, number>>;
  /**
   * Live current action per task, for MOVING rows, as rendered. Progress
   * heartbeats lay newer actions over it through the live store (S7).
   */
  liveLines?: Readonly<Record<string, string>>;
  /** Test seam: rows to treat as revealed. Inside a provider the focus store decides. */
  revealedTaskIds?: ReadonlySet<string>;
}

type PhaseGroup<T extends MissionFeedTaskInput> = Extract<FeedGroup<T>, { kind: 'phase' }>;

const groupKey = (g: FeedGroup, i: number) => (g.kind === 'phase' ? `phase:${g.index ?? 'none'}:${i}` : g.kind);

const GROUP_LABEL = { needs_you: 'NEEDS YOU', moving: 'MOVING NOW' } as const;
const SLOT_LABEL = { needs_you: 'Needs you', moving: 'Moving now' } as const;

function GroupLabel({ children }: { children: string }) {
  return (
    <h2 className="flex min-h-[34px] items-center px-3 pt-2 font-mono text-[11px] font-semibold uppercase tracking-[2px] text-text-muted">
      {children}
    </h2>
  );
}

function MoreButton({ label, onClick, expanded }: { label: string; onClick: () => void; expanded: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      className="flex min-h-11 w-full items-center px-3 font-mono text-[12px] text-text-secondary hover:text-text-primary"
    >
      {label}
    </button>
  );
}

export default function MissionFeedList<T extends MissionFeedTaskInput>({
  missionId,
  tasks: latestTasks,
  now,
  from,
  initiativeId,
  recordsCountByTask,
  liveLines: serverLiveLines,
  revealedTaskIds: revealedProp,
}: MissionFeedListProps & { tasks: T[] }) {
  const liveLines = useMissionLiveLines(serverLiveLines, LIVE_STATUSES);
  const store = useMissionFocusStore();
  const focus = useMissionFocusSnapshot();

  // Freeze rule. The snapshot subscription re-renders this list when the
  // freeze lifts, and the gate then lets the latest tasks through.
  const gate = useMemo(() => store?.createFreezeGate<T[]>() ?? null, [store]);
  const tasks = gate ? gate(latestTasks) : latestTasks;
  const model = useMemo(() => buildMissionFeedGroups(tasks), [tasks]);
  const phaseGroupCount = model.groups.filter(g => g.kind === 'phase').length;

  // A reveal (pulse focus, `#t-` arrival) unfolds the group holding the
  // selected row. A toggle made while that same row is selected wins, so the
  // reader can still fold it again; the next selection re-applies the reveal.
  const selected = focus?.selectedTaskId ?? null;
  const forced: ReadonlySet<string> =
    revealedProp ?? (selected && focus?.revealedTaskIds.has(selected) ? new Set([selected]) : EMPTY_SET);
  const [toggled, setToggled] = useState<Record<string, { open: boolean; sel: string | null }>>({});
  const isOpen = (key: string, ids: readonly string[], byDefault: boolean) => {
    const t = toggled[key];
    if (t && t.sel === selected) return t.open;
    if (ids.some(id => forced.has(id))) return true;
    return t ? t.open : byDefault;
  };
  const toggle = (key: string, open: boolean) => setToggled(prev => ({ ...prev, [key]: { open, sel: selected } }));

  const rowCtx = { missionId, from, initiativeId, now };
  const rowProps = (row: FeedRow<T>) => ({
    ...rowCtx,
    row,
    recordsCount: recordsCountByTask?.[row.taskId],
    liveLine: liveLines?.[row.taskId] ?? null,
    blockedByTitle: row.blockedByTaskId ? model.rowsById.get(row.blockedByTaskId)?.task.title ?? null : null,
  });

  // ── FLIP on reorder ──
  const listRef = useRef<HTMLElement>(null);
  const positions = useRef<Map<string, number>>(new Map());
  const layoutSignature = model.groups
    .map(g => (g.kind === 'phase' ? g.items.map(i => (i.type === 'row' ? i.row.taskId : `s:${i.taskId}`)).join(',') : g.rows.map(r => r.taskId).join(',')))
    .join('|');
  const lastSignature = useRef(layoutSignature);
  useIsoLayoutEffect(() => {
    const root = listRef.current;
    if (!root) return;
    const origin = root.getBoundingClientRect().top;
    const next = new Map<string, number>();
    const els = new Map<string, HTMLElement>();
    root.querySelectorAll<HTMLElement>('[data-testid="mission-task-row"]').forEach(el => {
      const id = el.dataset.taskId;
      if (!id || el.offsetParent === null) return;
      next.set(id, el.getBoundingClientRect().top - origin);
      els.set(id, el);
    });
    const reordered = lastSignature.current !== layoutSignature;
    lastSignature.current = layoutSignature;
    const deltas = reordered ? flipDeltas(positions.current, next) : new Map<string, number>();
    positions.current = next;
    if (deltas.size === 0 || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    for (const [id, dy] of deltas) {
      const el = els.get(id)!;
      el.style.transition = 'none';
      el.style.transform = `translateY(${dy}px)`;
    }
    requestAnimationFrame(() => {
      for (const id of deltas.keys()) {
        const el = els.get(id)!;
        el.style.transition = `transform ${FLIP_MS}ms ease-out`;
        el.style.transform = '';
      }
    });
  });

  // ── Reveal-then-scroll ──
  // The focus store scrolls a row as soon as it is registered; a folded row is
  // registered but hidden, so that scroll lands nowhere. Once the reveal
  // unfolds it, scroll the selected row into place.
  const hiddenBefore = useRef<Set<string>>(new Set());
  const hiddenNow = new Set<string>();

  useEffect(() => {
    if (selected && hiddenBefore.current.has(selected) && !hiddenNow.has(selected)) {
      document.getElementById(missionTaskAnchorId(selected))?.scrollIntoView({ block: 'center' });
    }
    hiddenBefore.current = hiddenNow;
  });

  const renderRows = (rows: FeedRow<T>[], hidden: boolean) => {
    if (hidden) for (const r of rows) hiddenNow.add(r.taskId);
    return rows.map(row => <MissionTaskRow key={row.taskId} {...rowProps(row)} />);
  };

  // A slot is a 20px marker, not a tap target (44px rule): the pinned row above
  // is the target. `pointer-events-none` keeps a tap on it from reaching the
  // sheet's delegated [data-task-id] handler; aria-hidden keeps it out of the
  // reading order, where the pinned row already announces the task.
  const renderItems = (items: readonly FeedPhaseItem<T>[], hidden: boolean) =>
    items.map(item => {
      if (item.type === 'row') {
        if (hidden) hiddenNow.add(item.row.taskId);
        return <MissionTaskRow key={item.row.taskId} {...rowProps(item.row)} />;
      }
      return (
        <div
          key={`slot-${item.taskId}`}
          data-testid="mission-task-slot"
          data-task-id={item.taskId}
          aria-hidden="true"
          className="pointer-events-none flex h-5 items-center gap-1 truncate pl-[2.75rem] pr-3 font-mono text-[11px] text-text-muted"
        >
          <span>↑</span>
          <span className="min-w-0 truncate">{`${item.title} · in ${SLOT_LABEL[item.pinnedIn]}`}</span>
        </div>
      );
    });

  return (
    <section ref={listRef} data-testid="mission-feed" aria-label="Tasks" className="border-t-2 border-border-strong">
      {model.groups.map((group, gi) => {
        const key = groupKey(group, gi);

        if (group.kind === 'needs_you') {
          const open = isOpen(key, group.rows.slice(group.visibleLimit).map(r => r.taskId), false);
          const shown = group.rows.slice(0, group.visibleLimit);
          const rest = group.rows.slice(group.visibleLimit);
          return (
            <div key={key} data-testid="mission-feed-group" data-group="needs_you">
              <GroupLabel>{`${GROUP_LABEL.needs_you} · ${group.rows.length}`}</GroupLabel>
              {renderRows(shown, false)}
              {rest.length > 0 && (
                <>
                  <div data-testid="mission-feed-overflow" hidden={!open}>{renderRows(rest, !open)}</div>
                  <MoreButton label={open ? 'Show fewer ▴' : `+${rest.length} more ▾`} expanded={open} onClick={() => toggle(key, !open)} />
                </>
              )}
            </div>
          );
        }

        if (group.kind === 'moving') {
          return (
            <div key={key} data-testid="mission-feed-group" data-group="moving">
              <GroupLabel>{`${GROUP_LABEL.moving} · ${group.rows.length}`}</GroupLabel>
              {renderRows(group.rows, false)}
            </div>
          );
        }

        return renderPhase(group, key);
      })}
    </section>
  );

  function renderPhase(g: PhaseGroup<T>, key: string) {
    // mission-legibility §4: a mission where no task carries a phase renders no
    // phase header while it has open work. With no header there is nothing to
    // unfold, so its rows do not fold either. Once every row is finished the
    // group folds like a finished phase (grouping rule 3), under a plain
    // `Tasks ✓ n/n` header: a completed mission's first screen is its outcome,
    // not every row it ever ran.
    const unphasedOnly = g.label === null && phaseGroupCount === 1;
    const headerless = unphasedOnly && g.status !== 'finished';
    const rowIds = phaseRevealIds(g.items);
    const expanded = headerless || isOpen(key, rowIds, !g.collapsed);
    const limit = headerless ? null : g.visibleLimit;
    // Items in model order: a slot sits at its place (grouping rule 4). The cap
    // counts rows only; everything from the first row past it goes to overflow.
    const own: FeedRow<T>[] = [];
    let cut = g.items.length;
    g.items.forEach((item, i) => {
      if (item.type !== 'row') return;
      if (limit !== null && own.length === limit && cut === g.items.length) cut = i;
      own.push(item.row);
    });
    const shownItems = g.items.slice(0, cut);
    const restItems = g.items.slice(cut);
    const restRows = phaseRevealIds(restItems);
    const overflowKey = `${key}:more`;
    const overflowOpen = isOpen(overflowKey, restRows, false);
    const records = own.reduce((n, r) => n + (recordsCountByTask?.[r.taskId] ?? 0), 0);
    const label = g.label ? `${g.ordinal} · ${g.label}` : unphasedOnly ? 'Tasks' : 'Unphased';
    const headerMeta = [
      g.status === 'finished' ? `✓ ${g.done}/${g.total}` : `${g.done}/${g.total}`,
      g.status === 'finished' && records > 0 ? `${records} record${records === 1 ? '' : 's'}` : null,
    ].filter(Boolean).join(' · ');

    return (
      <div key={key} data-testid="mission-feed-group" data-group="phase" data-phase-index={g.index ?? ''}>
        {!headerless && (
          <button
            type="button"
            data-testid="mission-phase-header"
            data-phase-status={g.status}
            aria-expanded={expanded}
            onClick={() => toggle(key, !expanded)}
            className="flex min-h-11 w-full items-center gap-2 border-t border-border-default px-3 text-left font-mono text-[11px] uppercase tracking-[2px] text-text-muted hover:text-text-primary"
          >
            <span className="font-semibold text-text-secondary">{label}</span>
            <span className="normal-case tracking-normal">{headerMeta}</span>
            <span aria-hidden="true" className="ml-auto text-[12px]">{expanded ? '▾' : '▸'}</span>
          </button>
        )}
        <div hidden={!expanded}>
          {renderItems(shownItems, !expanded)}
          {restRows.length > 0 && (
            <>
              <div data-testid="mission-feed-overflow" hidden={!overflowOpen}>{renderItems(restItems, !expanded || !overflowOpen)}</div>
              <MoreButton
                label={overflowOpen ? 'Show fewer ▴' : `+${restRows.length} queued ▸`}
                expanded={overflowOpen}
                onClick={() => toggle(overflowKey, !overflowOpen)}
              />
            </>
          )}
        </div>
      </div>
    );
  }
}

const EMPTY_SET: ReadonlySet<string> = new Set();
