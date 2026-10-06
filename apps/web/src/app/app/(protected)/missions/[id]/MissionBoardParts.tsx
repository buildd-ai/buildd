'use client';

/**
 * Pieces the mission Board and Lanes share: the live overlay, the clock, the
 * scope chip, the runner avatar, a criterion box, the landed meter and the
 * inline answer to a waiting agent's question.
 */
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { missionTaskHref, type MissionOrigin } from '@/lib/mission-task-href';
import { runnerInitial } from '@/lib/runner-display';
import { BOARD_LANDED, type BoardCriterion, type BoardStatus, type BoardTask, type MissionBoardModel } from '@/lib/mission-board';
import {
  stripKeyTarget, stripTick, stripTone, type StripMark, type StripSlot, type StripState, type StripTone,
} from '@/lib/mission-task-strip';
import { useMissionLiveSnapshot } from './MissionLiveStore';
import { useAnswerSubmit } from '@/app/app/(protected)/tasks/[id]/respond/use-answer-submit';
import { answerOutcomeLines } from '@/app/app/(protected)/tasks/[id]/respond/submit-answer';

// ── Time ─────────────────────────────────────────────────────────────────────

/**
 * Wall clock, starting at the server's render time so the first client render
 * matches the HTML, then ticking. Stops for a finished mission.
 */
export function useNow(serverNow: number, intervalMs: number, running = true): number {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, running]);
  return running ? Math.max(now, serverNow) : serverNow;
}

// ── Live overlay ─────────────────────────────────────────────────────────────

/**
 * The model with the live store's newer action lines and milestones laid over
 * each live task. Structural changes (a status flip, a merge) re-render the
 * page, so only the notches and the current line change here.
 */
export function useLiveBoard(model: MissionBoardModel): MissionBoardModel {
  const live = useMissionLiveSnapshot();
  return useMemo(() => {
    const ids = Object.keys(live);
    if (ids.length === 0) return model;
    let changed = false;
    const tasks: Record<string, BoardTask> = { ...model.tasks };
    for (const id of ids) {
      const t = tasks[id];
      const p = live[id];
      if (!t || (p.workerId && t.workerId && p.workerId !== t.workerId)) continue;
      const last = t.milestones.length ? t.milestones[t.milestones.length - 1].ts : -Infinity;
      const fresh = p.milestones.filter(m => m.ts > last && m.label !== t.milestones[t.milestones.length - 1]?.label);
      if (fresh.length === 0 && (!p.currentAction || p.currentAction === t.currentAction)) continue;
      changed = true;
      tasks[id] = {
        ...t,
        milestones: [...t.milestones, ...fresh],
        currentAction: p.currentAction ?? t.currentAction,
      };
    }
    return changed ? { ...model, tasks } : model;
  }, [model, live]);
}

// ── Atoms ────────────────────────────────────────────────────────────────────

export function ScopeChip({ scope, tone = 'default', className = '' }: { scope: string | null; tone?: 'default' | 'ok' | 'ghost'; className?: string }) {
  if (!scope) return null;
  const toneCls = tone === 'ok'
    ? 'border-status-success text-status-success bg-transparent'
    : tone === 'ghost'
      ? 'border-border-default text-text-secondary bg-transparent'
      : 'border-border-default text-text-secondary bg-surface-3';
  return (
    <span className={`inline-flex h-[18px] shrink-0 items-center border px-[5px] font-mono text-[11px] md:text-[10.5px] font-semibold tracking-[0.2px] ${toneCls} ${className}`}>
      {scope}
    </span>
  );
}

export function RunnerAvatar({ runner, className = '' }: { runner: string | null; className?: string }) {
  if (!runner) return null;
  return (
    <span
      title={runner}
      className={`grid h-5 w-5 shrink-0 place-items-center border-[1.5px] border-border-strong bg-surface-1 font-mono text-[11px] md:text-[10.5px] font-bold uppercase text-text-primary ${className}`}
    >
      {runnerInitial(runner)}
    </span>
  );
}

/** The task's work-kind glyph, in its role's own colour (never a constant). */
export function RoleGlyph({ task }: { task: Pick<BoardTask, 'glyph' | 'roleColor' | 'roleName'> }) {
  if (!task.glyph) return null;
  return (
    <span
      aria-hidden="true"
      title={task.roleName ?? undefined}
      className="w-3 shrink-0 text-center text-[12px] text-text-muted"
      style={task.roleColor ? { color: task.roleColor } : undefined}
    >
      {task.glyph}
    </span>
  );
}

export function CriterionBox({ c, size = 14 }: { c: BoardCriterion; size?: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, c.frac)) * 100);
  const base = 'grid shrink-0 place-items-center border-[1.5px] font-mono text-[11px] md:text-[10px] font-bold leading-none';
  const style = { width: size, height: size } as React.CSSProperties;
  if (c.state === 'pass') return <span className={`${base} border-status-success bg-status-success text-card`} style={style}>✓</span>;
  if (c.state === 'fail') return <span className={`${base} border-status-error text-status-error`} style={style}>✕</span>;
  if (c.state === 'running') return <span className={`${base} border-accent`} style={style}><span className="h-1.5 w-1.5 animate-status-pulse bg-accent" /></span>;
  if (c.state === 'partial') {
    return (
      <span
        className={`${base} border-status-success`}
        style={{ ...style, background: `linear-gradient(to top, var(--status-success) ${pct}%, transparent ${pct}%)` }}
      />
    );
  }
  return <span className={`${base} border-[var(--fleet-border-mid)]`} style={style} />;
}

const METER_CLASS: Record<BoardStatus, string> = {
  merged: 'border-status-success bg-status-success',
  done: 'border-status-success bg-status-success',
  review: 'border-status-success fleet-hatch-ok',
  running: 'border-accent bg-accent',
  waiting: 'border-[2.5px] border-accent bg-card',
  ci_failed: 'border-status-error bg-[var(--fleet-err-soft)]',
  fixing: 'border-status-error bg-[var(--fleet-err-soft)]',
  failed: 'border-status-error bg-[var(--fleet-err-soft)]',
  ready: 'border-[var(--fleet-border-mid)] fleet-hatch',
  blocked: 'border-[var(--fleet-border-mid)] fleet-hatch',
};

/**
 * The interactive band cells: landed work is solid, anything unfinished is
 * hatched or empty, each in its state's tone. Ready, blocked and queued differ
 * in texture (none / dense / sparse), so they read in greyscale (ST-3).
 */
const STRIP_CELL_CLASS: Record<StripState, string> = {
  landed: 'border-2 border-status-success bg-status-success',
  review: 'border-2 border-status-success fleet-hatch-ok',
  running: 'border-2 border-accent fleet-hatch-accent',
  waiting: 'border-[2.5px] border-accent bg-card',
  ci_failed: 'border-2 border-status-error fleet-hatch-err',
  fixing: 'border-2 border-status-error fleet-hatch-err',
  failed: 'border-2 border-status-error fleet-hatch-err',
  ready: 'border-2 border-border-strong bg-card',
  blocked: 'border-2 border-[var(--fleet-border-mid)] fleet-hatch',
  queued: 'border-2 border-[var(--fleet-border-mid)] fleet-hatch-future',
};

const STRIP_OUTLINE: Record<StripTone, string> = {
  ok: 'outline-status-success',
  error: 'outline-status-error',
  open: 'outline-accent',
};

/**
 * The tone's text and dot colour, shared by the tick row here and the drawer
 * (border/background/pill) in MissionTaskStrip.tsx — one Record per CSS
 * property, all keyed by the same `StripTone`, so a failed cell is never
 * "error" in one place and "open" (accent) in another.
 */
export const TONE_BORDER: Record<StripTone, string> = {
  ok: 'border-status-success',
  error: 'border-status-error',
  open: 'border-accent',
};
export const TONE_BG: Record<StripTone, string> = {
  ok: 'bg-status-success',
  error: 'bg-status-error',
  open: 'bg-accent',
};
export const TONE_TEXT: Record<StripTone, string> = {
  ok: 'text-status-success',
  error: 'text-status-error',
  open: 'text-accent-text',
};

const STATUS_WORDS: Record<StripState, string> = {
  landed: 'landed', review: 'in review', running: 'running', waiting: 'needs you',
  ci_failed: 'CI failed', fixing: 'fixing', failed: 'failed', ready: 'ready', blocked: 'blocked', queued: 'queued behind',
};

/** Selecting a cell of the band (the mission page's Landed strip). */
export interface LandedMeterSelection {
  /** The cells, in strip order (`stripSlots`). */
  slots: readonly StripSlot[];
  selectedId: string;
  /** Per slot: how it relates to the selection (`slotMarks`). */
  marks: ReadonlyArray<StripMark | null>;
  onSelect(taskId: string): void;
}

/**
 * One square per deliverable, grouped by phase. With `selection` (the mission
 * page's Board) the band is a toolbar of real buttons in strip order: a click
 * selects without navigating, ArrowLeft/Right step and Home/End jump.
 */
export function LandedMeter({ model, variant, compact = false, selection }: { model: MissionBoardModel; variant: 'band' | 'strip'; compact?: boolean; selection?: LandedMeterSelection }) {
  if (variant === 'band' && selection) return <StripCells model={model} compact={compact} selection={selection} />;
  if (variant === 'strip') {
    return (
      <span className="flex gap-[7px]">
        {model.phases.map(p => (
          <span key={p.key} className="flex gap-0.5">
            {p.taskIds.map(id => (
              <i key={id} data-status={model.tasks[id].status} className={`block h-3.5 w-3.5 border-[1.5px] ${METER_CLASS[model.tasks[id].status]}`} />
            ))}
          </span>
        ))}
      </span>
    );
  }
  const cols = model.phases.map(p => `${Math.max(1, p.total)}fr`).join(' ');
  return (
    <div>
      <div className="grid gap-2.5" style={{ gridTemplateColumns: cols }}>
        {model.phases.map(p => (
          <span key={p.key} className="grid auto-cols-fr grid-flow-col gap-[3px]">
            {p.taskIds.map(id => (
              <i key={id} data-status={model.tasks[id].status} className={`block h-4 border-[1.5px] ${METER_CLASS[model.tasks[id].status]}`} />
            ))}
          </span>
        ))}
      </div>
      <div className="mt-[5px] grid gap-2.5 font-mono text-[11px] md:text-[10px] tracking-[1px] text-[var(--fleet-faint)]" style={{ gridTemplateColumns: cols }}>
        {model.phases.map(p => (
          <span
            key={p.key}
            data-testid="landed-phase-caption"
            title={p.label ? `${p.ordinal} · ${p.label}` : undefined}
            className={compact ? 'whitespace-nowrap tabular-nums' : 'truncate uppercase'}
          >
            {compact ? `${p.done}/${p.total}` : `${p.ordinal} · ${p.done}/${p.total}`}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Past this many cells the ticks lose their numbers: an unfinished one keeps a mark. */
const MAX_NUMBERED_TICKS = 12;

/** A mark on the tick row, by tick mode (§5.2): shape differs, not only colour. */
const TICK_MARK_NUMBERED: Record<StripMark, string> = {
  direct: 'bg-accent px-0.5 text-card',
  transitive: 'border-b-2 border-accent text-accent-text',
};
const TICK_MARK_BAR: Record<StripMark, string> = {
  direct: 'h-1.5',
  transitive: 'h-0.5',
};

function StripCells({ model, compact, selection }: { model: MissionBoardModel; compact: boolean; selection: LandedMeterSelection }) {
  const { slots, marks, onSelect } = selection;
  const n = slots.length;
  const sel = Math.max(0, slots.findIndex(s => s.id === selection.selectedId));
  const onKeyDown = (e: React.KeyboardEvent) => {
    const to = stripKeyTarget(e.key, sel, n);
    if (to == null) return;
    e.preventDefault();
    onSelect(slots[to].id);
    // Roving focus follows the selection (only the selected cell is tabbable).
    (e.currentTarget.querySelectorAll('button')[to] as HTMLButtonElement | undefined)?.focus();
  };
  const numbered = n <= MAX_NUMBERED_TICKS;
  return (
    <div>
      <div
        role="toolbar"
        aria-label="Mission tasks. Use the arrow keys to move between tasks."
        data-testid="landed-strip"
        onKeyDown={onKeyDown}
        className="flex gap-[var(--strip-gap)] pt-1.5"
      >
        {slots.map((s, i) => {
          if (s.kind === 'fold') {
            return (
              <StripCell
                key={s.id}
                id={s.id}
                state={s.state}
                selected={i === sel}
                tall={!compact}
                label={`${s.taskIds.length} ${s.state === 'landed' ? 'landed' : 'queued'} tasks`}
                onSelect={onSelect}
              />
            );
          }
          const t = model.tasks[s.id];
          const level = t.levels > 1 ? `, level ${t.level} of ${t.levels}` : '';
          return (
            <StripCell
              key={s.id}
              id={s.id}
              state={s.state}
              selected={i === sel}
              tall={!compact}
              label={`Cell ${i + 1} of ${n}${level}, ${STATUS_WORDS[s.state]}: ${t.title}`}
              onSelect={onSelect}
            />
          );
        })}
      </div>
      <div aria-hidden="true" className={`flex gap-[var(--strip-gap)] ${compact ? 'h-[26px]' : 'h-[26px] md:h-7'}`}>
        {slots.map((s, i) => {
          const open = s.state !== 'landed';
          const mark = i === sel ? null : marks[i] ?? null;
          const tick = s.kind === 'fold' ? `+${s.taskIds.length}` : stripTick(i);
          // The cell's own tone (TONE-1): a failed tick reads status-error, never
          // the accent "open" colour, whether it is the numbered digit or the dot.
          const tone = stripTone(s.state);
          let body: ReactNode = null;
          if (numbered || i === sel || s.kind === 'fold') {
            body = mark ? <span className={TICK_MARK_NUMBERED[mark]}>{tick}</span> : tick;
          } else if (mark) {
            body = <i className={`block w-full min-w-px bg-accent ${TICK_MARK_BAR[mark]}`} />;
          } else if (open) {
            body = <i className={`block h-1 w-1 ${TONE_BG[tone]}`} />;
          }
          return (
            <span
              key={s.id}
              data-testid="landed-strip-tick"
              data-open={open ? 'true' : undefined}
              data-mark={mark ?? undefined}
              data-tone={open ? tone : undefined}
              className={`flex min-w-0 flex-1 basis-0 items-center justify-center font-mono text-eyebrow tabular-nums ${open ? `font-semibold ${TONE_TEXT[tone]}` : mark ? 'font-semibold text-accent-text' : 'text-[var(--fleet-faint)]'}`}
            >
              {body}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** Memoised: a selection change re-renders the two cells it touches, not the strip. */
const StripCell = memo(function StripCell({ id, state, selected, tall, label, onSelect }: {
  id: string;
  state: StripState;
  selected: boolean;
  tall: boolean;
  label: string;
  onSelect(taskId: string): void;
}) {
  return (
    <button
      type="button"
      data-testid="landed-strip-cell"
      data-task-ref={id}
      data-status={state}
      aria-label={label}
      aria-pressed={selected}
      aria-controls={STRIP_DRAWER_ID}
      tabIndex={selected ? 0 : -1}
      onClick={() => onSelect(id)}
      className={`block h-11 min-w-0 flex-1 basis-0 cursor-pointer p-0 transition-transform duration-150 motion-reduce:transition-none ${tall ? 'md:h-14' : ''} ${STRIP_CELL_CLASS[state]} ${
        selected ? `-translate-y-1 outline outline-2 outline-offset-2 ${STRIP_OUTLINE[stripTone(state)]}` : 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text-primary'
      }`}
    />
  );
});

/** The tethered drawer's element id (the cells' `aria-controls`). */
export const STRIP_DRAWER_ID = 'mission-strip-drawer';

export function SectionLabel({ children, className = '', title, 'data-testid': testId }: { children: ReactNode; className?: string; title?: string; 'data-testid'?: string }) {
  return (
    <span data-testid={testId} title={title} className={`font-mono text-[11px] md:text-[10.5px] font-semibold uppercase tracking-[1.6px] text-text-muted ${className}`}>
      {children}
    </span>
  );
}

// ── Links ────────────────────────────────────────────────────────────────────

export interface BoardLinkContext {
  missionId: string;
  from?: MissionOrigin | null;
  initiativeId?: string | null;
}

/** The task sheet link: a real href, opened by TaskPanelWrapper's `data-task-id` handler. */
export function taskSheetHref(ctx: BoardLinkContext, taskId: string): string {
  return missionTaskHref({ missionId: ctx.missionId, taskId, from: ctx.from ?? null, initiativeId: ctx.initiativeId ?? null, mode: 'sheet' });
}

// ── Answering a waiting agent ────────────────────────────────────────────────

/**
 * Inline answer buttons for a waiting agent: one per option (the first is
 * primary), then `Reply…` for a free-text answer. Posts to the same respond
 * endpoint the task page uses, which resumes or continues the session.
 */
export function AnswerButtons({ workerId, options, compact = false }: { workerId: string | null; options: readonly string[]; compact?: boolean }) {
  const router = useRouter();
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState('');
  const [lastTried, setLastTried] = useState<string | null>(null);
  const onAnswered = useCallback(() => router.refresh(), [router]);
  const { submit, sending, outcome, error } = useAnswerSubmit({ workerId, resetKey: workerId ?? '', onAnswered });

  function send(message: string) {
    setLastTried(message.trim());
    void submit(message);
  }

  if (outcome) {
    const lines = answerOutcomeLines(outcome);
    return (
      <p data-testid="board-answer-sent" data-outcome={outcome.kind} className="font-mono text-[12px] text-status-success [overflow-wrap:anywhere]">
        {`✓ ${lines.headline}`}
        {lines.detail && <span className="block text-text-secondary">{lines.detail}</span>}
        <span className="block text-text-muted">Answer sent, waiting for the agent</span>
      </p>
    );
  }

  const btn = `inline-flex ${compact ? 'h-[30px] px-3 text-[12px]' : 'h-8 px-3.5 text-[12.5px]'} items-center border-[1.5px] font-mono font-semibold disabled:opacity-50`;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div data-testid="board-answer-options" className="flex flex-wrap items-center gap-1.5">
        {options.map((o, i) => (
          <button
            key={o}
            type="button"
            disabled={sending !== null}
            onClick={() => send(o)}
            className={`${btn} ${i === 0 ? 'border-accent bg-accent text-white hover:bg-primary-hover' : 'border-border-strong bg-surface-3 text-text-primary hover:bg-surface-4'}`}
          >
            {sending === o.trim() ? 'Sending…' : shortOption(o)}
          </button>
        ))}
        {!replying && (
          <button type="button" onClick={() => setReplying(true)} className={`${btn} border-[var(--fleet-border-mid)] bg-transparent text-text-primary hover:bg-surface-3`}>
            Reply…
          </button>
        )}
      </div>
      {replying && (
        <form
          className="flex gap-1.5"
          onSubmit={e => { e.preventDefault(); send(text); }}
        >
          <input
            autoFocus
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Your answer…"
            className="min-w-0 flex-1 border border-border-default bg-surface-1 px-2.5 py-1.5 font-mono text-base md:text-[12px] text-text-primary placeholder:text-text-muted focus:border-primary"
          />
          <button type="submit" disabled={!text.trim() || sending !== null} className={`${btn} border-border-strong bg-surface-3 text-text-primary`}>{sending !== null && sending === text.trim() ? 'Sending…' : 'Send'}</button>
        </form>
      )}
      {error && (
        <p className="font-mono text-[12px] text-status-error">
          {error.message}
          {lastTried && sending === null && (
            <>{' '}<button type="button" onClick={() => send(lastTried)} className="underline hover:no-underline">Retry</button></>
          )}
        </p>
      )}
    </div>
  );
}

/** "Per line — match Stripe" → "Per line": the button says the choice; the prompt says why. */
export function shortOption(o: string): string {
  const cut = o.split(/\s[—–-]\s/)[0].trim();
  return cut.length >= 2 ? cut : o;
}
