/**
 * The spec pages' loads against their budget (Living Spec "Fast at any size":
 * R-7, R-9, R-11, R-14, R-15, R-30) on a real database.
 *
 * R-7: a workspace's specs index and one spec's page each make at most 15
 * queries and read at most 200 KB before they respond, for a team at ten
 * times a large team's size with a busy spec workspace: many specs with long
 * bodies, areas, a filing history, and a spec with many revisions, comments
 * and pinned tasks.
 *
 * R-14: no outside call before responding. The specs index used to ask the
 * embedding service for a parent suggestion per unfiled spec, and the
 * approval confirm page asked GitHub for the repo checks; the render fails on
 * any fetch that is not the database's (page-render.ts).
 *
 * R-15: no write before the response.
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
process.env.AUTH_SECRET ||= 'specs-budget-test-secret';
// An embedding key, so a caller that would ask the embedding service does.
process.env.VOYAGE_API_KEY ||= 'test-voyage-key';

const page = await installPageRenderMocks();
const { default: WorkspaceSpecsPage } = await import('../../src/app/app/(protected)/workspaces/[id]/specs/page');
const { default: SpecPageRoute } = await import('../../src/app/app/(protected)/specs/[specId]/page');
const { default: SpecApprovePage } = await import('../../src/app/app/(protected)/specs/[specId]/approve/page');
const { getCurrentUser } = await import('../../src/lib/auth-helpers');
const { resolveActiveTeamScope, getUserWorkspaceIds, getUserTeamsWithDetails } = await import('../../src/lib/team-access');
const { getChatAvailability } = await import('../../src/lib/chat-availability');
const { createSpecDraft, reviseSpecDraft } = await import('../../src/lib/specs/store');
const { signSpecApprovalRequest } = await import('../../src/lib/specs/approval-request');

let team: SeededTeam;
let wsId: string;
let busySpecId: string;
const scale = seedScale();

const SPECS = 60;
const AREAS = 4;
const REVISIONS = 15;
const PINNED_TASKS = 10;

/** A spec body of about `kb` KB: sections of requirements, as a real spec reads. */
function body(title: string, kb: number, salt = ''): string {
  const lines = [`# ${title}`, '', 'What this covers and why it matters to the reader.', ''];
  for (let i = 1; lines.join('\n').length < kb * 1024; i++) {
    lines.push(`## Part ${i}`, '', `R-${i}: The page shows part ${i} of the work${salt}, read from what is stored, never worked out again.`, '');
  }
  return lines.join('\n');
}

const user = () => ({ kind: 'user' as const, userId: team.userId });

/**
 * The spec workspace: areas, many feature specs (most unfiled, so the index
 * would want a suggestion for each), a filing history, and one busy spec.
 * Synthetic; reused when present.
 */
async function seedSpecs(t: SeededTeam): Promise<void> {
  wsId = t.workspaceIds[0];
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${wsId}::uuid`);
  const [existing] = await q<{ id: string }>(sql`
    SELECT id FROM specs WHERE workspace_id = ${wsId}::uuid AND title = 'Budget busy spec' LIMIT 1`);
  if (existing) { busySpecId = existing.id; await pinTasks(); return; }

  const areaIds: string[] = [];
  for (let i = 1; i <= AREAS; i++) {
    const a = await createSpecDraft(user(), { workspaceId: wsId, title: `Budget area ${i}`, scope: 'domain', body: body(`Budget area ${i}`, 6) }, { duplicates: false });
    if (!a.ok) throw new Error(a.error);
    areaIds.push(a.spec.id);
  }
  const featureIds: string[] = [];
  for (let i = 1; i <= SPECS; i++) {
    // One in four filed under an area; the rest unfiled.
    const parentSpecId = i % 4 === 0 ? areaIds[i % AREAS] : undefined;
    const s = await createSpecDraft(user(), { workspaceId: wsId, title: `Budget feature ${i}`, body: body(`Budget feature ${i}`, 8), parentSpecId }, { duplicates: false });
    if (!s.ok) throw new Error(s.error);
    featureIds.push(s.spec.id);
  }
  // A filing history: older rows superseded by newer ones, a few still open.
  await q(sql`
    INSERT INTO spec_filings (workspace_id, spec_id, kind, status, source, parent_spec_id, proposal, created_at)
    SELECT ${wsId}::uuid, f.id, CASE WHEN g = 3 THEN 'suggested' ELSE 'filed' END,
      CASE WHEN g = 3 THEN 'open' ELSE 'applied' END, 'similarity',
      (${`{${areaIds.join(',')}}`}::uuid[])[1 + (g % ${AREAS})],
      jsonb_build_object('p', 0.8, 'notes', repeat('Why this placement was chosen. ', 30)),
      now() - (4 - g) * interval '1 day'
    FROM unnest(${`{${featureIds.slice(0, 20).join(',')}}`}::uuid[]) AS f(id), generate_series(1, 3) g`);

  // The busy spec: many revisions, comments, and tasks pinned to it.
  const b = await createSpecDraft(user(), { workspaceId: wsId, title: 'Budget busy spec', body: body('Budget busy spec', 20), parentSpecId: areaIds[0] }, { duplicates: false });
  if (!b.ok) throw new Error(b.error);
  busySpecId = b.spec.id;
  let version = b.spec.version;
  for (let r = 2; r <= REVISIONS; r++) {
    const next = await reviseSpecDraft(user(), busySpecId, { expectedVersion: version, body: body('Budget busy spec', 20, ` (rev ${r})`), changeSummary: `Revision ${r}` });
    if (!next.ok) throw new Error(next.error);
    version = next.spec.version;
  }
  await q(sql`
    INSERT INTO spec_comments (workspace_id, spec_id, spec_revision_id, anchor_kind, anchor_id, anchor_label, anchor_hash, body, author_kind, author_id)
    SELECT ${wsId}::uuid, ${busySpecId}::uuid, r.id, 'section', 'part-1', 'Part 1', 'h', repeat('A comment on this part of the spec. ', 10), 'user', ${t.userId}
    FROM spec_revisions r, generate_series(1, 12)
    WHERE r.spec_id = ${busySpecId}::uuid AND r.revision = ${REVISIONS}`);
  await pinTasks();
  for (const table of ['specs', 'spec_revisions', 'spec_filings', 'artifact_revisions']) await q(sql`ANALYZE ${sql.identifier(table)}`);
}

/**
 * Tasks pinned to the busy spec's first revision, as a claim pins them (the
 * revision's id and hash), each with a PR worker from the shared seed.
 */
async function pinTasks(): Promise<void> {
  await q(sql`
    UPDATE tasks SET context = jsonb_set(context, '{specSource}', jsonb_build_object(
      'specId', ${busySpecId}::text, 'revision', 1, 'criteria', jsonb_build_array('R-1', 'R-2'),
      'specRevisionId', r.id::text, 'contentHash', r.content_hash))
    FROM spec_revisions r
    WHERE r.spec_id = ${busySpecId}::uuid AND r.revision = 1
      AND tasks.id IN (SELECT id FROM tasks WHERE workspace_id = ${wsId}::uuid AND mission_id IS NULL ORDER BY created_at DESC LIMIT ${PINNED_TASKS})`);
}

beforeAll(async () => {
  team = await seedLargeTeam(scale);
  await seedSpecs(team);
}, 900_000);

async function newRequest(): Promise<void> {
  await page.newRequest(team.userId, async () => {
    await getCurrentUser();
    const [, , scope] = await Promise.all([
      getUserTeamsWithDetails(team.userId), getUserWorkspaceIds(team.userId), resolveActiveTeamScope(team.userId, undefined),
    ]);
    await getChatAvailability(team.userId, scope.teamId);
  });
}

async function measure(name: string, render: () => Promise<unknown>) {
  await newRequest();
  let rendered: Awaited<ReturnType<typeof page.render>> | null = null;
  const m = await measureLoader(name, async () => { rendered = await page.render(render); });
  reportBudget(m, PAGE_BUDGETS.specs, scale);
  return { m, rendered: rendered!, json: treeText(rendered!.tree) };
}

describe('Specs load budget', () => {
  it('the specs index fits R-7: at most 15 queries and 200 KB, no outside call, no write', async () => {
    const { m, rendered, json } = await measure('specsIndex', () => WorkspaceSpecsPage({ params: Promise.resolve({ id: wsId }) }));
    expect(rendered.outside).toEqual([]);
    expect(json).toContain('Budget feature 1');
    expect(json).toContain('Budget area 1');
    expect(Object.keys(m.byOperation).filter(isWrite)).toEqual([]);
    expectWithinBudget(m, PAGE_BUDGETS.specs);
  }, 300_000);

  it('works out parent suggestions after the response, and a later load shows them', async () => {
    const { neighbourDeps } = await import('../../src/lib/specs/neighbours');
    const realSimilar = neighbourDeps.similar;
    // No embedding service here: the areas are matched by their words.
    neighbourDeps.similar = async () => [];
    try {
      await newRequest();
      const first = treeText((await page.render(() => WorkspaceSpecsPage({ params: Promise.resolve({ id: wsId }) }))).tree);
      expect(page.deferred.length).toBeGreaterThan(0);
      for (const fn of page.deferred.splice(0)) await fn();
      await newRequest();
      const later = treeText((await page.render(() => WorkspaceSpecsPage({ params: Promise.resolve({ id: wsId }) }))).tree);
      const guesses = (t: string) => (t.match(/"reason":"Closest area by its words"/g) ?? []).length;
      expect(guesses(later)).toBeGreaterThan(guesses(first));
    } finally {
      neighbourDeps.similar = realSimilar;
    }
  }, 300_000);

  it('a busy spec page fits R-7: at most 15 queries and 200 KB, no outside call, no write', async () => {
    const { m, rendered, json } = await measure('specPage', () => SpecPageRoute({
      params: Promise.resolve({ specId: busySpecId }), searchParams: Promise.resolve({}),
    }));
    expect(rendered.outside).toEqual([]);
    expect(json).toContain('Budget busy spec');
    expect(Object.keys(m.byOperation).filter(isWrite)).toEqual([]);
    expectWithinBudget(m, PAGE_BUDGETS.specs);
  }, 300_000);

  it('the approval confirm page calls no outside service before responding', async () => {
    const [s] = await q<{ version: number; head_revision: number; content_hash: string }>(sql`
      SELECT s.version, s.head_revision, r.content_hash FROM specs s
      JOIN spec_revisions r ON r.spec_id = s.id AND r.revision = s.head_revision WHERE s.id = ${busySpecId}::uuid`);
    // The workspace writes repo copies, so the checks would ask GitHub.
    // The workspace writes repo copies to a linked repo, so the checks would ask GitHub.
    const [inst] = await q<{ id: string }>(sql`
      INSERT INTO github_installations (installation_id, account_type, account_login, account_id)
      VALUES (${Math.floor(Math.random() * 1e9)}, 'Organization', 'example', 1) RETURNING id`);
    const [repo] = await q<{ id: string }>(sql`
      INSERT INTO github_repos (installation_id, repo_id, full_name, name, owner)
      VALUES (${inst.id}::uuid, ${Math.floor(Math.random() * 1e9)}, 'example/fixture', 'fixture', 'example') RETURNING id`);
    await q(sql`UPDATE workspaces SET github_repo_id = ${repo.id}::uuid, github_installation_id = ${inst.id}::uuid,
      git_config = coalesce(git_config, '{}'::jsonb) || '{"livingSpecs":{"nativeSource":true}}'::jsonb WHERE id = ${wsId}::uuid`);
    try {
      const token = signSpecApprovalRequest({
        specId: busySpecId, workspaceId: wsId, revision: s.head_revision, expectedVersion: s.version,
        contentHash: s.content_hash, requestedBy: `user:${team.userId}`,
      } as never);
      expect(token).toBeTruthy();
      const { m, rendered, json } = await measure('specApprove', () => SpecApprovePage({
        params: Promise.resolve({ specId: busySpecId }), searchParams: Promise.resolve({ request: token! }),
      }));
      expect(rendered.outside).toEqual([]);
      expect(json).toContain('"state":"ready"');
      // The repo checks are fetched by the page after it shows.
      expect(json).toContain('"repoChecks":true');
      expect(Object.keys(m.byOperation).filter(isWrite)).toEqual([]);
    } finally {
      await q(sql`UPDATE workspaces SET git_config = git_config - 'livingSpecs', github_repo_id = NULL, github_installation_id = NULL WHERE id = ${wsId}::uuid`);
    }
  }, 300_000);
});
