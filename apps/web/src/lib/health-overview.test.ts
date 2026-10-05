import { describe, it, expect } from 'bun:test';
import { overviewHeadline, overviewStatusRows, type OverviewAttention, type OverviewState } from './health-overview';

const CALM: OverviewAttention = {
  noRunners: false, offlineRunners: 0, unsandboxedRunners: 0, brokenCredentials: 0,
  strandedBackends: 0, failingSchedules: 0, failureGroups: 0,
};

const STATE: OverviewState = {
  runners: { total: 1, online: 1, busySlots: 1, slots: 10 },
  credentials: { total: 2, broken: 0 },
  budget: { monthly: null, pausedProviders: 0 },
};

describe('overviewHeadline', () => {
  it('says all good when nothing needs attention', () => {
    expect(overviewHeadline(CALM)).toEqual({ tone: 'ok', count: 0, text: 'All good.' });
  });

  it('counts one thing per item, each failure group once', () => {
    expect(overviewHeadline({ ...CALM, failureGroups: 1 })).toMatchObject({ tone: 'attention', count: 1, text: '1 thing needs you.' });
    expect(overviewHeadline({ ...CALM, failureGroups: 3, brokenCredentials: 1, noRunners: true }))
      .toMatchObject({ count: 5, text: '5 things need you.' });
  });
});

describe('overviewStatusRows', () => {
  const byKey = (s: OverviewState) => Object.fromEntries(overviewStatusRows(s).map(r => [r.key, r]));

  it('every row links to Runners & capacity', () => {
    for (const r of overviewStatusRows(STATE)) expect(r.href).toBe('/app/health/runners');
  });

  it('runners: online count and agents running, tone by how many are up', () => {
    expect(byKey(STATE).runners).toMatchObject({ value: '1 of 1 online · 1 of 10 agents running', tone: 'ok' });
    expect(byKey({ ...STATE, runners: { total: 2, online: 1, busySlots: 0, slots: 6 } }).runners)
      .toMatchObject({ value: '1 of 2 online · 0 of 6 agents running', tone: 'warning' });
    expect(byKey({ ...STATE, runners: { total: 1, online: 0, busySlots: 0, slots: 0 } }).runners)
      .toMatchObject({ value: 'None online', tone: 'error' });
    expect(byKey({ ...STATE, runners: { total: 0, online: 0, busySlots: 0, slots: 0 } }).runners)
      .toMatchObject({ value: 'None connected', tone: 'error' });
  });

  it('credentials: working, broken, or none set up', () => {
    expect(byKey(STATE).credentials).toMatchObject({ value: '2 working', tone: 'ok' });
    expect(byKey({ ...STATE, credentials: { total: 2, broken: 1 } }).credentials)
      .toMatchObject({ value: '1 needs attention', tone: 'error' });
    expect(byKey({ ...STATE, credentials: { total: 3, broken: 2 } }).credentials.value).toBe('2 need attention');
    expect(byKey({ ...STATE, credentials: { total: 0, broken: 0 } }).credentials)
      .toMatchObject({ value: 'None set up', tone: 'warning' });
  });

  it('budget: a paused provider wins, then the monthly limit, else no limit', () => {
    expect(byKey(STATE).budget).toMatchObject({ value: 'No monthly limit set', tone: 'muted' });
    expect(byKey({ ...STATE, budget: { monthly: { spentUsd: 42, budgetUsd: 100, pctUsed: 42 }, pausedProviders: 0 } }).budget)
      .toMatchObject({ value: '$42 of $100 this month', tone: 'ok' });
    expect(byKey({ ...STATE, budget: { monthly: { spentUsd: 75, budgetUsd: 100, pctUsed: 75 }, pausedProviders: 0 } }).budget.tone).toBe('warning');
    expect(byKey({ ...STATE, budget: { monthly: { spentUsd: 95, budgetUsd: 100, pctUsed: 95 }, pausedProviders: 0 } }).budget.tone).toBe('error');
    expect(byKey({ ...STATE, budget: { monthly: { spentUsd: 10, budgetUsd: 100, pctUsed: 10 }, pausedProviders: 1 } }).budget)
      .toMatchObject({ value: 'Paused until a usage limit resets', tone: 'warning' });
  });
});
