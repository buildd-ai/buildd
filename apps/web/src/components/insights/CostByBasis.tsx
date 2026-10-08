import { BASIS_KEYS, BASIS_LABEL, type BasisKey } from '@/lib/cost-basis-split';
import type { usageByBasis } from './usage-model';

type Split = ReturnType<typeof usageByBasis>;

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Real dollars and plan usage at list price, side by side, split by who ran
 * the work (docs/specs/real-and-virtual-cost.md "Reporting"). Mixed and
 * unknown rows appear only when the window has them.
 */
export function CostByBasis({ split }: { split: Split }) {
  const shown = BASIS_KEYS.filter(k => k === 'real' || k === 'virtual' || split.total[k].workers > 0);
  if (BASIS_KEYS.every(k => split.total[k].workers === 0)) return null;
  const cols = 'grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem_4.5rem] sm:grid-cols-[minmax(0,1fr)_5.5rem_6.5rem_5.5rem] gap-2';
  return (
    <section className="mt-5 card p-4" data-testid="insights-cost-basis">
      <h2 className="text-title font-semibold">Cost</h2>
      <div className={`mt-3 ${cols} text-meta text-text-muted`}>
        <span />
        <span className="text-right">Runners</span>
        <span className="text-right">Interactive</span>
        <span className="text-right">Total</span>
      </div>
      <ul className="mt-2 space-y-2 text-meta">
        {shown.map((k: BasisKey) => (
          <li key={k} data-testid={`cost-basis-${k}`} className={cols}>
            <span className="break-words">
              {BASIS_LABEL[k]}
              {k === 'unknown' && <span className="text-text-muted"> · {split.total.unknown.workers} worker{split.total.unknown.workers === 1 ? '' : 's'}</span>}
            </span>
            <span className="text-right">{usd(split.byExecutor.runner[k].costUsd)}</span>
            <span className="text-right">{usd(split.byExecutor.interactive[k].costUsd)}</span>
            <span className="text-right font-semibold">{usd(split.total[k].costUsd)}</span>
          </li>
        ))}
        <li data-testid="cost-basis-combined" className={`${cols} border-t-2 border-border pt-2 text-text-secondary`}>
          <span>Combined</span>
          <span />
          <span />
          <span className="text-right">{usd(split.combinedUsd)}</span>
        </li>
      </ul>
    </section>
  );
}
