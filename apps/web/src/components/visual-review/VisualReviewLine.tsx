/**
 * The visual audit in one line (docs/design/visual-qa-human-review.md,
 * part 2): the phase label, an optional detail sentence, and one square dot
 * per current screen. A dot is coloured by the effective verdict (the human
 * decision where there is one); a decided dot carries a tick, and an unsure
 * screen nobody has decided is hollow.
 *
 * Every surface that states the phase renders this, so the wording lives in
 * one place: `describeVisualPhase` (lib/visual-review-model.ts), re-exported
 * here as `visualReviewPhaseCopy` for callers that need the bare strings.
 */
import type { VisualReviewModel, VisualReviewPhase } from '@buildd/shared';
import { describeVisualPhase } from '@/lib/visual-review-model';
import { VERDICT_DOT } from './ShotImage';

export const visualReviewPhaseCopy = describeVisualPhase;

export type VisualReviewTone = 'needs' | 'attention' | 'blocked' | 'working' | 'done' | 'quiet';

/**
 * How loud a phase is. Colour is for the label text and the dots only.
 * `needs` is the accent (the agent is asking, nothing broke), matching the
 * board's Needs-you tile; red is kept for a run that broke, and a missing
 * browser runner is blocked rather than broken.
 */
export function visualPhaseTone(phase: VisualReviewPhase): VisualReviewTone {
  switch (phase) {
    case 'needs_you':
      return 'needs';
    case 'boot_failed':
    case 'stalled':
    case 'failed':
      return 'attention';
    case 'no_browser_runner':
      return 'blocked';
    case 'capturing':
    case 'fixing':
      return 'working';
    case 'reviewed':
      return 'done';
    default:
      return 'quiet';
  }
}

/** The label colour per tone (text and dots only). */
export const VISUAL_TONE_TEXT: Record<VisualReviewTone, string> = {
  needs: 'text-accent-text',
  attention: 'text-status-error',
  blocked: 'text-status-warning',
  working: 'text-status-warning',
  done: 'text-status-success',
  quiet: 'text-text-secondary',
};

const MAX_DOTS = 24;

export interface VisualReviewLineProps {
  model: Pick<VisualReviewModel, 'phase' | 'progress' | 'summary' | 'needsYou' | 'cells'>;
  /** `full` adds the detail sentence under the label. */
  variant?: 'compact' | 'full';
  className?: string;
}

export function VerdictDots({ cells }: { cells: VisualReviewModel['cells'] }) {
  if (cells.length === 0) return null;
  const shown = cells.slice(0, MAX_DOTS);
  const more = cells.length - shown.length;
  return (
    <span data-testid="visual-review-dots" className="inline-flex flex-wrap items-center gap-[3px]" aria-hidden="true">
      {shown.map(c => {
        const decided = !!c.current.review;
        if (c.needsHuman) {
          return <i key={c.key} data-dot="awaiting" className="inline-block h-2.5 w-2.5 border-2 border-status-info" />;
        }
        return (
          <i key={c.key} data-dot={decided ? 'decided' : c.effectiveVerdict} className={`relative inline-block h-2.5 w-2.5 ${VERDICT_DOT[c.effectiveVerdict]}`}>
            {decided && (
              <svg viewBox="0 0 10 10" className="absolute inset-0 h-full w-full" aria-hidden="true">
                <path d="M2 5.2 4.2 7.4 8 2.8" fill="none" stroke="var(--surface-1)" strokeWidth="1.8" strokeLinecap="square" />
              </svg>
            )}
          </i>
        );
      })}
      {more > 0 && <span className="ml-0.5 font-mono text-[11px] text-text-muted">+{more}</span>}
    </span>
  );
}

export default function VisualReviewLine({ model, variant = 'compact', className = '' }: VisualReviewLineProps) {
  const copy = describeVisualPhase(model);
  const tone = visualPhaseTone(model.phase);
  const s = model.summary;
  const aria = [copy.label, s.shots > 0 ? `${s.shots} screens, ${s.reviewed} decided by you` : null].filter(Boolean).join('. ');
  return (
    <div data-testid="visual-review-line" data-phase={model.phase} className={`min-w-0 ${className}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="section-label !text-text-muted">Screens</span>
        <span data-testid="visual-review-line-label" aria-label={aria} className={`font-mono text-[13px] font-semibold ${VISUAL_TONE_TEXT[tone]}`}>
          {copy.label}
        </span>
        <VerdictDots cells={model.cells} />
      </div>
      {variant === 'full' && (
        <p data-testid="visual-review-line-detail" className="mt-1 text-[13px] leading-[1.45] text-text-secondary">
          {copy.detail}
        </p>
      )}
    </div>
  );
}
