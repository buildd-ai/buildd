import { describe, it, expect } from 'bun:test';
import { diagnoseRunnerReach, RESTRICTED_UNLINKED_MESSAGE } from './runner-reach-diagnosis';

const restricted = { teamId: 'team-1', accessMode: 'restricted' };

describe('diagnoseRunnerReach', () => {
  it("names the cause and offers a fix when the team's online runner is not linked to a restricted workspace", () => {
    expect(diagnoseRunnerReach({
      workspace: restricted,
      onlineRunners: [{ accountId: 'acct-runner', accountTeamId: 'team-1', link: null }],
      linkedClaimerCount: 0,
    })).toEqual({ reason: 'restricted_unlinked', message: RESTRICTED_UNLINKED_MESSAGE, fixAccountIds: ['acct-runner'] });
  });

  it('says nothing when an online runner already reaches the workspace', () => {
    expect(diagnoseRunnerReach({
      workspace: restricted,
      onlineRunners: [
        { accountId: 'acct-a', accountTeamId: 'team-1', link: null },
        { accountId: 'acct-b', accountTeamId: 'team-1', link: { canClaim: true, canCreate: false } },
      ],
      linkedClaimerCount: 1,
    })).toBeNull();
  });

  it('a link without canClaim does not count', () => {
    expect(diagnoseRunnerReach({
      workspace: restricted,
      onlineRunners: [{ accountId: 'acct-a', accountTeamId: 'team-1', link: { canClaim: false, canCreate: true } }],
      linkedClaimerCount: 0,
    })?.reason).toBe('restricted_unlinked');
  });

  it('says nothing for an open workspace', () => {
    expect(diagnoseRunnerReach({
      workspace: { teamId: 'team-1', accessMode: 'open' },
      onlineRunners: [],
      linkedClaimerCount: 0,
    })).toBeNull();
  });

  it("never offers to link another team's runner", () => {
    expect(diagnoseRunnerReach({
      workspace: restricted,
      onlineRunners: [{ accountId: 'acct-x', accountTeamId: 'team-2', link: null }],
      linkedClaimerCount: 0,
    })).toEqual(expect.objectContaining({ reason: 'restricted_no_runner', fixAccountIds: [] }));
  });

  it('stays quiet when a linked runner exists but is offline (the usual waiting copy applies)', () => {
    expect(diagnoseRunnerReach({ workspace: restricted, onlineRunners: [], linkedClaimerCount: 1 })).toBeNull();
  });
});
