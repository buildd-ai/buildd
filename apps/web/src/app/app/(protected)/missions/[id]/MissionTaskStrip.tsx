'use client';

/**
 * The mission page's Landed band, interactive: tap any task in the strip and
 * a drawer tethered under that cell shows it — number, state, title, why it
 * is open, its PR — with that task's actions, without leaving the screen.
 *
 * ```
 * LANDED                  1 open · 3 held ›
 * 6 of 10
 * ■ ■ ■ ■ ■ ▨ ▦ ░ ░ ░
 * 01 02 03 04 05 06 07 08 09 10
 *                   ▼  ^
 * ┌─────────────────────────▲──────────┐
 * │ 07 · LEVEL 3 OF 5  BLOCKED  builder │
 * │ feat: …                             │
 * │ After 06 api.                       │
 * │ [Run now]                     Task→ │
 * └─────────────────────────────────────┘
 * [‹]  [ Next open · 06 ]  [›]
 * ```
 *
 * - Order and marks: docs/specs/mission-progress-strip-ordering.md. Cells are
 *   in dependency order; selecting one marks, on the tick row, what holds it
 *   (held) or what it holds (active).
 * - Default selection: the task the situation block is about (when the strip
 *   has it), else the first active cell, else the first held one, else the last.
 * - The selection is a tiny store (`mission-strip-context`): a change
 *   re-renders the strip and this drawer, not the board.
 * - The actions are `TaskActionZone`, the renderer the task sheet and the
 *   task page mount, from the board model already loaded (no fetch on select).
 */
import { isSurfaceAuditTask } from '@buildd/core/surface-audit';
import { memo, useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { formatAge, type BoardTask, type MissionBoardModel } from '@/lib/mission-board';
import { taskPageHref } from '@/lib/mission-task-href';
import { taskActionPhase, type MissionExecutor } from '@/lib/task-actions';
import {
  activeIndices, DENSE_STRIP_CELLS, defaultStripSelection, errorIndices, heldCount, heldIndices, nextOpenIndex,
  slotIndexOf, slotMarks, stepIndex, stripBlockerCount, stripCaretLeft, stripMarks, stripOrdinal, stripSelectionReason,
  stripSlots, stripTick, stripTone, type StripSlot, type StripState, type StripTone,
} from '@/lib/mission-task-strip';
import { useMissionStrip } from '@/components/missions/mission-strip-context';
import {
  LandedMeter, RoleGlyph, SectionLabel, STRIP_DRAWER_ID, TONE_BG, TONE_BORDER, TONE_TEXT, taskSheetHref,
  type BoardLinkContext,
} from './MissionBoardParts';
import TaskActionZone from './TaskActionZone';

/** The situation block's task, handed to the drawer (its reason is the accessor's sentence). */
export interface StripFocus {
  taskId: string;
  reason: string;
}

export interface LandedStripProps {
  model: MissionBoardModel;
  compact: boolean;
  link: BoardLinkContext;
  workspaceId: string;
  executor: MissionExecutor | null;
  focus: StripFocus | null;
  /** The big "9 of 10", drawn by the band. */
  count: ReactNode;
}

const STATUS_PILL: Record<StripState, string> = {
  landed: 'Landed', review: 'In review', running: 'Running', waiting: 'Needs you',
  ci_failed: 'CI failed', fixing: 'Fixing', failed: 'Failed', ready: 'Ready', blocked: 'Blocked', queued: 'Queued',
};

const STEP_BTN = 'inline-flex h-11 items-center justify-center border-[1.5px] border-border-default font-mono text-text-primary hover:bg-surface-3 disabled:opacity-40';

export function LandedStrip({ model, compact, link, workspaceId, executor, focus, count }: LandedStripProps) {
  const strip = useMissionStrip();
  const slots = useMemo(() => stripSlots(model), [model]);
  const subscribe = strip?.store.subscribe ?? noopSubscribe;
  const chosen = useSyncExternalStore(subscribe, () => strip?.store.getSelected() ?? null, () => null);
  const focusNonce = useSyncExternalStore(subscribe, () => strip?.store.getFocusNonce() ?? 0, () => 0);
  const selectedId = chosen && slots.some(s => s.id === chosen) ? chosen : defaultStripSelection(slots, focus?.taskId);
  const select = useCallback((id: string) => strip?.store.select(id), [strip]);
  // Marks depend on the selected task only (SEL-1): the tick row re-renders as one unit.
  const selection = useMemo(() => (selectedId ? stripMarks(model, selectedId) : null), [model, selectedId]);

  const drawerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusNonce === 0 || !drawerRef.current) return;
    drawerRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    drawerRef.current.focus({ preventScroll: true });
  }, [focusNonce]);

  if (!selectedId || !selection) return null;
  const n = slots.length;
  const sel = slots.findIndex(s => s.id === selectedId);
  const slot = slots[sel];
  const at = slotIndexOf(slots);
  const tickOf = (taskId: string) => {
    const i = at.get(taskId) ?? 0;
    const s = slots[i];
    return s.kind === 'fold' ? `+${s.taskIds.length}` : stripTick(i);
  };
  const marks = slotMarks(slots, selection.marks, sel);
  // Next open cycles through active cells only (NX-1); held ones are skipped.
  const active = activeIndices(slots);
  // Failed is its own bucket (TONE-1): "N open" never silently counts a
  // failed cell as open, the same confusion the strip's own fill once had.
  const failed = errorIndices(slots);
  const openOnly = active.length - failed.length;
  const held = heldCount(slots);
  const target = active.length > 0 ? nextOpenIndex(active, sel) : (heldIndices(slots)[0] ?? null);
  const tone = stripTone(slot.state);
  const caret = stripCaretLeft(sel, n);
  const nextOpenLabel = active.length === 0
    ? (held > 0 ? `Nothing open · ${held} held` : 'All tasks landed')
    : target === sel ? `Only open task · ${stripTick(sel)}` : `Next open · ${stripTick(target!)}`;
  const gap = n > DENSE_STRIP_CELLS ? '[--strip-gap:1px]' : `[--strip-gap:4px] ${compact ? '' : 'md:[--strip-gap:6px]'}`;
  const openJumpLabel = [
    openOnly > 0 ? `${openOnly} open` : null,
    failed.length > 0 ? `${failed.length} failed` : null,
    held > 0 ? `${held} held` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div data-testid="landed-strip-band" data-cells={n} className={`flex flex-col gap-1.5 ${gap}`}>
      <div className="flex min-h-11 items-center justify-between">
        <SectionLabel>Landed</SectionLabel>
        {(active.length > 0 || held > 0) && (
          <button
            type="button"
            data-testid="landed-strip-open-jump"
            onClick={() => target != null && select(slots[target].id)}
            className={`-mr-3 inline-flex h-11 items-center px-3 font-mono text-body font-semibold hover:underline ${failed.length > 0 && openOnly === 0 ? TONE_TEXT.error : 'text-accent-text'}`}
          >
            {`${openJumpLabel} ›`}
          </button>
        )}
      </div>
      {count}
      <div className="relative mt-2">
        <LandedMeter model={model} variant="band" compact={compact} selection={{ slots, selectedId, marks, onSelect: select }} />
        {/* The tether: a 2px connector from the selected cell down to the drawer. */}
        <span
          aria-hidden="true"
          data-testid="landed-strip-connector"
          className={`absolute top-[50px] h-9 w-0.5 -ml-px transition-[left] duration-200 motion-reduce:transition-none ${compact ? '' : 'md:top-[62px] md:h-10'} ${TONE_BG[tone]}`}
          style={{ left: caret }}
        />
        {slot.kind === 'fold' ? (
          <FoldDrawer ref={drawerRef} slot={slot} index={sel} tone={tone} caret={caret} link={link} />
        ) : (
          <StripDrawer
            ref={drawerRef}
            task={model.tasks[slot.id]}
            state={slot.state}
            index={sel}
            tone={tone}
            caret={caret}
            compact={compact}
            link={link}
            workspaceId={workspaceId}
            executor={executor}
            reason={focus?.taskId === slot.id ? focus.reason : null}
            selectionReason={stripSelectionReason(model, slot.id, tickOf)}
            now={model.now}
          />
        )}
      </div>
      {/* Phone: ‹ [Next open] ›. Desktop: ‹ › [Next open]. */}
      <div className="mt-2 flex gap-2">
        <button type="button" data-testid="landed-strip-prev" aria-label="Previous task" onClick={() => select(slots[stepIndex(sel, -1, n)].id)} className={`${STEP_BTN} order-1 w-11 text-[18px]`}>‹</button>
        <button
          type="button"
          data-testid="landed-strip-next-open"
          disabled={target == null}
          onClick={() => target != null && select(slots[target].id)}
          className={`${STEP_BTN} order-2 flex-1 text-body font-medium ${compact ? '' : 'md:order-3'}`}
        >
          {nextOpenLabel}
        </button>
        <button type="button" data-testid="landed-strip-next" aria-label="Next task" onClick={() => select(slots[stepIndex(sel, 1, n)].id)} className={`${STEP_BTN} order-3 w-11 text-[18px] ${compact ? '' : 'md:order-2'}`}>›</button>
      </div>
      {!compact && (
        <span className="hidden font-mono text-eyebrow text-text-muted md:block">← → to move between tasks</span>
      )}
    </div>
  );
}

const noopSubscribe = () => () => {};

interface StripDrawerProps {
  task: BoardTask;
  state: StripState;
  index: number;
  tone: StripTone;
  caret: string;
  compact: boolean;
  link: BoardLinkContext;
  workspaceId: string;
  executor: MissionExecutor | null;
  reason: string | null;
  /** What the selection marks, as a sentence (`stripSelectionReason`). */
  selectionReason: string | null;
  now: number;
}

/**
 * Why an unfinished task is open, from the board's own state words (the
 * tile's), unless the situation accessor already said it for this task. A
 * held task's sentence is what holds it (`stripSelectionReason`).
 */
export function stripReason(t: BoardTask, executor: MissionExecutor | null): string | null {
  switch (t.status) {
    case 'merged':
    case 'done':
    case 'blocked':
      return null;
    case 'waiting': return t.waitingFor?.prompt ?? 'Needs input.';
    case 'running': return t.currentAction ?? `Running${t.runner ? ` on ${t.runner}` : ''}.`;
    case 'review': return 'PR open, awaiting merge.';
    case 'ci_failed': return 'CI failed on its PR.';
    case 'fixing': return 'A fix attempt is working on its red PR.';
    case 'failed': return 'The last attempt failed.';
    case 'ready':
      return executor === 'local'
        ? "Waiting for a local session to claim it. Runners never pick up this mission's tasks."
        : 'Ready · next free slot.';
  }
}

const StripDrawer = memo(function StripDrawer({ ref, task: t, state, index, tone, caret, compact, link, workspaceId, executor, reason, selectionReason, now }: StripDrawerProps & { ref: React.Ref<HTMLDivElement> }) {
  const router = useRouter();
  const onChanged = useCallback(() => router.refresh(), [router]);
  const landed = state === 'landed';
  // |blockers(T)|, off-strip included: every one of them is marked or named (SEL-3).
  const blockedByCount = stripBlockerCount(t);
  const { phase, isBlocked } = taskActionPhase({
    taskStatus: t.taskStatus,
    taskMode: t.taskMode,
    workerStatus: t.workerStatus,
    workerWaitingFor: t.waitingFor,
    blockedByCount,
  });
  const why = landed ? null : reason ?? selectionReason ?? stripReason(t, executor);
  const pill = state === 'ready' && executor === 'local' ? 'Needs claim' : STATUS_PILL[state];
  const meta = [
    t.pr ? `PR #${t.pr.number}` : null,
    landed && t.endedAt != null ? `landed ${formatAge(now - t.endedAt)} ago` : null,
    t.id.slice(0, 8),
  ].filter(Boolean).join(' · ');
  const twoCol = compact ? '' : 'md:grid md:grid-cols-[minmax(0,1fr)_fit-content(60%)] md:gap-6';

  return (
    <div
      ref={ref}
      id={STRIP_DRAWER_ID}
      tabIndex={-1}
      data-testid="landed-strip-drawer"
      data-task-ref={t.id}
      data-status={state}
      className={`relative mt-2.5 border-2 bg-surface-1 p-4 outline-none transition-colors duration-200 motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text-primary ${TONE_BORDER[tone]} ${twoCol}`}
    >
      {/* The caret: the drawer's own corner, pointing at the selected cell. */}
      <span
        aria-hidden="true"
        className={`absolute -top-[8px] -ml-[7px] h-3 w-3 rotate-45 border-l-2 border-t-2 bg-surface-1 transition-[left] duration-200 motion-reduce:transition-none ${TONE_BORDER[tone]}`}
        style={{ left: caret }}
      />
      <div aria-live="polite" className="flex min-w-0 flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span data-testid="landed-strip-drawer-ordinal" className="whitespace-nowrap font-mono text-meta font-semibold tabular-nums text-text-primary">{stripOrdinal(t, index)}</span>
          <span data-testid="landed-strip-drawer-status" className={`border px-1.5 py-0.5 font-mono text-chip font-semibold uppercase tracking-[1.4px] ${TONE_BORDER[tone]} ${TONE_TEXT[tone]}`}>{pill}</span>
          {t.roleName && (
            <span className="inline-flex items-center gap-1 border border-border-default px-1.5 py-0.5 font-mono text-chip uppercase tracking-[1.4px] text-text-muted">
              <RoleGlyph task={t} />{t.roleName}
            </span>
          )}
        </div>
        <p className={`font-mono font-semibold leading-snug text-text-primary [overflow-wrap:anywhere] ${compact ? 'text-[15px]' : 'text-[15px] md:text-[18px]'}`}>{t.title}</p>
        {why && <p data-testid="landed-strip-drawer-reason" className="font-mono text-body leading-normal text-text-secondary [overflow-wrap:anywhere]">{why}</p>}
        <p className="font-mono text-meta text-text-muted">{meta}</p>
      </div>
      <div className={`mt-3 flex min-w-0 flex-col gap-2 ${compact ? '' : 'md:mt-0'}`}>
        {!landed && (
          <TaskActionZone
            key={t.id}
            taskId={t.id}
            workspaceId={workspaceId}
            phase={phase}
            isBlocked={isBlocked}
            blockedByCount={blockedByCount}
            backend={t.backend}
            lastError={null}
            failureKind={t.failureKind}
            auditTaskId={t.failureKind === 'verification' && isSurfaceAuditTask(t.title) ? t.id : null}
            worker={t.workerId ? { id: t.workerId, waitingFor: t.waitingFor } : null}
            historyHref={taskPageHref({ taskId: t.id, missionId: link.missionId })}
            roleSlug={t.roleSlug}
            missionExecutor={executor}
            hideQueuedNote={!!why}
            onChanged={onChanged}
          />
        )}
        <div className="flex flex-wrap gap-2">
          {landed && t.pr?.url && (
            <a href={t.pr.url} target="_blank" rel="noopener noreferrer" className="inline-flex h-11 flex-1 items-center justify-center border-[1.5px] border-border-strong px-3.5 font-mono text-body font-semibold text-text-primary hover:bg-surface-3">
              {`PR #${t.pr.number} ↗`}
            </a>
          )}
          <a
            href={taskSheetHref(link, t.id)}
            data-task-id={t.id}
            data-testid="landed-strip-drawer-open"
            className="inline-flex h-11 items-center justify-center border-[1.5px] border-border-strong px-3.5 font-mono text-body font-semibold text-text-primary hover:bg-surface-3"
          >
            Task →
          </a>
        </div>
      </div>
    </div>
  );
});

/**
 * A summary cell's drawer (CAP-3): how many tasks it holds and where to see
 * them. No task actions — it is not one task.
 */
const FoldDrawer = memo(function FoldDrawer({ ref, slot, index, tone, caret, link }: {
  ref: React.Ref<HTMLDivElement>;
  slot: Extract<StripSlot, { kind: 'fold' }>;
  index: number;
  tone: StripTone;
  caret: string;
  link: BoardLinkContext;
}) {
  const k = slot.taskIds.length;
  return (
    <div
      ref={ref}
      id={STRIP_DRAWER_ID}
      tabIndex={-1}
      data-testid="landed-strip-drawer"
      data-status={slot.state}
      className={`relative mt-2.5 flex flex-col gap-2.5 border-2 bg-surface-1 p-4 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text-primary ${TONE_BORDER[tone]}`}
    >
      <span
        aria-hidden="true"
        className={`absolute -top-[8px] -ml-[7px] h-3 w-3 rotate-45 border-l-2 border-t-2 bg-surface-1 ${TONE_BORDER[tone]}`}
        style={{ left: caret }}
      />
      <span className="font-mono text-meta font-semibold tabular-nums text-text-primary">{stripTick(index)}</span>
      <p className="font-mono text-[15px] font-semibold text-text-primary">
        {`${k} ${slot.state === 'landed' ? 'landed' : 'queued'} tasks`}
      </p>
      <a
        href={`/app/missions/${link.missionId}?view=timeline`}
        className="inline-flex h-11 items-center justify-center self-start border-[1.5px] border-border-strong px-3.5 font-mono text-body font-semibold text-text-primary hover:bg-surface-3"
      >
        See them on the Timeline →
      </a>
    </div>
  );
});
