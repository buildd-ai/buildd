/**
 * Regression replay: one chain of work, filed and run through every entry
 * surface, keeps who filed each piece apart from who it is for and who
 * approved it (spec 7702c32a AC-1..AC-4).
 *
 * The chain: a person files a task over REST; a team runner claims it; the
 * agent on it files a follow-up with its per-task token, then a mission and a
 * task in it over MCP; review and repair land under that task; the person
 * files into the mission and approves an agent's plan from chat; a question
 * is answered and the task is claimed again as a continuation; finally the
 * one-time backfill runs over the chain as if it were history.
 *
 * Real Postgres (the requester trigger is only observable on real rows), real
 * keys and per-task tokens, the real route handlers and the real MCP / chat
 * action handlers. Only the dashboard session is stubbed. The review and
 * repair rows are inserted directly, in the shape the webhook writers use:
 * no writer names a person, which is what the trigger exists for.
 */
import { beforeAll, describe, expect, mock, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { assertDbConfigured, confinedRunnerEnvironment, q, seedWorkspace } from './harness';

let sessionUserId: string | null = null;
const realAuthHelpers = await import('../../src/lib/auth-helpers');
mock.module('../../src/lib/auth-helpers', () => ({
  ...realAuthHelpers,
  getCurrentUser: async () => (sessionUserId ? { id: sessionUserId, email: 'person@example.test' } : null),
}));

process.env.AUTH_SECRET ||= 'work-lineage-replay-test-secret-0123456789';

const { db } = await import('@buildd/core/db');
const { missions, tasks } = await import('@buildd/core/db/schema');
const { handleBuilddAction } = await import('@buildd/core/mcp-tools');
const { requesterOf } = await import('@buildd/core/task-requester');
const { createInProcessApi, matchChatRoute } = await import('../../src/lib/chat/in-process-api');
const { mintTaskToken } = await import('../../src/lib/task-token');
const tasksRoute = await import('../../src/app/api/tasks/route');
const missionsRoute = await import('../../src/app/api/missions/route');
const claimRoute = await import('../../src/app/api/workers/claim/route');
const respondRoute = await import('../../src/app/api/workers/[id]/respond/route');
const approvePlanRoute = await import('../../src/app/api/tasks/[id]/approve-plan/route');

setDefaultTimeout(30_000);

const DRIZZLE = join(import.meta.dir, '../../../../packages/core/drizzle');
const trigger = readdirSync(DRIZZLE).find((d) => d.endsWith('_task_requester_trigger'))!;
const BACKFILL = readFileSync(join(DRIZZLE, trigger, 'migration.sql'), 'utf8').split('--> statement-breakpoint').at(-1)!;

const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);

// ── world ──
let teamId: string;
let workspaceId: string;
let person: string;     // the member the work is for
let outsider: string;   // not a member of the team
type Key = { id: string; key: string; hash: string };
let runner: Key;        // a team runner (shared, not the person's), organizer-capable
let otherRunner: Key;   // a second team runner
let adminKey: Key;      // an admin API key: never a person

async function key(level: 'worker' | 'admin'): Promise<Key> {
  const k = `bld_${rand()}${rand()}`;
  const hash = createHash('sha256').update(k).digest('hex');
  const [a] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id, auth_type, level, max_concurrent_workers)
    VALUES ('service', ${`svc-${rand()}`}, ${hash}, ${teamId}::uuid, 'api', ${level}, 10) RETURNING id`);
  await q(sql`INSERT INTO account_workspaces (account_id, workspace_id, can_claim, can_create) VALUES (${a.id}::uuid, ${workspaceId}::uuid, true, true)`);
  return { id: a.id, key: k, hash };
}

const json = (body: unknown) => (body === undefined ? undefined : JSON.stringify(body));
function request(path: string, o: { method?: string; bearer?: string; body?: unknown } = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method: o.method ?? 'POST',
    headers: { 'content-type': 'application/json', ...(o.bearer ? { authorization: `Bearer ${o.bearer}` } : {}) },
    body: json(o.body),
  });
}

/** An MCP transport: handleBuilddAction's REST calls, made with the caller's bearer. */
function mcpApi(bearer: string) {
  return async (endpoint: string, options: RequestInit = {}) => {
    const method = (options.method ?? 'GET').toUpperCase();
    const url = new URL(endpoint, 'http://localhost');
    const match = matchChatRoute(method, url.pathname);
    if (!match) throw new Error(`no route for ${method} ${url.pathname}`);
    const handler = (await match.entry.load())[method] as (r: NextRequest, c: unknown) => Promise<Response>;
    const res = await handler(new NextRequest(url, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      ...(options.body && method !== 'GET' ? { body: options.body as BodyInit } : {}),
    }), { params: Promise.resolve(match.params) });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`API error: ${res.status} - ${JSON.stringify(body)}`);
    return body;
  };
}

function actionCtx(o: { workerId?: string; surface?: 'chat'; principal?: 'person' | 'key' | 'task_token'; level?: 'worker' | 'admin' }) {
  const { level = 'worker', ...rest } = o;
  return {
    ...rest, workspaceId, teamId, authType: 'api' as const,
    getWorkspaceId: async () => workspaceId,
    getLevel: async () => level,
  };
}

/** Chat as the signed-in person: the in-process API the chat route builds. */
const chatApi = () => createInProcessApi({ origin: 'http://localhost', headers: new Headers({ cookie: 'session=person' }) });

const textOf = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join('\n');
const idIn = (text: string) => text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];

const identity = async (id: string) =>
  (await db.select({
    parent: tasks.parentTaskId, mission: tasks.missionId,
    user: tasks.createdByUserId, source: tasks.requesterSource,
    account: tasks.createdByAccountId, worker: tasks.createdByWorkerId,
  }).from(tasks).where(eq(tasks.id, id)))[0];

const missionIdentity = async (id: string) =>
  (await db.select({
    user: missions.createdByUserId, source: missions.requesterSource,
    account: missions.createdByAccountId, worker: missions.createdByWorkerId, task: missions.createdByTaskId,
  }).from(missions).where(eq(missions.id, id)))[0];

async function claim(k: Key, taskId: string): Promise<string> {
  const res = await claimRoute.POST(request('/api/workers/claim', {
    bearer: k.key,
    body: { runner: `r-${rand()}`, maxTasks: 1, workspaceId, taskId, environment: confinedRunnerEnvironment() },
  }));
  const body = (await res.json()) as { workers?: Array<{ id: string; taskId: string }> };
  const w = body.workers?.find((x) => x.taskId === taskId);
  if (!w) throw new Error(`claim took nothing (${res.status}): ${JSON.stringify(body)}`);
  return w.id;
}

// ── the chain, filled in step by step ──
let origin: string;      // REST, the person
let originWorker: string;
let followUp: string;    // per-task token
let mission: string;     // MCP manage_missions
let missionTask: string; // MCP create_task
let review: string;
let repair: string;
let chatTask: string;    // chat create_task
let plan: string;        // an agent's planning task

beforeAll(async () => {
  assertDbConfigured();
  ({ teamId, workspaceId } = await seedWorkspace());
  const [p] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`p-${rand()}@example.test`}) RETURNING id`);
  const [o] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`o-${rand()}@example.test`}) RETURNING id`);
  person = p.id;
  outsider = o.id;
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${person}::uuid, 'owner')`);
  runner = await key('admin');
  otherRunner = await key('worker');
  adminKey = await key('admin');
});

describe('REST API', () => {
  test('a person filing a task or a mission names themselves; an API key names no one', async () => {
    sessionUserId = person;
    const res = await tasksRoute.POST(request('/api/tasks', { body: { workspaceId, title: 'Origin: tidy the parser' } }));
    expect(res.status).toBe(200);
    origin = ((await res.json()) as { id: string }).id;
    const filed = await identity(origin);
    expect(filed).toMatchObject({ user: person, source: 'explicit', worker: null });
    // Filed under the person's own account, never a team runner's or a key's.
    expect([runner.id, otherRunner.id, adminKey.id]).not.toContain(filed.account);

    // A mission the person files themselves is theirs, filed by no agent or runner.
    const m = await missionsRoute.POST(request('/api/missions', { body: { workspaceId, title: 'Person-filed mission' } }));
    expect(m.status).toBeLessThan(300);
    const own = await missionIdentity(((await m.json()) as { id: string }).id);
    expect(own).toMatchObject({ user: person, source: 'explicit', worker: null, task: null });
    expect([runner.id, otherRunner.id, adminKey.id]).not.toContain(own.account);

    sessionUserId = null;
    const keyed = await tasksRoute.POST(request('/api/tasks', { bearer: adminKey.key, body: { workspaceId, title: 'Keyed: no person' } }));
    expect(keyed.status).toBe(200);
    const keyedId = ((await keyed.json()) as { id: string }).id;
    expect(await identity(keyedId)).toMatchObject({ user: null, source: 'none', account: adminKey.id });
  });
});

describe('runner claim (AC-2)', () => {
  test('a team runner claiming changes neither who filed it nor who it is charged to', async () => {
    const before = await identity(origin);
    originWorker = await claim(runner, origin);
    expect(await identity(origin)).toEqual(before);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, origin));
    expect(row.claimedBy).toBe(runner.id);
    // The person a run is charged to (personal credentials, personal roles).
    expect(await requesterOf(row)).toBe(person);
  });
});

describe('agent-filed with a per-task token', () => {
  test('the follow-up records the agent as filer and the person as derived', async () => {
    const token = mintTaskToken({ accountId: runner.id, taskId: origin, workspaceId, keyHash: runner.hash })!.token;
    const res = await tasksRoute.POST(request('/api/tasks', {
      bearer: token, body: { workspaceId, title: 'Follow-up: cover the edge case', createdByWorkerId: originWorker },
    }));
    expect(res.status).toBe(200);
    followUp = ((await res.json()) as { id: string }).id;
    expect(await identity(followUp)).toMatchObject({
      parent: origin, user: person, source: 'parent', account: runner.id, worker: originWorker,
    });
  });
});

describe('MCP (AC-1)', () => {
  test('a mission the agent files traces to its task, its filer and the person it is for', async () => {
    const r = await handleBuilddAction(mcpApi(runner.key), 'manage_missions',
      { action: 'create', title: 'Parser hardening', description: 'Agent-filed', workspaceId },
      actionCtx({ workerId: originWorker, principal: 'key', level: 'admin' }) as never);
    mission = idIn(textOf(r as never))!;
    expect(mission).toBeTruthy();
    expect(await missionIdentity(mission)).toEqual({
      user: person, source: 'parent', account: runner.id, worker: originWorker, task: origin,
    });
  });

  test('a task the agent files in it, and the review and repair under that, all trace back', async () => {
    const r = await handleBuilddAction(mcpApi(runner.key), 'create_task',
      { title: 'Harden the tokenizer', description: 'x', workspaceId, missionId: mission },
      actionCtx({ workerId: originWorker, principal: 'key', level: 'admin' }) as never);
    missionTask = idIn(textOf(r as never))!;
    expect(await identity(missionTask)).toMatchObject({
      parent: origin, mission, user: person, account: runner.id, worker: originWorker,
    });

    // As the PR webhook and the repair loop write them: no person named.
    const [rv] = await db.insert(tasks).values({
      workspaceId, title: 'Review: harden the tokenizer', parentTaskId: missionTask, missionId: mission, category: 'review', creationSource: 'webhook',
    }).returning();
    const [rp] = await db.insert(tasks).values({
      workspaceId, title: 'Repair after review', parentTaskId: rv.id, missionId: mission, taskClass: 'attempt', creationSource: 'webhook',
    }).returning();
    review = rv.id;
    repair = rp.id;
    expect(await identity(review)).toMatchObject({ parent: missionTask, mission, user: person, source: 'parent', account: null, worker: null });
    expect(await identity(repair)).toMatchObject({ parent: review, mission, user: person, source: 'parent', account: null, worker: null });

    // Walk repair -> review -> task -> origin: the parent chain reaches the
    // person's own request, and the mission names the same origin.
    const chain: string[] = [];
    for (let id: string | null = repair; id; id = (await identity(id)).parent) chain.push(id);
    expect(chain).toEqual([repair, review, missionTask, origin]);
    expect((await missionIdentity(mission)).task).toBe(origin);
    // None of the agent's or the webhook's work is the person's own action.
    for (const id of [followUp, missionTask, review, repair]) expect((await identity(id)).source).not.toBe('explicit');
  });
});

describe('chat (AC-3)', () => {
  test('the person filing from chat is their own request, with no agent as filer', async () => {
    sessionUserId = person;
    const r = await handleBuilddAction(chatApi(), 'create_task',
      { title: 'Document the tokenizer limits', description: 'From chat', workspaceId, missionId: mission },
      actionCtx({ surface: 'chat', principal: 'person', level: 'admin' }) as never);
    chatTask = idIn(textOf(r as never))!;
    const filed = await identity(chatTask);
    expect(filed).toMatchObject({ mission, user: person, source: 'explicit', worker: null });
    expect([runner.id, otherRunner.id, adminKey.id]).not.toContain(filed.account);
  });

  test("an agent's plan needs the person: the agent and a runner key are refused, the person's approval is recorded apart", async () => {
    sessionUserId = null;
    // The agent files the planning task over MCP, in the mission.
    const filed = await handleBuilddAction(mcpApi(runner.key), 'create_task',
      { title: 'Plan the tokenizer work', description: 'Plan it', workspaceId, missionId: mission },
      actionCtx({ workerId: originWorker, principal: 'key', level: 'admin' }) as never);
    plan = idIn(textOf(filed as never))!;
    const planCreator = await identity(plan);
    expect(planCreator).toMatchObject({ user: person, worker: originWorker, account: runner.id });
    expect(planCreator.source).not.toBe('explicit');
    // The planning run finished with a plan marked for a person's review.
    await q(sql`UPDATE tasks SET status = 'completed', mode = 'planning',
      result = ${JSON.stringify({ structuredOutput: { plan: [{ title: 'Split the lexer', description: 'x' }] } })}::jsonb,
      context = coalesce(context, '{}'::jsonb) || '{"requiresPlanApproval": true}'::jsonb
      WHERE id = ${plan}::uuid`);
    const approve = (bearer?: string) =>
      approvePlanRoute.POST(request(`/api/tasks/${plan}/approve-plan`, { bearer }), { params: Promise.resolve({ id: plan }) });

    // An orchestration run in the same mission, whose admin-level token may
    // decide a sibling's plan, cannot decide one marked for a person.
    const orchestration = mintTaskToken({ accountId: runner.id, taskId: missionTask, workspaceId, keyHash: runner.hash, level: 'admin' })!.token;
    expect((await approve(orchestration)).status).toBe(403);
    // Nor can the team runner's own key, or an admin key.
    expect((await approve(runner.key)).status).toBe(403);
    expect((await approve(adminKey.key)).status).toBe(403);
    expect(await q(sql`SELECT id FROM tasks WHERE parent_task_id = ${plan}::uuid`)).toHaveLength(0);

    // The person approves from chat.
    sessionUserId = person;
    const r = await handleBuilddAction(chatApi(), 'approve_plan', { taskId: plan },
      actionCtx({ surface: 'chat', principal: 'person', level: 'admin' }) as never);
    expect(textOf(r as never)).not.toMatch(/error/i);
    const children = await db.select().from(tasks).where(eq(tasks.parentTaskId, plan));
    expect(children).toHaveLength(1);
    const child = children[0];
    // Approved by the person; filed by no one in their name; for the person, derived.
    expect((child.context as Record<string, unknown>).planApprovedBy).toBe(`human:${person}`);
    expect(child).toMatchObject({ createdByUserId: person, requesterSource: 'parent', createdByWorkerId: null });
    // The plan itself still records the agent as its filer.
    expect(await identity(plan)).toEqual(planCreator);
  });
});

describe('runner continuation (AC-2)', () => {
  test('an answered question reopens the task; another team runner resumes it and nothing about who changes', async () => {
    sessionUserId = null;
    const before = await identity(missionTask);
    const worker = await claim(otherRunner, missionTask);
    await q(sql`UPDATE workers SET status = 'error', turns = 3,
      waiting_for = ${JSON.stringify({ type: 'question', prompt: 'Keep the legacy grammar?', options: ['Yes', 'No'] })}::jsonb
      WHERE id = ${worker}::uuid`);

    sessionUserId = person;
    const answered = await respondRoute.POST(
      request(`/api/workers/${worker}/respond`, { body: { message: 'No, drop it' } }),
      { params: Promise.resolve({ id: worker }) });
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({ taskId: missionTask, newAttempt: true });

    sessionUserId = null;
    await claim(runner, missionTask);
    expect(await identity(missionTask)).toEqual(before);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, missionTask));
    expect(row.claimedBy).toBe(runner.id);
    expect(await requesterOf(row)).toBe(person);
    expect((await missionIdentity(mission)).user).toBe(person);
  });
});

describe('backfill (AC-4)', () => {
  test('replayed over the chain as history: it finds the person again, leaves unknown unknown, and a second run changes nothing', async () => {
    // Two rows with no person on their chain: one with nothing above it, one
    // whose mission names someone who is not on the team.
    const [orphan] = await db.insert(tasks).values({ workspaceId, title: 'No one asked' }).returning();
    const [foreignMission] = await db.insert(missions).values({ teamId, workspaceId, title: `m-${rand()}`, createdByUserId: outsider }).returning();
    const [stray] = await db.insert(tasks).values({ workspaceId, title: 'Outsider mission task', missionId: foreignMission.id }).returning();
    // A mission written before missions recorded how its person was decided.
    const [oldMission] = await db.insert(missions).values({ teamId, workspaceId, title: `m-${rand()}` }).returning();

    const history = [followUp, missionTask, review, repair, orphan.id, stray.id];
    for (const id of history) await q(sql`UPDATE tasks SET created_by_user_id = NULL, requester_source = NULL WHERE id = ${id}::uuid`);
    const filers = async () => Promise.all(history.map(async (id) => {
      const { account, worker, parent, mission } = await identity(id);
      return { account, worker, parent, mission };
    }));
    const filersBefore = await filers();

    await db.execute(sql.raw(BACKFILL));
    const once = await Promise.all(history.map(identity));
    for (const id of [followUp, missionTask, review, repair]) {
      expect(await identity(id)).toMatchObject({ user: person, source: expect.stringMatching(/^backfill_(parent|mission)$/) });
    }
    expect(await identity(orphan.id)).toMatchObject({ user: null, source: 'backfill_none' });
    expect(await identity(stray.id)).toMatchObject({ user: null, source: 'backfill_not_member' });
    // Never the person's own action, and the filers are untouched.
    for (const r of once) expect(r.source).not.toBe('explicit');
    expect(await filers()).toEqual(filersBefore);

    await db.execute(sql.raw(BACKFILL));
    expect(await Promise.all(history.map(identity))).toEqual(once);
    // Rows that were never history keep what was recorded live.
    expect(await identity(origin)).toMatchObject({ user: person, source: 'explicit' });
    expect(await identity(chatTask)).toMatchObject({ user: person, source: 'explicit' });
    // A mission from before the column stays unknown: nothing back-fills it.
    expect(await missionIdentity(oldMission.id)).toEqual({ user: null, source: null, account: null, worker: null, task: null });
  });
});
