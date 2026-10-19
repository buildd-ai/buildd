/**
 * The workspace overview, Settings › Agents and a release page against
 * their budget (Living Spec "Fast at any size": R-8, R-9, R-11, R-15, R-23,
 * R-30) on a real database: at most 25 queries and 300 KB each before they
 * respond, no outside call, no write, for a team at ten times a large team's
 * size with many roles (each with a long SKILL.md) and a release with many
 * attributed tasks.
 *
 * R-11: the overview never reads a linked account's credentials to say
 * whether a runner can claim, and Agents never reads a role's SKILL.md or a
 * task's whole context. R-23: the release page's degradation lookup is
 * scoped to the release's workspace in the query.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q } from './harness';
import {
  PAGE_BUDGETS, expectWithinBudget, measureLoader, reportBudget,
  seedLargeTeam, seedScale, type SeededTeam,
} from './budget-harness';
import { installPageRenderMocks, isWrite, treeText } from './page-render';

assertDbConfigured();

const page = await installPageRenderMocks();
const { default: WorkspacePage } = await import('../../src/app/app/(protected)/workspaces/[id]/page');
const { default: AgentsPage } = await import('../../src/app/app/(protected)/settings/agents/page');
const { default: ReleasePage } = await import('../../src/app/app/(protected)/releases/[id]/page');
const { getCurrentUser } = await import('../../src/lib/auth-helpers');
const { resolveActiveTeamScope, getUserWorkspaceIds, getUserTeamsWithDetails } = await import('../../src/lib/team-access');
const { getChatAvailability } = await import('../../src/lib/chat-availability');

let team: SeededTeam;
let releaseId: string;
const scale = seedScale();

const ROLES = 15;
const RELEASE_TASKS = 40;
const SECRET_MARKER = 'bld_settings_budget_secret';

/** Roles with long SKILL.md bodies, a claim-linked runner account, and a release. Synthetic; reused when present. */
async function seedSettings(t: SeededTeam): Promise<void> {
  const ws = t.workspaceIds[0];
  const [existing] = await q<{ id: string }>(sql`
    SELECT r.id FROM releases r WHERE r.workspace_id = ${ws}::uuid AND r.version = 'v-budget' LIMIT 1`);
  if (existing) { releaseId = existing.id; return; }
  await q(sql`
    INSERT INTO workspace_skills (team_id, slug, name, content, content_hash, is_role, enabled, description)
    SELECT ${t.teamId}::uuid, 'budget-role-' || g, 'Budget role ' || g,
      repeat('How this role works: what it reads, what it writes, and when it hands off. ', 250), md5(g::text), true, true,
      'A role for the budget fixture.'
    FROM generate_series(1, ${ROLES}) g`);
  const [acct] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id) VALUES ('user', 'settings runner', ${`${SECRET_MARKER}_${Date.now().toString(36)}`}, ${t.teamId}::uuid)
    RETURNING id`);
  await q(sql`INSERT INTO account_workspaces (account_id, workspace_id, can_claim) VALUES (${acct.id}::uuid, ${ws}::uuid, true)`);
  const [rel] = await q<{ id: string }>(sql`
    INSERT INTO releases (workspace_id, archetype, version, state, head_sha, previous_sha)
    VALUES (${ws}::uuid, 'web', 'v-budget', 'healthy', ${'a'.repeat(40)}, ${'b'.repeat(40)}) RETURNING id`);
  releaseId = rel.id;
  await q(sql`
    INSERT INTO release_tasks (release_id, task_id)
    SELECT ${rel.id}::uuid, id FROM tasks WHERE workspace_id = ${ws}::uuid ORDER BY created_at DESC LIMIT ${RELEASE_TASKS}`);
}

beforeAll(async () => {
  team = await seedLargeTeam(scale);
  await seedSettings(team);
}, 900_000);

async function measure(name: string, render: () => Promise<unknown>) {
  await page.newRequest(team.userId, async () => {
    await getCurrentUser();
    const [, , scope] = await Promise.all([
      getUserTeamsWithDetails(team.userId), getUserWorkspaceIds(team.userId), resolveActiveTeamScope(team.userId, undefined),
    ]);
    await getChatAvailability(team.userId, scope.teamId);
  });
  let rendered: Awaited<ReturnType<typeof page.render>> | null = null;
  const m = await measureLoader(name, async () => { rendered = await page.render(render); });
  reportBudget(m, PAGE_BUDGETS.other, scale);
  return { m, rendered: rendered!, json: treeText(rendered!.tree) };
}

describe('Settings and workspace load budget', () => {
  it('the workspace overview fits R-8 and never reads an account credential', async () => {
    const { m, rendered, json } = await measure('workspaceOverview', () => WorkspacePage({ params: Promise.resolve({ id: team.workspaceIds[0] }) }));
    expect(rendered.outside).toEqual([]);
    expect(json).toContain('budget-ws-');
    // A claim-linked runner exists, so the no-runner hint is absent.
    expect(json).not.toContain('workspace-no-runner');
    expect(Object.keys(m.byOperation).filter(isWrite)).toEqual([]);
    expect(m.queries.some((x) => x.table === 'accounts' && /api_key|oauth_token/.test(x.head))).toBe(false);
    expectWithinBudget(m, PAGE_BUDGETS.other);
  }, 300_000);

  it('Settings › Agents fits R-8 and never reads a SKILL.md', async () => {
    const { m, rendered, json } = await measure('settingsAgents', () => AgentsPage());
    expect(rendered.outside).toEqual([]);
    expect(json).toContain('Budget role 1');
    expect(json).not.toContain('How this role works');
    expect(Object.keys(m.byOperation).filter(isWrite)).toEqual([]);
    expectWithinBudget(m, PAGE_BUDGETS.other);
  }, 300_000);

  it('a release page fits R-8, its degradation lookup scoped to the workspace', async () => {
    const { m, rendered, json } = await measure('releasePage', () => ReleasePage({ params: Promise.resolve({ id: releaseId }) }));
    expect(rendered.outside).toEqual([]);
    expect(json).toContain('v-budget');
    expect(Object.keys(m.byOperation).filter(isWrite)).toEqual([]);
    const degradation = m.queries.find((x) => x.table === 'tasks' && /degradation|context->>/.test(x.head) && !/release_tasks/.test(x.head));
    if (degradation) expect(degradation.head).toMatch(/workspace_id/);
    expectWithinBudget(m, PAGE_BUDGETS.other);
  }, 300_000);
});
