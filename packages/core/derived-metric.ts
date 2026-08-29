export type DerivedMetric<T> =
  | { kind: 'value'; value: T }
  | { kind: 'unavailable'; reason: string }

export function derivedValue<T>(value: T): DerivedMetric<T> {
  return { kind: 'value', value }
}

export function derivedUnavailable<T>(reason: string): DerivedMetric<T> {
  return { kind: 'unavailable', reason }
}

export function isDerivedValue<T>(m: DerivedMetric<T>): m is { kind: 'value'; value: T } {
  return m.kind === 'value'
}

export function isDerivedUnavailable<T>(m: DerivedMetric<T>): m is { kind: 'unavailable'; reason: string } {
  return m.kind === 'unavailable'
}
