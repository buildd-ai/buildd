/**
 * The shared reach rule (spec "One runner for every team you run", R-3, R-6).
 * A person's pick that no longer holds comes back as a `revoked` link
 * (granted-links.ts readReachLink); it is a deny before the open-within-team
 * arm, so a picked key whose picker left its home team cannot keep acting in
 * that team's open workspaces. Keys without picks behave as before.
 */
import { describe, expect, it } from 'bun:test';
import { accountReachesWorkspace } from './workspace-reach';

const home = { teamId: 'team-a' };
const openHome = { id: 'ws-open', teamId: 'team-a', accessMode: 'open' };
const restrictedOther = { id: 'ws-r', teamId: 'team-b', accessMode: 'restricted' };
const live = { canClaim: true, canCreate: true };
const revoked = { canClaim: false, canCreate: false, revoked: true };

describe('accountReachesWorkspace', () => {
  it('R-6: an open workspace of the own team, or a link, reaches as before', () => {
    expect(accountReachesWorkspace(home, openHome, null)).toBe(true);
    expect(accountReachesWorkspace(home, restrictedOther, live, 'canClaim')).toBe(true);
    expect(accountReachesWorkspace(home, restrictedOther, null)).toBe(false);
  });

  it('a revoked pick is a deny even in an open workspace of the own team', () => {
    expect(accountReachesWorkspace(home, openHome, revoked)).toBe(false);
    expect(accountReachesWorkspace(home, openHome, revoked, 'canCreate')).toBe(false);
    expect(accountReachesWorkspace(home, openHome, revoked, 'canClaim')).toBe(false);
  });

  it('a revoked pick is a deny for a no-permission check too (a link existing is not enough)', () => {
    expect(accountReachesWorkspace(home, restrictedOther, revoked)).toBe(false);
  });
});
