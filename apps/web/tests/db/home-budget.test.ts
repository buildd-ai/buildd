/**
 * Home's load against its budget (Living Spec "Fast at any size": R-1, R-9,
 * R-14, R-15, R-30, AC-1, AC-3) on a real database.
 *
 * AC-1: a team at ten times a large team's size, its mission summaries
 * stored (in production they are written as work changes), Home makes at
 * most 15 queries and reads at most 200 KB before it responds.
 *
 * AC-3: Home renders with every outside service failing on any call, and
 * makes none: GitHub approvals and the visual review come from cache or the
 * stored summary, and their refreshes are deferred with after().
 *
 * R-15: no write before the response, on either team.
 *
 * Measured: the page's own server load (HomePage), signed in as the team's
 * owner with no filters, in a request whose layout already ran. The layout's
 * shared reads (the user, the team scope, chat availability) are React
 * cache()d per request; `requestScopedReact` gives Bun that request scope and
 * the test makes them first, as the layout does. Not measured: the layout
 * itself (its own budget under R-17), the Agents panel that streams in behind
 * Suspense, and work deferred with after().
 */
import { describe, it, expect, mock, beforeAll } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q } from './harness';
import {
  PAGE_BUDGETS, expectWithinBudget, measureLoader, reportBudget, requestScopedReact,
  seedLargeTeam, seedMissionSummaries, seedScale, type SeededTeam,
} from './budget-harness';

assertDbConfigured();

let signedIn: string | null = null;
mock.module('../../src/auth', () => ({ auth: async () => (signedIn ? { user: { id: signedIn } } : null) }));
mock.module('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }),
  headers: async () => new Headers(),
}));
// after() needs a request scope: the deferred work is collected, never run.
const deferred: Array<() => unknown> = [];
const nextServer = await import('next/server');
mock.module('next/server', () => ({ ...nextServer, after: (fn: () => unknown) => { deferred.push(fn); } }));
const react = requestScopedReact(await import('react'));
mock.module('react', () => react.mod);
// The GitHub client fails on any call, and says GitHub is configured so no
// caller skips it for want of credentials. Pure helpers stay real.
const githubCalls: string[] = [];
const github = await import('../../src/lib/github');
const PURE_GITHUB = new Set(['githubAppBotLogin', 'getGitHubAppConfig', 'retryAfterFromHeaders', 'isOwnPrReviewRefusal', 'checkSuitesAllPassed', 'dropSupersededSuites', 'verifyWebhookSignature']);
mock.module('../../src/lib/github', () => Object.fromEntries(Object.entries(github).map(([name, value]) => {
  if (name === 'isGitHubAppConfigured') return [name, () => true];
  if (typeof value !== 'function' || PURE_GITHUB.has(name)) return [name, value];
  return [name, (..._args: unknown[]) => { githubCalls.push(name); throw new Error(`GitHub called while rendering Home: ${name}`); }];
})));

const { default: HomePage } = await import('../../src/app/app/(protected)/home/page');
const { getCurrentUser } = await import('../../src/lib/auth-helpers');
const { resolveActiveTeamScope } = await import('../../src/lib/team-access');
const { getChatAvailability } = await import('../../src/lib/chat-availability');

/** A new request whose layout already ran: its shared reads are cached. */
async function asLayoutDid(userId: string): Promise<void> {
  react.reset();
  signedIn = userId;
  await getCurrentUser();
  const scope = await resolveActiveTeamScope(userId, undefined);
  await getChatAvailability(userId, scope.teamId);
}

/** Render Home, failing on (and recording) any GitHub call and any fetch that is not the database's. */
async function renderHome(): Promise<{ outside: string[]; swallowed: string[]; tree: unknown }> {
  githubCalls.length = 0;
  const outside: string[] = [];
  const errors: unknown[][] = [];
  const realFetch = globalThis.fetch;
  const dbHost = new URL(process.env.NEON_LOCAL_FETCH_ENDPOINT!).host;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.host === dbHost) return realFetch(input, init);
    outside.push(url.host);
    throw new Error(`outside call while rendering Home: ${url.host}`);
  }) as typeof fetch;
  const realError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const tree = await HomePage({ searchParams: Promise.resolve({}) });
    const swallowed = errors.filter(e => String(e[0]).includes('Home page query error'))
      .map(e => `${String(e[1]).slice(0, 200)} cause: ${String((e[1] as { cause?: unknown })?.cause)}`);
    return { outside: [...outside, ...githubCalls.map(c => `github:${c}`)], swallowed, tree };
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
  }
}

/** The rendered element tree as text: props and strings, no functions. */
const treeText = (tree: unknown) => JSON.stringify(tree, (_k, v) => (typeof v === 'function' || typeof v === 'symbol' ? undefined : v));

const isWrite = (operation: string) => ['insert', 'update', 'delete', 'merge'].includes(operation);

let team: SeededTeam;
const scale = seedScale();

beforeAll(async () => {
  team = await seedLargeTeam(scale);
  await seedMissionSummaries(team);
}, 900_000);

describe('Home load budget', () => {
  it('fits R-1 at AC-1 scale: at most 15 queries and 200 KB, no write', async () => {
    await asLayoutDid(team.userId);
    deferred.length = 0;
    let rendered: Awaited<ReturnType<typeof renderHome>> | null = null;
    const m = await measureLoader('home', async () => { rendered = await renderHome(); });
    reportBudget(m, PAGE_BUDGETS.home, scale);
    // Home catches its own query errors and renders empty; a swallowed error
    // would make a short, cheap load look like a fast one.
    expect(rendered!.swallowed).toEqual([]);
    expect(rendered!.outside).toEqual([]);
    // The harness saw the load at all, and it reached the team's missions:
    // the Moving section names its open missions.
    expect(m.count).toBeGreaterThan(0);
    expect(treeText(rendered!.tree)).toMatch(/"openMissions":[1-9]/);
    expect(Object.keys(m.byOperation).filter(isWrite)).toEqual([]);
    expectWithinBudget(m, PAGE_BUDGETS.home);
  }, 300_000);
});

describe('Home calls no outside service before it responds (AC-3)', () => {
  let ownerId: string;

  beforeAll(async () => {
    // A team whose workspace is linked to a GitHub installation, with open
    // PRs (one needing a person's review, one a mission PR whose visual
    // review is owed) and a question: every path that used to ask GitHub
    // while Home rendered. Synthetic; describes no real team.
    const slug = `ac3-home-${Date.now().toString(36)}`;
    const [t] = await q<{ id: string }>(sql`INSERT INTO teams (name, slug) VALUES ('AC-3 fixture team', ${slug}) RETURNING id`);
    const [u] = await q<{ id: string }>(sql`INSERT INTO users (email, name) VALUES (${`${slug}@example.test`}, 'AC-3 Owner') RETURNING id`);
    ownerId = u.id;
    await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${t.id}::uuid, ${u.id}::uuid, 'owner')`);
    const [inst] = await q<{ id: string }>(sql`
      INSERT INTO github_installations (installation_id, account_type, account_login, account_id)
      VALUES (${Math.floor(Date.now() / 1000)}, 'Organization', 'example', 1) RETURNING id`);
    const [repo] = await q<{ id: string }>(sql`
      INSERT INTO github_repos (installation_id, repo_id, full_name, name, owner)
      VALUES (${inst.id}::uuid, ${Date.now()}, 'example/fixture', 'fixture', 'example') RETURNING id`);
    const [ws] = await q<{ id: string }>(sql`
      INSERT INTO workspaces (name, team_id, repo, github_repo_id, github_installation_id)
      VALUES ('ac3-ws', ${t.id}::uuid, 'example/fixture', ${repo.id}::uuid, ${inst.id}::uuid) RETURNING id`);
    const [mission] = await q<{ id: string }>(sql`
      INSERT INTO missions (team_id, workspace_id, title, status, integration_branch_enabled, working_branch, auto_surface_audit)
      VALUES (${t.id}::uuid, ${ws.id}::uuid, 'Branch mission', 'active', true, 'mission/ac3', true) RETURNING id`);
    const [work] = await q<{ id: string }>(sql`
      INSERT INTO tasks (workspace_id, mission_id, title, status, task_class, role_slug, path_manifest)
      VALUES (${ws.id}::uuid, ${mission.id}::uuid, 'feat: change the settings page', 'completed', 'work', 'builder', '["apps/web/src/app/app/(protected)/settings/page.tsx"]'::jsonb) RETURNING id`);
    const [ship] = await q<{ id: string }>(sql`
      INSERT INTO tasks (workspace_id, mission_id, title, status, task_class)
      VALUES (${ws.id}::uuid, ${mission.id}::uuid, 'Ship mission: Branch mission', 'completed', 'bookkeeping') RETURNING id`);
    const [review] = await q<{ id: string }>(sql`
      INSERT INTO tasks (workspace_id, title, status, task_class, role_slug, requires_review)
      VALUES (${ws.id}::uuid, 'fix: needs a person''s review', 'completed', 'work', 'builder', true) RETURNING id`);
    const [ask] = await q<{ id: string }>(sql`
      INSERT INTO tasks (workspace_id, title, status, task_class, role_slug)
      VALUES (${ws.id}::uuid, 'Ask the owner', 'in_progress', 'work', 'builder') RETURNING id`);
    await q(sql`
      INSERT INTO workers (task_id, workspace_id, name, runner, branch, status, pr_url, pr_number, merged_at, pr_lifecycle_status, pr_base_ref, last_commit_sha, pr_last_verified_at, started_at, completed_at)
      VALUES
        (${work.id}::uuid, ${ws.id}::uuid, 'w-work', 'runner', 'b-work', 'completed', 'https://github.com/example/fixture/pull/11', 11, now() - interval '1 hour', 'merged', 'mission/ac3', 'sha-work', now(), now() - interval '3 hours', now() - interval '2 hours'),
        (${ship.id}::uuid, ${ws.id}::uuid, 'w-ship', 'runner', 'mission/ac3', 'completed', 'https://github.com/example/fixture/pull/12', 12, null, 'ci_green', 'main', 'sha-ship', now(), now() - interval '2 hours', now() - interval '1 hour'),
        (${review.id}::uuid, ${ws.id}::uuid, 'w-review', 'runner', 'b-review', 'completed', 'https://github.com/example/fixture/pull/13', 13, null, 'ci_green', 'main', 'sha-review', now(), now() - interval '2 hours', now() - interval '1 hour')`);
    await q(sql`
      INSERT INTO workers (task_id, workspace_id, name, runner, branch, status, waiting_for, started_at)
      VALUES (${ask.id}::uuid, ${ws.id}::uuid, 'w-ask', 'runner', 'b-ask', 'waiting_input',
        '{"type":"question","prompt":"Which billing period?","disposition":"ask"}'::jsonb, now() - interval '1 hour')`);
    await q(sql`UPDATE missions SET primary_pr_number = 12 WHERE id = ${mission.id}::uuid`);
    await seedMissionSummaries({ teamId: t.id } as SeededTeam);
  }, 300_000);

  it('renders with every outside client failing, and makes no call and no write', async () => {
    await asLayoutDid(ownerId);
    deferred.length = 0;
    let rendered: Awaited<ReturnType<typeof renderHome>> | null = null;
    const m = await measureLoader('home.ac3', async () => { rendered = await renderHome(); });
    expect(rendered!.swallowed).toEqual([]);
    expect(rendered!.outside).toEqual([]);
    expect(Object.keys(m.byOperation).filter(isWrite)).toEqual([]);
    // The paths ran: the PRs and the question reached Needs you, and the
    // approval refresh GitHub would have answered waits for after().
    const json = treeText(rendered!.tree);
    expect(json).toContain('Which billing period?');
    expect(json).toContain('Ship mission: Branch mission');
    expect(json).toContain("fix: needs a person's review");
    expect(deferred.length).toBeGreaterThan(0);
  }, 300_000);
});
