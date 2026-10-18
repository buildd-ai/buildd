/**
 * The mission page's load against its budget (Living Spec "Fast at any
 * size": R-3, R-9, R-11, R-12, R-14, R-15, R-18, R-30, AC-3) on a real
 * database.
 *
 * R-3: the busiest open mission of a team at ten times a large team's size,
 * at most 20 queries and 300 KB before the page responds, no write.
 *
 * AC-3: a mission whose page used to ask GitHub while it rendered (a gated
 * release with no release yet, a completed task whose PR merge was never
 * seen, an open visual audit on an integration branch) renders with every
 * outside client failing, and makes no call: those refreshes wait for after().
 *
 * R-18: only the layout on screen is built.
 *
 * Measured: the page's own server load (MissionDetailPage), signed in as the
 * team's owner, in a request whose layout already ran (page-render.ts).
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q } from './harness';
import {
  PAGE_BUDGETS, expectWithinBudget, measureLoader, reportBudget,
  seedLargeTeam, seedMissionSummaries, seedScale, type SeededTeam,
} from './budget-harness';
import { installPageRenderMocks, isWrite, treeText } from './page-render';

assertDbConfigured();

const page = await installPageRenderMocks();
const { default: MissionDetailPage } = await import('../../src/app/app/(protected)/missions/[id]/page');
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

async function renderMission(userId: string, missionId: string, searchParams: Record<string, string> = {}) {
  await page.newRequest(userId, () => layoutReads(userId));
  let rendered: Awaited<ReturnType<typeof page.render>> | null = null;
  const m = await measureLoader(`missionPage.${missionId.slice(0, 8)}`, async () => {
    rendered = await page.render(() => MissionDetailPage({ params: Promise.resolve({ id: missionId }), searchParams: Promise.resolve(searchParams) }));
  });
  return { m, rendered: rendered! };
}

/** The layouts the page built: MissionLayoutShell's board / flow / feed props that are set. */
function builtLayouts(tree: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 40) return;
    const el = node as { props?: Record<string, unknown> };
    const p = el.props;
    if (p && 'initial' in p && ('board' in p || 'flow' in p || 'feed' in p)) {
      for (const k of ['board', 'flow', 'feed']) if (p[k] != null) found.add(k);
      return;
    }
    if (Array.isArray(node)) { for (const c of node) walk(c, depth + 1); return; }
    if (p) for (const v of Object.values(p)) walk(v, depth + 1);
  };
  walk(tree, 0);
  return [...found].sort();
}

let team: SeededTeam;
let busiest: string;
const scale = seedScale();

beforeAll(async () => {
  team = await seedLargeTeam(scale);
  await seedMissionSummaries(team);
  const [row] = await q<{ id: string }>(sql`
    SELECT m.id FROM missions m JOIN tasks t ON t.mission_id = m.id
    WHERE m.team_id = ${team.teamId}::uuid AND m.status = 'active'
    GROUP BY m.id ORDER BY count(*) DESC, m.id LIMIT 1`);
  busiest = row.id;
}, 900_000);

describe('Mission page load budget', () => {
  it('fits R-3 at AC-1 scale: at most 20 queries and 300 KB, no outside call, no write', async () => {
    const { m, rendered } = await renderMission(team.userId, busiest);
    reportBudget(m, PAGE_BUDGETS.missionPage, scale);
    expect(rendered.outside).toEqual([]);
    expect(m.count).toBeGreaterThan(0);
    // It reached the mission and its tasks: the board names them.
    const json = treeText(rendered.tree);
    expect(json).toContain('Task ');
    expect(Object.keys(m.byOperation).filter(isWrite)).toEqual([]);
    expectWithinBudget(m, PAGE_BUDGETS.missionPage);
  }, 300_000);

  it('builds only the layout on screen (R-18)', async () => {
    expect(builtLayouts((await renderMission(team.userId, busiest)).rendered.tree)).toEqual(['board']);
    expect(builtLayouts((await renderMission(team.userId, busiest, { layout: 'flow' })).rendered.tree)).toEqual(['flow']);
    expect(builtLayouts((await renderMission(team.userId, busiest, { layout: 'feed' })).rendered.tree)).toEqual(['feed']);
  }, 300_000);
});

describe('Mission page calls no outside service before it responds (AC-3)', () => {
  let ownerId: string;
  let missionId: string;

  beforeAll(async () => {
    // A gated-release workspace linked to a GitHub installation, with no
    // release yet; an integration-branch mission with a completed task whose
    // PR merge was never seen and an open visual audit. Synthetic.
    const slug = `ac3-mission-${Date.now().toString(36)}`;
    const [t] = await q<{ id: string }>(sql`INSERT INTO teams (name, slug) VALUES ('AC-3 mission team', ${slug}) RETURNING id`);
    const [u] = await q<{ id: string }>(sql`INSERT INTO users (email, name) VALUES (${`${slug}@example.test`}, 'AC-3 Owner') RETURNING id`);
    ownerId = u.id;
    await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${t.id}::uuid, ${u.id}::uuid, 'owner')`);
    const [inst] = await q<{ id: string }>(sql`
      INSERT INTO github_installations (installation_id, account_type, account_login, account_id)
      VALUES (${Math.floor(Date.now() / 1000) + 7}, 'Organization', 'example', 1) RETURNING id`);
    const [repo] = await q<{ id: string }>(sql`
      INSERT INTO github_repos (installation_id, repo_id, full_name, name, owner)
      VALUES (${inst.id}::uuid, ${Date.now() + 7}, 'example/mission-fixture', 'mission-fixture', 'example') RETURNING id`);
    const [ws] = await q<{ id: string }>(sql`
      INSERT INTO workspaces (name, team_id, repo, github_repo_id, github_installation_id, git_config, release_config)
      VALUES ('ac3-mission-ws', ${t.id}::uuid, 'example/mission-fixture', ${repo.id}::uuid, ${inst.id}::uuid,
        '{"defaultBranch":"dev"}'::jsonb, '{"enabled":true,"prodBranch":"main"}'::jsonb) RETURNING id`);
    const [mission] = await q<{ id: string }>(sql`
      INSERT INTO missions (team_id, workspace_id, title, status, integration_branch_enabled, working_branch, auto_surface_audit)
      VALUES (${t.id}::uuid, ${ws.id}::uuid, 'Branch mission with an audit', 'active', true, 'mission/ac3-page', true) RETURNING id`);
    missionId = mission.id;
    const [work] = await q<{ id: string }>(sql`
      INSERT INTO tasks (workspace_id, mission_id, title, status, task_class, role_slug, path_manifest)
      VALUES (${ws.id}::uuid, ${mission.id}::uuid, 'feat: change the settings page', 'completed', 'work', 'builder', '["apps/web/src/app/app/(protected)/settings/page.tsx"]'::jsonb) RETURNING id`);
    await q(sql`
      INSERT INTO tasks (workspace_id, mission_id, title, status, task_class, role_slug)
      VALUES (${ws.id}::uuid, ${mission.id}::uuid, 'Surface audit: Branch mission with an audit', 'pending', 'work', 'visual-auditor')`);
    await q(sql`
      INSERT INTO workers (task_id, workspace_id, name, runner, branch, status, pr_url, pr_number, pr_lifecycle_status, pr_base_ref, last_commit_sha, started_at, completed_at)
      VALUES (${work.id}::uuid, ${ws.id}::uuid, 'w-work', 'runner', 'b-work', 'completed', 'https://github.com/example/mission-fixture/pull/21', 21, 'ci_green', 'mission/ac3-page', 'sha-work', now() - interval '3 hours', now() - interval '2 hours')`);
    await seedMissionSummaries({ teamId: t.id } as SeededTeam);
  }, 300_000);

  it('renders with every outside client failing, and makes no call and no write', async () => {
    const { m, rendered } = await renderMission(ownerId, missionId);
    expect(rendered.outside).toEqual([]);
    expect(Object.keys(m.byOperation).filter(isWrite)).toEqual([]);
    expect(treeText(rendered.tree)).toContain('feat: change the settings page');
    // The PR fact import for the unseen merge waits for after().
    expect(page.deferred.length).toBeGreaterThan(0);
  }, 300_000);
});
