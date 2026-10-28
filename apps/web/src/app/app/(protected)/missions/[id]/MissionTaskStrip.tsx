'use client';

/**
 * The mission Board's Landed band: one cell per task in dependency order.
 * Tapping a cell opens that task's page, the only task view (spec d25d923d
 * R-1); a summary cell opens the mission's History.
 *
 * ```
 * MERGED                       1 open · 3 waiting ›
 * 6 of 10
 * ■ ■ ■ ■ ■ ▨ ▦ ░ ░ ░
 * 01 02 03 04 05 06 07 08 09 10
 * ```
 *
 * - Order and marks: docs/specs/mission-progress-strip-ordering.md. Cells are
 *   in dependency order; the selected cell (arrow keys move it) marks, on the
 *   tick row, what holds it (held) or what it holds (active).
 * - Default selection: the task the situation block is about (when the strip
 *   has it), else the first active cell, else the first held one, else the last.
 * - The selection is a tiny store (`mission-strip-context`): a change
 *   re-renders the strip, not the board.
 * - The header's `N open ›` is a link to the next open task's page.
 */
import Link from 'next/link';
import { TERMS } from '@buildd/shared';
import { STATES } from '@/components/ui/states';
import { useCallback, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { BoardTask, MissionBoardModel } from '@/lib/mission-board';
import type { MissionExecutor } from '@/lib/task-actions';
import {
  DENSE_STRIP_CELLS, defaultStripSelection, errorIndices, heldIndices, nextOpenIndex, openIndices,
  slotMarks, stripMarks, stripCountsLabel, stripSlotCounts, stripSlots, type StripState,
} from '@/lib/mission-task-strip';
import { useMissionStrip } from '@/components/missions/mission-strip-context';
import { LandedMeter, SectionLabel, TONE_TEXT, boardTaskHref, type BoardLinkContext } from './MissionBoardParts';

/** The situation block's task, handed to the drawer (its reason is the accessor's sentence). */
export interface StripFocus {
  taskId: string;
  reason: string;
}

export interface LandedStripProps {
  model: MissionBoardModel;
  compact: boolean;
  link: BoardLinkContext;
  focus: StripFocus | null;
  /** The big "9 of 10", drawn by the band. */
  count: ReactNode;
}

// The strip state's own word comes from the shared state table.
const STATUS_PILL = (state: StripState): string => STATES[state].word;

/**
 * The drawer's status pill: a kernel-owned delivery's canonical label (the
 * words Home, the task list and chat say), else the strip state's own word.
 */
export function stripDrawerPill(t: Pick<BoardTask, 'delivery'>, state: StripState, executor: MissionExecutor | null): string {
  if (t.delivery) return t.delivery.label;
  return state === 'ready' && executor === 'local' ? 'Needs claim' : STATUS_PILL(state);
}

export function LandedStrip({ model, compact, link, focus, count }: LandedStripProps) {
  const router = useRouter();
  const strip = useMissionStrip();
  const slots = useMemo(() => stripSlots(model), [model]);
  const subscribe = strip?.store.subscribe ?? noopSubscribe;
  const chosen = useSyncExternalStore(subscribe, () => strip?.store.getSelected() ?? null, () => null);
  const selectedId = chosen && slots.some(s => s.id === chosen) ? chosen : defaultStripSelection(slots, focus?.taskId);
  const select = useCallback((id: string) => strip?.store.select(id), [strip]);
  // A tap opens the task's page; a summary cell (several tasks) opens History.
  const open = useCallback((id: string) => {
    const slot = slots.find(s => s.id === id);
    if (!slot) return;
    router.push(slot.kind === 'fold'
      ? `/app/missions/${encodeURIComponent(link.missionId)}?layout=feed`
      : boardTaskHref(link, id));
  }, [router, slots, link]);
  // Marks depend on the selected task only (strip R-11): the tick row re-renders as one unit.
  const selection = useMemo(() => (selectedId ? stripMarks(model, selectedId) : null), [model, selectedId]);

  if (!selectedId || !selection) return null;
  const n = slots.length;
  const sel = slots.findIndex(s => s.id === selectedId);
  const marks = slotMarks(slots, selection.marks, sel);
  // The header link goes to the next open task (strip R-32, R-33): held and
  // failed cells are skipped, a failed one only when nothing is open.
  const openAt = openIndices(slots);
  const failedAt = errorIndices(slots);
  const counts = stripSlotCounts(slots);
  const target = openAt.length > 0 ? nextOpenIndex(openAt, sel) : (failedAt[0] ?? heldIndices(slots)[0] ?? null);
  const targetSlot = target != null ? slots[target] : null;
  const gap = n > DENSE_STRIP_CELLS ? '[--strip-gap:1px]' : `[--strip-gap:4px] ${compact ? '' : 'md:[--strip-gap:6px]'}`;

  return (
    <div data-testid="landed-strip-band" data-cells={n} className={`flex flex-col gap-1.5 ${gap}`}>
      <div className="flex min-h-11 items-center justify-between">
        <SectionLabel>{TERMS['pr.merged'].word}</SectionLabel>
        {targetSlot && targetSlot.kind !== 'fold' && (
          <Link
            href={boardTaskHref(link, targetSlot.id)}
            data-testid="landed-strip-open-jump"
            className={`-mr-3 inline-flex h-11 items-center px-3 font-mono text-body font-semibold hover:underline ${counts.failed > 0 && counts.open + counts.active === 0 ? TONE_TEXT.error : 'text-accent-text'}`}
          >
            {`${stripCountsLabel(counts)} ›`}
          </Link>
        )}
      </div>
      {count}
      <div className="mt-2">
        <LandedMeter model={model} variant="band" compact={compact} selection={{ slots, selectedId, marks, onSelect: select, onOpen: open }} />
      </div>
    </div>
  );
}

const noopSubscribe = () => () => {};

/**
 * Why an unfinished task is open, from the board's own state words (the
 * tile's), unless the situation accessor already said it for this task. A
 * held task's sentence is what holds it (`stripSelectionReason`).
 */
export function stripReason(t: BoardTask, executor: MissionExecutor | null): string | null {
  // A kernel-owned delivery says where it stands in its own words (§17.5).
  if (t.kernelReason && t.status !== 'merged' && t.status !== 'done' && t.status !== 'blocked') return t.kernelReason;
  switch (t.status) {
    case 'merged':
    case 'done':
    case 'blocked':
      return null;
    case 'waiting': return t.waitingFor?.prompt ?? 'Has a question.';
    case 'running':
      // Work status and execution are separate axes: started, but no live worker, is interrupted.
      if (t.executing === false) return 'Started, but no agent is running it now.';
      return t.currentAction ?? `In progress${t.runner ? ` on ${t.runner}` : ''}.`;
    case 'review': return 'PR open, awaiting merge.';
    case 'ci_failed': return 'CI failed on its PR.';
    case 'fixing': return 'A fix attempt is working on its red PR.';
    case 'failed': return 'The last attempt failed.';
    case 'ready':
      return executor === 'local'
        ? 'Ready to start. Claim it from your session.'
        : 'Next in line for a runner.';
  }
}
