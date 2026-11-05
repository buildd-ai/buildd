import { describe, expect, it } from 'bun:test';
import { classifyRisk, filterByTier, RISK_KEYWORDS, sortHighFirst, type RiskInput } from './risk-tier';

// Spec b7fc9316 r6 (built ahead of approval): R-32, R-33, AC-33.

const BASE = `# Checkout

## Requirements

- R-1: Totals are in the shopper's currency.
  check: \`bun test token.test.ts\`
- R-2: Rates are cached for 15 minutes.

## Acceptance criteria

- AC-1: GIVEN a cart in EUR WHEN I check out THEN the total reads in EUR.
  screen: checkout-total
`;

const input = (to: string, extra: Partial<RiskInput> = {}): RiskInput => ({ scope: 'feature', flaggedHigh: false, from: BASE, to, ...extra });

describe('classifyRisk', () => {
  it('AC-33: a spec a person flagged risk: high is High, whatever changed', () => {
    const r = classifyRisk(input(BASE.replace('15 minutes', '20 minutes'), { flaggedHigh: true }));
    expect(r.tier).toBe('high');
    expect(r.reasons[0]).toContain('risk: high');
  });

  it('AC-33: a changed criterion containing "secret" is High', () => {
    const r = classifyRisk(input(BASE.replace('Rates are cached for 15 minutes.', 'Rates are read from a secret store.')));
    expect(r.tier).toBe('high');
    expect(r.reasons.join(' ')).toContain('R-2');
    expect(r.reasons.join(' ')).toContain('secret');
  });

  it('every keyword makes a changed criterion High, any case, whole words only', () => {
    for (const k of RISK_KEYWORDS) {
      const r = classifyRisk(input(BASE.replace('Rates are cached for 15 minutes.', `Rates need a ${k.toUpperCase()} first.`)));
      expect(r.tier).toBe('high');
    }
    expect(classifyRisk(input(BASE.replace('15 minutes', '15 minutes after authz'))).tier).toBe('high');
    expect(classifyRisk(input(BASE.replace('15 minutes', '15 minutes after authn'))).tier).toBe('high');
    // "author", "tokenizer", "emerge" are other words.
    expect(classifyRisk(input(BASE.replace('Rates are cached for 15 minutes.', 'The author sees the emerge tokenizer.'))).tier).toBe('medium');
  });

  it('a keyword in an unchanged criterion, or only in a check: line, does not make High', () => {
    const withSecret = BASE.replace('Rates are cached for 15 minutes.', 'Rates are read from a secret store.');
    expect(classifyRisk(input(withSecret.replace('Totals are in', 'Totals are always in'), { from: withSecret })).tier).toBe('medium');
    // R-1's check: line names token.test.ts; changing R-2 does not trip it; editing that check line is a change but not a keyword one.
    expect(classifyRisk(input(BASE.replace('15 minutes', '20 minutes'))).tier).toBe('medium');
    expect(classifyRisk(input(BASE.replace('token.test.ts', 'token.other.test.ts'))).tier).toBe('medium');
  });

  it('a removed criterion that held a keyword counts as changed text', () => {
    const from = BASE.replace('Rates are cached for 15 minutes.', 'Only an owner may approve a refund.');
    expect(classifyRisk(input(BASE, { from })).tier).toBe('high');
  });

  it('AC-33: a domain charter is Low', () => {
    expect(classifyRisk(input(BASE.replace('15 minutes', '20 minutes'), { scope: 'domain' })).tier).toBe('low');
  });

  it('AC-33: a spec with no criteria is Low', () => {
    const prose = '# Notes\n\nJust words about checkout.\n';
    expect(classifyRisk(input(prose, { from: null })).tier).toBe('low');
  });

  it('AC-33: a change that only edits a screen: binding is Low', () => {
    expect(classifyRisk(input(BASE.replace('screen: checkout-total', 'screen: checkout-total, checkout-eur'))).tier).toBe('low');
  });

  it('a copy-only edit (spacing, case, punctuation) is Low; a changed word is Medium', () => {
    expect(classifyRisk(input(BASE.replace('Rates are cached for 15 minutes.', 'Rates are  cached for 15 minutes'))).tier).toBe('low');
    expect(classifyRisk(input(BASE.replace('15 minutes', '20 minutes'))).tier).toBe('medium');
  });

  it('a prose-only change that touches no criterion is Low', () => {
    expect(classifyRisk(input(BASE.replace('# Checkout', '# Checkout\n\nNew context paragraph.'))).tier).toBe('low');
  });

  it('AC-33: any other change is Medium, including an added or removed criterion with no keyword', () => {
    expect(classifyRisk(input(BASE + '\n- R-3: Refunds go to the original card.\n')).tier).toBe('medium');
    expect(classifyRisk(input(BASE.replace('- R-2: Rates are cached for 15 minutes.\n', ''))).tier).toBe('medium');
  });

  it('a first draft (nothing approved) is measured from nothing: its keywords count', () => {
    expect(classifyRisk(input(BASE.replace('15 minutes', 'a login'), { from: null })).tier).toBe('high');
    expect(classifyRisk(input(BASE, { from: null })).tier).toBe('medium');
  });

  it('High wins over Low: a domain charter with a keyword criterion is High', () => {
    const r = classifyRisk(input('- R-1: Only owners may merge.\n', { scope: 'domain', from: null }));
    expect(r.tier).toBe('high');
  });

  it('is deterministic and pure', () => {
    const i = input(BASE.replace('15 minutes', '20 minutes'));
    expect(classifyRisk(i)).toEqual(classifyRisk(i));
  });
});

describe('ordering and filtering (R-33)', () => {
  const rows = [
    { id: 'a', tier: 'low' as const }, { id: 'b', tier: 'high' as const }, { id: 'c', tier: 'medium' as const },
    { id: 'd', tier: 'high' as const }, { id: 'e', tier: 'medium' as const },
  ];
  it('sorts High first, then Medium, then Low, keeping the given order within a tier', () => {
    expect(sortHighFirst(rows).map((r) => r.id)).toEqual(['b', 'd', 'c', 'e', 'a']);
  });
  it('filters to one tier, or to all', () => {
    expect(filterByTier(rows, 'high').map((r) => r.id)).toEqual(['b', 'd']);
    expect(filterByTier(rows, 'all')).toHaveLength(5);
  });
});
