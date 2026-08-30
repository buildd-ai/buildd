/**
 * Typed reasons for an unavailable derived metric.
 *
 * - `no_baseline`: no historical record to derive from (no healthy releases row, no usage history)
 * - `no_scope`: input set is empty — there is nothing to count yet (0 tasks, 0 criteria)
 * - `not_evaluated`: a verdict could be computed but has not been run yet
 */
export type DerivedMetricReason = 'no_baseline' | 'no_scope' | 'not_evaluated'

export type DerivedMetric<T> =
  | { kind: 'value'; value: T }
  | { kind: 'unavailable'; reason: DerivedMetricReason; detail?: string }

export function derivedValue<T>(value: T): DerivedMetric<T> {
  return { kind: 'value', value }
}

export function derivedUnavailable<T>(reason: DerivedMetricReason, detail?: string): DerivedMetric<T> {
  return detail ? { kind: 'unavailable', reason, detail } : { kind: 'unavailable', reason }
}

export function isDerivedValue<T>(m: DerivedMetric<T>): m is { kind: 'value'; value: T } {
  return m.kind === 'value'
}

export function isDerivedUnavailable<T>(m: DerivedMetric<T>): m is { kind: 'unavailable'; reason: DerivedMetricReason; detail?: string } {
  return m.kind === 'unavailable'
}
