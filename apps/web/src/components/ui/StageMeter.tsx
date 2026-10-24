import type { CSSProperties } from 'react';

export type StageMeterStage = 'build' | 'verify' | 'deliver';

export type StageMeterState =
  | 'queued'
  | 'build'
  | 'fixing-in-build'
  | 'verify'
  | 'fixing-in-verify'
  | 'check-cant-run'
  | 'waiting-on-you'
  | 'deliver';

export const STAGE_METER_STATES: readonly StageMeterState[] = [
  'queued', 'build', 'fixing-in-build', 'verify', 'fixing-in-verify', 'check-cant-run', 'waiting-on-you', 'deliver',
];

export interface StageMeterProps {
  /**
   * The stage the delivery is in. Optional: each of build, fixing-in-build,
   * verify, fixing-in-verify and deliver implies its own. Give it for queued,
   * check-cant-run and waiting-on-you, which can sit at any stage (default `build`).
   */
  stage?: StageMeterStage;
  state: StageMeterState;
  /** Fix rounds so far; shown as ↻N on the fixing states (and ignored elsewhere). */
  fixRounds?: number;
  /** Replaces the default accessible name. */
  label?: string;
  className?: string;
  'data-testid'?: string;
}

/** How one segment is drawn. Each is a different shape, never only a different colour. */
export type StageSegmentPattern = 'done' | 'empty' | 'dashed' | 'solid' | 'hatch' | 'outline' | 'alert';

const STAGES: readonly StageMeterStage[] = ['build', 'verify', 'deliver'];
const STAGE_WORD: Record<StageMeterStage, string> = { build: 'Build', verify: 'Verify', deliver: 'Deliver' };

const IMPLIED_STAGE: Partial<Record<StageMeterState, StageMeterStage>> = {
  build: 'build', 'fixing-in-build': 'build', verify: 'verify', 'fixing-in-verify': 'verify', deliver: 'deliver',
};

/** The pattern the current segment takes in each state. Done segments are always `done`, later ones `empty`. */
const CURRENT_PATTERN: Record<StageMeterState, StageSegmentPattern> = {
  queued: 'dashed',
  build: 'solid',
  'fixing-in-build': 'hatch',
  verify: 'solid',
  'fixing-in-verify': 'hatch',
  'check-cant-run': 'outline',
  'waiting-on-you': 'alert',
  deliver: 'solid',
};

/** The mark printed inside the current segment, so a state reads with colour removed. */
function markFor(state: StageMeterState, fixRounds: number): string {
  switch (state) {
    case 'fixing-in-build':
    case 'fixing-in-verify': return fixRounds > 0 ? `↻${fixRounds}` : '↻';
    case 'check-cant-run': return '?';
    case 'waiting-on-you': return '!';
    default: return '';
  }
}

const STATE_PHRASE: Record<StageMeterState, string> = {
  queued: 'Queued',
  build: 'Building',
  'fixing-in-build': 'Being fixed in build',
  verify: 'Verifying',
  'fixing-in-verify': 'Being fixed in verify',
  'check-cant-run': "Check can't run",
  'waiting-on-you': 'Waiting on you',
  deliver: 'Delivering',
};

export function stageMeterName(state: StageMeterState, stage: StageMeterStage, fixRounds = 0): string {
  const rounds = (state === 'fixing-in-build' || state === 'fixing-in-verify') && fixRounds > 0
    ? `, fix round ${fixRounds}`
    : '';
  const at = IMPLIED_STAGE[state] ? '' : `, at ${STAGE_WORD[stage].toLowerCase()}`;
  return `${STATE_PHRASE[state]}${at}${rounds}`;
}

const HATCH = 'repeating-linear-gradient(135deg, var(--act-hatch) 0 2px, transparent 2px 5px)';

function segmentStyle(p: StageSegmentPattern, state: StageMeterState): CSSProperties {
  switch (p) {
    case 'done': return { background: 'var(--faint)', borderColor: 'var(--faint)' };
    case 'solid': return state === 'deliver'
      ? { background: 'var(--status-success)', borderColor: 'var(--status-success)' }
      : { background: 'var(--accent)', borderColor: 'var(--accent)' };
    case 'hatch': return { backgroundColor: 'var(--accent-soft)', backgroundImage: HATCH, borderColor: 'var(--act-hatch)', color: 'var(--accent-text)' };
    case 'outline': return { borderColor: 'var(--text-primary)', borderWidth: 2, borderStyle: 'solid', color: 'var(--text-primary)' };
    case 'alert': return { background: 'var(--status-error)', borderColor: 'var(--status-error)', color: 'var(--on-ink)' };
    case 'dashed': return { borderColor: 'var(--text-secondary)', borderStyle: 'dashed' };
    default: return { borderColor: 'var(--border-strong)' };
  }
}

/**
 * Where a delivery is: Build / Verify / Deliver as three segments. Earlier
 * stages are grey, the current one is drawn by state, later ones are empty.
 * Every state differs by shape (solid, hatch, dashed, outline, filled with a
 * mark), so the meter survives greyscale. Read as one image with an accessible
 * name; the segments are decoration. Spec 9430a28f r2 R-9.
 */
export default function StageMeter({ stage, state, fixRounds = 0, label, className = '', 'data-testid': testId }: StageMeterProps) {
  const current = IMPLIED_STAGE[state] ?? stage ?? 'build';
  const at = STAGES.indexOf(current);
  const mark = markFor(state, fixRounds);
  return (
    <span
      role="img"
      aria-label={label ?? stageMeterName(state, current, fixRounds)}
      className={`inline-flex items-stretch gap-[2px] align-middle ${className}`}
      data-state={state}
      data-stage={current}
      data-testid={testId}
    >
      {STAGES.map((s, i) => {
        const pattern: StageSegmentPattern = i < at ? 'done' : i === at ? CURRENT_PATTERN[state] : 'empty';
        const here = i === at;
        return (
          <span
            key={s}
            aria-hidden="true"
            data-segment={s}
            data-pattern={pattern}
            data-mark={here && mark ? mark : undefined}
            className={`flex h-[14px] items-center justify-center border font-mono text-[10px] leading-none rounded-[3px] ${here && mark ? 'min-w-[30px] px-1' : 'w-[22px]'}`}
            style={segmentStyle(pattern, state)}
          >
            {here ? mark : null}
          </span>
        );
      })}
    </span>
  );
}
