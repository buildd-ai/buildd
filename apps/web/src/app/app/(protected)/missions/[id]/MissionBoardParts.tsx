'use client';

/**
 * Pieces the mission Board and Lanes share: the live overlay, the clock, the
 * scope chip, the runner avatar, a criterion box, the landed meter and the
 * inline answer to a waiting agent's question.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { missionTaskHref, type MissionOrigin } from '@/lib/mission-task-href';
import type { BoardCriterion, BoardStatus, BoardTask, MissionBoardModel } from '@/lib/mission-board';
import { useMissionLiveSnapshot } from './MissionLiveStore';

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
      {runner.slice(0, 1)}
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

/** One square per deliverable, grouped by phase. */
export function LandedMeter({ model, variant }: { model: MissionBoardModel; variant: 'band' | 'strip' }) {
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
          <span key={p.key} className="truncate uppercase">{`${p.ordinal} · ${p.done}/${p.total}`}</span>
        ))}
      </div>
    </div>
  );
}

export function SectionLabel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span className={`font-mono text-[11px] md:text-[10.5px] font-semibold uppercase tracking-[1.6px] text-text-muted ${className}`}>
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
  const [sending, setSending] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState('');

  async function send(message: string) {
    if (!workerId || !message.trim()) return;
    setSending(message);
    setError(null);
    try {
      const res = await fetch(`/api/workers/${workerId}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data?.error === 'string' ? data.error : 'Failed to send answer');
        return;
      }
      setSent(typeof data?.message === 'string' ? data.message : 'Answer sent.');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send answer');
    } finally {
      setSending(null);
    }
  }

  if (sent) return <p data-testid="board-answer-sent" className="font-mono text-[12px] text-status-success">{sent}</p>;

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
            {sending === o ? 'Sending…' : shortOption(o)}
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
          onSubmit={e => { e.preventDefault(); void send(text); }}
        >
          <input
            autoFocus
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Your answer…"
            className="min-w-0 flex-1 border border-border-default bg-surface-1 px-2.5 py-1.5 font-mono text-base md:text-[12px] text-text-primary placeholder:text-text-muted focus:border-primary"
          />
          <button type="submit" disabled={!text.trim() || sending !== null} className={`${btn} border-border-strong bg-surface-3 text-text-primary`}>Send</button>
        </form>
      )}
      {error && <p className="font-mono text-[12px] text-status-error">{error}</p>}
    </div>
  );
}

/** "Per line — match Stripe" → "Per line": the button says the choice; the prompt says why. */
export function shortOption(o: string): string {
  const cut = o.split(/\s[—–-]\s/)[0].trim();
  return cut.length >= 2 ? cut : o;
}
