import { describe, expect, it } from 'bun:test'
import {
  derivedUnavailable,
  derivedValue,
  isDerivedUnavailable,
  isDerivedValue,
  type DerivedMetric,
} from '../derived-metric'

describe('DerivedMetric', () => {
  describe('derivedValue', () => {
    it('round-trips a primitive value', () => {
      const m = derivedValue(42)
      expect(m.kind).toBe('value')
      if (m.kind === 'value') expect(m.value).toBe(42)
    })

    it('round-trips an object value', () => {
      const obj = { count: 3, label: 'foo' }
      const m = derivedValue(obj)
      expect(m.kind).toBe('value')
      if (m.kind === 'value') expect(m.value).toEqual(obj)
    })

    it('does not carry a reason property', () => {
      const m = derivedValue('hello')
      expect('reason' in m).toBe(false)
    })
  })

  describe('derivedUnavailable', () => {
    it('carries the reason string', () => {
      const m = derivedUnavailable<number>('no data yet')
      expect(m.kind).toBe('unavailable')
      if (m.kind === 'unavailable') expect(m.reason).toBe('no data yet')
    })

    it('does not carry a value property', () => {
      const m = derivedUnavailable<number>('empty')
      expect('value' in m).toBe(false)
    })
  })

  describe('type guards', () => {
    it('isDerivedValue returns true for value kind', () => {
      const m: DerivedMetric<string> = derivedValue('x')
      expect(isDerivedValue(m)).toBe(true)
      expect(isDerivedUnavailable(m)).toBe(false)
    })

    it('isDerivedUnavailable returns true for unavailable kind', () => {
      const m: DerivedMetric<string> = derivedUnavailable('reason')
      expect(isDerivedUnavailable(m)).toBe(true)
      expect(isDerivedValue(m)).toBe(false)
    })
  })
})
