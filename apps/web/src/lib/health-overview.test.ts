import { describe, it, expect } from 'bun:test';
import { overviewHeadline, overviewStatusRows, type OverviewAttention, type OverviewState } from './health-overview';

const CALM: OverviewAttention = {
  noRunners: false, offlineRunners: 0, unsandboxedRunners: 0, brokenCredentials: 0,
  strandedBackends: 0, failingSchedules: 0, failureGroups: 0,
};

const STATE: OverviewState = {
  runners: { total: 1, online: 1, busySlots: 1, slots: 10 },
  credentials: { total: 2, broken: 0 },
  budget: { monthly: null, paused: [] },
};

describe('overviewHeadline', () => {
  it('counts access problems: a run that cannot get access needs someone', () => {
    expect(overviewHeadline({ ...CALM, accessProblems: 2 })).toMatchObject({ tone: 'attention', count: 2 });
  });

  it('says all good when nothing needs attention', () => {
    expect(overviewHeadline(CALM)).toEqual({ tone: 'ok', count: 0, text: 'All good.' });
  });

  it('counts one thing per item, each failure group once', () => {
    expect(overviewHeadline({ ...CALM, failureGroups: 1 })).toMatchObject({ tone: 'attention', count: 1, text: '1 failure cause.' });
    expect(overviewHeadline({ ...CALM, failureGroups: 3, brokenCredentials: 1, noRunners: true }))
      .toMatchObject({ count: 5, text: 'No runners connected · 1 broken credential · 3 failure causes.' });
  });
});

describe('overviewStatusRows', () => {
  const byKey = (s: OverviewState, hideOfflineRunners?: boolean) => {
    const rows = overviewStatusRows(s, { hideOfflineRunners });
    return Object.fromEntries(rows.map(r => [r.key, r]));
  };

  it('budget links to Billing and budgets while capacity links to Runners', () => {
    const withSpend = { ...STATE, budget: { monthly: { spentUsd: 5, budgetUsd: 100, pctUsed: 5 }, paused: [] } };
    expect(byKey(withSpend).budget.href).toBe('/app/settings/billing');
    expect(byKey(STATE).runners.href).toBe('/app/health/runners');
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

  it('when offline runners are already shown in Problems, hide the error tone runners row from At a glance', () => {
    const offlineState = { ...STATE, runners: { total: 2, online: 0, busySlots: 0, slots: 0 } };
    // When offline runners are shown in Problems list, don't duplicate in At a glance
    const rowsWhenHidden = overviewStatusRows(offlineState, { hideOfflineRunners: true });
    expect(rowsWhenHidden.find(r => r.key === 'runners')).toBeUndefined();
    // Without the hide flag, the runners error row is shown normally
    const rowsNormal = overviewStatusRows(offlineState, { hideOfflineRunners: false });
    expect(rowsNormal.find(r => r.key === 'runners')).toMatchObject({ value: 'None online', tone: 'error' });
  });

  it('credentials: working, broken, or none stored (runners may use their own sign-in)', () => {
    expect(byKey(STATE).credentials).toMatchObject({ value: '2 working', tone: 'ok' });
    expect(byKey({ ...STATE, credentials: { total: 2, broken: 1 } }).credentials)
      .toMatchObject({ value: '1 needs attention', tone: 'error' });
    expect(byKey({ ...STATE, credentials: { total: 3, broken: 2 } }).credentials.value).toBe('2 need attention');
    expect(byKey({ ...STATE, credentials: { total: 0, broken: 0 } }).credentials)
      .toMatchObject({ value: 'None stored', tone: 'muted' });
  });

  it('budget: a paused provider wins, then real monthly spend, else no row', () => {
    expect(byKey(STATE).budget).toBeUndefined();
    // A cap with no real spend (a team on subscription logins) shows nothing.
    expect(byKey({ ...STATE, budget: { monthly: { spentUsd: 0, budgetUsd: 100, pctUsed: 0 }, paused: [] } }).budget).toBeUndefined();
    expect(byKey({ ...STATE, budget: { monthly: { spentUsd: 42, budgetUsd: 100, pctUsed: 42 }, paused: [] } }).budget)
      .toMatchObject({ value: '$42 of $100 this month', tone: 'ok' });
    expect(byKey({ ...STATE, budget: { monthly: { spentUsd: 75, budgetUsd: 100, pctUsed: 75 }, paused: [] } }).budget.tone).toBe('warning');
    expect(byKey({ ...STATE, budget: { monthly: { spentUsd: 95, budgetUsd: 100, pctUsed: 95 }, paused: [] } }).budget.tone).toBe('error');
    expect(byKey({ ...STATE, budget: { monthly: { spentUsd: 10, budgetUsd: 100, pctUsed: 10 }, paused: [{ label: 'Codex', resetsInMs: 7 * 3600_000 }] } }).budget)
      .toMatchObject({ value: 'Codex paused · resets in 7h', tone: 'warning' });
  });

  it('budget: names every paused provider, with the soonest reset when one is known', () => {
    const paused = (p: Array<{ label: string; resetsInMs: number | null }>) =>
      byKey({ ...STATE, budget: { monthly: null, paused: p } }).budget.value;
    expect(paused([{ label: 'Codex', resetsInMs: null }])).toBe('Codex paused');
    expect(paused([{ label: 'Codex', resetsInMs: 25 * 60_000 }])).toBe('Codex paused · resets in 25m');
    expect(paused([{ label: 'Codex', resetsInMs: 3 * 86_400_000 }])).toBe('Codex paused · resets in 3d');
    expect(paused([{ label: 'Codex', resetsInMs: 7 * 3600_000 }, { label: 'Claude', resetsInMs: 2 * 3600_000 }]))
      .toBe('Codex and Claude paused · resets in 2h');
  });
});

describe('overviewHeadline sandbox count', () => {
  it('counts sandbox problems without calling an unconfirmed probe unsandboxed', () => {
    expect(overviewHeadline({ ...CALM, unsandboxedRunners: 2 }).text).toBe('2 sandbox problems.');
  });
});
