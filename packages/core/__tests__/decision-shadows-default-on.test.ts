import { describe, it, expect } from 'bun:test';
import { getTableColumns } from 'drizzle-orm';
import { teams } from '../db/schema';
import { DEFAULT_ENABLED_DECISION_SHADOWS, OPT_IN_CAPABILITIES, normalizeDecisionShadows } from '../inference-policy';

/**
 * 2026-10-04 owner decision: every opt-in decision is on by default. A new
 * team row gets them all from the insert itself, whichever path files it
 * (POST /api/teams, the personal team at sign-up, seeds). Turning them off in
 * Settings still stores NULL, and NULL still means off.
 */
describe('new teams default every opt-in decision on', () => {
  it('the default lists every opt-in capability', () => {
    expect([...DEFAULT_ENABLED_DECISION_SHADOWS].sort()).toEqual([...OPT_IN_CAPABILITIES].sort());
  });

  it('a teams insert without the column fills it with the default', () => {
    const col = getTableColumns(teams).enabledDecisionShadows;
    expect(col.defaultFn?.()).toEqual([...DEFAULT_ENABLED_DECISION_SHADOWS]);
  });

  it('each insert gets its own array', () => {
    const col = getTableColumns(teams).enabledDecisionShadows;
    expect(col.defaultFn?.()).not.toBe(col.defaultFn?.());
  });

  it('switching everything off still stores NULL', () => {
    expect(normalizeDecisionShadows([])).toEqual({ ok: true, value: null });
  });
});
