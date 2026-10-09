import { Fragment } from 'react';
import { STATES, TONE_TEXT, type StateKey, type StateTone } from './states';

/** Which of Build (0) → Audit (1) → Land (2) a state sits on; 3 = all done, -1 = not started. */
export const STEP_OF: Record<StateKey, number> = {
  ready: -1, blocked: -1, queued: -1,
  running: 0, waiting: 0, failed: 0,
  review: 1, fixing: 1, recovering: 1, needs_you: 1, ci_failed: 1,
  landing: 2, not_landed: 2,
  landed: 3,
};

const STEPS = ['Build', 'Audit', 'Land'] as const;

/** Repair rounds already taken on Audit, as ` ↻N`; empty at zero. */
const rounds = (n: number | undefined) => (n ? ` ↻${n}` : '');

/** The current step's own glyph, tone and suffix: the variants (repair, paused, needs you…) live here. */
function current(state: StateKey, step: number, repairs: number | undefined): { glyph: string; tone: StateTone; extra?: string } {
  switch (state) {
    case 'fixing': return { glyph: STATES.fixing.glyph, tone: 'act', extra: ` · repair ${repairs ?? 1}` };
    case 'recovering': return { glyph: STATES.recovering.glyph, tone: 'q', extra: ` paused${rounds(repairs)}` };
    case 'needs_you': return { glyph: STATES.needs_you.glyph, tone: 'dec', extra: ` · needs you${rounds(repairs)}` };
    case 'ci_failed': return { glyph: STATES.ci_failed.glyph, tone: 'bad', extra: ` · CI failed${rounds(repairs)}` };
    case 'waiting': return { glyph: STATES.waiting.glyph, tone: 'act', extra: ' · waiting' };
    case 'failed': return { glyph: STATES.failed.glyph, tone: 'bad', extra: ' · failed' };
    case 'not_landed': return { glyph: STATES.not_landed.glyph, tone: 'bad', extra: ' · not landed' };
    case 'review':
      return { glyph: STATES.review.glyph, tone: 'run', extra: rounds(repairs) || undefined };
    default:
      return step === 0 ? { glyph: STATES.running.glyph, tone: 'act' }
        : step === 1 ? { glyph: STATES.review.glyph, tone: 'run' }
        : { glyph: STATES.landing.glyph, tone: 'ok' };
  }
}

/** One step's label: ticked when done, the state's glyph and variant when current, plain sub text later. */
function StepLabel({ name, i, at, state, repairs }: { name: string; i: number; at: number; state: StateKey; repairs?: number }) {
  if (at > i) return <span data-step={name} data-done="true" className={TONE_TEXT.ok}>✓ {name}</span>;
  if (at === i) {
    const c = current(state, i, repairs);
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
  /** One short phrase per step (Build, Audit, Land), shown under each step's label. */
  notes?: readonly [string, string, string];
  className?: string;
}

/**
 * `✓ Build → ◐ Audit → Land`: where one task is in delivery. Done steps are
 * ticked, the current step carries the state's glyph (and its variant: repair
 * count, paused, needs you), later steps are plain sub text. The one Build →
 * Audit → Land track: every surface that shows a delivery's stage draws this.
 * With `notes`, each step also carries its own phrase below the label.
 */
export default function Lifecycle({ state, repairs, notes, className = '' }: LifecycleProps) {
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
              <StepLabel name={name} i={i} at={at} state={state} repairs={repairs} />
              <span className={`[overflow-wrap:anywhere] ${at < i ? 'text-text-muted' : 'text-text-secondary'}`}>{notes[i]}</span>
            </span>
          ) : (
            <StepLabel name={name} i={i} at={at} state={state} repairs={repairs} />
          )}
        </Fragment>
      ))}
    </span>
  );
}

export { Lifecycle };
