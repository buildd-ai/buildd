import { describe, it, expect } from 'bun:test';
import {
  BYPASS_DEPS_GATE_KEY,
  BYPASS_HELD_GATE_KEY,
  BYPASS_MISSION_BUDGET_KEY,
  CAP_EXEMPT_KEY,
  bypassFlagCondition,
  hasBypassFlag,
} from './bypass-flags';

/**
 * These flags are evaluated twice per gate — once as SQL text (`context->>key`)
 * and once as raw JSON in TypeScript. The bug they caused: /start writes the
 * boolean `true`, `->>` renders it as the text `'true'`, and a TS check of
 * `=== true` silently rejected the string form. Both sides must accept both.
 */
describe('hasBypassFlag', () => {
  it('accepts the boolean form written by /start', () => {
    expect(hasBypassFlag({ capExempt: true }, CAP_EXEMPT_KEY)).toBe(true);
  });

  it('accepts the string form that `context->>key` yields', () => {
    expect(hasBypassFlag({ capExempt: 'true' }, CAP_EXEMPT_KEY)).toBe(true);
  });

  it('rejects absent, null, false and other truthy-looking values', () => {
    expect(hasBypassFlag(null, CAP_EXEMPT_KEY)).toBe(false);
    expect(hasBypassFlag(undefined, CAP_EXEMPT_KEY)).toBe(false);
    expect(hasBypassFlag({}, CAP_EXEMPT_KEY)).toBe(false);
    expect(hasBypassFlag({ capExempt: false }, CAP_EXEMPT_KEY)).toBe(false);
    expect(hasBypassFlag({ capExempt: 'yes' }, CAP_EXEMPT_KEY)).toBe(false);
    expect(hasBypassFlag({ capExempt: 1 }, CAP_EXEMPT_KEY)).toBe(false);
  });

  it('does not leak between keys — one override never opens another gate', () => {
    expect(hasBypassFlag({ bypassDepsGate: true }, CAP_EXEMPT_KEY)).toBe(false);
    expect(hasBypassFlag({ bypassDepsGate: true }, BYPASS_MISSION_BUDGET_KEY)).toBe(false);
    expect(hasBypassFlag({ bypassMissionBudget: true }, BYPASS_HELD_GATE_KEY)).toBe(false);
  });
});

describe('bypassFlagCondition', () => {
  it('renders the key as a bound literal so SQL and TS read the same flag', () => {
    const cond: any = bypassFlagCondition({ name: 'context' }, CAP_EXEMPT_KEY);
    const literals: string[] = [];
    const walk = (n: any, seen = new Set<any>()) => {
      if (typeof n === 'string') { literals.push(n); return; }
      if (!n || typeof n !== 'object' || seen.has(n)) return;
      seen.add(n);
      for (const v of Array.isArray(n) ? n : Object.values(n)) walk(v, seen);
    };
    walk(cond);
    expect(literals).toContain(CAP_EXEMPT_KEY);
    // Both value forms collapse to the text 'true' through ->>.
    expect(literals.some(l => l.includes("= 'true'"))).toBe(true);
  });

  it('every live bypass key is a distinct context key', () => {
    const keys = [BYPASS_DEPS_GATE_KEY, BYPASS_HELD_GATE_KEY, BYPASS_MISSION_BUDGET_KEY, CAP_EXEMPT_KEY];
    expect(new Set(keys).size).toBe(keys.length);
  });
});
