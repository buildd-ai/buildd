import { describe, expect, it } from 'bun:test';
import { parseBudgetInput, budgetFromApi, MAX_BUDGET_USD } from './budget-input';

describe('parseBudgetInput', () => {
  it('reads an empty field as "use the default" (null), never as unlimited', () => {
    expect(parseBudgetInput('')).toEqual({ ok: true, value: null });
    expect(parseBudgetInput('   ')).toEqual({ ok: true, value: null });
  });

  it('accepts dollars with or without a $ sign and rounds to cents', () => {
    expect(parseBudgetInput('20')).toEqual({ ok: true, value: 20 });
    expect(parseBudgetInput('$7.5')).toEqual({ ok: true, value: 7.5 });
    expect(parseBudgetInput('3.456')).toEqual({ ok: true, value: 3.46 });
    expect(parseBudgetInput('0')).toEqual({ ok: true, value: 0 });
  });

  it('accepts the placeholder form, $20/day', () => {
    expect(parseBudgetInput('$20/day')).toEqual({ ok: true, value: 20 });
    expect(parseBudgetInput('15 / day')).toEqual({ ok: true, value: 15 });
    expect(parseBudgetInput('/day').ok).toBe(false);
  });

  it('rejects negatives, words and values over the API ceiling', () => {
    expect(parseBudgetInput('-1').ok).toBe(false);
    expect(parseBudgetInput('lots').ok).toBe(false);
    expect(parseBudgetInput(String(MAX_BUDGET_USD + 1)).ok).toBe(false);
  });
});

describe('budgetFromApi', () => {
  it('turns the numeric column (often a string) into a number or null', () => {
    expect(budgetFromApi('12.50')).toBe(12.5);
    expect(budgetFromApi(8)).toBe(8);
    expect(budgetFromApi(null)).toBeNull();
    expect(budgetFromApi(undefined)).toBeNull();
    expect(budgetFromApi('x')).toBeNull();
  });
});
