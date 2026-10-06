import { describe, it, expect } from 'bun:test';
import {
  entitlements,
  isBillingEnforced,
  normalizePlan,
  FREE_KNOWLEDGE_BASE_DOC_CAP,
  TEAM_PLAN_MIN_SEATS,
} from '../entitlements';

const ON = { BILLING_ENFORCED: '1' };
const OFF = {};

describe('isBillingEnforced', () => {
  it('defaults off when the variable is absent', () => {
    expect(isBillingEnforced({})).toBe(false);
  });

  it('is on only for an explicit truthy value', () => {
    for (const v of ['1', 'true', 'TRUE', 'on', 'yes', ' true ']) {
      expect(isBillingEnforced({ BILLING_ENFORCED: v })).toBe(true);
    }
    for (const v of ['', '0', 'false', 'off', 'no', 'enforced']) {
      expect(isBillingEnforced({ BILLING_ENFORCED: v })).toBe(false);
    }
  });
});

describe('normalizePlan', () => {
  it('keeps known plans', () => {
    expect(normalizePlan('free')).toBe('free');
    expect(normalizePlan('pro')).toBe('pro');
    expect(normalizePlan('team')).toBe('team');
  });

  it('falls back to free for anything else', () => {
    expect(normalizePlan('enterprise')).toBe('free');
    expect(normalizePlan('')).toBe('free');
    expect(normalizePlan(null)).toBe('free');
    expect(normalizePlan(undefined)).toBe('free');
    expect(normalizePlan('PRO')).toBe('free');
  });
});

describe('entitlements — billing enforced', () => {
  it('free: one member, small KB cap, decisions bring-your-own-key', () => {
    expect(entitlements({ plan: 'free' }, { env: ON })).toEqual({
      plan: 'free',
      enforced: true,
      maxMembers: 1,
      knowledgeBaseCap: FREE_KNOWLEDGE_BASE_DOC_CAP,
      decisionCallsIncluded: false,
    });
  });

  it('pro: one member, full KB, decisions included', () => {
    expect(entitlements({ plan: 'pro' }, { env: ON })).toEqual({
      plan: 'pro',
      enforced: true,
      maxMembers: 1,
      knowledgeBaseCap: null,
      decisionCallsIncluded: true,
    });
  });

  it('team: paid seat count members, full KB, decisions included', () => {
    expect(entitlements({ plan: 'team', paidSeats: 8 }, { env: ON })).toEqual({
      plan: 'team',
      enforced: true,
      maxMembers: 8,
      knowledgeBaseCap: null,
      decisionCallsIncluded: true,
    });
  });

  it('team: seats never go below the minimum', () => {
    expect(TEAM_PLAN_MIN_SEATS).toBe(5);
    expect(entitlements({ plan: 'team', paidSeats: 2 }, { env: ON }).maxMembers).toBe(5);
    expect(entitlements({ plan: 'team', paidSeats: 0 }, { env: ON }).maxMembers).toBe(5);
    expect(entitlements({ plan: 'team', paidSeats: null }, { env: ON }).maxMembers).toBe(5);
    expect(entitlements({ plan: 'team' }, { env: ON }).maxMembers).toBe(5);
  });

  it('team: a fractional or negative seat count is floored, then clamped', () => {
    expect(entitlements({ plan: 'team', paidSeats: 6.9 }, { env: ON }).maxMembers).toBe(6);
    expect(entitlements({ plan: 'team', paidSeats: -3 }, { env: ON }).maxMembers).toBe(5);
  });

  it('paid seats do not lift a non-team plan above one member', () => {
    expect(entitlements({ plan: 'pro', paidSeats: 10 }, { env: ON }).maxMembers).toBe(1);
    expect(entitlements({ plan: 'free', paidSeats: 10 }, { env: ON }).maxMembers).toBe(1);
  });

  it('an unknown plan falls back to free', () => {
    expect(entitlements({ plan: 'enterprise' }, { env: ON })).toEqual(
      entitlements({ plan: 'free' }, { env: ON }),
    );
    expect(entitlements({ plan: null }, { env: ON }).plan).toBe('free');
    expect(entitlements({}, { env: ON }).plan).toBe('free');
  });
});

describe('entitlements — billing not enforced (default)', () => {
  it('every plan is unlimited', () => {
    for (const plan of ['free', 'pro', 'team', 'enterprise', null]) {
      const e = entitlements({ plan, paidSeats: 1 }, { env: OFF });
      expect(e.enforced).toBe(false);
      expect(e.maxMembers).toBeNull();
      expect(e.knowledgeBaseCap).toBeNull();
      expect(e.decisionCallsIncluded).toBe(true);
    }
  });

  it('still reports the team\'s stored plan, normalized', () => {
    expect(entitlements({ plan: 'pro' }, { env: OFF }).plan).toBe('pro');
    expect(entitlements({ plan: 'team' }, { env: OFF }).plan).toBe('team');
    expect(entitlements({ plan: 'bogus' }, { env: OFF }).plan).toBe('free');
  });

  it('reads process.env when no env is passed', () => {
    const prev = process.env.BILLING_ENFORCED;
    try {
      delete process.env.BILLING_ENFORCED;
      expect(entitlements({ plan: 'free' }).maxMembers).toBeNull();
      process.env.BILLING_ENFORCED = '1';
      expect(entitlements({ plan: 'free' }).maxMembers).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.BILLING_ENFORCED;
      else process.env.BILLING_ENFORCED = prev;
    }
  });
});
