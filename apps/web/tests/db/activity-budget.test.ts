/**
 * Activity's load against its budget (Living Spec "Fast at any size": R-4,
 * R-11, R-12, R-14, R-15, R-30) on a real database.
 *
 * R-4: a team at ten times a large team's size, Activity's Now and History
 * each make at most 10 queries and read at most 200 KB before the page
 * responds, call no outside service and write nothing.
 *
 * R-12: only the tab on screen is built: Now carries no History episodes and
 * History no Now groups.
 *
 * Mission and initiative filters narrow in SQL: a filtered view reads less
 * than the team view, not the team window and then a JS filter.
 *
 * Measured: the page's own server load (TasksPage), signed in as the team's
 * owner, in a request whose layout already ran (page-render.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q } from './harness';
import {
  PAGE_BUDGETS, expectWithinBudget, measureLoader, reportBudget,
  seedLargeTeam, seedMissionSummaries, seedScale, type SeededTeam,
} from './budget-harness';
import { installPageRenderMocks, isWrite } from './page-render';

assertDbConfigured();

const page = await installPageRenderMocks();
const { default: TasksPage } = await import('../../src/app/app/(protected)/tasks/page');
const { getCurrentUser } = await import('../../src/lib/auth-helpers');
const { resolveActiveTeamScope, getUserWorkspaceIds, getUserTeamsWithDetails } = await import('../../src/lib/team-access');
const { getChatAvailability } = await import('../../src/lib/chat-availability');

/** What the protected layout reads for every page; React cache()d per request. */
async function layoutReads(userId: string) {
  await getCurrentUser();
  const [, , scope] = await Promise.all([
    getUserTeamsWithDetails(userId), getUserWorkspaceIds(userId), resolveActiveTeamScope(userId, undefined),
  ]);
  if (scope.teamId) await getChatAvailability(userId, scope.teamId);
}

type ActivityProps = { mode: string; loadError: boolean; now: { groups: unknown[] }; history: unknown[] };

/**
 * The page returns ActivityView inside its LiveRegion (R-7), beside the
 * auto-refresh: find the view's element in the tree by its own props.
 */
function findActivityProps(node: unknown): ActivityProps | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findActivityProps(child);
      if (found) return found;
    }
    return null;
  }
  const props = (node as { props?: Record<string, unknown> } | null)?.props;
  if (!props) return null;
  if ('mode' in props && 'history' in props && 'loadError' in props) return props as unknown as ActivityProps;
  return findActivityProps(props.children);
}

async function renderActivity(userId: string, searchParams: Record<string, string>) {
  await page.newRequest(userId, () => layoutReads(userId));
  let rendered: Awaited<ReturnType<typeof page.render>> | null = null;
  const label = `activity.${searchParams.view ?? 'now'}${searchParams.mission ? '.mission' : ''}${searchParams.initiative ? '.initiative' : ''}`;
  const m = await measureLoader(label, async () => {
    rendered = await page.render(() => TasksPage({ searchParams: Promise.resolve(searchParams) }));
  });
  const props = findActivityProps(rendered!.tree);
  if (!props) throw new Error('TasksPage rendered no ActivityView');
  return { m, rendered: rendered!, props };
}

let team: SeededTeam;
let busyMission: string;
let initiativeId: string;
const scale = seedScale();

beforeAll(async () => {
  team = await seedLargeTeam(scale);
  // In production summaries are written as work changes (R-13).
  await seedMissionSummaries(team);
  // The open mission with the most recently touched tasks, and an initiative
  // holding it. Synthetic.
  const [row] = await q<{ id: string }>(sql`
    SELECT m.id FROM missions m JOIN tasks t ON t.mission_id = m.id
    WHERE m.team_id = ${team.teamId}::uuid AND m.status = 'active' AND t.updated_at > now() - interval '30 days'
    GROUP BY m.id ORDER BY count(*) DESC, m.id LIMIT 1`);
  busyMission = row.id;
  const [init] = await q<{ id: string }>(sql`
    INSERT INTO initiatives (team_id, title) VALUES (${team.teamId}::uuid, 'Budget initiative') RETURNING id`);
  initiativeId = init.id;
  await q(sql`UPDATE missions SET initiative_id = ${initiativeId}::uuid WHERE id = ${busyMission}::uuid`);
}, 900_000);

// The seeded team is shared with the other budget tests: leave it as found.
afterAll(async () => {
  if (!initiativeId) return;
  await q(sql`UPDATE missions SET initiative_id = NULL WHERE initiative_id = ${initiativeId}::uuid`);
  await q(sql`DELETE FROM initiatives WHERE id = ${initiativeId}::uuid`);
});

describe('Activity load budget', () => {
  for (const view of ['now', 'history'] as const) {
    it(`${view} fits R-4 at AC-1 scale: at most 10 queries and 200 KB, no outside call, no write`, async () => {
      const { m, rendered, props } = await renderActivity(team.userId, view === 'history' ? { view } : {});
      reportBudget(m, PAGE_BUDGETS.activity, scale);
      expect(rendered.outside).toEqual([]);
      expect(rendered.errors).toEqual([]);
      expect(props.loadError).toBe(false);
      expect(Object.keys(m.byOperation).filter(isWrite)).toEqual([]);
      // R-12: the tab on screen is built, the other is not.
      if (view === 'now') {
        expect(props.now.groups.length).toBeGreaterThan(0);
        expect(props.history).toEqual([]);
      } else {
        expect(props.history.length).toBeGreaterThan(0);
        expect(props.now.groups).toEqual([]);
      }
      expectWithinBudget(m, PAGE_BUDGETS.activity);
    }, 300_000);
  }

  it('narrows to a mission in SQL: less read than the team view', async () => {
    const team = await renderActivity(teamUser(), { view: 'history' });
    const filtered = await renderActivity(teamUser(), { view: 'history', mission: busyMission });
    reportBudget(filtered.m, PAGE_BUDGETS.activity, scale);
    expect(filtered.props.loadError).toBe(false);
    expect(filtered.props.history.length).toBeGreaterThan(0);
    expect(filtered.m.bytes).toBeLessThan(team.m.bytes / 2);
  }, 300_000);

  it('narrows to an initiative in SQL: less read than the team view', async () => {
    const team = await renderActivity(teamUser(), { view: 'history' });
    const filtered = await renderActivity(teamUser(), { view: 'history', initiative: initiativeId });
    reportBudget(filtered.m, PAGE_BUDGETS.activity, scale);
    expect(filtered.props.loadError).toBe(false);
    expect(filtered.props.history.length).toBeGreaterThan(0);
    expect(filtered.m.bytes).toBeLessThan(team.m.bytes / 2);
  }, 300_000);
});

function teamUser() { return team.userId; }
