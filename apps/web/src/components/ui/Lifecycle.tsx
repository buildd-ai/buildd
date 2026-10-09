import { Fragment } from 'react';
import { STATES, TONE_TEXT, type StateKey, type StateTone } from './states';

/** Which of Build (0) → Audit (1) → Land (2) a state sits on; 3 = all done, -1 = not started. */
const STEP_OF: Record<StateKey, number> = {
  ready: -1, blocked: -1, queued: -1,
  running: 0, waiting: 0, failed: 0,
  review: 1, fixing: 1, recovering: 1, needs_you: 1, ci_failed: 1,
  landing: 2, not_landed: 2,
  landed: 3,
};

const STEPS = ['Build', 'Audit', 'Land'] as const;

/** The current step's own glyph, tone and suffix: the variants (repair, paused, needs you…) live here. */
function current(state: StateKey, step: number, repairs: number | undefined): { glyph: string; tone: StateTone; extra?: string } {
  switch (state) {
    case 'fixing': return { glyph: STATES.fixing.glyph, tone: 'act', extra: ` · repair ${repairs ?? 1}` };
    case 'recovering': return { glyph: STATES.recovering.glyph, tone: 'q', extra: ' paused' };
    case 'needs_you': return { glyph: STATES.needs_you.glyph, tone: 'dec', extra: ' · needs you' };
    case 'ci_failed': return { glyph: STATES.ci_failed.glyph, tone: 'bad', extra: ' · CI failed' };
    case 'waiting': return { glyph: STATES.waiting.glyph, tone: 'act', extra: ' · waiting' };
    case 'failed': return { glyph: STATES.failed.glyph, tone: 'bad', extra: ' · failed' };
    case 'not_landed': return { glyph: STATES.not_landed.glyph, tone: 'bad', extra: ' · not landed' };
    default:
      return step === 0 ? { glyph: STATES.running.glyph, tone: 'act' }
        : step === 1 ? { glyph: STATES.review.glyph, tone: 'run' }
        : { glyph: STATES.landing.glyph, tone: 'ok' };
  }
}

/**
 * `✓ Build → ◐ Audit → Land`: where one task is in delivery. Done steps are
 * ticked, the current step carries the state's glyph (and its variant: repair
 * count, paused, needs you), later steps are plain sub text.
 */
export default function Lifecycle({ state, repairs, className = '' }: { state: StateKey; repairs?: number; className?: string }) {
  const at = STEP_OF[state];
  return (
    <div
      className={`flex flex-wrap items-center gap-2 font-mono text-meta ${className}`}
      data-testid="lifecycle"
      data-state={state}
      aria-label={`Lifecycle: ${STATES[state].word}`}
    >
      {STEPS.map((name, i) => {
        let node;
        if (at > i) {
          node = <span data-step={name} data-done="true" className={TONE_TEXT.ok}>✓ {name}</span>;
        } else if (at === i) {
          const c = current(state, i, repairs);
          node = (
            <span data-step={name} aria-current="step" className={`font-semibold ${TONE_TEXT[c.tone]}`}>
              {c.glyph} {name}{c.extra}
            </span>
          );
        } else {
          node = <span data-step={name} className="text-text-muted">{name}</span>;
        }
        return (
          <Fragment key={name}>
            {i > 0 && <span aria-hidden="true" className="text-[var(--faint)]">→</span>}
            {node}
          </Fragment>
        );
      })}
    </div>
  );
}

export { Lifecycle };
