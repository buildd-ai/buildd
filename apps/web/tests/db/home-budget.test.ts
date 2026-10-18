/**
 * Home's load against its budget (Living Spec "Fast at any size": R-1, R-30,
 * AC-1) on a real database holding a team at ten times a large team's size.
 *
 * Known over: Home reads every non-archived mission with its tasks and
 * workers today, so it is far past 15 queries and 200 KB. This test records
 * the numbers and passes while that is true; the Home slice that brings it
 * under drops `knownOver` and the budget is enforced from then on.
 *
 * Measured: the page's own server load (HomePage), signed in as the team's
 * owner with no filters. Not measured: the protected layout (shared chrome,
 * its own budget under R-17) and work deferred with after().
 */
import { describe, it, expect, mock, beforeAll } from 'bun:test';
import { assertDbConfigured } from './harness';
import { PAGE_BUDGETS, expectWithinBudget, measureLoader, reportBudget, seedLargeTeam, seedScale, type SeededTeam } from './budget-harness';

assertDbConfigured();

let signedIn: string | null = null;
mock.module('../../src/auth', () => ({ auth: async () => (signedIn ? { user: { id: signedIn } } : null) }));
mock.module('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }),
  headers: async () => new Headers(),
}));
// after() needs a request scope; deferred work is outside the budget anyway.
const nextServer = await import('next/server');
mock.module('next/server', () => ({ ...nextServer, after: () => {} }));

const { default: HomePage } = await import('../../src/app/app/(protected)/home/page');

let team: SeededTeam;
const scale = seedScale();

beforeAll(async () => {
  team = await seedLargeTeam(scale);
  signedIn = team.userId;
}, 600_000);

describe('Home load budget', () => {
  it('measures Home at AC-1 scale (known over budget until the Home slice)', async () => {
    // Home catches its own query errors and renders empty; a swallowed error
    // would make a short, cheap load look like a fast one.
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => { errors.push(args); };
    const m = await measureLoader('home', () => HomePage({ searchParams: Promise.resolve({}) }));
    reportBudget(m, PAGE_BUDGETS.home, scale);
    const swallowed = errors.filter(e => String(e[0]).includes('Home page query error'))
      .map(e => `${String(e[1]).slice(0, 200)} cause: ${String((e[1] as { cause?: unknown })?.cause)}`);
    expect(swallowed).toEqual([]);
    // The harness saw the load at all: Home reads the team's missions.
    expect(m.count).toBeGreaterThan(0);
    expect(m.byTable.missions?.count ?? 0).toBeGreaterThan(0);
    expectWithinBudget(m, PAGE_BUDGETS.home, { knownOver: true });
  }, 300_000);
});
