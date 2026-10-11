import { describe, it, expect } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  COST_BASES,
  combineCostBasis,
  costBasisWrite,
  countsTowardMissionBudget,
  parseCostBasis,
} from '../cost-basis';
import { countsTowardAgentSdkCreditPool } from '../budget-alerts';

describe('parseCostBasis', () => {
  it('accepts the four bases', () => {
    for (const b of COST_BASES) expect(parseCostBasis(b)).toEqual({ ok: true, basis: b });
  });

  it('treats an absent basis as absent, not as an error', () => {
    expect(parseCostBasis(undefined)).toEqual({ ok: true, basis: null });
    expect(parseCostBasis(null)).toEqual({ ok: true, basis: null });
  });

  it('rejects anything else', () => {
    expect(parseCostBasis('oauth').ok).toBe(false);
    expect(parseCostBasis('REAL').ok).toBe(false);
    expect(parseCostBasis(1).ok).toBe(false);
  });
});

describe('combineCostBasis', () => {
  it('keeps the first known basis', () => {
    expect(combineCostBasis(null, 'virtual')).toBe('virtual');
    expect(combineCostBasis('virtual', 'virtual')).toBe('virtual');
  });

  it('a different known basis makes the row mixed', () => {
    expect(combineCostBasis('virtual', 'real')).toBe('mixed');
    expect(combineCostBasis('real', 'virtual')).toBe('mixed');
    expect(combineCostBasis('mixed', 'real')).toBe('mixed');
  });

  it('unknown never overwrites a known basis, and a known basis replaces unknown', () => {
    expect(combineCostBasis('virtual', 'unknown')).toBe('virtual');
    expect(combineCostBasis('mixed', 'unknown')).toBe('mixed');
    expect(combineCostBasis('unknown', 'real')).toBe('real');
    expect(combineCostBasis(null, 'unknown')).toBe('unknown');
  });

  it('is order-independent for any pair', () => {
    for (const a of COST_BASES) for (const b of COST_BASES) {
      expect(combineCostBasis(combineCostBasis(null, a), b)).toBe(combineCostBasis(combineCostBasis(null, b), a));
    }
  });
});

describe('costBasisWrite', () => {
  const render = (s: ReturnType<typeof costBasisWrite>) => new PgDialect().sqlToQuery(s.getSQL());

  it('renders the same rule as combineCostBasis, atomically in SQL', () => {
    const q = render(costBasisWrite('real'));
    expect(q.sql).toContain('"cost_basis"');
    expect(q.sql).toMatch(/case/i);
    expect(q.params).toContain('real');
    expect(q.params).toContain('mixed');
  });
});

describe('countsTowardMissionBudget', () => {
  it('counts real, mixed and unknown cost, and never virtual', () => {
    expect(countsTowardMissionBudget('real')).toBe(true);
    expect(countsTowardMissionBudget('mixed')).toBe(true);
    expect(countsTowardMissionBudget('unknown')).toBe(true);
    expect(countsTowardMissionBudget('virtual')).toBe(false);
  });

  it('counts a row with no basis, which only carries cost when it predates the backfill', () => {
    expect(countsTowardMissionBudget(null)).toBe(true);
  });
});

describe('countsTowardAgentSdkCreditPool with a cost basis', () => {
  it('real usage never draws on the pool', () => {
    expect(countsTowardAgentSdkCreditPool({ backend: 'claude', authType: 'oauth', costBasis: 'real' })).toBe(false);
  });

  it('virtual, mixed, unknown and absent bases draw on it as before', () => {
    for (const costBasis of ['virtual', 'mixed', 'unknown', null] as const) {
      expect(countsTowardAgentSdkCreditPool({ backend: 'claude', authType: 'api', costBasis })).toBe(true);
    }
  });
});
