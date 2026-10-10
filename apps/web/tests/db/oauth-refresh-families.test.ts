/**
 * Refresh tokens against real Postgres (docs/specs/auth-oauth-boundaries.md,
 * "Refresh tokens: hashed, one family per sign-in"):
 *
 *   - stored as a SHA-256 hash, looked up by it;
 *   - a token that existed before the hashing migration still refreshes once
 *     the migration's backfill has run, and re-running the backfill changes
 *     nothing;
 *   - every rotation stays in the sign-in's family; presenting an
 *     already-rotated token revokes the whole family and nothing else;
 *   - a family past its absolute lifetime gets no new pair;
 *   - a request naming another client spends nothing.
 *
 * The family revocation and the client binding are SQL predicates, which a
 * mocked `db` cannot see, so they are checked here on real rows.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

process.env.AUTH_SECRET ||= 'oauth-refresh-families-test-secret-0123456789';
const storage = await import('../../src/lib/oauth/storage');
const config = await import('../../src/lib/oauth/config');
const tokenRoute = await import('../../src/app/api/oauth/token/route');

beforeAll(() => assertDbConfigured());

const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);
const DAY_MS = 24 * 60 * 60 * 1000;

/** A user who is a member of one workspace's team, and a registered client. */
async function setup() {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  const ws = await seedWorkspace();
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${ws.teamId}::uuid, ${u.id}::uuid, 'owner')`);
  const key = `k-${rand()}`;
  await q(sql`INSERT INTO accounts (type, name, api_key, team_id, auth_type) VALUES ('user', ${key}, ${key}, ${ws.teamId}::uuid, 'oauth')`);
  const { clientId } = await storage.createClient({ clientName: 'test', redirectUris: ['https://client.example/cb'] });
  return { userId: u.id, workspaceId: ws.workspaceId, clientId };
}

function refresh(token: string, clientId: string) {
  return tokenRoute.POST(new NextRequest('http://localhost/api/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: clientId }).toString(),
  }));
}

async function refreshOk(token: string, clientId: string): Promise<string> {
  const res = await refresh(token, clientId);
  expect(res.status).toBe(200);
  return ((await res.json()) as { refresh_token: string }).refresh_token;
}

type Row = { token: string; family_id: string; family_issued_at: string; created_at: string; expires_at: string; revoked_at: string | null };
async function rowFor(token: string): Promise<Row | undefined> {
  const [r] = await q<Row>(sql`SELECT * FROM oauth_refresh_tokens WHERE token = ${storage.hashRefreshToken(token)}`);
  return r;
}

/** The data statements of the migration that introduced refresh-token families. */
function backfillStatements(): string[] {
  const dir = join(import.meta.dir, '../../../../packages/core/drizzle');
  const file = readdirSync(dir).find((f) => f.endsWith('.sql')
    && readFileSync(join(dir, f), 'utf8').includes('"oauth_refresh_tokens_family_idx"'));
  if (!file) throw new Error('refresh-token family migration not found');
  return readFileSync(join(dir, file), 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim())
    .filter((s) => /^UPDATE\b/i.test(s));
}

describe('stored as a hash', () => {
  test('the token itself is never in the table; its SHA-256 is', async () => {
    const { userId, workspaceId, clientId } = await setup();
    const token = await storage.createRefreshToken({ clientId, userId, workspaceId, scope: 'mcp' });
    const raw = await q(sql`SELECT 1 FROM oauth_refresh_tokens WHERE token = ${token}`);
    expect(raw.length).toBe(0);
    const [r] = await q<{ ok: boolean }>(sql`
      SELECT token = encode(sha256(convert_to(${token}, 'UTF8')), 'hex') AS ok
      FROM oauth_refresh_tokens WHERE token = ${storage.hashRefreshToken(token)}`);
    expect(r?.ok).toBe(true);
  });
});

describe('a token issued before hashing', () => {
  test('still refreshes after the backfill, and a second backfill run changes nothing', async () => {
    const { userId, workspaceId, clientId } = await setup();
    const raw = `pre${rand()}${rand()}${rand()}${rand()}`.slice(0, 43);
    const issued = new Date(Date.now() - 5 * DAY_MS);
    // The pre-migration shape: the token in clear, and family columns as the
    // ADD COLUMN defaults left them (own family, stamped at migration time).
    await q(sql`
      INSERT INTO oauth_refresh_tokens (token, client_id, user_id, workspace_id, scope, expires_at, created_at)
      VALUES (${raw}, ${clientId}, ${userId}::uuid, ${workspaceId}::uuid, 'mcp',
              ${new Date(Date.now() + 30 * DAY_MS).toISOString()}::timestamptz, ${issued.toISOString()}::timestamptz)`);

    const statements = backfillStatements();
    expect(statements.length).toBe(2);
    for (const s of statements) await q(sql.raw(s));
    const once = await rowFor(raw);
    expect(once).toBeDefined();
    expect(new Date(once!.family_issued_at).getTime()).toBe(new Date(once!.created_at).getTime());

    for (const s of statements) await q(sql.raw(s));
    const twice = await rowFor(raw);
    expect(twice).toEqual(once);

    const next = await refreshOk(raw, clientId);
    const rotated = await rowFor(next);
    expect(rotated?.family_id).toBe(once!.family_id);
    expect(new Date(rotated!.family_issued_at).getTime()).toBe(issued.getTime());
  });

  test('the backfill leaves tokens issued since untouched', async () => {
    const { userId, workspaceId, clientId } = await setup();
    const first = await storage.createRefreshToken({ clientId, userId, workspaceId, scope: 'mcp' });
    const second = await refreshOk(first, clientId);
    const before = await rowFor(second);
    for (const s of backfillStatements()) await q(sql.raw(s));
    expect(await rowFor(second)).toEqual(before);
  });
});

describe('one family per sign-in', () => {
  test('rotation keeps the family and its sign-in time', async () => {
    const { userId, workspaceId, clientId } = await setup();
    const a = await storage.createRefreshToken({ clientId, userId, workspaceId, scope: 'mcp' });
    const b = await refreshOk(a, clientId);
    const c = await refreshOk(b, clientId);
    const [ra, rc] = [await rowFor(a), await rowFor(c)];
    expect(rc?.family_id).toBe(ra!.family_id);
    expect(rc?.family_issued_at).toBe(ra!.family_issued_at);
    expect(ra?.revoked_at).not.toBeNull();
  });

  test('presenting an already-rotated token revokes every live token of its family, and only that family', async () => {
    const { userId, workspaceId, clientId } = await setup();
    const a = await storage.createRefreshToken({ clientId, userId, workspaceId, scope: 'mcp' });
    const other = await storage.createRefreshToken({ clientId, userId, workspaceId, scope: 'mcp' });
    const b = await refreshOk(a, clientId);

    const res = await refresh(a, clientId);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');

    expect((await rowFor(b))?.revoked_at).not.toBeNull();
    expect((await refresh(b, clientId)).status).toBe(400);
    // A separate sign-in by the same user is its own family and keeps working.
    expect((await rowFor(other))?.revoked_at).toBeNull();
    await refreshOk(other, clientId);
  });
});

describe('absolute lifetime', () => {
  test('a family older than the cap gets no new pair, even with an unexpired token', async () => {
    const { userId, workspaceId, clientId } = await setup();
    const t = await storage.createRefreshToken({ clientId, userId, workspaceId, scope: 'mcp' });
    const old = new Date(Date.now() - config.REFRESH_TOKEN_ABSOLUTE_LIFETIME_SECONDS * 1000 - DAY_MS);
    await q(sql`
      UPDATE oauth_refresh_tokens
      SET family_issued_at = ${old.toISOString()}::timestamptz, created_at = ${old.toISOString()}::timestamptz,
          expires_at = now() + interval '1 day'
      WHERE token = ${storage.hashRefreshToken(t)}`);
    const res = await refresh(t, clientId);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
  });

  test('a rotated token never expires after the family cap', async () => {
    const { userId, workspaceId, clientId } = await setup();
    const t = await storage.createRefreshToken({ clientId, userId, workspaceId, scope: 'mcp' });
    const issued = new Date(Date.now() - 80 * DAY_MS);
    await q(sql`UPDATE oauth_refresh_tokens SET family_issued_at = ${issued.toISOString()}::timestamptz WHERE token = ${storage.hashRefreshToken(t)}`);
    const next = await refreshOk(t, clientId);
    const r = await rowFor(next);
    expect(new Date(r!.expires_at).getTime())
      .toBe(issued.getTime() + config.REFRESH_TOKEN_ABSOLUTE_LIFETIME_SECONDS * 1000);
  });
});

describe('client binding', () => {
  test('a request naming another client spends nothing; the holder can still refresh', async () => {
    const { userId, workspaceId, clientId } = await setup();
    const { clientId: otherClient } = await storage.createClient({ clientName: 'other', redirectUris: ['https://other.example/cb'] });
    const t = await storage.createRefreshToken({ clientId, userId, workspaceId, scope: 'mcp' });

    const res = await refresh(t, otherClient);
    expect(res.status).toBe(400);
    expect((await rowFor(t))?.revoked_at).toBeNull();
    await refreshOk(t, clientId);
  });

  test('another client presenting a rotated token does not revoke the family', async () => {
    const { userId, workspaceId, clientId } = await setup();
    const { clientId: otherClient } = await storage.createClient({ clientName: 'other', redirectUris: ['https://other.example/cb'] });
    const a = await storage.createRefreshToken({ clientId, userId, workspaceId, scope: 'mcp' });
    const b = await refreshOk(a, clientId);
    expect((await refresh(a, otherClient)).status).toBe(400);
    expect((await rowFor(b))?.revoked_at).toBeNull();
    await refreshOk(b, clientId);
  });
});

describe('concurrent refreshes', () => {
  test('of one token, exactly one mints a pair', async () => {
    const { userId, workspaceId, clientId } = await setup();
    const t = await storage.createRefreshToken({ clientId, userId, workspaceId, scope: 'mcp' });
    const results = await Promise.all([refresh(t, clientId), refresh(t, clientId), refresh(t, clientId)]);
    expect(results.filter((r) => r.status === 200).length).toBe(1);
  });
});
