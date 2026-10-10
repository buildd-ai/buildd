/**
 * Account-level consent at the authorize endpoint, against real Postgres
 * (docs/specs/auth-oauth-boundaries.md, "Account-level consent").
 *
 * The browser path end to end: GET the consent page for the account-level
 * resource, POST the person's choice back, exchange the code at the token
 * endpoint, and check the grant row that results. Covers the consent token
 * (CSRF), same origin, state, PKCE S256, a tampered workspace selection, a
 * tampered kind, the agent default, a downgrade, and pagination carrying a
 * selection across pages.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

let currentUser: string | null = null;
mock.module('../../src/auth', () => ({ auth: async () => (currentUser ? { user: { id: currentUser } } : null) }));

process.env.AUTH_SECRET ||= 'mcp-oauth-consent-test-secret-0123456789abcdef';
process.env.OAUTH_ISSUER = 'http://localhost';
const authorize = await import('../../src/app/api/oauth/authorize/route');
const tokenRoute = await import('../../src/app/api/oauth/token/route');
const storage = await import('../../src/lib/oauth/storage');
const tokens = await import('../../src/lib/oauth/tokens');
const grants = await import('../../src/lib/mcp-grants');

beforeAll(() => assertDbConfigured());

const ORIGIN = 'http://localhost';
const RESOURCE = `${ORIGIN}/api/mcp`;
const REDIRECT = 'https://client.example/cb';
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);

async function user(): Promise<string> {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  return u.id;
}
async function member(teamId: string, userId: string, role = 'member') {
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${userId}::uuid, ${role})`);
}
async function addWorkspaces(teamId: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const [w] = await q<{ id: string }>(sql`INSERT INTO workspaces (name, team_id) VALUES (${`w-${String(i).padStart(3, '0')}-${rand()}`}, ${teamId}::uuid) RETURNING id`);
    ids.push(w.id);
  }
  return ids;
}

/** Two teams the user is in (one workspace each), plus a team they are not in. */
async function setup() {
  const userId = await user();
  const a = await seedWorkspace();
  const b = await seedWorkspace();
  const outside = await seedWorkspace();
  await member(a.teamId, userId, 'owner');
  await member(b.teamId, userId, 'member');
  await q(sql`INSERT INTO accounts (type, name, api_key, team_id, auth_type) VALUES ('user', ${`k-${rand()}`}, ${`k-${rand()}`}, ${a.teamId}::uuid, 'oauth')`);
  const { clientId } = await storage.createClient({ clientName: 'Test client', redirectUris: [REDIRECT] });
  currentUser = userId;
  return { userId, a, b, outside, clientId };
}

beforeEach(() => { currentUser = null; });

function authorizeQuery(clientId: string, extra: Record<string, string> = {}) {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'st-123',
    scope: 'mcp',
    resource: RESOURCE,
    ...extra,
  };
}

function getPage(query: Record<string, string>) {
  return authorize.GET(new NextRequest(`${ORIGIN}/api/oauth/authorize?${new URLSearchParams(query)}`));
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

function post(fields: Array<[string, string]>, origin: string | null = ORIGIN) {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (origin) headers.origin = origin;
  return authorize.POST(new NextRequest(`${ORIGIN}/api/oauth/authorize`, { method: 'POST', headers, body: new URLSearchParams(fields).toString() }));
}

/** Replace every value of `name` (or drop it) in a form. */
function setField(fields: Array<[string, string]>, name: string, values: string[]): Array<[string, string]> {
  return [...fields.filter(([k]) => k !== name), ...values.map((v) => [name, v] as [string, string])];
}

function codeFrom(html: string): { code: string; state: string | null } {
  const href = unescape(html.match(/<a href="([^"]+)"/)![1]);
  const u = new URL(href);
  return { code: u.searchParams.get('code')!, state: u.searchParams.get('state') };
}

function exchange(clientId: string, code: string, verifier = VERIFIER) {
  return tokenRoute.POST(new NextRequest(`${ORIGIN}/api/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier }).toString(),
  }));
}

async function grantRows(userId: string) {
  return q<{ id: string; acts_as: string; scopes: string[] }>(sql`SELECT id, acts_as, scopes FROM mcp_oauth_grants WHERE user_id = ${userId}::uuid`);
}
async function grantWorkspaces(grantId: string) {
  return (await q<{ workspace_id: string }>(sql`SELECT workspace_id FROM mcp_oauth_grant_workspaces WHERE grant_id = ${grantId}::uuid`)).map((r) => r.workspace_id).sort();
}

describe('the consent page', () => {
  test('lists every team with its workspaces, preselects one, defaults to agent, issues nothing', async () => {
    const { userId, a, b, outside, clientId } = await setup();
    const res = await getPage(authorizeQuery(clientId));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-consent="account"');
    expect(html).toContain(a.workspaceId);
    expect(html).toContain(b.workspaceId);
    expect(html).not.toContain(outside.workspaceId);
    expect(html).not.toContain('code=');
    const checked = formOf(html).filter(([k]) => k === 'ws');
    expect(checked.length).toBe(1);
    expect(formOf(html)).toContainEqual(['acts_as', 'agent']);
    expect(html).toMatch(/value="person" disabled/);
    expect(await grantRows(userId)).toEqual([]);
  });

  test('without resource the per-workspace flow is unchanged', async () => {
    const { clientId } = await setup();
    const { resource: _r, ...legacy } = authorizeQuery(clientId);
    const html = await (await getPage(legacy)).text();
    expect(html).not.toContain('data-consent="account"');
  });

  test('PKCE is S256 only: plain or a missing challenge redirects with invalid_request', async () => {
    const { clientId } = await setup();
    const plain = await getPage(authorizeQuery(clientId, { code_challenge_method: 'plain' }));
    expect(plain.headers.get('location')).toContain('error=invalid_request');
    const { code_challenge: _c, ...noChallenge } = authorizeQuery(clientId);
    const none = await getPage(noChallenge);
    expect(none.headers.get('location')).toContain('error=invalid_request');
    expect(none.headers.get('location')).toContain('state=st-123');
  });
});

describe('approving', () => {
  test('creates an agent grant over the chosen workspaces; the code carries state and exchanges for a grant token', async () => {
    const { userId, a, b, clientId } = await setup();
    const page = formOf(await (await getPage(authorizeQuery(clientId))).text());
    const res = await post([...setField(page, 'ws', [a.workspaceId, b.workspaceId]), ['decision', 'approve']]);
    expect(res.status).toBe(200);
    const { code, state } = codeFrom(await res.text());
    expect(state).toBe('st-123');

    const rows = await grantRows(userId);
    expect(rows.length).toBe(1);
    expect(rows[0].acts_as).toBe('agent');
    expect(rows[0].scopes).toEqual(['read', 'write']);
    expect(await grantWorkspaces(rows[0].id)).toEqual([a.workspaceId, b.workspaceId].sort());

    const tok = await exchange(clientId, code);
    expect(tok.status).toBe(200);
    const body = await tok.json();
    const claims = await tokens.verifyAccessTokenAnyAudience(body.access_token);
    expect(claims && 'grant_id' in claims && claims.grant_id).toBe(rows[0].id);
    expect(body.scope).toBe('buildd:read buildd:write');
  });

  test('a wrong PKCE verifier is refused at the token endpoint', async () => {
    const { a, clientId } = await setup();
    const page = formOf(await (await getPage(authorizeQuery(clientId))).text());
    const { code } = codeFrom(await (await post([...setField(page, 'ws', [a.workspaceId]), ['decision', 'approve']])).text());
    const tok = await exchange(clientId, code, 'w'.repeat(64));
    expect(tok.status).toBe(400);
    expect((await tok.json()).error).toBe('invalid_grant');
  });

  test('a person request preselects person; approving as person records person', async () => {
    const { userId, a, clientId } = await setup();
    const page = formOf(await (await getPage(authorizeQuery(clientId, { scope: 'mcp buildd:act-as-person' }))).text());
    expect(page).toContainEqual(['acts_as', 'person']);
    await post([...setField(page, 'ws', [a.workspaceId]), ['decision', 'approve']]);
    const [row] = await grantRows(userId);
    expect(row.acts_as).toBe('person');
    const resolved = await grants.resolveGrant(row.id, userId, clientId);
    expect(grants.grantPrincipal(resolved!).sessionUserId).toBe(userId);
  });

  test('a person request downgraded to agent, and write unticked, is honoured', async () => {
    const { userId, a, clientId } = await setup();
    const page = formOf(await (await getPage(authorizeQuery(clientId, { scope: 'mcp buildd:act-as-person' }))).text());
    const fields = setField(setField(setField(page, 'acts_as', ['agent']), 'perm_write', []), 'ws', [a.workspaceId]);
    const res = await post([...fields, ['decision', 'approve']]);
    expect(res.status).toBe(200);
    const [row] = await grantRows(userId);
    expect(row.acts_as).toBe('agent');
    expect(row.scopes).toEqual(['read']);
  });

  test('a tampered kind (person not requested) is refused and writes nothing', async () => {
    const { userId, a, clientId } = await setup();
    const page = formOf(await (await getPage(authorizeQuery(clientId))).text());
    const res = await post([...setField(setField(page, 'acts_as', ['person']), 'ws', [a.workspaceId]), ['decision', 'approve']]);
    expect(res.status).toBe(400);
    expect(await grantRows(userId)).toEqual([]);
  });

  test('a tampered scope cannot widen what the client asked for', async () => {
    const { userId, a, clientId } = await setup();
    const page = formOf(await (await getPage(authorizeQuery(clientId, { scope: 'buildd:read' }))).text());
    // flipping scope invalidates the consent token
    const widened = await post([...setField(setField(page, 'scope', ['mcp buildd:act-as-person']), 'ws', [a.workspaceId]), ['acts_as', 'person'], ['decision', 'approve']]);
    expect(widened.status).toBe(403);
    // ticking write the client did not ask for is refused
    const write = await post([...setField(page, 'ws', [a.workspaceId]), ['perm_write', 'on'], ['decision', 'approve']]);
    expect(write.status).toBe(400);
    expect(await grantRows(userId)).toEqual([]);
  });

  test('a workspace the user cannot reach is refused, nothing is written, no id is named', async () => {
    const { userId, a, outside, clientId } = await setup();
    const page = formOf(await (await getPage(authorizeQuery(clientId))).text());
    const res = await post([...setField(page, 'ws', [a.workspaceId, outside.workspaceId]), ['decision', 'approve']]);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(outside.workspaceId);
    expect(await grantRows(userId)).toEqual([]);
  });

  test('membership lost between page and approval is refused', async () => {
    const { userId, b, clientId } = await setup();
    const page = formOf(await (await getPage(authorizeQuery(clientId))).text());
    await q(sql`DELETE FROM team_members WHERE team_id = ${b.teamId}::uuid AND user_id = ${userId}::uuid`);
    const res = await post([...setField(page, 'ws', [b.workspaceId]), ['decision', 'approve']]);
    expect(res.status).toBe(403);
    expect(await grantRows(userId)).toEqual([]);
  });

  test('an empty selection shows the page again with a message', async () => {
    const { userId, clientId } = await setup();
    const page = formOf(await (await getPage(authorizeQuery(clientId))).text());
    const res = await post([...setField(page, 'ws', []), ['decision', 'approve']]);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Choose at least one workspace.');
    expect(await grantRows(userId)).toEqual([]);
  });

  test('cancel returns access_denied with state and writes nothing', async () => {
    const { userId, clientId } = await setup();
    const page = formOf(await (await getPage(authorizeQuery(clientId))).text());
    const res = await post([...page, ['decision', 'deny']]);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('error=access_denied');
    expect(res.headers.get('location')).toContain('state=st-123');
    expect(await grantRows(userId)).toEqual([]);
  });
});

describe('CSRF', () => {
  test('a missing or forged consent token is refused', async () => {
    const { userId, a, clientId } = await setup();
    const page = formOf(await (await getPage(authorizeQuery(clientId))).text());
    expect((await post([...setField(setField(page, 'csrf_token', []), 'ws', [a.workspaceId]), ['decision', 'approve']])).status).toBe(403);
    expect((await post([...setField(setField(page, 'csrf_token', ['1.forged']), 'ws', [a.workspaceId]), ['decision', 'approve']])).status).toBe(403);
    expect(await grantRows(userId)).toEqual([]);
  });

  test('a foreign or missing Origin is refused', async () => {
    const { userId, a, clientId } = await setup();
    const page = formOf(await (await getPage(authorizeQuery(clientId))).text());
    const fields: Array<[string, string]> = [...setField(page, 'ws', [a.workspaceId]), ['decision', 'approve']];
    expect((await post(fields, 'https://evil.example')).status).toBe(403);
    expect((await post(fields, null)).status).toBe(403);
    expect(await grantRows(userId)).toEqual([]);
  });

  test("another user's consent token does not approve", async () => {
    const { a, clientId } = await setup();
    const page = formOf(await (await getPage(authorizeQuery(clientId))).text());
    const other = await user();
    await member(a.teamId, other);
    currentUser = other;
    expect((await post([...setField(page, 'ws', [a.workspaceId]), ['decision', 'approve']])).status).toBe(403);
    expect(await grantRows(other)).toEqual([]);
  });

  test('a tampered state or redirect is refused', async () => {
    const { a, clientId } = await setup();
    const page = formOf(await (await getPage(authorizeQuery(clientId))).text());
    expect((await post([...setField(setField(page, 'state', ['other']), 'ws', [a.workspaceId]), ['decision', 'approve']])).status).toBe(403);
  });
});

describe('pagination and selection across pages', () => {
  test('a large team pages, carries a selection to the next page, and select all takes every workspace', async () => {
    const { userId, a, b, clientId } = await setup();
    const extra = await addWorkspaces(a.teamId, 30); // team a now has 31
    let page = formOf(await (await getPage(authorizeQuery(clientId))).text());
    const firstChecked = page.filter(([k]) => k === 'ws').map(([, v]) => v);
    expect(firstChecked.length).toBe(1);

    // turn team a to page 2: the page-1 selection is carried as a hidden field
    const res = await post([...page, ['nav', `page:${a.teamId}:2`]]);
    expect(res.status).toBe(200);
    const html2 = await res.text();
    expect(html2).toContain('page 2 of 2');
    expect(html2).toContain(`<input type="hidden" name="ws" value="${firstChecked[0]}">`);
    page = formOf(html2);

    // tick one on page 2 as well and approve
    const onPage2 = [...html2.matchAll(/<input type="checkbox" name="ws" value="([^"]+)">/g)].map((m) => m[1]);
    expect(onPage2.length).toBeGreaterThan(0);
    const res2 = await post([...page, ['ws', onPage2[0]], ['decision', 'approve']]);
    expect(res2.status).toBe(200);
    const [row] = await grantRows(userId);
    expect(await grantWorkspaces(row.id)).toEqual([firstChecked[0], onPage2[0]].sort());

    // select all, from a fresh page, takes all 32 reachable workspaces
    const fresh = formOf(await (await getPage(authorizeQuery(clientId))).text());
    const all = formOf(await (await post([...fresh, ['nav', 'select_all']])).text());
    const chosen = all.filter(([k]) => k === 'ws').map(([, v]) => v).sort();
    expect(chosen).toEqual([a.workspaceId, b.workspaceId, ...extra].sort());
  });

  test('search narrows the list and a page action never approves', async () => {
    const { userId, a, clientId } = await setup();
    const extra = await addWorkspaces(a.teamId, 3);
    const page = formOf(await (await getPage(authorizeQuery(clientId))).text());
    const name = (await q<{ name: string }>(sql`SELECT name FROM workspaces WHERE id = ${extra[2]}::uuid`))[0].name;
    const html = await (await post([...setField(page, 'q', [name]), ['nav', 'search']])).text();
    expect(html).toContain(extra[2]);
    expect(html).toContain(`<input type="checkbox" name="ws" value="${extra[2]}"`);
    expect(html).not.toContain(`<input type="checkbox" name="ws" value="${extra[1]}"`);
    expect(await grantRows(userId)).toEqual([]);
  });
});
