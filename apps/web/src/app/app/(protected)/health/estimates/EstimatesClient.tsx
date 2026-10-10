import type { TaskEstimateReadout, GroupScore } from '@buildd/core/task-estimate-accuracy';
type BacktestScore = TaskEstimateReadout['overall'];
import { estimatesHeadline, logPos, medianBandRatio, pct, scatterBounds, sourceLabel, typicalLine } from './estimates-view';

export interface EstimatePoint { estimate: number; actual: number; p80: number }

export function EstimatesClient({ readout, points }: { readout: TaskEstimateReadout; points: EstimatePoint[] }) {
  const head = estimatesHeadline(readout.overall);
  return (
    <div className="max-w-2xl mx-auto px-4 pt-14 pb-24 md:pt-6" data-testid="estimates-page">
      <h1 className="hidden md:block text-heading font-bold">Estimates</h1>
      <div className="py-3">
        <p className="text-title font-semibold text-text-primary" data-testid="estimates-lead">{head.lead}</p>
        {head.basis && <p className="mt-1 text-body text-text-muted">{head.basis}</p>}
      </div>

      {!readout.indeterminate && (
        <details className="border-t border-border-default" data-testid="estimates-details">
          <summary className="py-3 text-body font-medium text-text-primary cursor-pointer">Details</summary>
          <Scatter points={points} />
          <Groups title="By kind of task" groups={readout.byKind} />
          <Groups title="By area" groups={readout.byCluster} />
          <Groups title="By what the estimate leaned on" groups={readout.bySource} label={sourceLabel} />
          <section className="py-3 border-t border-border-default">
            <h2 className="text-body font-semibold text-text-primary">Learning curve</h2>
            <p className="text-meta text-text-muted">A new repo starts on priors and improves as it finishes tasks.</p>
            <Rows rows={readout.byHistory.map(h => ({ key: `${h.band} finished`, score: h.score }))} />
          </section>
          <section className="py-3 border-t border-border-default">
            <h2 className="text-body font-semibold text-text-primary">Tokens</h2>
            <p className="text-meta text-text-muted">{pct(readout.tokens.withinP80)} within p80 · typical {typicalLine(readout.tokens)} · n {readout.tokens.scored}</p>
          </section>
        </details>
      )}
    </div>
  );
}

function Rows({ rows }: { rows: Array<{ key: string; score: BacktestScore }> }) {
  if (rows.length === 0) return <p className="py-2 text-meta text-text-muted">Nothing yet.</p>;
  return (
    <ul className="mt-1 divide-y divide-border-default border-y border-border-default">
      {rows.map(r => (
        <li key={r.key} className="flex items-baseline justify-between gap-3 py-2 text-body" data-testid="estimates-row">
          <span className="min-w-0 truncate text-text-primary" title={r.key}>{r.key}</span>
          <span className="shrink-0 text-meta text-text-muted">
            n {r.score.scored} · {pct(r.score.withinP80)} within p80 · {typicalLine(r.score)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Groups({ title, groups, label }: { title: string; groups: GroupScore[]; label?: (k: string) => string }) {
  return (
    <section className="py-3 border-t border-border-default">
      <h2 className="text-body font-semibold text-text-primary">{title}</h2>
      <Rows rows={groups.filter(g => g.score.scored > 0).map(g => ({ key: label ? label(g.key) : g.key, score: g.score }))} />
    </section>
  );
}

/** Estimated vs actual minutes, log scale. Diagonal = p50; band = the median p80 above it. */
function Scatter({ points }: { points: EstimatePoint[] }) {
  const usable = points.filter(p => p.estimate > 0 && p.actual > 0);
  if (usable.length === 0) return null;
  const { lo, hi } = scatterBounds(usable);
  const band = medianBandRatio(usable.map(p => ({ p50: p.estimate, p80: p.p80 })));
  const S = 100;
  const x = (v: number) => logPos(v, lo, hi) * S;
  const y = (v: number) => S - logPos(v, lo, hi) * S;
  return (
    <section className="py-3 border-t border-border-default" data-testid="estimates-scatter">
      <h2 className="text-body font-semibold text-text-primary">Estimated vs actual</h2>
      <p className="text-meta text-text-muted">Minutes, log scale. On the line is the p50 estimate; the shaded band runs up to p80.</p>
      <svg viewBox={`-4 -4 ${S + 8} ${S + 8}`} className="mt-2 w-full max-w-sm text-text-muted" role="img" aria-label="Estimated against actual minutes per task">
        <rect x="0" y="0" width={S} height={S} fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="0.4" />
        <polygon points={bandPolygon(lo, hi, band, x, y)} fill="currentColor" fillOpacity="0.12" />
        <line x1={x(lo)} y1={y(lo)} x2={x(hi)} y2={y(hi)} stroke="currentColor" strokeWidth="0.6" />
        {usable.map((p, i) => (
          <circle key={i} cx={x(p.estimate)} cy={y(p.actual)} r="1" className="fill-current text-text-primary" fillOpacity="0.55" />
        ))}
      </svg>
      <p className="text-meta text-text-muted">Estimated {lo}m to {hi}m across, actual up the side. Above the band ran past p80.</p>
    </section>
  );
}

/** Between y = x and y = x * band, clipped to the axes [lo, hi]. */
function bandPolygon(lo: number, hi: number, band: number, x: (v: number) => number, y: (v: number) => number): string {
  const pts = [`${x(lo)},${y(lo)}`, `${x(hi)},${y(hi)}`];
  if (hi / band > lo) pts.push(`${x(hi / band)},${y(hi)}`);
  pts.push(`${x(lo)},${y(Math.min(hi, lo * band))}`);
  return pts.join(' ');
}
