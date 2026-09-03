import type { DerivedMetric } from '@buildd/core/derived-metric';

/**
 * The stat tile Health and the usage drill-down both render.
 *
 * Shared rather than copied because the interesting half is `MetricStat`'s
 * absence behaviour, and a second copy of that is a second chance to render a
 * zero where a measurement was never taken.
 */
export function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div>
      <div className="text-xs text-text-muted">{label}</div>
      <div className="text-lg text-text-primary tabular-nums">{value}</div>
      <div className="text-xs text-text-muted tabular-nums">{sub}</div>
    </div>
  );
}

/**
 * A stat tile over a `DerivedMetric`. On `unavailable` it shows an em-dash with
 * the reason as a tooltip — never a zero, which would read as "this task cost
 * nothing" instead of "we never recorded it".
 *
 * The tooltip prefers `detail` (a sentence written for a reader) over `reason`
 * (a machine token like `no_scope`), per the reachable-reason contract in
 * `docs/design/derived-metric-availability.md`.
 *
 * `extra` renders under the em-dash on the unavailable path only: it is where a
 * measurable STAND-IN goes, for a metric that is structurally absent under some
 * auth modes. It must never be a version of the missing number itself.
 */
export function MetricStat<T>({
  label,
  metric,
  render,
  sub,
  extra,
}: {
  label: string;
  metric: DerivedMetric<T>;
  render: (v: T) => string;
  sub: (v: T) => string;
  extra?: string | null;
}) {
  if (metric.kind === 'unavailable') {
    return (
      <div title={metric.detail ?? metric.reason}>
        <div className="text-xs text-text-muted">{label}</div>
        <div className="text-lg text-text-muted tabular-nums">—</div>
        <div className="text-xs text-text-muted">not recorded</div>
        {extra && <div className="text-[11px] text-text-muted/80 tabular-nums">{extra}</div>}
      </div>
    );
  }
  return <Stat label={label} value={render(metric.value)} sub={sub(metric.value)} />;
}
