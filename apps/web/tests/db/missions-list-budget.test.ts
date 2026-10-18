/**
 * The missions list's load against its budget (Living Spec "Fast at any
 * size": R-2, R-9, R-11, R-13, R-14, R-15, R-30) on a real database.
 *
 * R-2: a team at ten times a large team's size, its mission summaries stored
 * (in production they are written as work changes), the list makes at most
 * 10 queries and reads at most 200 KB before it responds, calls no outside
 * service and writes nothing.
 *
 * Measured: the page's own server load (MissionsPage), signed in as the
 * team's owner with no filters, in a request whose layout already ran (its
 * shared reads are React cache()d per request, see page-render.ts).
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { assertDbConfigured } from './harness';
import {
  PAGE_BUDGETS, expectWithinBudget, measureLoader, reportBudget,
  seedLargeTeam, seedMissionSummaries, seedScale, type SeededTeam,
} from './budget-harness';
import { installPageRenderMocks, isWrite, treeText } from './page-render';

assertDbConfigured();

const page = await installPageRenderMocks();
const { default: MissionsPage } = await import('../../src/app/app/(protected)/missions/page');
const { getCurrentUser } = await import('../../src/lib/auth-helpers');
const { resolveActiveTeamScope, getUserWorkspaceIds, getUserTeamsWithDetails } = await import('../../src/lib/team-access');
const { getChatAvailability } = await import('../../src/lib/chat-availability');

let team: SeededTeam;
const scale = seedScale();

beforeAll(async () => {
  team = await seedLargeTeam(scale);
  await seedMissionSummaries(team);
}, 900_000);

describe('Missions list load budget', () => {
  it('fits R-2 at AC-1 scale: at most 10 queries and 200 KB, no outside call, no write', async () => {
    await page.newRequest(team.userId, async () => {
      // What the protected layout reads for every page.
      await getCurrentUser();
      const [, , scope] = await Promise.all([
        getUserTeamsWithDetails(team.userId), getUserWorkspaceIds(team.userId), resolveActiveTeamScope(team.userId, undefined),
      ]);
      await getChatAvailability(team.userId, scope.teamId);
    });
    let rendered: Awaited<ReturnType<typeof page.render>> | null = null;
    const m = await measureLoader('missionsList', async () => {
      rendered = await page.render(() => MissionsPage({ searchParams: Promise.resolve({}) }));
    });
    reportBudget(m, PAGE_BUDGETS.missionsList, scale);
    expect(rendered!.outside).toEqual([]);
    expect(m.count).toBeGreaterThan(0);
    // The list reached the team's missions: open ones with their delivery rows.
    const json = treeText(rendered!.tree);
    expect(json).toMatch(/"rows":\[\{"delivery":\{"id":/);
    expect(json).toContain('"open":true');
    expect(Object.keys(m.byOperation).filter(isWrite)).toEqual([]);
    expectWithinBudget(m, PAGE_BUDGETS.missionsList);
  }, 300_000);
});
