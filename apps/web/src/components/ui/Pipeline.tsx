import Link from 'next/link';
import type { CSSProperties } from 'react';
import { meterStage, type StageMeterStage, type StageMeterState } from './StageMeter';

/** A Pipeline group: the three meter stages, plus queued ahead of them. */
export type PipelineStage = 'queued' | StageMeterStage;

export const PIPELINE_STAGES: readonly PipelineStage[] = ['queued', 'build', 'verify', 'deliver'];

/** What the Pipeline needs of a delivery: the same state and stage its StageMeter is drawn from. */
export interface PipelineDelivery {
  id: string;
  state: StageMeterState;
  stage?: StageMeterStage;
}

/** The group a delivery sits in: queued, else the segment its meter lights. */
export function pipelineStage(d: Pick<PipelineDelivery, 'state' | 'stage'>): PipelineStage {
  return d.state === 'queued' ? 'queued' : meterStage(d.state, d.stage);
}

/**
 * Deliveries split by Pipeline stage, input order kept within each group.
 * The one grouping both the Pipeline and the rows under it read, so a
 * stage's count, its dots and its rows are the same array (spec 9430a28f r2
 * R-13, AC-12). Pass the rows' own list; do not recount elsewhere.
 */
export function groupByStage<T extends Pick<PipelineDelivery, 'state' | 'stage'>>(deliveries: readonly T[]): Record<PipelineStage, T[]> {
  const groups: Record<PipelineStage, T[]> = { queued: [], build: [], verify: [], deliver: [] };
  for (const d of deliveries) groups[pipelineStage(d)].push(d);
  return groups;
}

const STAGE_LABEL: Record<PipelineStage, string> = { queued: 'queued', build: 'Build', verify: 'Verify', deliver: 'Deliver' };

/** How a delivery's dot is drawn: the stage fill, or the state's shape where the meter has one. */
export type PipelineDotPattern = 'build' | 'verify' | 'deliver' | 'fixing' | 'cant-run' | 'waiting';

export function dotPattern(d: Pick<PipelineDelivery, 'state' | 'stage'>): PipelineDotPattern {
  switch (d.state) {
    case 'fixing-in-build':
    case 'fixing-in-verify': return 'fixing';
    case 'check-cant-run': return 'cant-run';
    case 'waiting-on-you': return 'waiting';
    default: {
      const s = pipelineStage(d);
      return s === 'queued' ? 'build' : s;
    }
  }
}

const HATCH = 'repeating-linear-gradient(135deg, var(--accent) 0 2px, var(--accent-soft) 2px 4px)';

const DOT_STYLE: Record<PipelineDotPattern, CSSProperties> = {
  build: { background: 'var(--accent)' },
  verify: { background: 'var(--status-info)' },
  deliver: { background: 'var(--status-success)' },
  fixing: { backgroundImage: HATCH, boxShadow: 'inset 0 0 0 1px var(--accent)' },
  'cant-run': { boxShadow: 'inset 0 0 0 1.5px var(--faint)', borderRadius: 2 },
  // The only orange-red on the Pipeline, as on the meter and the YouStrip.
  waiting: { background: 'var(--status-error)' },
};

export interface PipelineProps {
  /** The deliveries the rows below are drawn from: the same array, not a copy with its own counts. */
  deliveries: readonly PipelineDelivery[];
  /** `stack` (phone, above the rows) or `row` (desktop, across the top). Default `stack`. */
  layout?: 'stack' | 'row';
  /** Where each stage's cell goes (its group on the page). Absent: the cell is not a link. */
  hrefFor?: (stage: PipelineStage) => string | undefined;
  className?: string;
  'data-testid'?: string;
}

function cellName(stage: PipelineStage, n: number) {
  return `${STAGE_LABEL[stage]}: ${n} ${n === 1 ? 'delivery' : 'deliveries'}`;
}

/**
 * Now's count per stage and one dot per delivery: queued, then Build,
 * Verify, Deliver. Queued is a count only; each stage shows its count over
 * its dots, each dot in the delivery's meter state (hatched while being
 * fixed, outlined when a check can't run, orange-red when it waits on you).
 * Counts and dots both come from `groupByStage(deliveries)`, so they cannot
 * disagree with each other or with the rows. Spec 9430a28f r2 R-13.
 */
export default function Pipeline({ deliveries, layout = 'stack', hrefFor, className = '', 'data-testid': testId = 'pipeline' }: PipelineProps) {
  const groups = groupByStage(deliveries);
  const row = layout === 'row';
  const dotSize = row ? 'h-[9px] w-[9px]' : 'h-2 w-2';
  return (
    <section
      aria-label="Pipeline"
      data-testid={testId}
      data-layout={layout}
      className={`grid w-full text-text-primary ${row
        ? 'grid-cols-[120px_repeat(3,minmax(0,1fr))] border-y border-border-default'
        : 'grid-cols-[56px_repeat(3,minmax(0,1fr))] items-end'} ${className}`}
    >
      {PIPELINE_STAGES.map(stage => {
        const group = groups[stage];
        const queued = stage === 'queued';
        const href = hrefFor?.(stage);
        const cellClass = queued
          ? `flex min-h-11 ${row ? 'items-center py-4' : 'items-end'}`
          : `flex min-h-11 min-w-0 border-l border-border-default ${row ? 'flex-row items-center gap-3.5 px-5 py-4' : 'flex-col gap-1.5 px-2.5'}`;
        const body = (
          <>
            <span className="flex flex-col gap-1.5">
              <span
                data-count={group.length}
                className={`font-mono font-semibold leading-none ${queued ? 'text-[20px] text-text-muted' : row ? 'text-[32px]' : 'text-[28px]'}`}
              >
                {group.length}
              </span>
              <span className="text-[12px] text-text-muted">{STAGE_LABEL[stage]}</span>
            </span>
            {!queued && (
              <span aria-hidden="true" data-dots={stage} className={`flex min-h-2.5 min-w-0 max-w-[120px] flex-wrap gap-1 ${row ? 'flex-1' : ''}`}>
                {group.map(d => (
                  <span key={d.id} data-dot={dotPattern(d)} className={`block rounded-full ${dotSize}`} style={DOT_STYLE[dotPattern(d)]} />
                ))}
              </span>
            )}
          </>
        );
        const common = { 'data-stage': stage, 'aria-label': cellName(stage, group.length) };
        return href
          ? <Link key={stage} href={href} {...common} className={`${cellClass} no-underline hover:bg-surface-3/60`}>{body}</Link>
          : <div key={stage} role="group" {...common} className={cellClass}>{body}</div>;
      })}
    </section>
  );
}

export { Pipeline };
