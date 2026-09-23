import { describe, it, expect } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { tasks } from '@buildd/core/db/schema';
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

// ─── The emitted SQL ─────────────────────────────────────────────────────────
//
// The `walk`-based assertion above proves the key literal reaches the fragment
// somewhere, but never renders it — a wrong operator (`->` instead of `->>`,
// `=` flipped to `!=`) or a mis-cast column would pass it just the same. This
// is the same class of invisibility that shipped the ANY(${array}) and
// dependsOn/depends_on bugs: a route test that mocks the query builder can
// never see a malformed fragment, only a real dialect render can.
describe('bypassFlagCondition() — emitted SQL', () => {
  const dialect = new PgDialect();
  const render = (key: typeof CAP_EXEMPT_KEY) => dialect.sqlToQuery(bypassFlagCondition(tasks.context, key));

  it('reads the key via ->> so both the boolean and string forms compare as text', () => {
    const { sql: text } = render(CAP_EXEMPT_KEY);
    // `->` returns jsonb, and jsonb `true` would then need a jsonb literal on
    // the right-hand side rather than the text comparison this predicate uses.
    expect(text).toContain('->>');
    expect(text).not.toMatch(/->[^>]/);
  });

  it("compares against the text 'true', not a boolean or jsonb literal", () => {
    expect(render(CAP_EXEMPT_KEY).sql).toMatch(/= 'true'$/);
    expect(render(CAP_EXEMPT_KEY).params).toEqual([CAP_EXEMPT_KEY]);
  });

  it('COALESCEs a missing key to empty string rather than leaving it NULL', () => {
    // NULL = 'true' is NULL (neither true nor false) in Postgres, which would
    // make the predicate silently inert for a task with no context at all.
    expect(render(CAP_EXEMPT_KEY).sql).toContain("COALESCE(");
    expect(render(CAP_EXEMPT_KEY).sql).toContain(", '')");
  });

  it('binds the requested key as a parameter, not string-interpolated text', () => {
    const { sql: text, params } = render(BYPASS_HELD_GATE_KEY);
    expect(params[0]).toBe(BYPASS_HELD_GATE_KEY);
    expect(text).not.toContain(BYPASS_HELD_GATE_KEY);
  });
});
