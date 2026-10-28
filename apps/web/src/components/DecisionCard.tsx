'use client';

/**
 * The one decision card (Navigation d25d923d R-16): a decision or approval a
 * person must give, the same on the mission page, the task page and Home.
 *
 * ```
 * ● Mirror the runner image to Docker Hub · asked 4m ago
 * CI has no Docker Hub secrets, so every release skips the image mirror.
 * Waits on this: The release publishes an image digest, then A runner bundle.
 * How should Docker Hub credentials be set up?
 * [Provide a token ⌘⏎            ] [I'll set them myself        ]
 *  Stored as a team secret          Resumes when CI sees them
 *  Finishes the task: The release…  Keeps working: The release…
 * Answer differently                                     Not now
 * Expires in 3 hours 30 minutes, then the task starts again and the agent goes with Provide a token.
 * ```
 *
 * What waits on the answer (Living Spec 1b257609) fills three of these lines
 * and adds none: the summary's `Waits on this:` clause, each option's effect
 * under its consequence, and the footer's expiry. All three come from the
 * view's `waits` (the projection) through packages/core/question-waits.ts.
 *
 * The view is data (`lib/needs-you-card.ts`); this draws it and records the
 * answer: a parked worker through the one answer path every surface shares
 * (`useAnswerSubmit`), an organizer's note through the mission's reply
 * route, an approval by linking to where it is decided. After an answer the
 * card collapses to `You chose <option> · <when>`. ⌘⏎ (Ctrl⏎) picks the
 * focused card's primary option, never on an approval.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Kbd } from '@/components/KeyHints';
import { useAnswerSubmit } from '@/app/app/(protected)/tasks/[id]/respond/use-answer-submit';
import { answerOutcomeLines } from '@/app/app/(protected)/tasks/[id]/respond/submit-answer';
import { askedAgo, type DecisionOption, type DecisionView } from '@/lib/needs-you-card';
import { waitsFooter, waitsSummary } from '@buildd/core/question-waits';
import WaitsParts from '@/components/WaitsParts';

export interface DecisionCardProps {
  view: DecisionView;
  /** Server time at render; the card ticks from it. */
  now: number;
  /** After the answer is recorded (the host refreshes or folds the card). */
  onAnswered?: (label: string) => void;
  /** After Not now (the host hides the card). Absent: the card folds to one line itself. */
  onNotNow?: () => void;
  /** Acts on a visual-review option (`missions/[id]/visual-decision-act.ts`); throws with the reason on a refusal. */
  visualAct?: (label: string) => Promise<void>;
  /** The mission whose page this is: a subject naming it is left out (the page already says so). */
  pageMissionId?: string;
  /** Extra attributes on the article (a surface's own test id). */
  testId?: string;
}

// `.btn` is one nowrap line; an option carries its effect too, so it wraps inside the card on a phone.
const PRIMARY = 'btn btn-ink h-auto min-h-11 min-w-0 max-w-full whitespace-normal flex-col items-start gap-0.5 px-3.5 py-2 text-left';
const SECONDARY = 'btn h-auto min-h-11 min-w-0 max-w-full whitespace-normal flex-col items-start gap-0.5 px-3.5 py-2 text-left';
const TEXT_BUTTON = 'inline-flex min-h-11 items-center text-body text-text-secondary underline-offset-4 hover:text-text-primary hover:underline md:min-h-0';

function useNow(serverNow: number): number {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return Math.max(now, serverNow);
}

/** The option's button: label, its one-line effect, and on desktop a tip above it on hover or focus. */
function OptionButton({ option, primary, shortcut, href, onPick, disabled, pending }: {
  option: DecisionOption; primary: boolean; shortcut: boolean; href?: string; onPick?: () => void; disabled?: boolean; pending?: boolean;
}) {
  const tipId = useId();
  const body = (
    <>
      <span className="flex items-center gap-2 font-semibold">
        {pending ? 'Sending…' : option.label}
        {primary && shortcut && <Kbd tone="accent">⌘⏎</Kbd>}
      </span>
      {/* The effect inherits the button's own ink (on-ink on the primary), so both themes keep it readable. */}
      {option.effect && <span data-testid="decision-option-effect" className={`text-meta font-normal [overflow-wrap:anywhere] ${primary ? 'opacity-80' : 'text-text-muted'}`}>{option.effect}</span>}
      {option.downstream && <span data-testid="decision-option-downstream" className={`text-meta font-normal [overflow-wrap:anywhere] ${primary ? 'opacity-80' : 'text-text-muted'}`}>{option.downstream}</span>}
    </>
  );
  // Fills its share of the row: two options side by side when they fit, stacked at 320.
  const cls = `${primary ? PRIMARY : SECONDARY} w-full [overflow-wrap:anywhere]`;
  return (
    <span className="group relative flex min-w-0 max-w-full flex-[1_1_10rem]">
      {href
        ? <a href={href} data-testid="decision-option" data-primary={primary || undefined} aria-describedby={option.tip ? tipId : undefined} className={cls}>{body}</a>
        : (
          <button
            type="button"
            data-testid="decision-option"
            data-primary={primary || undefined}
            aria-describedby={option.tip ? tipId : undefined}
            aria-keyshortcuts={primary && shortcut ? 'Meta+Enter Control+Enter' : undefined}
            disabled={disabled}
            onClick={onPick}
            className={cls}
          >
            {body}
          </button>
        )}
      {option.tip && (
        // Above the button, desktop only, on hover or focus (R-16).
        <span
          id={tipId}
          role="tooltip"
          data-testid="decision-option-tip"
          className="card pointer-events-none absolute bottom-full left-0 z-10 mb-2 hidden w-72 max-w-[80vw] p-3 text-body text-text-secondary md:group-hover:block md:group-focus-within:block"
        >
          {option.tip}
        </span>
      )}
    </span>
  );
}

export default function DecisionCard({ view, now: serverNow, onAnswered, onNotNow, pageMissionId, visualAct, testId }: DecisionCardProps) {
  const router = useRouter();
  const now = useNow(serverNow);
  const [more, setMore] = useState(false);
  const [differently, setDifferently] = useState(false);
  const [text, setText] = useState('');
  const [later, setLater] = useState(false);
  const [noteOutcome, setNoteOutcome] = useState<{ label: string; at: number } | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [noteSending, setNoteSending] = useState<string | null>(null);

  const worker = view.answer.kind === 'worker' ? view.answer : null;
  const submit = useAnswerSubmit({
    workerId: worker?.workerId ?? null,
    taskId: worker?.taskId ?? null,
    noteId: worker?.noteId ?? null,
    resetKey: view.key,
    onAnswered: (o) => { onAnswered?.(o.answer); router.refresh(); },
  });

  const answerNote = useCallback(async (label: string) => {
    if (view.answer.kind !== 'note' || noteSending) return;
    setNoteSending(label);
    setNoteError(null);
    try {
      const res = await fetch(`/api/missions/${encodeURIComponent(view.answer.missionId)}/notes/${encodeURIComponent(view.answer.noteId)}/reply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ type: 'reply', title: label }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error || 'Could not record the answer.');
      }
      setNoteOutcome({ label, at: Date.now() });
      onAnswered?.(label);
      router.refresh();
    } catch (e) {
      setNoteError(e instanceof Error ? e.message : 'Could not reach buildd.');
    } finally {
      setNoteSending(null);
    }
  }, [view.answer, noteSending, onAnswered, router]);

  // The visual review's options act through the host's handler (mission code the shared card cannot import).
  const answerVisual = useCallback(async (label: string) => {
    if (view.answer.kind !== 'visual' || !visualAct || noteSending) return;
    setNoteSending(label);
    setNoteError(null);
    try {
      await visualAct(label);
      if (label !== 'Review screens') {
        setNoteOutcome({ label, at: Date.now() });
        onAnswered?.(label);
        router.refresh();
      }
    } catch (e) {
      setNoteError(e instanceof Error ? e.message : 'Could not reach buildd.');
    } finally {
      setNoteSending(null);
    }
  }, [view.answer.kind, visualAct, noteSending, onAnswered, router]);
  // The criteria escalation: waiving completes the mission (the filing option is a link).
  const waive = useCallback(async (label: string) => {
    if (view.answer.kind !== 'criteria' || noteSending) return;
    setNoteSending(label);
    setNoteError(null);
    try {
      const res = await fetch(`/api/missions/${encodeURIComponent(view.answer.missionId)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ status: 'completed' }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error || 'Could not complete the mission. Try again.');
      }
      setNoteOutcome({ label, at: Date.now() });
      onAnswered?.(label);
      router.refresh();
    } catch (e) {
      setNoteError(e instanceof Error ? e.message : 'Could not reach buildd.');
    } finally {
      setNoteSending(null);
    }
  }, [view.answer, noteSending, onAnswered, router]);

  // The criteria escalation's Answer differently: the person's words become a task on the
  // mission, which clears the escalation the way filing the work does (POST /api/tasks).
  const fileAnswer = useCallback(async (text: string) => {
    if (view.answer.kind !== 'criteria' || !view.answer.workspaceId || noteSending) return;
    setNoteSending(text);
    setNoteError(null);
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ workspaceId: view.answer.workspaceId, missionId: view.answer.missionId, title: text.length > 120 ? `${text.slice(0, 119)}…` : text, description: text }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error || 'Could not file the answer. Try again.');
      }
      setNoteOutcome({ label: text, at: Date.now() });
      onAnswered?.(text);
      router.refresh();
    } catch (e) {
      setNoteError(e instanceof Error ? e.message : 'Could not reach buildd.');
    } finally {
      setNoteSending(null);
    }
  }, [view.answer, noteSending, onAnswered, router]);

  const pick = useCallback((label: string) => {
    if (view.answer.kind === 'worker') void submit.submit(label);
    else if (view.answer.kind === 'note') void answerNote(label);
    else if (view.answer.kind === 'visual') void answerVisual(label);
    else if (view.answer.kind === 'criteria') void (view.options.some(o => o.label === label) ? waive(label) : fileAnswer(label));
  }, [view.answer.kind, view.options, submit, answerNote, answerVisual, waive, fileAnswer]);

  const primary = view.options[0] ?? null;
  const sending = submit.sending ?? noteSending;
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    // The shortcut applies to this card's primary only while focus is inside it, never on an approval.
    if (!view.shortcut || !primary || view.answer.kind === 'link' || view.answer.kind === 'criteria') return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !sending) {
      e.preventDefault();
      pick(primary.label);
    }
  };

  const subject: ReactNode = view.task
    ? <Link href={view.task.href} className="underline-offset-4 hover:underline">{view.task.title}</Link>
    : view.mission && view.mission.id !== pageMissionId
      ? <Link href={view.mission.href} className="underline-offset-4 hover:underline">{view.mission.title}</Link>
      : view.label ?? (view.mission ? 'This mission' : null);
  const age = askedAgo(view.askedAt, now);
  const waitsParts = view.waits ? waitsSummary(view.waits) : [];
  const footer = view.waits ? waitsFooter(view.waits, now) : null;

  const cardRef = useRef<HTMLElement | null>(null);
  const answeredRef = useRef(false);

  // Collapsed: answered, or set aside.
  const chosen = submit.outcome
    ? (submit.outcome.kind === 'sent' ? submit.outcome.answer : submit.outcome.recordedAnswer ?? submit.outcome.answer)
    : noteOutcome?.label ?? null;
  // Once answered, focus moves to the next item that still needs the person.
  const isAnswered = chosen != null;
  useEffect(() => {
    if (!isAnswered || answeredRef.current) return;
    answeredRef.current = true;
    const el = cardRef.current;
    if (!el) return;
    // Any decision card, whatever its testId (the home feed uses its own), still open: the next after this one, else the first.
    const open = Array.from(document.querySelectorAll<HTMLElement>('article[data-kind]:not([data-answered]):not([data-later])'));
    const next = open.find(c => !!(el.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING)) ?? open[0];
    next?.querySelector<HTMLElement>('button, a[href]')?.focus();
  }, [isAnswered]);
  if (chosen != null) {
    const lines = submit.outcome ? answerOutcomeLines(submit.outcome) : null;
    const already = submit.outcome?.kind === 'already_answered';
    return (
      <article ref={cardRef} data-testid={testId ?? 'decision-card'} data-kind={view.kind} data-answered="true" className="flex min-w-0 flex-col gap-1 border-t border-[var(--line-soft)] py-3 text-body">
        <p className="text-text-primary [overflow-wrap:anywhere]">
          {already ? 'Already answered' : 'You chose'} <span className="font-semibold">{chosen}</span> · just now
        </p>
        {lines?.detail && <p className="text-meta text-text-muted [overflow-wrap:anywhere]">{lines.detail}</p>}
      </article>
    );
  }
  if (later) {
    return (
      <p data-testid={testId ?? 'decision-card'} data-kind={view.kind} data-later="true" className="flex min-w-0 items-baseline gap-2 border-t border-[var(--line-soft)] py-3 text-body text-text-secondary">
        <span className="shrink-0 text-text-muted">Not now</span>
        <span className="min-w-0 truncate">{subject ?? view.question}</span>
        <button type="button" onClick={() => setLater(false)} className={`${TEXT_BUTTON} ml-auto shrink-0`}>Show</button>
      </p>
    );
  }

  const error = submit.error?.message ?? noteError;
  return (
    <article
      data-testid={testId ?? 'decision-card'}
      data-kind={view.kind}
      data-task-id-ref={view.task?.id}
      aria-label={view.kind === 'approval' ? 'Approval required' : 'Your decision'}
      onKeyDown={onKeyDown}
      className="card-decision flex min-w-0 flex-col gap-2.5 p-4 md:px-5"
    >
      <p data-testid="question-subject" className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-meta font-medium text-status-warning">
        <span aria-hidden="true">●</span>
        {subject}
        {age && <span className="text-text-muted">· {age}</span>}
      </p>
      <h3 data-testid="decision-question" className="text-title font-semibold text-text-primary [overflow-wrap:anywhere]">{view.question}</h3>
      {(view.summary || waitsParts.length > 0) && (
        <p data-testid="decision-summary" className="min-w-0 text-body text-text-secondary [overflow-wrap:anywhere]">
          <span className={more ? '' : 'line-clamp-2 md:line-clamp-none'}>
            {view.summary}
            {waitsParts.length > 0 && (
              <span data-testid="decision-waits">{view.summary ? ' ' : ''}<WaitsParts parts={waitsParts} /></span>
            )}
            {view.diffHref && <> <a href={view.diffHref} data-testid="decision-diff" className="whitespace-nowrap text-text-primary underline-offset-4 hover:underline">View diff ↗</a></>}
          </span>
          {!more && (
            <button type="button" onClick={() => setMore(true)} className={`${TEXT_BUTTON} md:hidden`}>More</button>
          )}
        </p>
      )}
      {view.options.length > 0 && (
        <div data-testid="decision-options" className="flex flex-wrap gap-2.5">
          {view.options.map((o, i) => (
            <OptionButton
              key={o.label}
              option={o}
              primary={i === 0}
              shortcut={view.shortcut}
              href={view.answer.kind === 'link' ? (i === 0 ? view.answer.primaryHref : view.answer.secondaryHref) : view.answer.kind === 'criteria' && i === 0 ? view.answer.fileWorkHref : undefined}
              onPick={() => pick(o.label)}
              disabled={!!sending}
              pending={sending === o.label}
            />
          ))}
        </div>
      )}
      {differently && view.answer.kind === 'visual' ? (
        <div data-testid="decision-skips" className="flex flex-wrap gap-2.5">
          {view.answer.skips.map(label => (
            <button key={label} type="button" data-testid="decision-skip" disabled={!!sending} onClick={() => pick(label)} className="btn min-h-11 md:min-h-9">
              {sending === label ? 'Saving…' : label}
            </button>
          ))}
        </div>
      ) : differently ? (
        <form
          data-testid="decision-answer-form"
          className="flex flex-wrap gap-2"
          onSubmit={e => { e.preventDefault(); if (text.trim()) pick(text.trim()); }}
        >
          <input
            value={text}
            onChange={e => setText(e.target.value)}
            aria-label="Your answer"
            placeholder="Your answer…"
            autoFocus={differently}
            disabled={!!sending}
            className="min-h-11 min-w-0 flex-1 border border-border-default bg-surface-1 px-3 text-body text-text-primary placeholder:text-text-muted md:min-h-9"
          />
          <button type="submit" disabled={!!sending || !text.trim()} className="btn btn-ink min-h-11 md:min-h-9">{sending && sending === text.trim() ? 'Sending…' : 'Send'}</button>
        </form>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-x-4">
        {view.answer.kind === 'link' || (view.answer.kind === 'criteria' && !view.answer.workspaceId)
          ? <span />
          : !differently
            ? <button type="button" data-testid="decision-answer-differently" onClick={() => setDifferently(true)} className={TEXT_BUTTON}>Answer differently</button>
            : <span />}
        <button type="button" data-testid="decision-not-now" onClick={() => (onNotNow ? onNotNow() : setLater(true))} className={TEXT_BUTTON}>Not now</button>
      </div>
      {footer && <p data-testid="decision-expiry" className="text-meta text-text-muted [overflow-wrap:anywhere]" suppressHydrationWarning>{footer}</p>}
      {error && <p role="alert" className="text-meta text-status-error [overflow-wrap:anywhere]">{error}</p>}
    </article>
  );
}

export { DecisionCard };
