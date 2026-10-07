'use client';

/**
 * The desktop right panel (knowledge-base: buildd/design/chat-v3-desktop.md, "Dock"): one solid
 * 420px slot beside the chat column that shows one thing at a time, the
 * object the conversation is about, the task that needs you, or the
 * conversation list. Opaque: the sea stays in the stage.
 *
 * Which thing it shows is `dockChoice` (dock-model.ts); this file only draws.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { BuilddObjectRef } from './chat-contract';
import { MissionContextCard } from './MissionSheet';
import { useChatActions } from './ChatActions';
import { refKey } from './chat-contract';
import { ChatVisualDeck, MissionVisualRow, hasVisualReview } from './objects/mission-visual';
import { ObjectPane } from './objects/registry';
import { useObjectEntry } from './objects/ObjectStoreProvider';
import { popOutHref } from './pane-state';
import { atWorkRows, taskDockModel, type DockAction, type DockMode, type DockTone } from './dock-model';
import type { TaskObjectView } from './objects/object-views';

const SQUARE: Record<DockTone, string> = {
  needs: 'bg-[var(--mood-needs)]',
  live: 'bg-[var(--mood-thinking)]',
  landed: 'bg-[var(--mood-landed)]',
  idle: 'border border-[var(--chat-rule-strong)]',
};
const BADGE: Record<DockTone, string> = {
  needs: 'border-[var(--mood-needs)] text-[var(--mood-needs)]',
  live: 'border-[var(--mood-thinking)] text-[var(--mood-thinking)]',
  landed: 'border-[var(--mood-landed)] text-[var(--mood-landed)]',
  idle: 'border-[var(--chat-rule-strong)] text-[var(--chat-muted)]',
};
const OVERLINE = 'font-mono text-[11px] md:text-[10.5px] uppercase tracking-[.16em] text-[var(--chat-muted)]';

function kindWord(ref: BuilddObjectRef | null): string {
  switch (ref?.kind) {
    case 'mission': return 'Mission';
    case 'task': return 'Task';
    case 'question': return 'Question';
    case 'pr': return 'Pull request';
    default: return ref?.kind ?? '';
  }
}

export interface ChatDockProps {
  mode: DockMode;
  objRef: BuilddObjectRef | null;
  onClose(): void;
  /** The conversation list (history mode). */
  history?: ReactNode;
  /** Say something in the chat (an action row). */
  onSend(text: string): void;
  /** Open another object in the panel (Answer it → the question). */
  onOpen(ref: BuilddObjectRef): void;
  /** The visual review deck is open here: the panel widens to fit both viewports. */
  wide?: boolean;
}

export default function ChatDock({ mode, objRef, onClose, history, onSend, onOpen, wide = false }: ChatDockProps) {
  const actions = useChatActions();
  // `wide` is the review deck in the panel: the header says so and carries the
  // one way back to the mission (the deck's own boxed close is hidden).
  const reviewing = wide && mode === 'object';
  const lead = mode === 'history' ? 'History' : mode === 'needs' ? 'Needs you' : 'About';
  const open = objRef ? popOutHref(objRef) : null;
  return (
    <aside
      data-testid="chat-dock"
      data-mode={mode}
      data-ref={objRef ? `${objRef.kind}:${objRef.id}` : undefined}
      aria-label={mode === 'history' ? 'Chat history' : `${lead}: ${kindWord(objRef)}`}
      // Needs you docks only where there is room (1280+); below that the pinned strip carries it.
      data-wide={wide ? 'true' : undefined}
      className={`hidden min-h-0 shrink-0 flex-col border-l border-[var(--chat-rule)] bg-[var(--chat-bar)] ${wide ? 'lg:w-[min(820px,58vw)]' : 'lg:w-[420px]'} ${mode === 'needs' ? 'xl:flex' : 'lg:flex'}`}
    >
      <header className="flex h-14 shrink-0 items-stretch border-b border-[var(--chat-rule)]">
        <p data-testid="chat-dock-crumbs" className="flex min-w-0 flex-1 items-center gap-1.5 px-5 font-mono text-[11px] uppercase tracking-[.16em] text-[var(--chat-muted)]">
          <span className="font-bold text-[var(--chat-text)]">{lead}</span>
          {mode !== 'history' && (
            <>
              <span aria-hidden="true" className="text-[var(--chat-dim)]">/</span>
              <span className="truncate">{kindWord(objRef)}</span>
            </>
          )}
          {reviewing && (
            <>
              <span aria-hidden="true" className="text-[var(--chat-dim)]">/</span>
              <span className="truncate">Review</span>
            </>
          )}
        </p>
        {reviewing && (
          <button
            type="button"
            data-testid="dock-review-back"
            onClick={actions.closeVisualReview}
            className="inline-flex shrink-0 items-center border-l border-[var(--chat-rule)] px-4 font-mono text-[11px] uppercase tracking-[.14em] text-[var(--chat-text)] hover:bg-[var(--chat-raised)]"
          >
            Back to mission
          </button>
        )}
        {open && (
          /^https?:/.test(open)
            ? <a href={open} target="_blank" rel="noreferrer" data-testid="dock-open" className="inline-flex shrink-0 items-center border-l border-[var(--chat-rule)] px-4 font-mono text-[11px] uppercase tracking-[.14em] text-[var(--chat-text)] hover:bg-[var(--chat-raised)]">Open ↗</a>
            : <Link href={open} data-testid="dock-open" className="inline-flex shrink-0 items-center border-l border-[var(--chat-rule)] px-4 font-mono text-[11px] uppercase tracking-[.14em] text-[var(--chat-text)] hover:bg-[var(--chat-raised)]">Open ↗</Link>
        )}
        <button
          type="button"
          data-testid="dock-close"
          onClick={onClose}
          aria-label={mode === 'history' ? 'Close history' : 'Close panel'}
          className="grid w-14 shrink-0 place-items-center border-l border-[var(--chat-rule)] font-mono text-[16px] text-[var(--chat-text)] hover:bg-[var(--chat-raised)]"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </header>
      <div className={`min-h-0 flex-1 overflow-y-auto ${wide ? '' : 'px-5 py-6'}`}>
        {mode === 'history'
          ? history ?? <p data-testid="dock-history-empty" className="font-voice text-[17px] italic text-[var(--chat-muted)]">No chats.</p>
          : objRef && <DockObject objRef={objRef} onSend={onSend} onOpen={onOpen} />}
      </div>
    </aside>
  );
}

function DockObject({ objRef, onSend, onOpen }: { objRef: BuilddObjectRef; onSend(text: string): void; onOpen(ref: BuilddObjectRef): void }) {
  if (objRef.kind === 'mission') return <MissionDock objRef={objRef} />;
  if (objRef.kind === 'task') return <TaskDock objRef={objRef} onSend={onSend} onOpen={onOpen} />;
  // Questions and PRs keep their own pane bodies (answerable in place).
  return <div className="-mx-6 -mt-5"><ObjectPane objRef={objRef} /></div>;
}

function MissionDock({ objRef }: { objRef: BuilddObjectRef }) {
  const { view } = useObjectEntry(objRef);
  const actions = useChatActions();
  const rows = view?.kind === 'mission' ? atWorkRows(view.board) : [];
  // "Review" from the thread: the deck takes the panel (inline, never a Dialog).
  const r = actions.visualReview;
  const reviewing = r && r.surface === 'dock' && refKey(r.ref) === refKey(objRef) ? r : null;
  if (reviewing && view?.kind === 'mission' && view.visual && view.visual.cells.length > 0) {
    return <ChatVisualDeck objRef={objRef} view={{ ...view, visual: view.visual }} startKey={reviewing.startKey} showHeaderClose={false} />;
  }
  return (
    <>
      <MissionContextCard objRef={objRef} />
      {view?.kind === 'mission' && hasVisualReview(view.visual) && (
        <section data-testid="dock-visual" className="mt-6 border border-[var(--chat-rule)] bg-[var(--chat-ground)] p-3">
          <MissionVisualRow objRef={objRef} visual={view.visual} />
        </section>
      )}
      {rows.length > 0 && (
        <section data-testid="dock-at-work" className="mt-6">
          <h3 className={`mb-2 ${OVERLINE}`}>At work</h3>
          <ul className="divide-y divide-[var(--chat-rule)] border border-[var(--chat-rule)] bg-[var(--chat-ground)]">
            {rows.map(r => (
              <li key={r.id} data-testid="dock-at-work-row" data-tone={r.tone} className="flex min-h-9 min-w-0 items-center gap-3 px-3 py-2 font-mono text-[12.5px]">
                <span aria-hidden="true" className={`h-2 w-2 shrink-0 ${SQUARE[r.tone]}`} />
                <span className="min-w-0 flex-1 truncate text-[var(--chat-text)]">{r.label}</span>
                <span className={`shrink-0 ${r.tone === 'needs' ? 'text-[var(--mood-needs)]' : 'text-[var(--chat-muted)]'}`}>{r.state}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function TaskDock({ objRef, onSend, onOpen }: { objRef: BuilddObjectRef; onSend(text: string): void; onOpen(ref: BuilddObjectRef): void }) {
  const { view } = useObjectEntry(objRef);
  const task = view?.kind === 'task' ? view : null;
  if (!task) {
    return (
      <p data-testid="dock-task-loading" className="font-mono text-[12.5px] text-[var(--chat-muted)] [overflow-wrap:anywhere]">{objRef.fallbackText}</p>
    );
  }
  const m = taskDockModel(task);
  const act = (a: DockAction) => {
    if (a.kind === 'send' && a.text) onSend(a.text);
    else if (a.kind === 'answer' && task.worker) {
      onOpen({ kind: 'question', id: task.worker.id, taskId: task.id, missionId: task.missionId, workspaceId: task.workspaceId, fallbackText: `A question on ${task.label}` });
    }
  };
  return (
    <>
      <TaskDockCard view={task} model={m} />
      {m.happened.length > 0 && (
        <section data-testid="dock-happened" className="mt-6">
          <h3 className={`mb-2 ${OVERLINE}`}>What happened</h3>
          <ol className="divide-y divide-[var(--chat-rule)] border border-[var(--chat-rule)] bg-[var(--chat-ground)]">
            {m.happened.map((h, i) => (
              <li key={i} data-testid="dock-happened-row" className="flex min-h-10 min-w-0 items-baseline gap-4 px-3 py-2.5 font-mono text-[12.5px]">
                <span suppressHydrationWarning className="w-10 shrink-0 tabular-nums text-[var(--chat-muted)]">{h.ts != null ? hhmm(h.ts) : 'now'}</span>
                <span className={`min-w-0 flex-1 [overflow-wrap:anywhere] ${h.needs ? 'text-[var(--mood-needs)]' : 'text-[var(--chat-text)]'}`}>{h.text}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      {m.actions.length > 0 && (
        <div className="mt-6 flex flex-wrap gap-3">
          {m.actions.map(a => (
            <button
              key={a.label}
              type="button"
              data-testid="dock-action"
              data-primary={a.primary ? 'true' : undefined}
              onClick={() => act(a)}
              className={`min-h-11 px-4 font-mono text-[13px] font-bold ${a.primary
                ? 'bg-[var(--mood-needs-fill)] text-[var(--chat-ground)] hover:brightness-110'
                : 'border border-[var(--chat-rule-strong)] text-[var(--chat-text)] hover:bg-[var(--chat-raised)]'}`}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export function TaskDockCard({ view, model }: { view: TaskObjectView; model: ReturnType<typeof taskDockModel> }) {
  const needs = model.badge.tone === 'needs';
  return (
    <section
      data-testid="dock-task-card"
      data-tone={model.badge.tone}
      className={`border bg-[var(--chat-surface)] shadow-[4px_4px_0_0_var(--chat-rule-strong)] ${needs ? 'border-[var(--chat-rule-strong)] border-t-2 border-t-[var(--mood-needs)]' : 'border-[var(--chat-rule-strong)]'}`}
    >
      <div className="px-4 pb-3 pt-3">
        <div className="flex items-center justify-between gap-3">
          <span className={`min-w-0 truncate ${OVERLINE}`}>{view.scope ? `Task · ${view.scope}` : 'Task'}</span>
          <span data-testid="dock-task-badge" className={`inline-flex h-5 shrink-0 items-center border px-1.5 font-mono text-[11px] md:text-[10.5px] font-bold uppercase tracking-[.12em] ${BADGE[model.badge.tone]}`}>
            {model.badge.label}
          </span>
        </div>
        <h2 data-testid="dock-task-title" className="mt-2 font-voice text-[22px] leading-[1.2] text-[var(--chat-text)] [overflow-wrap:anywhere]">{model.title}</h2>
      </div>
      <div className="grid grid-cols-2 divide-x divide-[var(--chat-rule)] border-t border-[var(--chat-rule)]">
        <div data-testid="dock-task-tries" className="min-w-0 px-4 py-2.5">
          <p className="flex items-baseline justify-between gap-2 font-mono text-[11px] md:text-[10.5px] uppercase tracking-[.14em] text-[var(--chat-muted)]">
            <span>Tries</span>
            <span className="text-[var(--chat-text)]">{model.tries.value}</span>
          </p>
          <div aria-hidden="true" className="mt-2 flex h-1.5 gap-[3px]">
            {model.tries.segs.map((t, i) => <span key={i} className={`min-w-0 flex-1 ${SQUARE[t]}`} />)}
          </div>
        </div>
        <div data-testid="dock-task-turns" className="min-w-0 px-4 py-2.5">
          <p className="flex items-baseline justify-between gap-2 font-mono text-[11px] md:text-[10.5px] uppercase tracking-[.14em] text-[var(--chat-muted)]">
            <span>Turns</span>
            <span className="text-[var(--chat-text)]">{model.turns ?? 'none'}</span>
          </p>
          <div aria-hidden="true" className="mt-2 h-1.5" />
        </div>
      </div>
      {model.insight && (
        <p data-testid="dock-task-insight" className="flex items-start gap-2 border-t border-[var(--chat-rule)] px-4 py-3 font-voice text-[16px] italic leading-snug text-[var(--chat-muted)] [overflow-wrap:anywhere]">
          {model.insight.flag && <span aria-hidden="true" className="mt-[7px] h-2 w-2 shrink-0 bg-[var(--mood-needs)]" />}
          <span>{model.insight.text}</span>
        </p>
      )}
    </section>
  );
}
