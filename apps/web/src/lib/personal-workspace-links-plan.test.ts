import { describe, it, expect } from 'bun:test';
import { planPersonalWorkspaceLinks, personalTeamSlug } from './personal-workspace-links-plan';

const userId = 'user-1';
const team = { id: 'team-p', slug: personalTeamSlug(userId) };
const loginAccount = { id: 'acct-login', type: 'user', teamId: 'team-p', workspaceIds: null };
const myWorkspace = { id: 'ws-mine', teamId: 'team-p', accessMode: 'restricted' };

describe('planPersonalWorkspaceLinks', () => {
  it("links a fresh user's login account to the restricted workspace sign-in created", () => {
    expect(planPersonalWorkspaceLinks({
      userId, canManageTeamKeys: true, team, account: loginAccount, teamWorkspaces: [myWorkspace],
    })).toEqual([{ accountId: 'acct-login', workspaceId: 'ws-mine', canClaim: true, canCreate: true }]);
  });

  it('adds nothing for an open workspace (already reachable within the team) or an existing link', () => {
    expect(planPersonalWorkspaceLinks({
      userId, canManageTeamKeys: true, team, account: loginAccount,
      teamWorkspaces: [{ id: 'ws-open', teamId: 'team-p', accessMode: 'open' }, myWorkspace],
      existingLinks: ['ws-mine'],
    })).toEqual([]);
  });

  it("never links in a shared team, even one the user owns", () => {
    expect(planPersonalWorkspaceLinks({
      userId, canManageTeamKeys: true, team: { id: 'team-p', slug: 'acme' }, account: loginAccount, teamWorkspaces: [myWorkspace],
    })).toEqual([]);
  });

  it("never links in someone else's personal team", () => {
    expect(planPersonalWorkspaceLinks({
      userId, canManageTeamKeys: true, team: { id: 'team-p', slug: personalTeamSlug('user-2') }, account: loginAccount, teamWorkspaces: [myWorkspace],
    })).toEqual([]);
  });

  it('requires the user to be allowed to manage team keys', () => {
    expect(planPersonalWorkspaceLinks({
      userId, canManageTeamKeys: false, team, account: loginAccount, teamWorkspaces: [myWorkspace],
    })).toEqual([]);
  });

  it('skips service/action accounts, other-team accounts and workspace-scoped tokens', () => {
    for (const account of [
      { ...loginAccount, type: 'service' },
      { ...loginAccount, teamId: 'team-other' },
      { ...loginAccount, workspaceIds: ['ws-elsewhere'] },
    ]) {
      expect(planPersonalWorkspaceLinks({ userId, canManageTeamKeys: true, team, account, teamWorkspaces: [myWorkspace] })).toEqual([]);
    }
  });

  it("ignores workspaces of another team even if passed in", () => {
    expect(planPersonalWorkspaceLinks({
      userId, canManageTeamKeys: true, team, account: loginAccount,
      teamWorkspaces: [{ id: 'ws-x', teamId: 'team-other', accessMode: 'restricted' }],
    })).toEqual([]);
  });
});
