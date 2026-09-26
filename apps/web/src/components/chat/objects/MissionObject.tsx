'use client';

/**
 * The mission as an object in the feed. The inline card and the docked pane
 * are the mission board's own components (LandedMeter, MissionBoard,
 * MissionLanes) over the same model the mission page builds, live over the
 * mission's Pusher channels.
 */
import Link from 'next/link';
import { useState } from 'react';
import type { BoardStatus, BoardTask, MissionBoardModel } from '@/lib/mission-board';
import MissionBoard from '@/app/app/(protected)/missions/[id]/MissionBoard';
import MissionLanes from '@/app/app/(protected)/missions/[id]/MissionLanes';
import { LandedMeter, RoleGlyph, ScopeChip } from '@/app/app/(protected)/missions/[id]/MissionBoardParts';
import { MissionLiveContext } from '@/app/app/(protected)/missions/[id]/MissionLiveStore';
import type { BuilddObjectRef } from '../chat-contract';
import { useChatActions } from '../ChatActions';
import { useObjectStore } from './ObjectStoreProvider';
import type { MissionObjectView } from './object-views';
import { Eyebrow, OpenButton, StateChip, missionTone } from './parts';

const STATUS_TEXT: Record<BoardStatus, { text: string; cls: string }> = {
  waiting: { text: 'needs you', cls: 'text-status-warning' },
  running: { text: 'running', cls: 'text-accent-text' },
  review: { text: 'in review', cls: 'text-status-success' },
  ci_failed: { text: 'CI failed', cls: 'text-status-error' },
  fixing: { text: 'fixing', cls: 'text-status-error' },
  failed: { text: 'failed', cls: 'text-status-error' },
  ready: { text: 'queued', cls: 'text-text-muted' },
  blocked: { text: 'queued', cls: 'text-text-muted' },
  merged: { text: 'merged', cls: 'text-status-success' },
  done: { text: 'done', cls: 'text-status-success' },
};
const ROW_ORDER: Record<BoardStatus, number> = {
  waiting: 0, ci_failed: 1, fixing: 1, failed: 1, running: 2, review: 3, ready: 4, blocked: 5, merged: 6, done: 6,
};

/** The rows the inline card lists: what needs you first, then live work, then the rest. */
export function missionCardRows(model: MissionBoardModel, max = 6): { rows: BoardTask[]; more: number } {
  const order = model.phases.flatMap(p => p.taskIds);
  const all = order.map(id => model.tasks[id]).filter(Boolean);
  const sorted = [...all].sort((a, b) => ROW_ORDER[a.status] - ROW_ORDER[b.status] || order.indexOf(a.id) - order.indexOf(b.id));
  return { rows: sorted.slice(0, max), more: Math.max(0, sorted.length - max) };
}

/** "3 of 12 landed · 4 running · 1 needs you" */
export function missionCountsLine(model: MissionBoardModel): string {
  const running = Object.values(model.tasks).filter(t => t.status === 'running').length;
  const bits = [`${model.landed.done} of ${model.landed.total} landed`];
  if (model.planning && model.landed.total === 0) bits[0] = 'planning';
  if (running > 0) bits.push(`${running} running`);
  if (model.needsYou.length > 0) bits.push(`${model.needsYou.length} need${model.needsYou.length === 1 ? 's' : ''} you`);
  return bits.join(' · ');
}

function TaskRow({ t }: { t: BoardTask }) {
  const st = STATUS_TEXT[t.status];
  const meta = t.status === 'blocked' && t.deps.find(d => !d.ok) ? `waits on ${t.deps.find(d => !d.ok)!.label}` : t.runner;
  return (
    <li data-testid="mission-card-row" data-status={t.status} className="flex min-h-9 min-w-0 items-center gap-2.5 border-t border-border-default font-mono text-[12.5px]">
      <RoleGlyph task={t} />
      <ScopeChip scope={t.scope} />
      <span className="min-w-0 truncate font-semibold text-text-primary">{t.label}</span>
      {meta && <span className="hidden min-w-0 truncate text-text-muted sm:inline">{`· ${meta}`}</span>}
      <span className={`ml-auto shrink-0 text-[11px] font-bold uppercase tracking-[1.2px] ${st.cls}`}>
        {t.status === 'running' && <span aria-hidden="true" className="mr-1.5 inline-block h-1.5 w-1.5 animate-status-pulse bg-current align-middle" />}
        {t.pr && (t.status === 'merged' || t.status === 'review') ? `#${t.pr.number} ${st.text}` : st.text}
      </span>
    </li>
  );
}

export function MissionCard({ objRef, view }: { objRef: BuilddObjectRef; view: MissionObjectView }) {
  const actions = useChatActions();
  const store = useObjectStore();
  const inPane = actions.paneRef?.kind === 'mission' && actions.paneRef.id === objRef.id;
  const model = view.board;
  const tone = missionTone(view.stateLabel, view.status);
  const { rows, more } = missionCardRows(model);
  const counts = missionCountsLine(model);
  const open = () => actions.openObject(objRef);

  const compact = (
    <div className={`flex min-w-0 flex-col gap-2 px-4 py-3 ${inPane ? '' : 'md:hidden'}`}>
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[14.5px] font-semibold text-text-primary">{view.title}</div>
          <div className="mt-0.5 truncate font-mono text-[12px] text-text-muted">{`mission · ${counts}`}</div>
        </div>
        <OpenButton inPane={inPane} onOpen={open} />
      </div>
      {model.landed.total > 0 && <LandedMeter model={model} variant="strip" />}
    </div>
  );

  return (
    <MissionLiveContext.Provider value={store.live(objRef)}>
      <article
        data-testid="object-card"
        data-kind="mission"
        data-in-pane={inPane ? 'true' : undefined}
        className={`border-2 bg-card ${inPane ? 'border-accent shadow-[var(--accent-shadow)]' : 'border-border-strong shadow-[var(--card-shadow)]'}`}
      >
        {compact}
        {!inPane && (
          <div className="hidden md:block">
            <header className="flex items-center gap-3 border-b border-border-default px-5 py-3">
              <Eyebrow className="text-accent-text">Mission</Eyebrow>
              <StateChip label={view.stateLabel} tone={tone} pulse={tone === 'live'} />
              {view.workspaceName && <span className="ml-auto font-mono text-[12px] text-text-muted">{view.workspaceName}</span>}
            </header>
            <div className="px-5 pb-3 pt-4">
              <h3 className="font-mono text-[19px] font-semibold text-text-primary [overflow-wrap:anywhere]">{view.title}</h3>
              {view.goal && <p className="mt-1 font-[family-name:var(--font-outfit)] text-[15px] leading-relaxed text-text-secondary">{view.goal}</p>}
              {model.landed.total > 0 && <div className="mt-4"><LandedMeter model={model} variant="band" /></div>}
              <div className="mt-2 flex items-center justify-between font-mono text-[12px] text-text-muted">
                <span>{counts}</span>
                {view.conversationId && <span>via chat</span>}
              </div>
              {rows.length > 0 && (
                <ul className="mt-3">
                  {rows.map(t => <TaskRow key={t.id} t={t} />)}
                </ul>
              )}
              {model.planning && rows.length === 0 && (
                <p className="mt-3 border-t border-border-default pt-3 font-mono text-[12.5px] text-text-secondary">
                  {`${model.planning.roleName} is planning${model.planning.currentAction ? ` · ${model.planning.currentAction}` : '…'}`}
                </p>
              )}
              {more > 0 && <p className="border-t border-border-default pt-2 font-mono text-[12px] text-text-muted">{`+${more} more`}</p>}
            </div>
            <footer className="flex flex-wrap items-center gap-2.5 border-t border-border-default bg-surface-2 px-5 py-3">
              <span className="mr-auto font-mono text-[11.5px] text-text-muted">Updates live. The same object as the mission board.</span>
              <OpenButton inPane={false} onOpen={open} />
              <Link
                href={`/app/missions/${view.id}`}
                className="inline-flex min-h-10 items-center border-2 border-border-strong bg-surface-3 px-4 font-mono text-[13px] font-semibold text-text-primary hover:bg-surface-4"
              >
                Open mission
              </Link>
            </footer>
          </div>
        )}
      </article>
    </MissionLiveContext.Provider>
  );
}

/** The docked pane / phone sheet: the mission board itself. */
export function MissionPane({ objRef, view, variant = 'pane' }: { objRef: BuilddObjectRef; view: MissionObjectView; variant?: 'pane' | 'sheet' }) {
  const store = useObjectStore();
  const [layout, setLayout] = useState<'board' | 'lanes'>('board');
  const tone = missionTone(view.stateLabel, view.status);
  const link = { missionId: view.id, from: null, initiativeId: null };
  return (
    <MissionLiveContext.Provider value={store.live(objRef)}>
      <div data-testid="object-pane" data-kind="mission" className={variant === 'pane' ? 'px-6 pb-10 pt-5' : 'pb-6'}>
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {variant === 'pane' && (
            <Link href="/app/missions" className="font-mono text-[13px] text-text-muted hover:text-text-primary">‹ Missions</Link>
          )}
          <h2 className="min-w-0 truncate font-mono text-[20px] font-semibold text-text-primary md:text-[22px]">
            <Link href={`/app/missions/${view.id}`} className="hover:underline">{view.title}</Link>
          </h2>
          <StateChip label={view.stateLabel} tone={tone} pulse={tone === 'live'} />
          <span className="flex-1" />
          {variant === 'pane' && (
            <div role="tablist" aria-label="Mission layout" className="flex shrink-0 border-[1.5px] border-border-strong">
              {(['board', 'lanes'] as const).map(l => (
                <button
                  key={l}
                  type="button"
                  role="tab"
                  aria-selected={layout === l}
                  onClick={() => setLayout(l)}
                  className={`min-h-8 px-2.5 font-mono text-[11px] font-semibold uppercase tracking-[0.6px] ${layout === l ? 'bg-text-primary text-surface-1' : 'text-text-muted hover:text-text-primary'}`}
                >
                  {l}
                </button>
              ))}
            </div>
          )}
        </header>
        {view.goal && <p className="mt-1.5 max-w-[90ch] font-mono text-[12.5px] text-text-muted">{view.goal}</p>}
        {/* Board and Lanes lay the live store's progress over the model themselves. */}
        {variant === 'pane' && layout === 'lanes'
          ? <MissionLanes model={view.board} {...link} />
          : <MissionBoard model={view.board} {...link} />}
      </div>
    </MissionLiveContext.Provider>
  );
}
