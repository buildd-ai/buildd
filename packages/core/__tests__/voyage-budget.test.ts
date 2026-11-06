import { describe, expect, it } from 'bun:test';
import {
  PAID_VOYAGE_EMBED_TOKENS,
  PAID_VOYAGE_RERANK_TOKENS,
  VOYAGE_QUERY_HEADROOM,
  estimateRerankTokens,
  isVoyageBudgetEnforced,
  isVoyageExempt,
  voyageBudgetState,
  voyageCapFor,
  voyageCapsForPlan,
  voyageMonth,
  voyageMonthResetsAt,
} from '../voyage-budget';

describe('isVoyageBudgetEnforced', () => {
  it('is off by default', () => {
    expect(isVoyageBudgetEnforced({})).toBe(false);
  });

  it('follows BILLING_ENFORCED when unset', () => {
    expect(isVoyageBudgetEnforced({ BILLING_ENFORCED: '1' })).toBe(true);
  });

  it('can be turned on before billing', () => {
    expect(isVoyageBudgetEnforced({ VOYAGE_BUDGET_ENFORCED: 'true' })).toBe(true);
  });

  it('an explicit off wins over billing', () => {
    expect(isVoyageBudgetEnforced({ VOYAGE_BUDGET_ENFORCED: '0', BILLING_ENFORCED: '1' })).toBe(false);
  });
});

describe('voyageCapsForPlan', () => {
  const NONE = { embed: 0, rerank: 0 };

  it('gives free no platform allowance', () => {
    expect(voyageCapsForPlan('free', {})).toEqual(NONE);
  });

  it('treats an unknown plan as free', () => {
    expect(voyageCapsForPlan('enterprise-ish', {})).toEqual(NONE);
    expect(voyageCapsForPlan(null, {})).toEqual(NONE);
  });

  it('gives paid plans the fair-use allowance', () => {
    for (const plan of ['pro', 'team']) {
      expect(voyageCapsForPlan(plan, {})).toEqual({ embed: PAID_VOYAGE_EMBED_TOKENS, rerank: PAID_VOYAGE_RERANK_TOKENS });
    }
  });

  it('reads paid allowances from env, ignoring junk', () => {
    expect(voyageCapsForPlan('pro', { VOYAGE_PAID_EMBED_TOKENS: '123', VOYAGE_PAID_RERANK_TOKENS: 'lots' }))
      .toEqual({ embed: 123, rerank: PAID_VOYAGE_RERANK_TOKENS });
  });

  it('env never gives free an allowance', () => {
    expect(voyageCapsForPlan('free', { VOYAGE_PAID_EMBED_TOKENS: '123' })).toEqual(NONE);
  });
});

describe('voyageCapFor', () => {
  it('keeps zero at zero, query or not', () => {
    expect(voyageCapFor({ embed: 0, rerank: 0 }, 'embed', 'query')).toBe(0);
  });

  const caps = { embed: 1000, rerank: 500 };

  it('holds documents at the cap', () => {
    expect(voyageCapFor(caps, 'embed', 'document')).toBe(1000);
  });

  it('gives query embeddings headroom past it', () => {
    expect(voyageCapFor(caps, 'embed', 'query')).toBe(Math.floor(1000 * (1 + VOYAGE_QUERY_HEADROOM)));
  });

  it('gives rerank no headroom', () => {
    expect(voyageCapFor(caps, 'rerank')).toBe(500);
  });
});

describe('isVoyageExempt', () => {
  it('matches a listed team only', () => {
    const env = { VOYAGE_BUDGET_EXEMPT_TEAMS: ' team-a , team-b' };
    expect(isVoyageExempt('team-b', env)).toBe(true);
    expect(isVoyageExempt('team-c', env)).toBe(false);
    expect(isVoyageExempt('team-a', {})).toBe(false);
  });
});

describe('estimateRerankTokens', () => {
  it('bills the query once per document, as Voyage does', () => {
    // 30 chars = 10 tokens query; two 3-char docs = 1 token each.
    expect(estimateRerankTokens('x'.repeat(30), ['abc', 'def'])).toBe(10 * 2 + 2);
  });

  it('is zero with no documents', () => {
    expect(estimateRerankTokens('query', [])).toBe(0);
  });
});

describe('months', () => {
  it('uses the UTC calendar month', () => {
    expect(voyageMonth(new Date('2026-11-30T23:59:59Z'))).toBe('2026-11');
    expect(voyageMonth(new Date('2026-12-01T00:00:00Z'))).toBe('2026-12');
  });

  it('resets on the first of the next month, across a year end', () => {
    expect(voyageMonthResetsAt(new Date('2026-12-15T10:00:00Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('voyageBudgetState', () => {
  const caps = { embed: 100, rerank: 100 };

  it('is ok below the warning line', () => {
    expect(voyageBudgetState({ embed: 79, rerank: 0 }, caps, false)).toBe('ok');
  });

  it('is near from 80% of either counter', () => {
    expect(voyageBudgetState({ embed: 0, rerank: 80 }, caps, false)).toBe('near');
  });

  it('is over at the cap or once a call was denied', () => {
    expect(voyageBudgetState({ embed: 100, rerank: 0 }, caps, false)).toBe('over');
    expect(voyageBudgetState({ embed: 1, rerank: 1 }, caps, true)).toBe('over');
  });

  it('is lexical_only with no platform allowance, whatever was used', () => {
    expect(voyageBudgetState({ embed: 0, rerank: 0 }, { embed: 0, rerank: 0 }, false)).toBe('lexical_only');
  });

  it('is ok with no caps', () => {
    expect(voyageBudgetState({ embed: 1e12, rerank: 1e12 }, { embed: null, rerank: null }, false)).toBe('ok');
  });
});
