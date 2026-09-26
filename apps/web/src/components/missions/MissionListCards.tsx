'use client';

/**
 * The redesigned missions-list cards (model: lib/mission-list-card.ts).
 *
 * - `ActiveMissionCard`: status word, title, live-agent dots, the phase bar,
 *   the inline answer strip when a worker is parked on a question, and a
 *   counts + criteria footer.
 * - `MiniMissionCard`: recurring (↻ cadence, run history, next tick), held
 *   (Arm), scheduled and paused missions.
 * - `DoneMissionRows`: completed missions as compact table rows.
 *
 * Every link into a task goes through the model's `missionTaskHref` output.
 */
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { MissionCardView } from '@/lib/mission-card-view';
import { nextRunLabel, shortAgo, shortDuration, type ListTone, type MissionListCardModel } from '@/lib/mission-list-card';
import { timeAgo } from '@/lib/mission-helpers';
import PhaseBar, { CELL_BOX } from './PhaseBar';

export interface ListCardProps {
  view: MissionCardView;
  model: MissionListCardModel;
  workspaceName?: string | null;
}

const TONE_TEXT: Record<ListTone, string> = {
  accent: 'text-accent-text',
  warning: 'text-status-warning',
  success: 'text-status-success',
  error: 'text-status-error',
  muted: 'text-text-secondary',
};
const TONE_SQUARE: Record<ListTone, string> = {
  accent: 'bg-accent',
  warning: 'bg-status-warning',
  success: 'bg-status-success',
  error: 'bg-status-error',
  muted: 'border-2 border-text-secondary',
};
const TONE_EDGE: Record<ListTone, string> = {
  accent: 'border-l-accent',
  warning: 'border-l-status-warning',
  success: 'border-l-status-success',
  error: 'border-l-status-error',
  muted: 'border-l-border-strong',
};

export const statusSlug = (label: string) => label.toLowerCase().replace(/\s+/g, '_');

export function StatusWord({ label, tone }: { label: string; tone: ListTone }) {
  return (
    <span
      data-testid="mission-status-word"
      className={`inline-flex items-center gap-[7px] whitespace-nowrap font-mono text-[11px] font-bold uppercase tracking-[1.5px] ${TONE_TEXT[tone]}`}
    >
      <span aria-hidden="true" className={`inline-block h-2 w-2 shrink-0 ${TONE_SQUARE[tone]}`} />
      {label}
    </span>
  );
}

function LiveDots({ dots }: { dots: MissionListCardModel['live']['dots'] }) {
  return (
    <span className="flex gap-[3px]" aria-hidden="true">
      {dots.slice(0, 10).map((d, i) => (
        <i
          key={i}
          className={`inline-block h-2.5 w-2.5 ${d.color ? '' : 'bg-accent'}`}
          style={d.color ? { backgroundColor: d.color } : undefined}
        />
      ))}
    </span>
  );
}

function CriteriaPips({ criteria }: { criteria: NonNullable<MissionListCardModel['criteria']> }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className="flex gap-1" aria-hidden="true">
        {Array.from({ length: Math.min(criteria.total, 8) }, (_, i) => (
          <i
            key={i}
            className={`inline-block h-2.5 w-2.5 border ${i < criteria.passed ? 'border-status-success bg-status-success' : 'border-text-muted'}`}
          />
        ))}
      </span>
      <span>criteria <b className="font-semibold text-text-primary">{criteria.passed}</b>/{criteria.total}</span>
    </span>
  );
}

/** One-tap answers to a parked worker — POSTs to the existing respond route. */
export function InlineAnswer({ question, compact = false }: { question: NonNullable<MissionListCardModel['question']>; compact?: boolean }) {
  const router = useRouter();
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function answer(option: string) {
    if (!question.workerId || sent) return;
    setSent(option);
    setError(null);
    try {
      const res = await fetch(`/api/workers/${encodeURIComponent(question.workerId)}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: option }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Could not send the answer');
      }
      startTransition(() => router.refresh());
    } catch (e: any) {
      setSent(null);
      setError(e?.message || 'Could not send the answer');
    }
  }

  const canAnswer = !!question.workerId && question.options.length > 0;
  return (
    <div
      data-testid="mission-inline-answer"
      className={`flex flex-col gap-2 border border-status-warning bg-status-warning/10 px-3 py-2.5 md:flex-row md:items-center md:gap-3 ${compact ? '' : 'mt-3.5'}`}
    >
      <span className="shrink-0 font-mono text-[11px] font-bold uppercase tracking-[1.5px] text-status-warning">? {question.label}</span>
      <span className="min-w-0 flex-1 font-mono text-[12.5px] text-text-primary md:truncate">{question.prompt}</span>
      <span className="flex shrink-0 flex-wrap gap-2">
        {canAnswer
          ? question.options.map((opt, i) => (
              <button
                key={opt}
                type="button"
                data-testid="mission-inline-answer-option"
                disabled={!!sent || pending}
                onClick={() => answer(opt)}
                title={opt}
                className={`min-h-11 px-3 font-mono text-[12px] font-semibold md:min-h-9 disabled:opacity-60 ${
                  i === 0
                    ? 'border-2 border-primary bg-primary text-white shadow-sm'
                    : 'border-2 border-border-strong bg-surface-3 text-text-primary'
                }`}
              >
                {sent === opt ? 'Sent…' : opt.split(/\s+[—–-]\s+/)[0]}
              </button>
            ))
          : null}
        <Link
          href={question.href}
          className="inline-flex min-h-11 items-center border-2 border-border-default px-3 font-mono text-[12px] text-text-secondary hover:text-text-primary md:min-h-9"
        >
          {canAnswer ? 'Reply…' : 'Answer'}
        </Link>
      </span>
      {error && <span role="alert" className="font-mono text-[11px] text-status-error">{error}</span>}
    </div>
  );
}

export function ActiveMissionCard({ view, model, workspaceName }: ListCardProps) {
  const { counts } = model;
  return (
    <article
      data-testid="mission-card"
      data-status={statusSlug(model.status.label)}
      data-group={view.group}
      className={`card border-l-[6px] px-4 py-4 md:px-5 ${TONE_EDGE[model.status.tone]}`}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 md:grid-cols-[120px_minmax(0,1fr)_auto]">
        <StatusWord {...model.status} />
        <h3 className="order-3 col-span-2 min-w-0 truncate font-mono text-[15px] font-semibold tracking-[-0.2px] text-text-primary md:order-none md:col-span-1 md:text-[17px]">
          <Link href={view.href} className="hover:underline">{view.title}</Link>
        </h3>
        <div className="flex items-center gap-2.5 font-mono text-[12px] text-text-secondary">
          {model.live.count > 0 && (
            <>
              <LiveDots dots={model.live.dots} />
              <span><b className="text-text-primary">{model.live.count}</b> live</span>
            </>
          )}
          {model.elapsedMin != null && <span className="text-text-muted">· {shortDuration(model.elapsedMin * 60_000)}</span>}
        </div>
      </div>
      {(model.sentence || workspaceName) && (
        <p className="mt-1.5 truncate font-mono text-[11.5px] text-text-muted md:pl-[136px]">
          {workspaceName && <span className="text-text-secondary">{workspaceName}</span>}
          {workspaceName && model.sentence && ' · '}
          {model.sentence}
        </p>
      )}
      <div className="mt-4">
        <PhaseBar phases={model.phases} />
      </div>
      {model.question && <InlineAnswer question={model.question} />}
      {model.ask && (
        <Link
          href={model.ask.href}
          data-testid="mission-card-ask"
          className="mt-3.5 flex min-h-11 items-center justify-between gap-3 border border-status-warning bg-status-warning/10 px-3 font-mono text-[12.5px] text-text-primary hover:underline"
        >
          <span className="truncate">{model.ask.label}</span>
          <span aria-hidden="true" className="text-status-warning">→</span>
        </Link>
      )}
      <div className="mt-3.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border-default pt-3 font-mono text-[12px] text-text-secondary">
        <div className="flex flex-wrap items-center gap-x-[18px] gap-y-1">
          {counts.total > 0 && <span><b className="font-semibold text-text-primary">{counts.done}</b>/{counts.total} done</span>}
          {counts.inCi > 0 && <span><b className="font-semibold text-text-primary">{counts.inCi}</b> in CI</span>}
          {counts.running > 0 && <span><b className="font-semibold text-text-primary">{counts.running}</b> running</span>}
          {counts.needsYou > 0 && (
            <span className="text-status-warning"><b className="font-semibold">{counts.needsYou}</b> {model.question ? 'question' : 'needs you'}</span>
          )}
          {counts.failed > 0 && <span className="text-status-error"><b className="font-semibold">{counts.failed}</b> failed</span>}
          {counts.queued > 0 && <span className="text-text-muted">{counts.queued} queued</span>}
        </div>
        {model.criteria && <CriteriaPips criteria={model.criteria} />}
      </div>
    </article>
  );
}

/* ── Arm — releases a held mission ── */
export function ArmButton({ missionId }: { missionId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  async function handleArm() {
    setBusy(true);
    try {
      await fetch(`/api/missions/${encodeURIComponent(missionId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ arm: true }),
      });
      startTransition(() => router.refresh());
    } catch {
      // non-fatal: the card stays held and the button can be pressed again
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      data-testid="mission-arm-button"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleArm(); }}
      disabled={isPending || busy}
      className="inline-flex min-h-11 items-center gap-1 border-2 border-primary bg-primary px-3.5 font-mono text-[12px] font-semibold text-white shadow-sm transition-colors hover:bg-primary-hover disabled:opacity-50 md:min-h-9"
      aria-label="Arm this mission: release its tasks for workers to claim"
    >
      {isPending || busy ? 'Arming…' : 'Arm →'}
    </button>
  );
}

const RUN_PIP: Record<'ok' | 'fail' | 'live' | 'pending', string> = {
  ok: 'border-status-success bg-status-success',
  fail: 'border-status-error bg-status-error',
  live: 'border-accent bg-accent',
  pending: 'border-border-strong',
};

export function MiniMissionCard({ view, model, workspaceName }: ListCardProps) {
  const r = model.recurring;
  const h = model.held;
  const meta = r
    ? [r.lastTickAt ? `last tick ${timeAgo(r.lastTickAt)}` : 'no tick yet', r.lastSummary].filter(Boolean).join(' · ')
    : h
      ? `${h.ready} ${h.roles.length === 1 ? `${h.roles[0]} ` : ''}task${h.ready === 1 ? '' : 's'} ready · arm to start`
      : model.sentence ?? view.situation.headline;

  return (
    <article
      data-testid="mission-card"
      data-status={statusSlug(model.status.label)}
      data-group={view.group}
      className={`card flex min-h-32 flex-col gap-3 border-l-[6px] px-4 py-3.5 md:px-[18px] ${TONE_EDGE[model.kind === 'held' ? 'warning' : model.status.tone === 'muted' ? 'muted' : model.status.tone]}`}
    >
      <div className="flex items-center justify-between gap-3">
        <StatusWord {...model.status} />
        {r ? (
          <span className="whitespace-nowrap border border-border-default px-1.5 py-0.5 font-mono text-[11px] md:text-[10.5px] font-semibold uppercase tracking-[0.5px] text-text-secondary">
            ↻ {r.cadence}
          </span>
        ) : h?.since ? (
          <span className="font-mono text-[11px] text-text-muted">{shortAgo(h.since)}</span>
        ) : null}
      </div>
      <div className="min-w-0">
        <h3 className="truncate font-mono text-[15px] font-semibold text-text-primary">
          <Link href={view.href} className="hover:underline">{view.title}</Link>
        </h3>
        <p className="mt-1 line-clamp-2 font-mono text-[11.5px] text-text-muted">
          {workspaceName && <span className="text-text-secondary">{workspaceName} · </span>}
          {meta}
        </p>
      </div>
      <div className="mt-auto flex items-center justify-between gap-3 font-mono text-[12px] text-text-secondary">
        {r ? (
          <>
            <span className="flex items-center gap-1">
              {r.runs.map(run => (
                <i key={run.taskId} aria-hidden="true" className={`inline-block h-3.5 w-3.5 border ${RUN_PIP[run.state]}`} />
              ))}
              <span className="ml-1.5 text-text-muted">{r.totalRuns} run{r.totalRuns === 1 ? '' : 's'}</span>
            </span>
            {r.nextMins != null && (
              <span>
                {(() => {
                  const next = nextRunLabel(r.nextMins, r.nextRunAt);
                  return next && <>{next.lead && `${next.lead} `}<b className="text-text-primary">{next.value}</b></>;
                })()}
              </span>
            )}
          </>
        ) : (
          <>
            <span className="flex h-2.5 w-[120px] gap-[2px]" aria-hidden="true">
              {model.phases.flatMap(p => p.cells).slice(0, 12).map(c => (
                <span key={c.taskId} className={`flex-1 ${CELL_BOX[c.state]}`} />
              ))}
            </span>
            <span className="flex items-center gap-2">
              {model.counts.total > 0 && <span className="text-text-muted">{model.counts.done}/{model.counts.total}</span>}
              {model.kind === 'held' && <ArmButton missionId={view.id} />}
            </span>
          </>
        )}
      </div>
    </article>
  );
}

function Tick() {
  return (
    <span aria-hidden="true" className="grid h-4 w-4 place-items-center bg-status-success">
      <svg viewBox="0 0 16 16" className="h-[11px] w-[11px] fill-none stroke-[var(--card)] stroke-[2.2]">
        <path d="M3 8.5l3 3 7-7" />
      </svg>
    </span>
  );
}

export function DoneMissionRows({ items }: { items: ReadonlyArray<{ view: MissionCardView; model: MissionListCardModel }> }) {
  if (items.length === 0) return null;
  return (
    <div data-testid="mission-done-table" className="card p-0">
      {items.map(({ view, model }) => {
        const d = model.done;
        const meta = [
          d && d.prs > 0 ? `${d.prs} PR${d.prs === 1 ? '' : 's'}` : null,
          d && d.fixes > 0 ? `${d.fixes} fix${d.fixes === 1 ? '' : 'es'}` : null,
        ].filter(Boolean).join(' · ');
        const fresh = !!d?.completedAt && Date.now() - new Date(d.completedAt).getTime() < 3_600_000;
        return (
          <div
            key={view.id}
            data-testid="mission-card"
            data-status="done"
            data-fresh={fresh ? 'true' : undefined}
            data-group={view.group}
            className={`relative grid min-h-11 grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-3.5 border-b border-border-default px-4 py-2 font-mono text-[12px] text-text-secondary last:border-b-0 ${fresh ? 'bg-status-success/10' : ''} md:grid-cols-[16px_minmax(0,1fr)_200px_110px_76px_84px] md:px-[18px]`}
          >
            <Tick />
            <Link
              href={view.href}
              className="truncate text-[13px] font-semibold text-text-primary after:absolute after:inset-0 after:content-[''] hover:underline"
            >
              {view.title}
            </Link>
            <span className="hidden truncate md:block">{meta || '—'}</span>
            <span className="hidden h-2 gap-[2px] md:flex" aria-hidden="true">
              {Array.from({ length: Math.min(view.total, 16) }, (_, i) => (
                <i key={i} className="flex-1 bg-status-success" />
              ))}
            </span>
            <span className="hidden md:block">
              {model.criteria ? <>crit <b className="text-status-success">{model.criteria.passed}/{model.criteria.total}</b></> : `${view.done}/${view.total}`}
            </span>
            <span className="text-right text-text-muted">
              {d?.durationMs != null && <span className="hidden md:inline">{shortDuration(d.durationMs)} · </span>}
              {shortAgo(d?.completedAt)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
