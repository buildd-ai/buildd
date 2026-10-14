/**
 * A runner key's dead pick (spec "One runner for every team you run", R-3)
 * is a deny in every per-workspace reach check, not just the claim route:
 * the MCP `?workspace=` scope, the mission open-mode check, the account
 * workspace checks. Each reads the link through readReachLink first, so the
 * own-team / open rule never gets a dead pick back. Real rows:
 * apps/web/tests/db/runner-picks-reach.test.ts.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

const WS = '11111111-2222-4333-8444-555555555555';
let link: any = null;
const mockReadReachLink = mock(async (_a: string, _w: string) => link);
const ws = { id: WS, teamId: 'team-home', accessMode: 'open' };

const grantedLinks = () => ({
  readReachLink: mockReadReachLink,
  liveLinkCondition: () => undefined,
  liveGrantedWorkspaceIds: async () => new Set<string>(),
  grantedLinkHolds: async () => false,
  grantedLinkStillValid: () => undefined,
  liveGrantedLinksQuery: () => undefined,
});
mock.module('@/lib/granted-links', grantedLinks);
mock.module('./granted-links', grantedLinks);
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: async () => ws },
      accounts: { findFirst: async () => ({ teamId: 'team-home', workspaceIds: [WS] }) },
    },
  },
}));

const { isWorkspaceInCallerScope } = await import('./mcp-request-scope');
const { workspaceOpenToCaller } = await import('./open-workspaces');
const { verifyAccountWorkspaceAccess } = await import('./team-access');
const { resolveWorkspaceAccess } = await import('./workspace-access');

const key = { id: 'acct-k', teamId: 'team-home', workspaceIds: [WS] };

beforeEach(() => {
  mockReadReachLink.mockClear();
});

describe('a dead pick of an open home-team workspace', () => {
  beforeEach(() => { link = { canClaim: false, canCreate: false, revoked: true }; });

  it('is out of the MCP request scope', async () => {
    expect(await isWorkspaceInCallerScope(WS, key)).toBe(false);
  });
  it('is not open to the caller', async () => {
    expect(await workspaceOpenToCaller(WS, { teamIds: ['team-home'], accountId: 'acct-k' })).toBe(false);
  });
  it('fails verifyAccountWorkspaceAccess', async () => {
    expect(await verifyAccountWorkspaceAccess('acct-k', WS)).toBe(false);
    expect(await verifyAccountWorkspaceAccess('acct-k', WS, 'canCreate')).toBe(false);
  });
  it('fails resolveWorkspaceAccess', async () => {
    const r = await resolveWorkspaceAccess(WS, { account: key } as any);
    expect(r.ok).toBe(false);
  });
});

describe('R-6: with a live pick, or no link at all, the open rule applies as before', () => {
  it('a live pick reaches', async () => {
    link = { canClaim: true, canCreate: true };
    expect(await isWorkspaceInCallerScope(WS, key)).toBe(true);
    expect(await workspaceOpenToCaller(WS, { teamIds: ['team-home'], accountId: 'acct-k' })).toBe(true);
    expect(await verifyAccountWorkspaceAccess('acct-k', WS)).toBe(true);
  });
  it('no link: own-team open still reaches', async () => {
    link = null;
    expect(await isWorkspaceInCallerScope(WS, { id: 'acct-old', teamId: 'team-home' })).toBe(true);
    expect(await workspaceOpenToCaller(WS, { teamIds: ['team-home'], accountId: 'acct-old' })).toBe(true);
  });
});
