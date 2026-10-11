'use client';

/**
 * The initiative row (model: lib/initiative-view.ts), used by the Initiatives
 * list, plus the pieces the initiative page reuses: the status pill, the
 * mission strip, the next-action control and the mission lines.
 *
 * Anatomy (L1, the MissionRow anatomy): title + status + next action; the
 * facts that need you; one small strip cell per mission; owner · target · n/N.
 */
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type {
  InitiativeAction,
  InitiativeCardModel,
  InitiativeMissionLine,
  InitiativeSegment,
  InitiativeStatus,
} from '@/lib/initiative-view';
import { ArmButton, InlineAnswer, StatusWord } from '@/components/missions/MissionListCards';
import PhaseBar from '@/components/missions/PhaseBar';
import { TonePill } from '@/components/ui/StatePill';
import TaskStrip from '@/components/ui/TaskStrip';
import type { StateKey, StateTone } from '@/components/ui/states';

/** A status a person set is not a delivery state, so it is a tone pill without a glyph. */
const STATUS_TONE: Record<InitiativeStatus, StateTone> = {
  planned: 'q',
  active: 'run',
  paused: 'q',
  completed: 'ok',
  archived: 'q',
};

export function InitiativeStatusChip({ status, label }: { status: InitiativeStatus; label: string }) {
  return (
    <span data-testid="initiative-status" data-status={status} className="inline-flex shrink-0">
      <TonePill tone={STATUS_TONE[status]}>{label}</TonePill>
    </span>
  );
}

const SEGMENT_STATE: Record<InitiativeSegment['state'], StateKey> = {
  done: 'landed',
  needs_you: 'needs_you',
  // Held: paused until someone arms it.
  held: 'waiting',
  running: 'running',
  waiting: 'ready',
};

/** A mission segment as a strip display state. */
export const segmentStripState = (state: InitiativeSegment['state']): StateKey => SEGMENT_STATE[state];

/** The small box strip, one cell per mission: the progress element (replaces the old segmented bar). */
export function InitiativeStrip({ segments }: { segments: readonly InitiativeSegment[] }) {
  if (segments.length === 0) return null;
  return (
    <TaskStrip
      size="sm"
      label="Missions"
      cells={segments.map((s) => ({ id: s.missionId, state: segmentStripState(s.state), title: s.title }))}
    />
  );
}

const TEXT_ACTION =
  'inline-flex min-h-11 items-center gap-1 whitespace-nowrap font-mono text-meta text-text-secondary hover:text-text-primary hover:underline disabled:opacity-50 md:min-h-0';
/** Answering a decision is the one prominent action: ink, never an orange fill. */
const ANSWER_BTN = 'btn btn-ink h-11 md:h-8';

/** Sets an initiative's status. The one place the dashboard writes it. */
export function useSetInitiativeStatus(initiativeId: string) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function setStatus(status: InitiativeStatus) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/initiatives/${encodeURIComponent(initiativeId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Could not update the status');
      }
      startTransition(() => router.refresh());
    } catch (e: any) {
      setError(e?.message || 'Could not update the status');
    } finally {
      setBusy(false);
    }
  }
  return { setStatus, pending: busy || isPending, error };
}

function MarkCompletedButton({ initiativeId }: { initiativeId: string }) {
  const { setStatus, pending, error } = useSetInitiativeStatus(initiativeId);
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        data-testid="initiative-action"
        data-kind="mark_completed"
        onClick={() => setStatus('completed')}
        disabled={pending}
        className={TEXT_ACTION}
      >
        {pending ? 'Saving…' : 'Mark completed'}
      </button>
      {error && <span role="alert" className="font-mono text-[11px] text-status-error">{error}</span>}
    </span>
  );
}

/**
 * The initiative's next action. On a list row every action but answering is a
 * text link (`open` is dropped: the title is the link). On the initiative page
 * (`header`) only answering shows: held missions are armed from their own line,
 * and the status control and "+ New mission" cover the rest.
 */
export function InitiativeActionButton({ initiativeId, action, variant = 'row' }: { initiativeId: string; action: InitiativeAction | null; variant?: 'row' | 'header' }) {
  if (!action) return null;
  if (action.kind === 'answer') {
    return (
      <Link href={action.href ?? '#'} data-testid="initiative-action" data-kind="answer" className={ANSWER_BTN}>
        {action.label} <span aria-hidden="true">→</span>
      </Link>
    );
  }
  if (variant === 'header' || action.kind === 'open') return null;
  if (action.kind === 'mark_completed') return <MarkCompletedButton initiativeId={initiativeId} />;
  return (
    <Link href={action.href ?? '#'} data-testid="initiative-action" data-kind={action.kind} className={TEXT_ACTION}>
      {action.label} <span aria-hidden="true">→</span>
    </Link>
  );
}

function CriteriaPips({ criteria }: { criteria: { passed: number; total: number } }) {
  return (
    <span className="inline-flex items-center gap-1" title={`Goal criteria: ${criteria.passed} of ${criteria.total} pass`}>
      {Array.from({ length: Math.min(criteria.total, 6) }, (_, i) => (
        <i
          key={i}
          aria-hidden="true"
          className={`inline-block h-2 w-2 border ${i < criteria.passed ? 'border-status-success bg-status-success' : 'border-text-muted'}`}
        />
      ))}
      <span className="sr-only">criteria {criteria.passed} of {criteria.total}</span>
    </span>
  );
}

export function InitiativeMissionLines({ missions, limit, moreHref, detail = false }: { missions: readonly InitiativeMissionLine[]; limit?: number; moreHref?: string; detail?: boolean }) {
  const shown = limit ? missions.slice(0, limit) : missions;
  const hidden = missions.length - shown.length;
  if (missions.length === 0) return null;
  return (
    <ul data-testid="initiative-missions" className="divide-y divide-border-default border-t border-border-default">
      {shown.map((m) => (
        <li
          key={m.id}
          data-testid="initiative-mission"
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-2 md:grid-cols-[112px_minmax(0,1fr)_auto]"
        >
          <span className="col-span-2 md:col-span-1">
            <StatusWord label={m.statusLabel} tone={m.tone} />
          </span>
          <Link href={m.href} className="min-w-0 truncate font-mono text-[13px] text-text-primary hover:underline">
            {m.title}
          </Link>
          <span className="flex items-center justify-end gap-3 font-mono text-[12px] text-text-secondary tabular-nums">
            {m.criteria && <CriteriaPips criteria={m.criteria} />}
            {m.total > 0 && (
              <span>
                <b className="font-semibold text-text-primary">{m.done}</b>/{m.total}
              </span>
            )}
            {m.note && <span className={m.failed > 0 ? 'text-status-error' : 'text-text-muted'}>{m.note}</span>}
            {m.ask && !(detail && m.inlineQuestion) && (
              <Link href={m.ask.href} className="text-status-warning underline decoration-dotted underline-offset-2 hover:text-text-primary">
                {m.ask.label}
              </Link>
            )}
          </span>
          {detail && m.phases.length > 0 && (
            <div className="col-span-2 pb-1 pt-1.5 md:col-start-2 md:col-span-2">
              <PhaseBar phases={m.phases} size="sm" />
            </div>
          )}
          {detail && m.held && (
            <div className="col-span-2 pb-1 md:col-start-2 md:col-span-2">
              <ArmButton missionId={m.id} />
            </div>
          )}
          {detail && m.inlineQuestion && (
            <div className="col-span-2 pb-1 md:col-start-2 md:col-span-2">
              <InlineAnswer question={m.inlineQuestion} compact />
            </div>
          )}
        </li>
      ))}
      {hidden > 0 && moreHref && (
        <li className="py-2">
          <Link href={moreHref} className="font-mono text-[12px] text-text-muted hover:text-text-secondary">
            + {hidden} more {hidden === 1 ? 'mission' : 'missions'}
          </Link>
        </li>
      )}
    </ul>
  );
}

/** Owner · target · n/N missions · n/N tasks. */
export function InitiativeMeta({ card }: { card: InitiativeCardModel }) {
  const { progress } = card;
  return (
    <p data-testid="initiative-meta" className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[12px] text-text-secondary">
      {card.owner && <span>{card.owner}</span>}
      {card.owner && card.target && <span aria-hidden="true" className="text-text-muted">·</span>}
      {card.target && (
        <span data-testid="initiative-target" className={card.target.overdue ? 'font-semibold text-status-warning' : ''}>
          {card.target.label}
        </span>
      )}
      {(card.owner || card.target) && progress.total > 0 && <span aria-hidden="true" className="hidden text-text-muted sm:inline">·</span>}
      {progress.total > 0 && (
        <span data-testid="initiative-progress" className="basis-full tabular-nums sm:basis-auto">
          <b className="font-semibold text-text-primary">{progress.done}</b>/{progress.total} missions done
          {progress.tasksTotal > 0 && <span className="text-text-muted"> · {progress.tasksDone}/{progress.tasksTotal} tasks</span>}
        </span>
      )}
    </p>
  );
}

/** What needs you, one `! …` line (MissionRow's decide line); a finished initiative says so quietly. */
export function InitiativeFacts({ card }: { card: InitiativeCardModel }) {
  if (card.facts.length === 0) return null;
  return (
    <p data-testid="initiative-facts" className="flex flex-wrap gap-x-4 gap-y-1 text-body">
      {card.facts.map((f) =>
        f.href ? (
          <Link key={f.key} href={f.href} className="font-semibold text-status-warning hover:underline">
            ! {f.text}
          </Link>
        ) : (
          <span key={f.key} className={f.key === 'all_done' ? 'text-status-success' : 'text-text-muted'}>
            {f.text}
          </span>
        ),
      )}
    </p>
  );
}

/** One initiative on the list: an L1 row (hairline above, no box), the MissionRow anatomy. */
export function InitiativeRow({ card }: { card: InitiativeCardModel }) {
  return (
    <article
      data-testid="initiative-row"
      data-section={card.section}
      data-status={card.status}
      className="flex flex-col gap-1.5 border-t border-border-default py-3.5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <h3 className="min-w-0 text-title font-semibold text-text-primary [overflow-wrap:anywhere]">
            <Link href={card.href} className="hover:underline hover:decoration-[var(--border-strong)]">{card.title}</Link>
          </h3>
          <InitiativeStatusChip status={card.status} label={card.statusLabel} />
        </div>
        <span className="hidden shrink-0 sm:block">
          <InitiativeActionButton initiativeId={card.id} action={card.action} />
        </span>
      </div>
      <InitiativeFacts card={card} />
      <InitiativeStrip segments={card.segments} />
      <InitiativeMeta card={card} />
      {card.action && card.action.kind !== 'open' && (
        <div className="sm:hidden">
          <InitiativeActionButton initiativeId={card.id} action={card.action} />
        </div>
      )}
    </article>
  );
}
