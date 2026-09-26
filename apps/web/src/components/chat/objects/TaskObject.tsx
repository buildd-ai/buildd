'use client';

/**
 * A task as an object in the feed: a Board-style tile inline, and the task
 * page's Now strip in the pane while an agent is live on it.
 */
import Link from 'next/link';
import { taskPageHref } from '@/lib/mission-task-href';
import { formatAge } from '@/lib/mission-board';
import NowStrip from '@/app/app/(protected)/tasks/[id]/NowStrip';
import { RunnerAvatar, ScopeChip, useNow } from '@/app/app/(protected)/missions/[id]/MissionBoardParts';
import type { BuilddObjectRef } from '../chat-contract';
import { useChatActions } from '../ChatActions';
import type { TaskObjectView } from './object-views';
import { Eyebrow, OpenButton, StateChip, type Tone } from './parts';

/** The tile's words for where a task is: the worker's state wins over the task row's. */
export function taskState(view: TaskObjectView): { label: string; tone: Tone; live: boolean } {
  const w = view.worker;
  if (w?.waiting) return { label: 'waiting on you', tone: 'attention', live: false };
  if (w?.mergedAt) return { label: `#${w.prNumber} merged`, tone: 'ok', live: false };
  if (w?.prLifecycleStatus === 'ci_failed') return { label: `#${w.prNumber} CI failed`, tone: 'bad', live: false };
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
      className={`relative border-2 bg-card pl-5 pr-4 py-3 before:absolute before:inset-y-0 before:left-0 before:w-[5px] ${EDGE[st.tone]} ${inPane ? 'border-accent shadow-[var(--accent-shadow)]' : 'border-border-strong'}`}
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
      <Eyebrow className="text-text-muted">{view.missionTitle ? `Task · ${view.missionTitle}` : 'Task'}</Eyebrow>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <ScopeChip scope={view.scope} />
        <h2 className="min-w-0 font-mono text-[20px] font-semibold text-text-primary [overflow-wrap:anywhere]">{view.label}</h2>
        <StateChip label={st.label} tone={st.tone} pulse={st.live} />
      </div>
      <p className="mt-1 font-mono text-[12.5px] text-text-muted [overflow-wrap:anywhere]">{view.title}</p>
      <div className="mt-5">
        {view.now && st.live ? (
          <NowStrip now={view.now} nowMs={nowMs} />
        ) : (
          <div className="border-2 border-border-default bg-surface-2 px-4 py-3 font-mono text-[12.5px] text-text-secondary">
            {view.worker?.prUrl
              ? <a href={view.worker.prUrl} target="_blank" rel="noreferrer" className="text-accent-text hover:underline">{`PR #${view.worker.prNumber} ↗`}</a>
              : 'No agent is on this task right now.'}
          </div>
        )}
      </div>
      <Link href={href} className="mt-5 inline-flex min-h-10 items-center border-2 border-border-strong bg-surface-3 px-4 font-mono text-[13px] font-semibold text-text-primary hover:bg-surface-4">
        Open task →
      </Link>
    </div>
  );
}
