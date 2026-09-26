'use client';

/**
 * The initiative card (model: lib/initiative-view.ts), used by the Initiatives
 * list, plus the pieces the initiative page reuses: the status chip, the
 * mission-segmented bar, the next-action button and the mission lines.
 *
 * Anatomy: status + title + next action; owner · target · n/N missions; one bar
 * segment per mission; the facts that need you, each a link; its missions.
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

const STATUS_CHIP: Record<InitiativeStatus, string> = {
  planned: 'border-border-strong text-text-secondary',
  active: 'border-accent text-accent-text',
  paused: 'border-border-default text-text-muted',
  completed: 'border-status-success text-status-success',
  archived: 'border-border-default text-text-muted',
};

export function InitiativeStatusChip({ status, label }: { status: InitiativeStatus; label: string }) {
  return (
    <span
      data-testid="initiative-status"
      data-status={status}
      className={`inline-flex shrink-0 items-center border px-1.5 py-[3px] font-mono text-[11px] md:text-[10px] font-bold uppercase leading-none tracking-[1.5px] ${STATUS_CHIP[status]}`}
    >
      {label}
    </span>
  );
}

const SEGMENT_BOX: Record<InitiativeSegment['state'], string> = {
  done: 'border-status-success bg-status-success',
  needs_you: 'border-status-warning',
  held: 'border-dashed border-status-warning',
  running: 'border-accent',
  waiting: 'border-border-strong',
};
const SEGMENT_FILL: Record<InitiativeSegment['state'], string> = {
  done: 'bg-status-success',
  needs_you: 'bg-status-warning',
  held: 'bg-status-warning/40',
  running: 'bg-accent',
  waiting: 'bg-text-muted',
};
const SEGMENT_WORD: Record<InitiativeSegment['state'], string> = {
  done: 'done',
  needs_you: 'needs you',
  held: 'held',
  running: 'running',
  waiting: 'not started',
};

/** One segment per mission: a done mission is solid, an open one fills to its tasks done. */
export function InitiativeBar({ segments, size = 'md' }: { segments: readonly InitiativeSegment[]; size?: 'md' | 'lg' }) {
  if (segments.length === 0) return null;
  const h = size === 'lg' ? 'h-[14px]' : 'h-[10px]';
  return (
    <div data-testid="initiative-bar" className="flex min-w-0 gap-[3px]">
      {segments.map((s) => (
        <Link
          key={s.missionId}
          href={s.href}
          data-testid="initiative-bar-segment"
          data-state={s.state}
          aria-label={`${s.title}: ${SEGMENT_WORD[s.state]}`}
          title={`${s.title} · ${SEGMENT_WORD[s.state]}${s.state !== 'done' && s.fill > 0 ? ` · ${Math.round(s.fill * 100)}% of tasks` : ''}`}
          className={`relative block min-w-[10px] flex-1 overflow-hidden border ${h} ${SEGMENT_BOX[s.state]} hover:opacity-90`}
        >
          {s.state !== 'done' && s.fill > 0 && (
            <span aria-hidden="true" className={`absolute inset-y-0 left-0 ${SEGMENT_FILL[s.state]}`} style={{ width: `${Math.round(s.fill * 100)}%` }} />
          )}
        </Link>
      ))}
    </div>
  );
}

const PRIMARY_BTN =
  'inline-flex min-h-11 items-center gap-1 whitespace-nowrap border-2 border-primary bg-primary px-3.5 font-mono text-[12px] font-semibold text-white shadow-sm transition-colors hover:bg-primary-hover disabled:opacity-50 md:min-h-9';
const QUIET_BTN =
  'inline-flex min-h-11 items-center gap-1 whitespace-nowrap border-2 border-border-strong bg-surface-3 px-3.5 font-mono text-[12px] font-semibold text-text-primary transition-colors hover:bg-surface-4 md:min-h-9';

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
        className={PRIMARY_BTN}
      >
        {pending ? 'Saving…' : 'Mark completed'}
      </button>
      {error && <span role="alert" className="font-mono text-[11px] text-status-error">{error}</span>}
    </span>
  );
}

export function InitiativeActionButton({ initiativeId, action }: { initiativeId: string; action: InitiativeAction | null }) {
  if (!action) return null;
  if (action.kind === 'mark_completed') return <MarkCompletedButton initiativeId={initiativeId} />;
  if (action.kind === 'arm' && action.missionId) return <ArmButton missionId={action.missionId} />;
  return (
    <Link
      href={action.href ?? '#'}
      data-testid="initiative-action"
      data-kind={action.kind}
      className={action.kind === 'open' ? QUIET_BTN : PRIMARY_BTN}
    >
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

export function InitiativeFacts({ card }: { card: InitiativeCardModel }) {
  if (card.facts.length === 0) return null;
  return (
    <p data-testid="initiative-facts" className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[12.5px]">
      {card.facts.map((f) =>
        f.href ? (
          <Link key={f.key} href={f.href} className="text-status-warning underline decoration-dotted underline-offset-2 hover:text-text-primary">
            {f.text}
          </Link>
        ) : (
          <span key={f.key} className={f.key === 'all_done' ? 'text-status-success' : 'text-text-secondary'}>
            {f.text}
          </span>
        ),
      )}
    </p>
  );
}

const SECTION_EDGE: Record<InitiativeCardModel['section'], string> = {
  needs_you: 'border-l-status-warning',
  active: 'border-l-accent',
  planned: 'border-l-border-strong',
  paused: 'border-l-border-default',
  completed: 'border-l-status-success',
};

export function InitiativeCard({ card }: { card: InitiativeCardModel }) {
  return (
    <article
      data-testid="initiative-card"
      data-section={card.section}
      data-status={card.status}
      className={`card border-l-[6px] px-4 py-4 md:px-5 ${SECTION_EDGE[card.section]}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2.5">
            <InitiativeStatusChip status={card.status} label={card.statusLabel} />
            <h3 className="min-w-0 font-mono text-[15px] font-semibold leading-tight tracking-[-0.2px] text-text-primary md:text-[17px]">
              <Link href={card.href} className="line-clamp-2 hover:underline sm:line-clamp-1">{card.title}</Link>
            </h3>
          </div>
          <div className="mt-1.5">
            <InitiativeMeta card={card} />
          </div>
        </div>
        <span className="hidden shrink-0 sm:block">
          <InitiativeActionButton initiativeId={card.id} action={card.action} />
        </span>
      </div>

      {card.segments.length > 0 && (
        <div className="mt-3.5">
          <InitiativeBar segments={card.segments} />
        </div>
      )}

      {card.facts.length > 0 && (
        <div className="mt-3">
          <InitiativeFacts card={card} />
        </div>
      )}

      {card.action && (
        <div className="mt-3 sm:hidden">
          <InitiativeActionButton initiativeId={card.id} action={card.action} />
        </div>
      )}

      {card.missions.length > 0 && (
        <div className="mt-3.5">
          <InitiativeMissionLines missions={card.missions} limit={4} moreHref={card.href} />
        </div>
      )}
    </article>
  );
}
