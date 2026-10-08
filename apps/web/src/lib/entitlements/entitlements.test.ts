import { describe, it, expect } from 'bun:test';
import {
  UNLIMITED_MANAGED_RUNNER_ENTITLEMENT,
  evaluateManagedRunnerEntitlement,
  nextMonthlyReset,
  parseEntitlementBlock,
} from '@buildd/shared';
import { MANAGED_RUNNER_PLANS, resolveManagedRunnerEntitlement } from './plans';
import { checkManagedRunnerEntitlement, type ManagedRunnerDeps } from './managed-runner';

const NOW = new Date('2026-10-06T12:00:00Z');

function deps(o: { plan?: Record<string, unknown> | null; active?: number; hours?: number }) {
  const calls = { active: 0, hours: 0 };
  const d: ManagedRunnerDeps = {
    loadTeamPlan: async () => (o.plan ?? null) as any,
    countActiveManagedRuns: async () => { calls.active++; return o.active ?? 0; },
    managedRunnerHoursSince: async () => { calls.hours++; return o.hours ?? 0; },
  };
  return { d, calls };
}

describe('resolveManagedRunnerEntitlement', () => {
  it('self-hosted default: no assignment and no deployment default is unlimited', () => {
    expect(resolveManagedRunnerEntitlement(null, {})).toEqual(UNLIMITED_MANAGED_RUNNER_ENTITLEMENT);
  });

  it('hosted individual is 3 at once; team is 10 pooled', () => {
    expect(resolveManagedRunnerEntitlement({ plan: 'individual' }, {}).concurrency).toBe(3);
    expect(resolveManagedRunnerEntitlement({ plan: 'team' }, {}).concurrency).toBe(10);
    expect(resolveManagedRunnerEntitlement({ plan: 'team' }, {}).scope).toBe('team');
  });

  it('enterprise is custom: unlimited unless the team row carries numbers', () => {
    expect(resolveManagedRunnerEntitlement({ plan: 'enterprise' }, {}).concurrency).toBeNull();
    expect(resolveManagedRunnerEntitlement({ plan: 'enterprise', concurrency: 40 }, {}).concurrency).toBe(40);
  });

  it('the deployment default applies only to teams with no assignment', () => {
    expect(resolveManagedRunnerEntitlement(null, { BUILDD_DEFAULT_MANAGED_PLAN: 'individual' }).concurrency).toBe(3);
    expect(resolveManagedRunnerEntitlement({ plan: 'team' }, { BUILDD_DEFAULT_MANAGED_PLAN: 'individual' }).concurrency).toBe(10);
  });

  it('an unknown plan id never blocks work', () => {
    expect(resolveManagedRunnerEntitlement({ plan: 'typo' }, {})).toEqual(UNLIMITED_MANAGED_RUNNER_ENTITLEMENT);
  });

  it('hosted config may replace catalog values without code changes; bad JSON keeps the built-in catalog', () => {
    const env = { BUILDD_MANAGED_PLAN_CATALOG: JSON.stringify({ individual: { concurrency: 4, monthlyRunnerHours: 80 } }) };
    expect(resolveManagedRunnerEntitlement({ plan: 'individual' }, env)).toMatchObject({ concurrency: 4, monthlyRunnerHours: 80 });
    expect(resolveManagedRunnerEntitlement({ plan: 'individual' }, { BUILDD_MANAGED_PLAN_CATALOG: '{' }).concurrency)
      .toBe(MANAGED_RUNNER_PLANS.individual.concurrency);
  });
});

describe('evaluateManagedRunnerEntitlement', () => {
  const individual = MANAGED_RUNNER_PLANS.individual;

  it('blocks at the limit, not below it', () => {
    expect(evaluateManagedRunnerEntitlement(individual, { activeRuns: 2, runnerHoursUsed: 0, now: NOW })).toBeNull();
    expect(evaluateManagedRunnerEntitlement(individual, { activeRuns: 3, runnerHoursUsed: 0, now: NOW }))
      .toMatchObject({ kind: 'concurrency', active: 3, limit: 3 });
  });

  it('runner-hours: blocks with the next UTC month as the refill when overage is block', () => {
    const block = evaluateManagedRunnerEntitlement(individual, { activeRuns: 0, runnerHoursUsed: 50, now: NOW });
    expect(block).toMatchObject({ kind: 'usage', unit: 'runner_hours', limit: 50, resetsAt: '2026-11-01T00:00:00.000Z' });
  });

  it('runner-hours: an overage policy lets work through', () => {
    expect(evaluateManagedRunnerEntitlement({ ...individual, overage: 'allow' }, { activeRuns: 0, runnerHoursUsed: 500, now: NOW })).toBeNull();
  });

  it('concurrency is reported first: it clears soonest', () => {
    expect(evaluateManagedRunnerEntitlement(individual, { activeRuns: 3, runnerHoursUsed: 99, now: NOW })?.kind).toBe('concurrency');
  });

  it('next reset rolls the year', () => {
    expect(nextMonthlyReset(new Date('2026-12-31T23:00:00Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('parseEntitlementBlock', () => {
  it('round-trips both shapes and rejects junk', () => {
    const c = evaluateManagedRunnerEntitlement(MANAGED_RUNNER_PLANS.team, { activeRuns: 10, runnerHoursUsed: 0, now: NOW })!;
    const u = evaluateManagedRunnerEntitlement(MANAGED_RUNNER_PLANS.team, { activeRuns: 0, runnerHoursUsed: 300, now: NOW })!;
    expect(parseEntitlementBlock(JSON.parse(JSON.stringify(c)))).toEqual(c);
    expect(parseEntitlementBlock(JSON.parse(JSON.stringify(u)))).toEqual(u);
    expect(parseEntitlementBlock({ kind: 'concurrency' })).toBeNull();
    expect(parseEntitlementBlock('x')).toBeNull();
    expect(parseEntitlementBlock(null)).toBeNull();
  });
});

describe('checkManagedRunnerEntitlement', () => {
  it('unlimited: answers without counting anything', async () => {
    const { d, calls } = deps({ plan: null, active: 100 });
    expect(await checkManagedRunnerEntitlement('team-1', { now: NOW }, d)).toBeNull();
    expect(calls).toEqual({ active: 0, hours: 0 });
  });

  it('individual at 3/3 blocks; at 2/3 plus one claimed in this batch also blocks', async () => {
    expect(await checkManagedRunnerEntitlement('t', { now: NOW }, deps({ plan: { plan: 'individual' }, active: 3 }).d))
      .toMatchObject({ kind: 'concurrency', active: 3, limit: 3 });
    expect(await checkManagedRunnerEntitlement('t', { now: NOW, claimedInBatch: 1 }, deps({ plan: { plan: 'individual' }, active: 2 }).d))
      .toMatchObject({ kind: 'concurrency', active: 3 });
    expect(await checkManagedRunnerEntitlement('t', { now: NOW }, deps({ plan: { plan: 'individual' }, active: 2 }).d)).toBeNull();
  });

  it('team at 10/10 blocks, 9/10 does not', async () => {
    expect(await checkManagedRunnerEntitlement('t', { now: NOW }, deps({ plan: { plan: 'team' }, active: 10 }).d))
      .toMatchObject({ kind: 'concurrency', limit: 10, scope: 'team' });
    expect(await checkManagedRunnerEntitlement('t', { now: NOW }, deps({ plan: { plan: 'team' }, active: 9 }).d)).toBeNull();
  });

  it('runner-hours exhausted blocks; adding allowance (a larger plan) lets the same usage through', async () => {
    expect(await checkManagedRunnerEntitlement('t', { now: NOW }, deps({ plan: { plan: 'individual' }, hours: 51 }).d))
      .toMatchObject({ kind: 'usage', used: 51, limit: 50 });
    expect(await checkManagedRunnerEntitlement('t', { now: NOW }, deps({ plan: { plan: 'individual', monthlyRunnerHours: 100 }, hours: 51 }).d))
      .toBeNull();
  });
});
