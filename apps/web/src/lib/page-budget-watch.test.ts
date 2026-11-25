import { describe, it, expect } from 'bun:test';
import {
  ALERT_INTERVAL_MS, MIN_OVER_LOADS, WINDOW_MS, formatPageBudgetAlert, heaviestLoader, isOverBudget,
  planPageBudgetAlerts, slowestLoader, type OverLoad,
} from './page-budget-watch';
import { PAGE_BUDGETS } from './page-budgets';

const NOW = 1_800_000_000_000;
const load = (over: Partial<OverLoad> = {}): OverLoad => ({
  page: 'home', queries: 30, bytes: 400 * 1024, loader: 'home.missions', at: NOW - 60_000, ...over,
});
const many = (n: number, over: Partial<OverLoad> = {}) => Array.from({ length: n }, () => load(over));

describe('page budget alert', () => {
  it('judges a load against the shared PAGE_BUDGETS table', () => {
    expect(isOverBudget({ queries: PAGE_BUDGETS.home.queries, bytes: 1 }, PAGE_BUDGETS.home)).toBe(false);
    expect(isOverBudget({ queries: PAGE_BUDGETS.home.queries + 1, bytes: 1 }, PAGE_BUDGETS.home)).toBe(true);
    expect(isOverBudget({ queries: 1, bytes: PAGE_BUDGETS.home.bytes + 1 }, PAGE_BUDGETS.home)).toBe(true);
  });

  it('names the loader that returned the most data', () => {
    expect(heaviestLoader({ a: { count: 9, bytes: 10 }, b: { count: 1, bytes: 500 } })).toBe('b');
  });

  // R-1..R-8 "Ready": the time budget lives in the same table, so this alert
  // replaces the Axiom p90 monitor that hard-coded it (R-40).
  it('judges load time against the Ready column of the same table', () => {
    const b = PAGE_BUDGETS.missionPage;
    expect(b.readyMs).toBe(1200);
    expect(PAGE_BUDGETS.home.readyMs).toBe(1000);
    expect(PAGE_BUDGETS.other.readyMs).toBe(1500);
    expect(isOverBudget({ queries: 1, bytes: 1, ms: b.readyMs }, b)).toBe(false);
    expect(isOverBudget({ queries: 1, bytes: 1, ms: b.readyMs + 1 }, b)).toBe(true);
    expect(isOverBudget({ queries: 1, bytes: 1 }, b)).toBe(false);
  });

  it('names the loader that spent the most time in the database for a slow load', () => {
    const queries = [
      { label: 'a', durationMs: 40 }, { label: 'b', durationMs: 300 }, { label: 'a', durationMs: 50 },
    ];
    expect(slowestLoader(queries)).toBe('b');
    expect(slowestLoader([])).toBe('unlabelled');
  });

  it('says a slow page was slow, with its worst time against the budget', () => {
    const [alert] = planPageBudgetAlerts(
      many(MIN_OVER_LOADS, { page: 'missionPage', queries: 5, bytes: 1024, ms: 2400, loader: 'mission.tasks' }), {}, NOW,
    );
    const text = formatPageBudgetAlert(alert);
    expect(text.title).toContain('missionPage');
    expect(text.message).toContain('mission.tasks');
    expect(text.message).toContain('2.4 s');
    expect(text.message).toContain('1.2 s');
  });

  // @notify-fire: page-budget-over-an-hour
  it('alerts a page over budget in the hour, naming the page and loader', () => {
    const [alert] = planPageBudgetAlerts(many(MIN_OVER_LOADS), {}, NOW);
    const text = formatPageBudgetAlert(alert);
    expect(text.title).toContain('home');
    expect(text.message).toContain('home.missions');
  });

  it('ignores a blip, loads older than the hour and pages already alerted today', () => {
    expect(planPageBudgetAlerts(many(MIN_OVER_LOADS - 1), {}, NOW)).toEqual([]);
    expect(planPageBudgetAlerts(many(MIN_OVER_LOADS, { at: NOW - WINDOW_MS - 1 }), {}, NOW)).toEqual([]);
    expect(planPageBudgetAlerts(many(MIN_OVER_LOADS), { home: NOW - ALERT_INTERVAL_MS + 1000 }, NOW)).toEqual([]);
    expect(planPageBudgetAlerts(many(MIN_OVER_LOADS), { home: NOW - ALERT_INTERVAL_MS - 1 }, NOW)).toHaveLength(1);
  });

  it('plans each page separately', () => {
    const plan = planPageBudgetAlerts([...many(3), ...many(4, { page: 'health', loader: 'health.runners' })], { home: NOW }, NOW);
    expect(plan.map(a => [a.page, a.loader])).toEqual([['health', 'health.runners']]);
  });
});
