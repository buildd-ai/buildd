import { describe, it, expect } from 'bun:test';
import { BudgetWalls, describeBudgetWalls, accountLimitRefusal, formatLiftTime } from './claim-limits';

const NOW = new Date('2026-10-09T18:00:00.000Z');
const AT = '2026-10-09T20:00:00.000Z';

describe('formatLiftTime', () => {
  it('says the time alone when it is today, and the date too when it is not', () => {
    expect(formatLiftTime(AT, NOW)).toBe('20:00 UTC');
    expect(formatLiftTime('2026-10-10T09:00:00.000Z', NOW)).toBe('Oct 10, 09:00 UTC');
  });
  it('returns null for a missing or unreadable time', () => {
    expect(formatLiftTime(null, NOW)).toBeNull();
    expect(formatLiftTime('soon', NOW)).toBeNull();
  });
});

describe('BudgetWalls', () => {
  it('keeps one wall per kind and provider, first reset wins', () => {
    const w = new BudgetWalls();
    w.add('account_seat', 'claude', AT);
    w.add('account_seat', 'claude', '2026-10-09T23:00:00.000Z');
    w.add('provider_pause', 'codex', new Date(AT));
    expect(w.size).toBe(2);
    expect(w.list()).toEqual([
      { kind: 'account_seat', backend: 'claude', resetsAt: AT },
      { kind: 'provider_pause', backend: 'codex', resetsAt: AT },
    ]);
  });
});

describe('describeBudgetWalls', () => {
  it('names the account session limit and when it lifts', () => {
    const s = describeBudgetWalls([{ kind: 'account_seat', backend: 'claude', resetsAt: AT }], { now: NOW, interactive: false });
    expect(s).toContain("The account's Claude session limit is reached. It lifts at 20:00 UTC.");
  });

  it('names a recorded rate limit per provider', () => {
    const s = describeBudgetWalls([{ kind: 'provider_pause', backend: 'codex', resetsAt: AT }], { now: NOW, interactive: false });
    expect(s).toContain('A run hit the Codex rate limit for this team. Codex work waits until 20:00 UTC.');
  });

  it("names a tenant's budget", () => {
    const s = describeBudgetWalls([{ kind: 'tenant_budget', backend: 'claude', resetsAt: AT }], { now: NOW, interactive: false });
    expect(s).toContain("This tenant's Claude budget is used up until 20:00 UTC.");
  });

  it('says when it lifts is unknown rather than inventing a time', () => {
    const s = describeBudgetWalls([{ kind: 'account_seat', backend: 'claude', resetsAt: null }], { now: NOW, interactive: false });
    expect(s).toContain("The account's Claude session limit is reached.");
    expect(s).not.toMatch(/lifts at/);
  });

  it('tells a runner caller that a session claim is not held by a seat wall, and says nothing of it to a session', () => {
    const walls = [{ kind: 'account_seat' as const, backend: 'claude' as const, resetsAt: AT }];
    expect(describeBudgetWalls(walls, { now: NOW, interactive: false })).toContain('A claim from your own Claude Code session runs on your seat and can start now.');
    expect(describeBudgetWalls(walls, { now: NOW, interactive: true })).not.toContain('your own Claude Code session');
    // A tenant budget holds sessions too, so no such line.
    expect(describeBudgetWalls([{ kind: 'tenant_budget', backend: 'claude', resetsAt: AT }], { now: NOW, interactive: false }))
      .not.toContain('your own Claude Code session');
  });

  it('never uses the "not this, it\'s that" shape', () => {
    const all = describeBudgetWalls([
      { kind: 'account_seat', backend: 'claude', resetsAt: AT },
      { kind: 'provider_pause', backend: 'claude', resetsAt: AT },
      { kind: 'tenant_budget', backend: 'claude', resetsAt: AT },
    ], { now: NOW, interactive: false });
    expect(all).not.toMatch(/\bNot [a-z]+:/);
    expect(all).not.toMatch(/, not /);
  });
});

describe('accountLimitRefusal', () => {
  it('keeps the existing error string and adds a code and a sentence for every limit', () => {
    const workers = accountLimitRefusal({ code: 'max_concurrent_workers', limit: 2, current: 2 });
    expect(workers.error).toBe('Max concurrent workers limit reached');
    expect(workers.code).toBe('max_concurrent_workers');
    expect(workers.detail).toBe('All 2 runner slots on this account are busy. A slot frees when a running task finishes.');

    const cost = accountLimitRefusal({ code: 'daily_cost_limit', limit: '10.00', current: '15.00' });
    expect(cost.error).toBe('Daily cost limit exceeded');
    expect(cost.detail).toBe('The account has spent $15.00 of its $10.00 daily limit. Raise the limit in Settings to start more work today.');

    const sessions = accountLimitRefusal({ code: 'max_concurrent_sessions', limit: 3, current: 3 });
    expect(sessions.error).toBe('Max concurrent sessions limit reached');
    expect(sessions.detail).toBe('The account is at its limit of 3 concurrent sessions. One frees when a session ends.');
  });

  it('keeps limit and current on the body', () => {
    const r = accountLimitRefusal({ code: 'max_concurrent_workers', limit: 4, current: 5 });
    expect(r.limit).toBe(4);
    expect(r.current).toBe(5);
  });
});
