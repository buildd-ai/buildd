import type { DerivedMetric } from '@buildd/core/derived-metric'

interface Props<T> {
  metric: DerivedMetric<T>
  /** Render the value when available */
  renderValue: (value: T) => React.ReactNode
  /** Placeholder shown when unavailable (defaults to a neutral dash) */
  unavailableLabel?: React.ReactNode
  className?: string
}

export function DerivedMetricDisplay<T>({
  metric,
  renderValue,
  unavailableLabel = <span className="text-muted-foreground">—</span>,
  className,
}: Props<T>) {
  if (metric.kind === 'unavailable') {
    return (
      <span className={className} title={metric.reason} aria-label={metric.reason}>
        {unavailableLabel}
      </span>
    )
  }
  return <span className={className}>{renderValue(metric.value)}</span>
}
