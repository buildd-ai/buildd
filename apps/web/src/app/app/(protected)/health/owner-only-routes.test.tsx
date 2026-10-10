import { beforeEach, describe, expect, it, mock } from 'bun:test';

/**
 * Failures, Usage and Insights moved to the private admin app with the
 * Operator page. Everyone but the platform owner gets a 404 at the old routes,
 * as if they did not exist; the owner still reaches them.
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

const pages: Array<[string, () => Promise<{ default: (p: { searchParams: Promise<Record<string, string>> }) => unknown }>]> = [
  ['/app/health/failures', () => import('./failures/page')],
  ['/app/health/usage', () => import('./usage/page')],
  ['/app/health/insights', () => import('./insights/page')],
  ['/app/health/insights/tasks', () => import('./insights/tasks/page')],
  ['/app/health/operator', () => import('./operator/page')],
];

async function visit(load: (typeof pages)[number][1]): Promise<'not-found' | 'past-gate'> {
  const { default: Page } = await load();
  try {
    await Page({ searchParams: Promise.resolve({}) });
    return 'past-gate';
  } catch (err) {
    return err instanceof NotFound ? 'not-found' : 'past-gate';
  }
}

beforeEach(() => { signedIn = null; });

describe('operator screens moved to the admin app', () => {
  for (const [route, load] of pages) {
    it(`${route} is a 404 for a team member`, async () => {
      signedIn = { id: 'member', email: 'member@example.com' };
      expect(await visit(load)).toBe('not-found');
    });

    it(`${route} still opens for the platform owner`, async () => {
      signedIn = { id: 'owner', email: OWNER };
      expect(await visit(load)).toBe('past-gate');
    });
  }
});
