import { Fragment } from 'react';
import { STATES, TONE_TEXT, type StateKey, type StateTone } from './states';

/** Which of Build (0) → Verify (1) → Deliver (2) a state sits on; 3 = all done, -1 = not started. */
export const STEP_OF: Record<StateKey, number> = {
  ready: -1, blocked: -1, queued: -1,
  running: 0, waiting: 0, failed: 0,
  review: 1, fixing: 1, recovering: 1, needs_you: 1, ci_failed: 1,
  landing: 2, not_landed: 2,
  landed: 3,
};

const STEPS = ['Build', 'Verify', 'Deliver'] as const;

/** Repair rounds already taken in Verify, as ` ↻N`; empty at zero. */
const rounds = (n: number | undefined) => (n ? ` ↻${n}` : '');

/** The current step's own glyph, tone and suffix: the variants (repair, paused, needs you…) live here. */
function current(state: StateKey, step: number, repairs: number | undefined): { glyph: string; tone: StateTone; extra?: string } {
  switch (state) {
    case 'fixing': return { glyph: STATES.fixing.glyph, tone: 'act', extra: ` · repair ${repairs ?? 1}` };
    case 'recovering': return { glyph: STATES.recovering.glyph, tone: 'q', extra: ` paused${rounds(repairs)}` };
    case 'needs_you': return { glyph: STATES.needs_you.glyph, tone: 'dec', extra: ` · waiting on you${rounds(repairs)}` };
    case 'ci_failed': return { glyph: STATES.ci_failed.glyph, tone: 'bad', extra: ` · CI failed${rounds(repairs)}` };
    case 'waiting': return { glyph: STATES.waiting.glyph, tone: 'act', extra: ' · waiting' };
    case 'failed': return { glyph: STATES.failed.glyph, tone: 'bad', extra: ' · failed' };
    case 'not_landed': return { glyph: STATES.not_landed.glyph, tone: 'bad', extra: ' · closed without merging' };
    case 'review':
      return { glyph: STATES.review.glyph, tone: 'run', extra: rounds(repairs) || undefined };
    default:
      return step === 0 ? { glyph: STATES.running.glyph, tone: 'act' }
        : step === 1 ? { glyph: STATES.review.glyph, tone: 'run' }
        : { glyph: STATES.landing.glyph, tone: 'ok' };
  }
}

/** One step's label: ticked when done, the state's glyph and variant when current, plain sub text later. */
function StepLabel({ name, i, at, state, repairs, phrase }: { name: string; i: number; at: number; state: StateKey; repairs?: number; phrase?: string | null }) {
  if (at > i) return <span data-step={name} data-done="true" className={TONE_TEXT.ok}>✓ {name}</span>;
  if (at === i) {
    const c = current(state, i, repairs);
    // The delivery's own phrase (task-page State mapping) says what the step is doing.
    if (phrase) c.extra = ` · ${phrase}`;
    return (
      <span data-step={name} aria-current="step" className={`font-semibold ${TONE_TEXT[c.tone]}`}>
        {c.glyph} {name}{c.extra}
      </span>
    );
  }
  return <span data-step={name} className="text-text-muted">{name}</span>;
}

export interface LifecycleProps {
  state: StateKey;
  /** Repair rounds: on `fixing` it reads `repair N`; on `review` the rounds already taken (`↻N`). */
  repairs?: number;
  /**
   * What the current step is doing, in the delivery's words ("updating branch",
   * "awaiting merge"). Replaces the state's own variant, so a refresh or a review
   * never reads as "repair N".
   */
  phrase?: string | null;
  /** One short phrase per step (Build, Verify, Deliver), shown under each step's label. */
  notes?: readonly [string, string, string];
  /**
   * `line`: `Build ✓  Verify  Deliver` on one line at 320px. No arrows, no
   * glyph or variant on the current step (the card's status line says it);
   * only the current step takes colour. Default `track`.
   */
  variant?: 'track' | 'line';
  className?: string;
}

/** A closed, unshipped delivery is not a failure: on the line it reads neutral. */
const LINE_TONE: Partial<Record<StateKey, StateTone>> = { not_landed: 'q' };

function LifecycleLine({ state, className }: { state: StateKey; className: string }) {
  const at = STEP_OF[state];
  const tone = LINE_TONE[state] ?? current(state, Math.max(0, at), undefined).tone;
  return (
    <span
      className={`flex items-center gap-3 whitespace-nowrap font-mono text-meta ${className}`}
      data-testid="lifecycle"
      data-variant="line"
      data-state={state}
      aria-label={`Lifecycle: ${STATES[state].word}`}
    >
      {STEPS.map((name, i) => (
        at > i ? <span key={name} data-step={name} data-done="true" className="text-text-secondary">{name} ✓</span>
          : at === i ? <span key={name} data-step={name} aria-current="step" className={`font-semibold ${TONE_TEXT[tone]}`}>{name}</span>
          : <span key={name} data-step={name} className="text-text-muted">{name}</span>
      ))}
    </span>
  );
}

/**
 * `✓ Build → ◐ Verify → Deliver`: where one task is in delivery. Done steps are
 * ticked, the current step carries the state's glyph (and its variant: repair
 * count, paused, needs you), later steps are plain sub text. The one Build →
 * Verify → Deliver track: every surface that shows a delivery's stage draws this.
 * With `notes`, each step also carries its own phrase below the label.
 */
export default function Lifecycle({ state, repairs, phrase, notes, variant = 'track', className = '' }: LifecycleProps) {
  if (variant === 'line') return <LifecycleLine state={state} className={className} />;
  const at = STEP_OF[state];
  return (
    <span
      className={`flex flex-wrap ${notes ? 'items-start gap-x-3 gap-y-2' : 'items-center gap-2'} font-mono text-meta ${className}`}
      data-testid="lifecycle"
      data-state={state}
      aria-label={`Lifecycle: ${STATES[state].word}`}
    >
      {STEPS.map((name, i) => (
        <Fragment key={name}>
          {i > 0 && <span aria-hidden="true" className="text-[var(--faint)]">→</span>}
          {notes ? (
            <span
              data-testid="lifecycle-step"
              data-stage={name.toLowerCase()}
              data-state={at > i ? 'done' : at === i ? 'current' : 'later'}
              className="flex min-w-0 flex-1 flex-col"
            >
              <StepLabel name={name} i={i} at={at} state={state} repairs={repairs} phrase={phrase} />
              <span className={`[overflow-wrap:anywhere] ${at < i ? 'text-text-muted' : 'text-text-secondary'}`}>{notes[i]}</span>
            </span>
          ) : (
            <StepLabel name={name} i={i} at={at} state={state} repairs={repairs} phrase={phrase} />
          )}
        </Fragment>
      ))}
    </span>
  );
}

export { Lifecycle };
