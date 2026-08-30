/**
 * Type-level regression guard for DerivedMetric<T>.
 *
 * This file is NOT a runtime test — it is compiled by tsc via tsconfig.test-d.json
 * and run as part of `bun run type-check`. Its purpose is to prove that the
 * discriminated union enforces narrowing: reading `.value` or `.reason` without
 * first checking `kind` is a TS2339 compile error.
 *
 * Two-sided enforcement:
 *   1. @ts-expect-error on the unguarded access — tsc errors if the guard
 *      regresses (making the directive "unused").
 *   2. The narrowed accesses below carry NO annotation — tsc errors if they
 *      ever stop compiling.
 */

import type { DerivedMetric } from '../derived-metric'

declare const m: DerivedMetric<number>

// ── Unguarded access must NOT compile ────────────────────────────────────────
// TS2339: Property 'value' does not exist on type 'DerivedMetric<number>'
// @ts-expect-error
const _badValue: number = m.value

// TS2339: Property 'reason' does not exist on type 'DerivedMetric<number>'
// @ts-expect-error
const _badReason: string = m.reason

// ── Narrowed access MUST compile ─────────────────────────────────────────────
// These lines must carry no @ts-expect-error; any breakage surfaces as a new
// unexpected TS error, which fails the type-check step.
if (m.kind === 'value') {
  const _goodValue: number = m.value
  void _goodValue
}

if (m.kind === 'unavailable') {
  const _goodReason: string = m.reason
  void _goodReason
}
