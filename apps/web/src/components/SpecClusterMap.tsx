'use client';

import { MIX_STATES, type IndexArea, type SpecMixState } from '@/lib/specs/index-view';

const FILL: Record<SpecMixState, string> = {
  approved: 'var(--status-success)',
  draft: 'var(--q)',
  imported: 'var(--status-info)',
  failing: 'var(--status-error)',
};

/** Inner padding shared by the block buttons. */
const PAD = 'p-1.5';

/** The id `onSelect` gets for the loose dots (specs buildd could not place). */
export const UNFILED = 'unfiled';

/** Fewer than this many areas is not a map: the one line of counts says it all. */
export const MIN_AREAS_FOR_MAP = 2;

/**
 * Areas as blocks sized by spec count and filled by status mix (living-specs
 * R-37), loose dots for unfiled specs. Every block is a button: tapping it
 * filters the outline to that area, tapping it again clears the filter.
 * Words are in each block (title and count), never colour alone (R-21).
 */
export default function SpecClusterMap({ areas, unfiledCount, selected, onSelect }: {
  areas: IndexArea[];
  unfiledCount: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const toggle = (id: string) => onSelect(selected === id ? null : id);
  const shown = areas.filter((a) => a.count > 0);
  return (
    <div className="flex flex-col gap-2" data-testid="spec-cluster-map" role="group" aria-label="Areas by spec count. Tap one to show only its specs.">
      <div className="flex flex-wrap gap-1.5">
        {shown.map((a) => (
          <button
            key={a.id} type="button" onClick={() => toggle(a.id)} aria-pressed={selected === a.id}
            data-testid="spec-cluster-block" data-area-id={a.id} data-count={a.count}
            className={`flex min-h-11 min-w-[5.5rem] flex-col gap-1 rounded-[var(--radius-cell)] border bg-surface-1 ${PAD} text-left hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--text-primary)] ${selected === a.id ? 'border-[var(--text-primary)]' : 'border-[var(--line-soft)]'}`}
            style={{ flexGrow: a.count, flexBasis: `${Math.min(4 + a.count * 1.5, 16)}rem` }}
          >
            <span className="text-meta font-medium text-text-primary [overflow-wrap:anywhere]">{a.title}</span>
            <span className="text-meta text-text-muted">{a.count} spec{a.count === 1 ? '' : 's'}</span>
            <span className="flex h-3 w-full gap-px overflow-hidden rounded-[var(--radius-cell)]" aria-hidden="true">
              {MIX_STATES.filter((s) => a.mix[s]).map((s) => (
                <span key={s} data-state={s} style={{ flexGrow: a.mix[s], flexBasis: 0, background: FILL[s] }} />
              ))}
            </span>
          </button>
        ))}
        {unfiledCount ? (
          <button
            type="button" onClick={() => toggle(UNFILED)} aria-pressed={selected === UNFILED}
            data-testid="spec-cluster-unfiled"
            className={`flex min-h-11 flex-col justify-center gap-1 rounded-[var(--radius-cell)] border border-dashed bg-surface-1 ${PAD} text-left hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--text-primary)] ${selected === UNFILED ? 'border-[var(--text-primary)]' : 'border-[var(--border-strong)]'}`}
          >
            <span className="text-meta font-medium text-text-primary">Unfiled</span>
            <span className="flex max-w-[8rem] flex-wrap gap-1" aria-hidden="true">
              {Array.from({ length: Math.min(unfiledCount, 12) }, (_, i) => (
                <span key={i} data-testid="spec-cluster-dot" className="inline-block h-2 w-2 rounded-full bg-[var(--faint)]" />
              ))}
            </span>
            <span className="text-meta text-text-muted">{unfiledCount} spec{unfiledCount === 1 ? '' : 's'}</span>
          </button>
        ) : null}
      </div>
      {selected ? (
        <button type="button" className="btn btn-sm btn-quiet h-11 self-start md:h-8" onClick={() => onSelect(null)} data-testid="spec-cluster-clear">
          Show all areas
        </button>
      ) : null}
    </div>
  );
}
