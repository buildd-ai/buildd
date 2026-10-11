/**
 * Live E2E: one MCP connection across workspaces in several teams, driven over
 * HTTP against a running production build, the way an MCP client does it.
 *
 *   discovery (401 challenge -> protected-resource metadata -> AS metadata)
 *   -> dynamic client registration -> authorize with PKCE S256 -> consent POST
 *   -> code exchange -> /api/mcp tool calls -> refresh -> Settings edits
 *   (shrink, read-only) -> membership loss -> revoke -> reconnect
 *
 * plus the two kinds of connection ("agent working for you", the default, and
 * "acts as you", only when the client asks with `buildd:act-as-person`), the
 * strict workspace resolution errors, and the legacy per-workspace endpoint.
 *
 * The in-process real-Postgres suites (apps/web/tests/db/mcp-*.test.ts) pin the
 * same rules handler by handler. This file checks they hold through the real
 * server: Next routing, the Auth.js session cookie, the MCP transport, and the
 * self-calls the MCP route makes over HTTP to its own REST API.
 *
 * It seeds users, teams and workspaces straight into the server's database, so
 * it needs the database the server uses, and it refuses any non-loopback one.
 * Opt-in; it never runs in CI's integration job (which lists its files):
 *
 *   BUILDD_LIVE_MCP_E2E=1 \
 *   BUILDD_TEST_SERVER=http://localhost:<port> \
 *   DATABASE_URL=postgres://...@localhost:<pg-port>/<db> \
 *   AUTH_SECRET=<the server's AUTH_SECRET> \
 *   bun test apps/web/tests/integration/mcp-multi-workspace.test.ts
 *
 * The server must run with NEXTAUTH_URL (and OAUTH_ISSUER) set to its own
 * origin, or the MCP route's self-calls leave the machine. See
 * docs/mcp-connect-operators.md, "Running the live E2E".
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { encode } from 'next-auth/jwt';

const SERVER = (process.env.BUILDD_TEST_SERVER ?? '').replace(/\/$/, '');
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const AUTH_SECRET = process.env.AUTH_SECRET ?? '';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLoopback(url: string): boolean {
  try { return LOOPBACK.has(new URL(url).hostname); } catch { return false; }
}

const ENABLED = process.env.BUILDD_LIVE_MCP_E2E === '1';
if (ENABLED) {
  if (!SERVER || !isLoopback(SERVER)) throw new Error('BUILDD_TEST_SERVER must be a loopback URL for the live MCP E2E');
  if (!DATABASE_URL || !isLoopback(DATABASE_URL)) throw new Error('DATABASE_URL must be a loopback Postgres for the live MCP E2E');
  if (!AUTH_SECRET) throw new Error('AUTH_SECRET (the server\'s) is required to mint a dashboard session');
}

const T = 60_000;
const REDIRECT = 'http://127.0.0.1:1/callback';
const RESOURCE = `${SERVER}/api/mcp`;
const rand = () => randomBytes(5).toString('hex');

// ── Database seeding (loopback only) ─────────────────────────────────────────

let pool: pg.Pool;
async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(text, params)).rows as T[];
}
async function seedUser(): Promise<string> {
  const [u] = await q<{ id: string }>('INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id', [`e2e-${rand()}@example.test`, 'E2E Person']);
  return u.id;
}
async function seedTeam(): Promise<string> {
  const slug = `e2e-${rand()}`;
  const [t] = await q<{ id: string }>('INSERT INTO teams (name, slug) VALUES ($1, $1) RETURNING id', [slug]);
  return t.id;
}
/** Restricted (the schema default): a grant session must reach it anyway (#4285). */
async function seedWorkspace(teamId: string, name: string): Promise<string> {
  const [w] = await q<{ id: string }>('INSERT INTO workspaces (name, team_id) VALUES ($1, $2) RETURNING id', [name, teamId]);
  return w.id;
}
async function addMember(teamId: string, userId: string, role: string) {
  await q('INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [teamId, userId, role]);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

/** An Auth.js session cookie for `userId`, as the dashboard sign-in would set it. */
async function sessionCookie(userId: string): Promise<string> {
  const name = 'authjs.session-token';
  const value = await encode({ token: { sub: userId, userId }, secret: AUTH_SECRET, salt: name, maxAge: 3600 });
  return `${name}=${value}`;
}

const unescape = (v: string) => v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** The form as a browser would submit it: hidden fields, checked boxes and radios, text inputs. */
function formOf(html: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of html.matchAll(/<input ([^>]*)>/g)) {
    const attrs = m[1];
    const name = attrs.match(/name="([^"]+)"/)?.[1];
    const value = unescape(attrs.match(/value="([^"]*)"/)?.[1] ?? '');
    const type = attrs.match(/type="([^"]+)"/)?.[1];
    if (!name || /\bdisabled\b/.test(attrs)) continue;
    if ((type === 'checkbox' || type === 'radio') && !/\bchecked\b/.test(attrs)) continue;
    out.push([unescape(name), value]);
  }
  return out;
}
function setField(fields: Array<[string, string]>, name: string, values: string[]): Array<[string, string]> {
  return [...fields.filter(([k]) => k !== name), ...values.map((v) => [name, v] as [string, string])];
}

async function registerClient(name: string): Promise<string> {
  const res = await fetch(`${SERVER}/api/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
  });
  expect(res.status).toBe(201);
  const body = await res.json() as { client_id: string };
  expect(body.client_id).toBeTruthy();
  return body.client_id;
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function authorizeUrl(clientId: string, challenge: string, o: { scope?: string; resource?: string | null; workspace?: string; state?: string } = {}) {
  const p = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT,
    code_challenge: challenge, code_challenge_method: 'S256', state: o.state ?? `st-${rand()}`,
    scope: o.scope ?? 'buildd:read buildd:write',
  });
  if (o.resource !== null) p.set('resource', o.resource ?? RESOURCE);
  if (o.workspace) p.set('workspace', o.workspace);
  return `${SERVER}/api/oauth/authorize?${p}`;
}

async function getConsent(url: string, cookie: string | null) {
  return fetch(url, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
}

async function postConsent(fields: Array<[string, string]>, cookie: string) {
  return fetch(`${SERVER}/api/oauth/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: SERVER },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
}

function codeFrom(html: string): { code: string; state: string | null } {
  const href = unescape(html.match(/<a href="([^"]+)"/)![1]);
  const u = new URL(href);
  return { code: u.searchParams.get('code')!, state: u.searchParams.get('state') };
}

interface TokenSet { access_token: string; refresh_token: string; scope: string; token_type: string; expires_in: number }

async function tokenRequest(form: Record<string, string>) {
  const res = await fetch(`${SERVER}/api/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  return { status: res.status, body: await res.json() as TokenSet & { error?: string; error_description?: string } };
}

/** The whole browser leg: consent page -> chosen workspaces/kind -> code -> token pair. */
async function connect(o: {
  clientId: string; cookie: string; workspaceIds: string[]; scope?: string;
  actsAs?: 'agent' | 'person'; write?: boolean;
}): Promise<TokenSet> {
  const { verifier, challenge } = pkce();
  const state = `st-${rand()}`;
  const page = await getConsent(authorizeUrl(o.clientId, challenge, { scope: o.scope, state }), o.cookie);
  expect(page.status).toBe(200);
  let fields = formOf(await page.text());
  fields = setField(fields, 'ws', o.workspaceIds);
  if (o.actsAs) fields = setField(fields, 'acts_as', [o.actsAs]);
  if (o.write === false) fields = setField(fields, 'perm_write', []);
  const res = await postConsent([...fields, ['decision', 'approve']], o.cookie);
  expect(res.status).toBe(200);
  const { code, state: back } = codeFrom(await res.text());
  expect(back).toBe(state);
  const tok = await tokenRequest({ grant_type: 'authorization_code', code, client_id: o.clientId, redirect_uri: REDIRECT, code_verifier: verifier });
  expect(tok.status).toBe(200);
  return tok.body;
}

let rpcId = 0;
async function mcpRaw(token: string | null, body: Record<string, unknown>, path = '/api/mcp') {
  return fetch(`${SERVER}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, ...body }),
  });
}
async function tool(token: string, args: Record<string, unknown>, path = '/api/mcp') {
  const res = await mcpRaw(token, { method: 'tools/call', params: { name: 'buildd', arguments: args } }, path);
  const text = await res.text();
  let parsed: { result?: { content?: Array<{ text: string }>; isError?: boolean } } = {};
  try { parsed = JSON.parse(text); } catch { /* non-JSON, e.g. 401 body */ }
  return {
    status: res.status,
    headers: res.headers,
    text: parsed.result?.content?.[0]?.text ?? text,
    isError: parsed.result?.isError === true,
  };
}
function json<T = Record<string, unknown>>(text: string): T {
  return JSON.parse(text) as T;
}
interface Listing { total: number; teams: Array<{ teamId: string; workspaces: Array<{ id: string; name: string; level: string; access: string }> }> }
async function listedIds(token: string): Promise<string[]> {
  const r = await tool(token, { action: 'list_workspaces' });
  expect(r.isError).toBe(false);
  return json<Listing>(r.text).teams.flatMap((t) => t.workspaces.map((w) => w.id)).sort();
}

async function grantsApi(cookie: string, method: 'GET' | 'PATCH' | 'DELETE', id?: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api/mcp-grants${id ? `/${id}` : ''}`, {
    method,
    headers: { cookie, 'content-type': 'application/json', origin: SERVER },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
async function latestGrantId(userId: string, clientId: string): Promise<string> {
  const [g] = await q<{ id: string }>('SELECT id FROM mcp_oauth_grants WHERE user_id = $1 AND client_id = $2 ORDER BY created_at DESC LIMIT 1', [userId, clientId]);
  return g.id;
}

// ── World ────────────────────────────────────────────────────────────────────

/**
 * One person in two teams (owner of A, member of B), a granted workspace in
 * each, an ungranted sibling in A, and a team (C) they are not in.
 */
const W = {
  userId: '', cookie: '',
  teamA: '', teamB: '', teamC: '',
  a1: '', a2: '', b1: '', c1: '',
  a1Name: '', b1Name: '',
};

describe.skipIf(!ENABLED)('live: one MCP connection across teams', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    W.userId = await seedUser();
    W.teamA = await seedTeam();
    W.teamB = await seedTeam();
    W.teamC = await seedTeam();
    W.a1Name = `alpha-${rand()}`;
    W.b1Name = `bravo-${rand()}`;
    W.a1 = await seedWorkspace(W.teamA, W.a1Name);
    W.a2 = await seedWorkspace(W.teamA, `alpha-sibling-${rand()}`);
    W.b1 = await seedWorkspace(W.teamB, W.b1Name);
    W.c1 = await seedWorkspace(W.teamC, `charlie-${rand()}`);
    await addMember(W.teamA, W.userId, 'owner');
    await addMember(W.teamB, W.userId, 'member');
    W.cookie = await sessionCookie(W.userId);
  });
  afterAll(async () => { await pool?.end(); });

  describe('discovery', () => {
    test('an unauthenticated call is a 401 whose challenge names the protected-resource metadata', async () => {
      const res = await mcpRaw(null, { method: 'initialize', params: {} });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe(`Bearer realm="buildd", resource_metadata="${SERVER}/.well-known/oauth-protected-resource/api/mcp"`);
      const bad = await mcpRaw('not-a-token', { method: 'initialize', params: {} });
      expect(bad.status).toBe(401);
      expect(bad.headers.get('www-authenticate')).toContain('resource_metadata=');
    });

    test('the metadata names exactly <issuer>/api/mcp and does not advertise the person scope', async () => {
      const prm = await (await fetch(`${SERVER}/.well-known/oauth-protected-resource/api/mcp`)).json() as { resource: string; authorization_servers: string[]; scopes_supported: string[] };
      expect(prm.resource).toBe(RESOURCE);
      expect(prm.authorization_servers).toEqual([SERVER]);
      expect(prm.scopes_supported).not.toContain('buildd:act-as-person');
      const as = await (await fetch(`${SERVER}/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>;
      expect(as.issuer).toBe(SERVER);
      expect(as.registration_endpoint).toBe(`${SERVER}/api/oauth/register`);
      expect(as.code_challenge_methods_supported).toEqual(['S256']);
      expect(as.scopes_supported).not.toContain('buildd:act-as-person');
    });

    test('authorize without a dashboard session sends the person to sign in first', async () => {
      const clientId = await registerClient('e2e signed-out');
      const res = await getConsent(authorizeUrl(clientId, pkce().challenge), null);
      expect([302, 303, 307]).toContain(res.status);
      expect(res.headers.get('location')).toContain('/api/auth/signin');
    });
  });

  describe('an agent connection (the default)', () => {
    let clientId = '';
    let tok: TokenSet;
    let grantId = '';

    beforeAll(async () => {
      clientId = await registerClient('e2e agent client');
    });

    test('the consent page lists only the person\'s teams, defaults to agent, and offers no person option', async () => {
      const page = await getConsent(authorizeUrl(clientId, pkce().challenge), W.cookie);
      expect(page.status).toBe(200);
      const html = await page.text();
      for (const id of [W.a1, W.a2, W.b1]) expect(html).toContain(id);
      expect(html).not.toContain(W.c1);
      expect(formOf(html)).toContainEqual(['acts_as', 'agent']);
      expect(html).toMatch(/value="person" disabled/);
    }, T);

    test('connect once, granting a workspace in each of two teams', async () => {
      tok = await connect({ clientId, cookie: W.cookie, workspaceIds: [W.a1, W.b1] });
      expect(tok.token_type.toLowerCase()).toBe('bearer');
      expect(tok.scope).toBe('buildd:read buildd:write');
      grantId = await latestGrantId(W.userId, clientId);
      const [g] = await q<{ acts_as: string }>('SELECT acts_as FROM mcp_oauth_grants WHERE id = $1', [grantId]);
      expect(g.acts_as).toBe('agent');
    }, T);

    test('initialize says how to pick a workspace and that this is an agent', async () => {
      const res = await mcpRaw(tok.access_token, { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } });
      expect(res.status).toBe(200);
      const body = await res.json() as { result: { instructions: string } };
      expect(body.result.instructions).toContain('across 2 teams');
      expect(body.result.instructions).toContain('as your agent');
      expect(body.result.instructions).toContain('list_workspaces');
    }, T);

    test('list_workspaces lists the granted workspaces in both teams and nothing else', async () => {
      const r = await tool(tok.access_token, { action: 'list_workspaces' });
      const out = json<Listing>(r.text);
      expect(out.total).toBe(2);
      const byTeam = Object.fromEntries(out.teams.map((t) => [t.teamId, t.workspaces.map((w) => ({ id: w.id, level: w.level, access: w.access }))]));
      expect(byTeam[W.teamA]).toEqual([{ id: W.a1, level: 'admin', access: 'read-write' }]);
      expect(byTeam[W.teamB]).toEqual([{ id: W.b1, level: 'worker', access: 'read-write' }]);
      for (const id of [W.a2, W.c1, W.teamC]) expect(r.text).not.toContain(id);
    }, T);

    test('writes and reads in each granted workspace, by id and by name', async () => {
      const ta = await tool(tok.access_token, { action: 'create_task', params: { workspaceId: W.a1, title: `e2e task in A ${rand()}`, description: 'live e2e', kind: 'engineering' } });
      expect(ta.isError).toBe(false);
      const tb = await tool(tok.access_token, { action: 'create_task', params: { workspaceId: W.b1Name, title: `e2e task in B ${rand()}`, description: 'live e2e', kind: 'engineering' } });
      expect(tb.isError).toBe(false);
      const rows = await q<{ workspace_id: string; n: number }>(
        "SELECT workspace_id, count(*)::int AS n FROM tasks WHERE workspace_id = ANY($1::uuid[]) AND description = 'live e2e' GROUP BY workspace_id", [[W.a1, W.b1]]);
      expect(Object.fromEntries(rows.map((r) => [r.workspace_id, r.n]))).toEqual({ [W.a1]: 1, [W.b1]: 1 });

      const listA = await tool(tok.access_token, { action: 'list_tasks', params: { workspaceId: W.a1 } });
      expect(listA.isError).toBe(false);
      expect(listA.text).toContain('e2e task in A');
      expect(listA.text).not.toContain('e2e task in B');
      const listB = await tool(tok.access_token, { action: 'list_tasks', params: { workspaceId: W.b1 } });
      expect(listB.text).toContain('e2e task in B');
      expect(listB.text).not.toContain('e2e task in A');

      // A's task read while naming B reaches nothing.
      const [taskA] = await q<{ id: string }>("SELECT id FROM tasks WHERE workspace_id = $1 AND description = 'live e2e'", [W.a1]);
      const cross = await tool(tok.access_token, { action: 'get_task', params: { taskId: taskA.id, workspaceId: W.b1 } });
      expect(cross.isError).toBe(true);
      const own = await tool(tok.access_token, { action: 'get_task', params: { taskId: taskA.id, workspaceId: W.a1 } });
      expect(own.isError).toBe(false);
    }, T);

    test('an ungranted workspace (same team or another team) is refused without echoing it', async () => {
      for (const ref of [W.a2, W.c1, crypto.randomUUID()]) {
        const r = await tool(tok.access_token, { action: 'list_tasks', params: { workspaceId: ref } });
        expect(r.isError).toBe(true);
        expect(json<{ error: string }>(r.text).error).toBe('workspace_not_granted');
        expect(r.text).not.toContain(ref);
      }
      // The same through the connection URL.
      const res = await mcpRaw(tok.access_token, { method: 'tools/list' }, `/api/mcp?workspace=${W.c1}`);
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain(W.c1);
      // And straight at REST with the token and a binding to an ungranted workspace.
      const rest = await fetch(`${SERVER}/api/tasks?workspaceId=${W.a2}`, { headers: { authorization: `Bearer ${tok.access_token}`, 'x-buildd-workspace': W.a2 } });
      expect(rest.status).toBe(401);
    }, T);

    test('a mutation with no workspace, or an ambiguous one, is refused with the granted choices only', async () => {
      const none = await tool(tok.access_token, { action: 'create_task', params: { title: 'no ws', description: 'd', kind: 'engineering' } });
      expect(none.isError).toBe(true);
      const noneBody = json<{ error: string; message: string; choices: Array<{ workspaceId: string }> }>(none.text);
      expect(noneBody.error).toBe('workspace_required');
      expect(noneBody.choices.map((c) => c.workspaceId).sort()).toEqual([W.a1, W.b1].sort());

      const dup = `dup-${rand()}`;
      await q('UPDATE workspaces SET name = $1 WHERE id = ANY($2::uuid[])', [dup, [W.a1, W.b1, W.a2, W.c1]]);
      try {
        const amb = await tool(tok.access_token, { action: 'create_task', params: { workspaceId: dup, title: 'amb', description: 'd', kind: 'engineering' } });
        expect(amb.isError).toBe(true);
        const body = json<{ error: string; message: string; choices: Array<{ workspaceId: string; name: string; teamId?: string }> }>(amb.text);
        expect(body.error).toBe('workspace_ambiguous');
        expect(typeof body.message).toBe('string');
        expect(body.choices.map((c) => c.workspaceId).sort()).toEqual([W.a1, W.b1].sort());
        for (const id of [W.a2, W.c1]) expect(amb.text).not.toContain(id);
        const [{ n }] = await q<{ n: number }>("SELECT count(*)::int AS n FROM tasks WHERE title IN ('no ws', 'amb')");
        expect(n).toBe(0);
      } finally {
        await q('UPDATE workspaces SET name = $1 WHERE id = $2', [W.a1Name, W.a1]);
        await q('UPDATE workspaces SET name = $1 WHERE id = $2', [W.b1Name, W.b1]);
      }
    }, T);

    test('person-only actions are refused: a landing-override grant, and Abandon', async () => {
      const r = await tool(tok.access_token, {
        action: 'create_task',
        params: { workspaceId: W.a1, title: 'override as agent', description: 'd', kind: 'engineering', context: { landingOverride: { prNumbers: [1], overrides: ['freshness'] } } },
      });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('landingOverride is a person');

      const { missionId, taskId } = await closedPrInMission(W.teamA, W.a1);
      const res = await abandon(tok.access_token, W.a1, missionId, taskId);
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).toContain('Only a person');
      const [w] = await q<{ abandoned_at: string | null }>('SELECT abandoned_at FROM workers WHERE task_id = $1', [taskId]);
      expect(w.abandoned_at).toBeNull();
    }, T);

    test('refresh rotates; replaying the spent refresh token revokes the whole family', async () => {
      const r1 = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: clientId });
      expect(r1.status).toBe(200);
      expect(r1.body.refresh_token).not.toBe(tok.refresh_token);
      expect(await listedIds(r1.body.access_token)).toEqual([W.a1, W.b1].sort());

      // Another client cannot spend it.
      const other = await registerClient('e2e other client');
      const wrong = await tokenRequest({ grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: other });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error).toBe('invalid_grant');

      const replay = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: clientId });
      expect(replay.status).toBe(400);
      expect(replay.body.error).toBe('invalid_grant');
      const afterReplay = await tokenRequest({ grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: clientId });
      expect(afterReplay.status).toBe(400);
      // The access token already issued keeps working until it expires; the grant is not revoked.
      expect(await listedIds(r1.body.access_token)).toEqual([W.a1, W.b1].sort());
      tok = r1.body;
    }, T);

    test('Settings › Connected apps lists the connection with its kind and workspaces', async () => {
      const r = await grantsApi(W.cookie, 'GET');
      expect(r.status).toBe(200);
      const conns = r.body.connections as Array<{ id: string; actsAs: string; access: string; workspaces: Array<{ id?: string; workspaceId?: string }> }>;
      const mine = conns.find((c) => c.id === grantId);
      expect(mine).toBeTruthy();
      expect(mine!.actsAs).toBe('agent');
      expect(mine!.access).toBe('read-write');
      expect(JSON.stringify(mine!.workspaces)).toContain(W.a1);
      expect(JSON.stringify(mine!.workspaces)).toContain(W.b1);
    }, T);

    test('read-only applies on the next request on the same access token, and write comes back', async () => {
      expect((await grantsApi(W.cookie, 'PATCH', grantId, { access: 'read' })).status).toBe(200);
      const read = await tool(tok.access_token, { action: 'list_tasks', params: { workspaceId: W.a1 } });
      expect(read.isError).toBe(false);
      const write = await tool(tok.access_token, { action: 'create_task', params: { workspaceId: W.a1, title: 'read-only write', description: 'd', kind: 'engineering' } });
      expect(write.isError).toBe(true);
      const [{ n }] = await q<{ n: number }>("SELECT count(*)::int AS n FROM tasks WHERE title = 'read-only write'");
      expect(n).toBe(0);
      expect((await grantsApi(W.cookie, 'PATCH', grantId, { access: 'read-write' })).status).toBe(200);
      const again = await tool(tok.access_token, { action: 'create_task', params: { workspaceId: W.a1, title: `write again ${rand()}`, description: 'd', kind: 'engineering' } });
      expect(again.isError).toBe(false);
    }, T);

    test('shrink applies on the next request; expand brings it back', async () => {
      expect((await grantsApi(W.cookie, 'PATCH', grantId, { removeWorkspaceIds: [W.b1] })).status).toBe(200);
      expect(await listedIds(tok.access_token)).toEqual([W.a1]);
      const r = await tool(tok.access_token, { action: 'list_tasks', params: { workspaceId: W.b1 } });
      expect(json<{ error: string }>(r.text).error).toBe('workspace_not_granted');
      // With one workspace left, a call needs no workspaceId.
      const implicit = await tool(tok.access_token, { action: 'list_tasks', params: {} });
      expect(implicit.isError).toBe(false);

      // A workspace in a team the person is not in cannot be added.
      const foreign = await grantsApi(W.cookie, 'PATCH', grantId, { addWorkspaceIds: [W.c1] });
      expect(foreign.status).toBe(403);
      expect(JSON.stringify(foreign.body)).not.toContain(W.c1);

      expect((await grantsApi(W.cookie, 'PATCH', grantId, { addWorkspaceIds: [W.b1] })).status).toBe(200);
      expect(await listedIds(tok.access_token)).toEqual([W.a1, W.b1].sort());
    }, T);

    // Task f371c26c: a team joined after connecting has no session account
    // (seedTeam makes none). Its workspace, added in Settings, must work on the
    // next request on the same access token, not 401 until a refresh.
    test('a workspace in a team joined after connecting works on the next request, without a refresh', async () => {
      const teamD = await seedTeam();
      const d1 = await seedWorkspace(teamD, `delta-${rand()}`);
      await addMember(teamD, W.userId, 'member');
      const sessionAccounts = async (teamId: string) => (await q<{ n: number }>("SELECT count(*)::int AS n FROM accounts WHERE team_id = $1 AND type = 'user'", [teamId]))[0].n;
      expect(await sessionAccounts(teamD)).toBe(0);

      expect((await grantsApi(W.cookie, 'PATCH', grantId, { addWorkspaceIds: [d1] })).status).toBe(200);
      expect(await listedIds(tok.access_token)).toContain(d1);
      const r = await tool(tok.access_token, { action: 'list_tasks', params: { workspaceId: d1 } });
      expect(r.status).toBe(200);
      expect(r.isError).toBe(false);
      expect(await sessionAccounts(teamD)).toBe(1);

      // The same when the grant reaches such a team by any other path: the MCP
      // route provisions the session account instead of answering 401.
      const teamE = await seedTeam();
      const e1 = await seedWorkspace(teamE, `echo-${rand()}`);
      await addMember(teamE, W.userId, 'member');
      await q('INSERT INTO mcp_oauth_grant_workspaces (grant_id, workspace_id) VALUES ($1, $2)', [grantId, e1]);
      const viaRoute = await tool(tok.access_token, { action: 'list_tasks', params: { workspaceId: e1 } });
      expect(viaRoute.status).toBe(200);
      expect(viaRoute.isError).toBe(false);
      expect(await sessionAccounts(teamE)).toBe(1);

      expect((await grantsApi(W.cookie, 'PATCH', grantId, { removeWorkspaceIds: [d1, e1] })).status).toBe(200);
      expect(await listedIds(tok.access_token)).toEqual([W.a1, W.b1].sort());
    }, T);

    test('a bearer token cannot manage connections, so a connection cannot widen itself', async () => {
      const res = await fetch(`${SERVER}/api/mcp-grants/${grantId}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ addWorkspaceIds: [W.a2] }),
      });
      expect(res.status).toBe(401);
    }, T);

    test('revoke stops the access token at once and the refresh token with it', async () => {
      expect((await grantsApi(W.cookie, 'DELETE', grantId)).status).toBe(200);
      const res = await mcpRaw(tok.access_token, { method: 'tools/list' });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
      const refresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: clientId });
      expect(refresh.status).toBe(400);
      expect(refresh.body.error).toBe('invalid_grant');
      expect(JSON.stringify(refresh.body)).not.toContain(grantId);
    }, T);

    test('reconnect: the same client signs in again and gets a fresh connection', async () => {
      const again = await connect({ clientId, cookie: W.cookie, workspaceIds: [W.b1] });
      expect(await listedIds(again.access_token)).toEqual([W.b1]);
      expect(await latestGrantId(W.userId, clientId)).not.toBe(grantId);
    }, T);
  });

  describe('a person connection ("acts as you")', () => {
    let clientId = '';
    let tok: TokenSet;

    beforeAll(async () => {
      clientId = await registerClient('e2e person client');
    });

    test('only offered when the client asks with buildd:act-as-person, and then preselected', async () => {
      const page = await getConsent(authorizeUrl(clientId, pkce().challenge, { scope: 'buildd:read buildd:write buildd:act-as-person' }), W.cookie);
      const html = await page.text();
      expect(formOf(html)).toContainEqual(['acts_as', 'person']);
      expect(html).not.toMatch(/value="person" disabled/);
    }, T);

    test('a forged person choice without the scope is refused and writes nothing', async () => {
      const { challenge } = pkce();
      const page = await getConsent(authorizeUrl(clientId, challenge), W.cookie);
      const fields = setField(setField(formOf(await page.text()), 'acts_as', ['person']), 'ws', [W.a1]);
      const before = await q<{ n: number }>('SELECT count(*)::int AS n FROM mcp_oauth_grants WHERE client_id = $1', [clientId]);
      const res = await postConsent([...fields, ['decision', 'approve']], W.cookie);
      expect(res.status).toBe(400);
      const after = await q<{ n: number }>('SELECT count(*)::int AS n FROM mcp_oauth_grants WHERE client_id = $1', [clientId]);
      expect(after[0].n).toBe(before[0].n);
    }, T);

    test('consent from another origin is refused', async () => {
      const page = await getConsent(authorizeUrl(clientId, pkce().challenge), W.cookie);
      const fields = setField(formOf(await page.text()), 'ws', [W.a1]);
      const res = await fetch(`${SERVER}/api/oauth/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: W.cookie, origin: 'https://evil.example' },
        body: new URLSearchParams([...fields, ['decision', 'approve']]).toString(),
        redirect: 'manual',
      });
      expect(res.status).toBe(403);
    }, T);

    test('approved as person: the session is the person, so person-only actions are allowed', async () => {
      tok = await connect({ clientId, cookie: W.cookie, workspaceIds: [W.a1, W.b1], scope: 'buildd:read buildd:write buildd:act-as-person' });
      const [g] = await q<{ acts_as: string }>('SELECT acts_as FROM mcp_oauth_grants WHERE id = $1', [await latestGrantId(W.userId, clientId)]);
      expect(g.acts_as).toBe('person');

      const init = await mcpRaw(tok.access_token, { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } });
      expect(((await init.json()) as { result: { instructions: string } }).result.instructions).toContain(', as you.');

      const title = `override as person ${rand()}`;
      const r = await tool(tok.access_token, {
        action: 'create_task',
        params: { workspaceId: W.a1, title, description: 'd', kind: 'engineering', context: { landingOverride: { prNumbers: [1], overrides: ['freshness'] } } },
      });
      expect(r.isError).toBe(false);
      const [row] = await q<{ context: { landingOverride?: { grantedBy?: string } } }>('SELECT context FROM tasks WHERE title = $1', [title]);
      expect(row.context.landingOverride?.grantedBy).toBe(`human:${W.userId}`);

      const { missionId, taskId } = await closedPrInMission(W.teamA, W.a1);
      const res = await abandon(tok.access_token, W.a1, missionId, taskId);
      expect(res.status).toBe(200);
      const [w] = await q<{ abandoned_at: string | null }>('SELECT abandoned_at FROM workers WHERE task_id = $1', [taskId]);
      expect(w.abandoned_at).not.toBeNull();
    }, T);

    test('downgrading to agent in Settings applies on the next request; going back needs a fresh consent', async () => {
      const id = await latestGrantId(W.userId, clientId);
      const up = await grantsApi(W.cookie, 'PATCH', id, { actsAs: 'person' });
      expect(up.status).toBe(403);
      expect((await grantsApi(W.cookie, 'PATCH', id, { actsAs: 'agent' })).status).toBe(200);
      const r = await tool(tok.access_token, {
        action: 'create_task',
        params: { workspaceId: W.a1, title: 'override after downgrade', description: 'd', kind: 'engineering', context: { landingOverride: { prNumbers: [1], overrides: ['freshness'] } } },
      });
      expect(r.isError).toBe(true);
      // The next token response no longer claims the person scope.
      const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: clientId });
      expect(refreshed.status).toBe(200);
      expect(refreshed.body.scope).not.toContain('buildd:act-as-person');
      tok = refreshed.body;
    }, T);

    test('losing team membership removes that team\'s workspaces on the next call; rejoining restores them', async () => {
      await q('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [W.teamB, W.userId]);
      try {
        expect(await listedIds(tok.access_token)).toEqual([W.a1]);
        const r = await tool(tok.access_token, { action: 'list_tasks', params: { workspaceId: W.b1 } });
        expect(json<{ error: string }>(r.text).error).toBe('workspace_not_granted');
        // A refresh still works: the grant reaches A.
        const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: clientId });
        expect(refreshed.status).toBe(200);
        tok = refreshed.body;
      } finally {
        await addMember(W.teamB, W.userId, 'member');
      }
      expect(await listedIds(tok.access_token)).toEqual([W.a1, W.b1].sort());
    }, T);

    test('losing every granted team makes the token and its refresh fail', async () => {
      await q('DELETE FROM team_members WHERE user_id = $1 AND team_id = ANY($2::uuid[])', [W.userId, [W.teamA, W.teamB]]);
      try {
        const res = await mcpRaw(tok.access_token, { method: 'tools/list' });
        expect(res.status).toBe(401);
        const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: clientId });
        expect(refreshed.status).toBe(400);
        expect(refreshed.body.error).toBe('invalid_grant');
      } finally {
        await addMember(W.teamA, W.userId, 'owner');
        await addMember(W.teamB, W.userId, 'member');
      }
    }, T);
  });

  describe('legacy per-workspace connection (backward compatible, deprecated)', () => {
    let clientId = '';
    let tok: TokenSet;

    test('authorize without the resource keeps the one-workspace flow and its token', async () => {
      clientId = await registerClient('e2e legacy client');
      const { verifier, challenge } = pkce();
      const page = await getConsent(authorizeUrl(clientId, challenge, { resource: null, workspace: W.a1, scope: 'mcp' }), W.cookie);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).not.toContain('data-consent="account"');
      const res = await postConsent([...formOf(html), ['decision', 'approve']], W.cookie);
      expect(res.status).toBe(200);
      const { code } = codeFrom(await res.text());
      const t = await tokenRequest({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier });
      expect(t.status).toBe(200);
      tok = t.body;
    }, T);

    test('works on its own endpoint, with Deprecation and successor Link headers', async () => {
      const r = await tool(tok.access_token, { action: 'list_tasks', params: {} }, `/api/mcp-oauth/${W.a1}`);
      expect(r.status).toBe(200);
      expect(r.isError).toBe(false);
      expect(r.headers.get('deprecation')).toBe('true');
      expect(r.headers.get('link')).toBe(`<${SERVER}/api/mcp>; rel="successor-version"`);
    }, T);

    test('is refused on another workspace\'s endpoint, and a grant token is refused on any of them', async () => {
      const other = await tool(tok.access_token, { action: 'list_tasks', params: {} }, `/api/mcp-oauth/${W.b1}`);
      expect(other.status).toBe(401);
      const grantTok = await connect({ clientId: await registerClient('e2e grant on legacy'), cookie: W.cookie, workspaceIds: [W.a1] });
      const g = await tool(grantTok.access_token, { action: 'list_tasks', params: {} }, `/api/mcp-oauth/${W.a1}`);
      expect(g.status).toBe(401);
    }, T);

    test('refresh keeps the legacy binding', async () => {
      const r = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: clientId });
      expect(r.status).toBe(200);
      const call = await tool(r.body.access_token, { action: 'list_tasks', params: {} }, `/api/mcp-oauth/${W.a1}`);
      expect(call.isError).toBe(false);
    }, T);

    test('Settings lists it as a legacy connection', async () => {
      const r = await grantsApi(W.cookie, 'GET');
      const legacy = r.body.legacy as Array<{ clientName: string; workspaceName: string }>;
      expect(legacy).toContainEqual(expect.objectContaining({ clientName: 'e2e legacy client', workspaceName: W.a1Name }));
    }, T);
  });
});

// ── Person-only fixture: a closed, unmerged PR in a mission ─────────────────

async function closedPrInMission(teamId: string, workspaceId: string): Promise<{ missionId: string; taskId: string }> {
  const [m] = await q<{ id: string }>('INSERT INTO missions (team_id, workspace_id, title) VALUES ($1, $2, $3) RETURNING id', [teamId, workspaceId, `e2e mission ${rand()}`]);
  const [t] = await q<{ id: string }>("INSERT INTO tasks (workspace_id, title, status, mission_id) VALUES ($1, $2, 'completed', $3) RETURNING id", [workspaceId, `e2e pr task ${rand()}`, m.id]);
  const n = 1000 + Math.floor(Math.random() * 100000);
  await q(
    "INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, pr_url, pr_number, pr_lifecycle_status) VALUES ($1, $2, 'e2e', 'e2e', $3, 'completed', $4, $5, 'closed')",
    [workspaceId, t.id, `e2e/${rand()}`, `https://github.com/example-org/example-repo/pull/${n}`, n],
  );
  return { missionId: m.id, taskId: t.id };
}

/** Exactly what the MCP route's self-call sends: the grant token plus the workspace binding. */
async function abandon(token: string, workspaceId: string, missionId: string, taskId: string) {
  const res = await fetch(`${SERVER}/api/missions/${missionId}/closed-prs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-buildd-workspace': workspaceId },
    body: JSON.stringify({ taskId, action: 'abandon', reason: 'plan changed' }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
