'use client';

/**
 * A task as an object in the feed: a Board-style tile inline, and the task
 * page's Now strip in the pane while an agent is live on it.
 */
import Link from 'next/link';
import { taskPageHref } from '@/lib/mission-task-href';
import { formatAge } from '@/lib/mission-board';
import { derivePrDisplayState } from '@/lib/pr-presentation';
import { deliveryReading, type DeliveryDisplay, type DeliveryReadingInput, type DeliveryTone } from '@/lib/workflow/delivery-display';
import NowStrip from '@/app/app/(protected)/tasks/[id]/NowStrip';
import { RunnerAvatar, ScopeChip, useNow } from '@/app/app/(protected)/missions/[id]/MissionBoardParts';
import type { BuilddObjectRef } from '../chat-contract';
import { useChatActions } from '../ChatActions';
import type { TaskObjectView } from './object-views';
import FocusCard from '@/components/ui/FocusCard';
import { OpenButton, StateChip, toneState, type Tone } from './parts';

/**
 * A kernel-owned delivery's words for the tile (§17.5). Null for `working`:
 * the owner's own attempt is the reading.
 */
export function taskStateForDelivery(d: DeliveryReadingInput & Pick<DeliveryDisplay, 'prNumber'>): { label: string; tone: Tone; live: boolean } | null {
  const r = deliveryReading(d);
  if (!r) return null;
  const pr = d.prNumber != null ? `#${d.prNumber} ` : '';
  return { label: `${pr}${r.label}`, tone: TILE_TONE_FOR_DELIVERY[r.tone], live: false };
}

/** The tile's palette per canonical delivery tone (`deliveryReading`). */
const TILE_TONE_FOR_DELIVERY: Record<DeliveryTone, Tone> = {
  needs: 'attention', live: 'live', stalled: 'neutral', landed: 'ok', closed: 'idle', failed: 'bad',
};

/** The tile's words for where a task is: the worker's state wins over the task row's. */
export function taskState(view: TaskObjectView): { label: string; tone: Tone; live: boolean } {
  const w = view.worker;
  if (w?.waiting) return { label: 'needs input', tone: 'attention', live: false };
  const kernel = view.delivery ? taskStateForDelivery(view.delivery) : null;
  if (kernel) return kernel;
  // Legacy-owned: the one fact-cache mapping.
  const pr = w?.prNumber ? derivePrDisplayState(w.prLifecycleStatus, w.mergedAt) : null;
  if (pr === 'merged') return { label: `#${w!.prNumber} merged`, tone: 'ok', live: false };
  if (pr === 'ci_failed') return { label: `#${w!.prNumber} CI failed`, tone: 'bad', live: false };
  if (w && ['running', 'starting', 'idle'].includes(w.status)) return { label: 'running', tone: 'live', live: true };
  if (w?.prNumber && view.status !== 'completed') return { label: `#${w.prNumber} in review`, tone: 'ok', live: false };
  switch (view.status) {
    case 'completed': return { label: 'done', tone: 'ok', live: false };
    case 'failed': return { label: 'failed', tone: 'bad', live: false };
    case 'blocked': return { label: 'queued', tone: 'idle', live: false };
    case 'pending': return { label: 'queued', tone: 'idle', live: false };
    default: return { label: view.status.replace(/_/g, ' '), tone: 'idle', live: false };
  }
}

const EDGE: Record<Tone, string> = {
  live: 'before:bg-accent',
  neutral: 'before:bg-text-primary',
  attention: 'before:bg-status-warning',
  ok: 'before:bg-status-success',
  bad: 'before:bg-status-error',
  idle: 'before:bg-border-default',
};

export function TaskCard({ objRef, view }: { objRef: BuilddObjectRef; view: TaskObjectView }) {
  const actions = useChatActions();
  const inPane = actions.paneRef?.kind === 'task' && actions.paneRef.id === objRef.id;
  const st = taskState(view);
  const now = useNow(view.renderedAt, 30_000, st.live);
  const w = view.worker;
  const since = w?.startedAt ? formatAge(now - w.startedAt) : null;
  return (
    <article
      data-testid="object-card"
      data-kind="task"
      data-in-pane={inPane ? 'true' : undefined}
      className={`relative overflow-hidden rounded-[var(--radius-card)] border bg-card pl-5 pr-4 py-3 before:absolute before:inset-y-0 before:left-0 before:w-[3px] ${EDGE[st.tone]} ${inPane ? 'border-text-primary' : 'border-border-default'}`}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <ScopeChip scope={view.scope} />
        <span className="min-w-0 truncate font-mono text-[14px] font-semibold text-text-primary">{view.label}</span>
        <RunnerAvatar runner={w?.runner ?? null} className="ml-auto" />
      </div>
      <div className="mt-1.5 flex min-w-0 items-center gap-2 font-mono text-[12px] text-text-muted">
        <StateChip label={st.label} tone={st.tone} pulse={st.live} />
        {view.roleName && <span className="truncate">{view.roleName}</span>}
        {w?.currentAction && st.live && <span className="hidden min-w-0 truncate md:inline">{`· ${w.currentAction}`}</span>}
        {since && <span className="ml-auto shrink-0 tabular-nums" suppressHydrationWarning>{since}</span>}
      </div>
      <div className="mt-1 flex items-center justify-between gap-3">
        {view.missionTitle
          ? <span className="min-w-0 truncate font-mono text-[11.5px] text-text-muted">{`in ${view.missionTitle}`}</span>
          : <span />}
        <OpenButton inPane={inPane} onOpen={() => actions.openObject(objRef)} />
      </div>
    </article>
  );
}

export function TaskPane({ view, variant = 'pane' }: { view: TaskObjectView; variant?: 'pane' | 'sheet' }) {
  const st = taskState(view);
  const nowMs = useNow(view.renderedAt, 1_000, st.live);
  const href = taskPageHref({ taskId: view.id, missionId: view.missionId });
  return (
    <div data-testid="object-pane" data-kind="task" className={variant === 'pane' ? 'px-6 pb-10 pt-5' : 'pb-6'}>
      <FocusCard
        focused={false}
        meta={<>{view.missionTitle ? `Task · ${view.missionTitle}` : 'Task'} · <ScopeChip scope={view.scope} /></>}
        title={<>{view.label} <StateChip label={st.label} tone={st.tone} pulse={st.live} /></>}
        state={toneState(st.tone)}
        next={view.title}
        footer={
          <Link href={href} className="inline-flex min-h-10 items-center self-start rounded-[var(--radius-card)] border border-border-strong bg-surface-3 px-4 font-mono text-[13px] font-semibold text-text-primary hover:bg-surface-4">
            Open task →
          </Link>
        }
      >
        {view.now && st.live ? (
          <NowStrip now={view.now} nowMs={nowMs} />
        ) : (
          <div className="rounded-[var(--radius-card)] border border-border-default bg-surface-2 px-4 py-3 font-mono text-[12.5px] text-text-secondary">
            {view.worker?.prUrl
              ? <a href={view.worker.prUrl} target="_blank" rel="noreferrer" className="text-accent-text hover:underline">{`PR #${view.worker.prNumber} ↗`}</a>
              : 'No agent is on this task right now.'}
          </div>
        )}
      </FocusCard>
    </div>
  );
}
