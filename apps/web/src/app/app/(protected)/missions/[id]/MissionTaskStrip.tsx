'use client';

/**
 * The mission page's Landed band, interactive: tap any task in the strip and
 * a drawer tethered under that cell shows it — number, state, title, why it
 * is open, its PR — with that task's actions, without leaving the screen.
 *
 * ```
 * LANDED                       1 open ›
 * 9 of 10
 * ■ ■ ■ ■ ■ ■ ■ ■ ▨ ■
 * 01 02 03 04 05 06 07 08 09 10
 *                         │
 * ┌──────────────────────▲─────────────┐
 * │ 09 / 10  NEEDS CLAIM  builder       │
 * │ feat: …                             │
 * │ Waiting for a local session …       │
 * │ [Copy claim command] [Run now] Task→│
 * └─────────────────────────────────────┘
 * [‹]  [ Only open task · 09 ]  [›]
 * ```
 *
 * - Default selection: the task the situation block is about (when the strip
 *   has it), else the first unfinished task, else the last.
 * - The selection is a tiny store (`mission-strip-context`): a change
 *   re-renders the strip and this drawer, not the board.
 * - The actions are `TaskActionZone`, the renderer the task sheet and the
 *   task page mount, from the board model already loaded (no fetch on select).
 */
import { memo, useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { BOARD_LANDED, formatAge, type BoardStatus, type BoardTask, type MissionBoardModel } from '@/lib/mission-board';
import { taskPageHref } from '@/lib/mission-task-href';
import { taskActionPhase, type MissionExecutor } from '@/lib/task-actions';
import {
  defaultStripSelection, nextOpenIndex, openIndices, stepIndex, stripCaretLeft, stripOrder, stripTick,
} from '@/lib/mission-task-strip';
import { useMissionStrip } from '@/components/missions/mission-strip-context';
import {
  LandedMeter, RoleGlyph, SectionLabel, STRIP_DRAWER_ID, stripTone, taskSheetHref,
  type BoardLinkContext, type StripTone,
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

const STATUS_PILL: Record<BoardStatus, string> = {
  merged: 'Landed', done: 'Landed', review: 'In review', running: 'Running', waiting: 'Needs you',
  ci_failed: 'CI failed', fixing: 'Fixing', failed: 'Failed', ready: 'Queued', blocked: 'Blocked',
};

const TONE_BORDER: Record<StripTone, string> = {
  ok: 'border-status-success',
  error: 'border-status-error',
  open: 'border-accent',
};
const TONE_BG: Record<StripTone, string> = {
  ok: 'bg-status-success',
  error: 'bg-status-error',
  open: 'bg-accent',
};
const TONE_TEXT: Record<StripTone, string> = {
  ok: 'text-status-success',
  error: 'text-status-error',
  open: 'text-accent-text',
};

const STEP_BTN = 'inline-flex h-11 items-center justify-center border-[1.5px] border-border-default font-mono text-text-primary hover:bg-surface-3 disabled:opacity-40';

export function LandedStrip({ model, compact, link, workspaceId, executor, focus, count }: LandedStripProps) {
  const strip = useMissionStrip();
  const order = useMemo(() => stripOrder(model), [model]);
  const statusOf = useCallback((id: string) => model.tasks[id]?.status, [model]);
  const subscribe = strip?.store.subscribe ?? noopSubscribe;
  const chosen = useSyncExternalStore(subscribe, () => strip?.store.getSelected() ?? null, () => null);
  const focusNonce = useSyncExternalStore(subscribe, () => strip?.store.getFocusNonce() ?? 0, () => 0);
  const selectedId = chosen && order.includes(chosen) ? chosen : defaultStripSelection(order, statusOf, focus?.taskId);
  const select = useCallback((id: string) => strip?.store.select(id), [strip]);

  const drawerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusNonce === 0 || !drawerRef.current) return;
    drawerRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    drawerRef.current.focus({ preventScroll: true });
  }, [focusNonce]);

  if (!selectedId) return null;
  const n = order.length;
  const sel = order.indexOf(selectedId);
  const task = model.tasks[selectedId];
  const open = openIndices(order, statusOf);
  const target = nextOpenIndex(open, sel);
  const tone = stripTone(task.status);
  const caret = stripCaretLeft(sel, n);
  const nextOpenLabel = target == null
    ? 'All tasks landed'
    : target === sel ? `Only open task · ${stripTick(sel)}` : `Next open · ${stripTick(target)}`;

  return (
    <div data-testid="landed-strip-band" className={`flex flex-col gap-1.5 [--strip-gap:4px] ${compact ? '' : 'md:[--strip-gap:6px]'}`}>
      <div className="flex min-h-11 items-center justify-between">
        <SectionLabel>Landed</SectionLabel>
        {open.length > 0 && (
          <button
            type="button"
            data-testid="landed-strip-open-jump"
            onClick={() => target != null && select(order[target])}
            className="-mr-3 inline-flex h-11 items-center px-3 font-mono text-body font-semibold text-accent-text hover:underline"
          >
            {`${open.length} open ›`}
          </button>
        )}
      </div>
      {count}
      <div className="relative mt-2">
        <LandedMeter model={model} variant="band" compact={compact} selection={{ selectedId, onSelect: select }} />
        {/* The tether: a 2px connector from the selected cell down to the drawer. */}
        <span
          aria-hidden="true"
          data-testid="landed-strip-connector"
          className={`absolute top-[50px] h-9 w-0.5 -ml-px transition-[left] duration-200 motion-reduce:transition-none ${compact ? '' : 'md:top-[62px] md:h-10'} ${TONE_BG[tone]}`}
          style={{ left: caret }}
        />
        <StripDrawer
          ref={drawerRef}
          task={task}
          index={sel}
          n={n}
          tone={tone}
          caret={caret}
          compact={compact}
          link={link}
          workspaceId={workspaceId}
          executor={executor}
          reason={focus?.taskId === task.id ? focus.reason : null}
          now={model.now}
        />
      </div>
      {/* Phone: ‹ [Next open] ›. Desktop: ‹ › [Next open]. */}
      <div className="mt-2 flex gap-2">
        <button type="button" data-testid="landed-strip-prev" aria-label="Previous task" onClick={() => select(order[stepIndex(sel, -1, n)])} className={`${STEP_BTN} order-1 w-11 text-[18px]`}>‹</button>
        <button
          type="button"
          data-testid="landed-strip-next-open"
          disabled={target == null}
          onClick={() => target != null && select(order[target])}
          className={`${STEP_BTN} order-2 flex-1 text-body font-medium ${compact ? '' : 'md:order-3'}`}
        >
          {nextOpenLabel}
        </button>
        <button type="button" data-testid="landed-strip-next" aria-label="Next task" onClick={() => select(order[stepIndex(sel, 1, n)])} className={`${STEP_BTN} order-3 w-11 text-[18px] ${compact ? '' : 'md:order-2'}`}>›</button>
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
  index: number;
  n: number;
  tone: StripTone;
  caret: string;
  compact: boolean;
  link: BoardLinkContext;
  workspaceId: string;
  executor: MissionExecutor | null;
  reason: string | null;
  now: number;
}

/**
 * Why an unfinished task is open, from the board's own state words (the
 * tile's), unless the situation accessor already said it for this task.
 */
export function stripReason(t: BoardTask, executor: MissionExecutor | null): string | null {
  switch (t.status) {
    case 'merged':
    case 'done':
      return null;
    case 'waiting': return t.waitingFor?.prompt ?? 'Waiting on you.';
    case 'running': return t.currentAction ?? `Running${t.runner ? ` on ${t.runner}` : ''}.`;
    case 'review': return 'PR open, awaiting merge.';
    case 'ci_failed': return 'CI failed on its PR.';
    case 'fixing': return 'A fix attempt is working on its red PR.';
    case 'failed': return 'The last attempt failed.';
    case 'ready':
      return executor === 'local'
        ? "Waiting for a local session to claim it. Runners never pick up this mission's tasks."
        : 'Ready · next free slot.';
    case 'blocked': {
      const holding = t.deps.filter(d => !d.ok).map(d => d.scope ?? d.label);
      return holding.length ? `After ${holding.join(', ')}.` : 'Waiting on its dependencies.';
    }
  }
}

const StripDrawer = memo(function StripDrawer({ ref, task: t, index, n, tone, caret, compact, link, workspaceId, executor, reason, now }: StripDrawerProps & { ref: React.Ref<HTMLDivElement> }) {
  const router = useRouter();
  const onChanged = useCallback(() => router.refresh(), [router]);
  const landed = BOARD_LANDED.has(t.status);
  const { phase, isBlocked } = taskActionPhase({
    taskStatus: t.taskStatus,
    taskMode: t.taskMode,
    workerStatus: t.workerStatus,
    workerWaitingFor: t.waitingFor,
    blockedByCount: t.deps.filter(d => !d.ok).length,
  });
  const why = landed ? null : reason ?? stripReason(t, executor);
  const pill = t.status === 'ready' && executor === 'local' ? 'Needs claim' : STATUS_PILL[t.status];
  const meta = [
    t.pr ? `PR #${t.pr.number}` : null,
    landed && t.endedAt != null ? `landed ${formatAge(now - t.endedAt)} ago` : null,
    t.id.slice(0, 8),
  ].filter(Boolean).join(' · ');
  const twoCol = compact ? '' : 'md:grid md:grid-cols-[minmax(0,1fr)_minmax(200px,auto)] md:gap-6';

  return (
    <div
      ref={ref}
      id={STRIP_DRAWER_ID}
      tabIndex={-1}
      data-testid="landed-strip-drawer"
      data-task-ref={t.id}
      data-status={t.status}
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
          <span className="font-mono text-meta font-semibold tabular-nums text-text-primary">{`${stripTick(index)} / ${n}`}</span>
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
            blockedByCount={t.deps.filter(d => !d.ok).length}
            backend={t.backend}
            lastError={null}
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
