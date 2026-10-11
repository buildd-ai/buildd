import { beforeEach, describe, expect, it, mock } from 'bun:test';

/**
 * Failures, Usage and Insights are the team's own Health pages again: anyone
 * signed in to the team gets past the route, and each page scopes what it
 * reads (a team admin sees the team, a member their own work; Insights says
 * "Team admins only"). Operator stays the platform owner's: everyone else,
 * team admins included, gets a 404 as if it did not exist.
 */
const OWNER = 'owner@example.com';
let signedIn: { id: string; email: string } | null = null;

class NotFound extends Error { constructor() { super('NEXT_NOT_FOUND'); } }
class Downstream extends Error { constructor() { super('downstream'); } }

const navigation = await import('next/navigation');
mock.module('next/navigation', () => ({
  ...navigation,
  notFound: () => { throw new NotFound(); },
  redirect: () => { throw new Error('NEXT_REDIRECT'); },
}));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => signedIn }));
// Past the gate a page loads its data; failing here proves the gate let it through.
const downstream = async () => { throw new Downstream(); };
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: downstream,
  resolveActiveTeamId: downstream,
  resolveActiveTeamScope: downstream,
  getTeamWorkspaceIds: downstream,
}));
mock.module('next/headers', () => ({ cookies: downstream }));

process.env.BUILDD_OPERATOR_USER_EMAILS = OWNER;

type Load = () => Promise<{ default: (p: { searchParams: Promise<Record<string, string>> }) => unknown }>;
const teamPages: Array<[string, Load]> = [
  ['/app/health/failures', () => import('./failures/page')],
  ['/app/health/usage', () => import('./usage/page')],
  ['/app/health/insights', () => import('./insights/page')],
  ['/app/health/insights/tasks', () => import('./insights/tasks/page')],
];
const operatorPage: Load = () => import('./operator/page');

async function visit(load: Load): Promise<'not-found' | 'past-gate'> {
  const { default: Page } = await load();
  try {
    await Page({ searchParams: Promise.resolve({}) });
    return 'past-gate';
  } catch (err) {
    return err instanceof NotFound ? 'not-found' : 'past-gate';
  }
}

beforeEach(() => { signedIn = null; });

describe("the team's Health pages", () => {
  for (const [route, load] of teamPages) {
    it(`${route} opens for anyone in the team`, async () => {
      signedIn = { id: 'member', email: 'member@example.com' };
      expect(await visit(load)).toBe('past-gate');
    });
  }
});

describe('Operator', () => {
  it('is a 404 for a team admin', async () => {
    signedIn = { id: 'admin', email: 'admin@example.com' };
    expect(await visit(operatorPage)).toBe('not-found');
  });

  it('still opens for the platform owner', async () => {
    signedIn = { id: 'owner', email: OWNER };
    expect(await visit(operatorPage)).toBe('past-gate');
  });
});
