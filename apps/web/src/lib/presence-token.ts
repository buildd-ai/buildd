import { createHmac, hkdfSync, timingSafeEqual } from 'crypto';
import { db } from '@buildd/core/db';
import { presenceTokens } from '@buildd/core/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

/**
 * A person's presence token: what the buildd agent plugin's hooks
 * authenticate with (docs/specs/local-agent-presence.md).
 *
 * An account API key belongs to one team. A person with several teams, or
 * whose folder's MCP signs in another way (another team's key, OAuth), claims
 * workers under accounts the hooks' key is not. This token is for the PERSON,
 * across every team they are in, and it can do almost nothing:
 *
 *  - report presence (POST /api/workers/local-sessions),
 *  - read the workspace repos the hooks scope against
 *    (GET /api/workers/local-sessions/workspaces),
 *  - bind and release that person's own interactive workers.
 *
 * `authenticateApiKey` refuses it outright, so every other route answers 401;
 * presence-token-routes.test.ts pins the routes that verify it.
 *
 * Format: `bldp_<base64url {t: tokenId, u: userId}>.<HMAC>`, signed with a key
 * HKDF-derived from the server secret under its own label. The token is never
 * stored; its `presence_tokens` row is what makes it revocable (one per
 * machine, listed and revoked in settings, revoked by `buildd logout`).
 *
 * Fails closed: with no signing secret nothing is minted and nothing verifies.
 */

export const PRESENCE_TOKEN_PREFIX = 'bldp_';
const KEY_LABEL = 'presence-token';
/** last_used_at is bumped at most this often per token. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

function signingKey(): Buffer | null {
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || process.env.ENCRYPTION_KEY || null;
  if (!secret) return null;
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), KEY_LABEL, 32));
}

function mac(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(`presence-token:${payload}`).digest('base64url');
}

export function isPresenceToken(token: string | null | undefined): boolean {
  return typeof token === 'string' && token.startsWith(PRESENCE_TOKEN_PREFIX);
}

/** Null when no signing secret is configured. */
export function mintPresenceToken(input: { tokenId: string; userId: string }): string | null {
  const key = signingKey();
  if (!key) return null;
  const payload = Buffer.from(JSON.stringify({ t: input.tokenId, u: input.userId })).toString('base64url');
  return `${PRESENCE_TOKEN_PREFIX}${payload}.${mac(key, payload)}`;
}

/** The ids of a genuinely signed presence token; null for anything else. Says nothing about revocation. */
export function verifyPresenceTokenSignature(token: string | null | undefined): { tokenId: string; userId: string } | null {
  if (!isPresenceToken(token)) return null;
  const key = signingKey();
  if (!key) return null;
  const body = token!.slice(PRESENCE_TOKEN_PREFIX.length);
  const dot = body.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = body.slice(0, dot);
  const given = Buffer.from(body.slice(dot + 1));
  const expected = Buffer.from(mac(key, payload));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let parsed: { t?: unknown; u?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed.t !== 'string' || typeof parsed.u !== 'string') return null;
  return { tokenId: parsed.t, userId: parsed.u };
}

export function normalizePresenceTokenLabel(label: unknown): string {
  const s = typeof label === 'string' ? label.trim() : '';
  return (s || 'cli').slice(0, 64);
}

export interface PresenceTokenStore {
  insert(userId: string, label: string, now: Date): Promise<{ id: string }>;
  revokeActiveForLabel(userId: string, label: string, now: Date): Promise<void>;
  find(tokenId: string): Promise<{ userId: string; revokedAt: Date | null; lastUsedAt: Date | null } | null>;
  touch(tokenId: string, now: Date): Promise<void>;
  /** Revoke one of this user's live tokens. True if it was live. */
  revoke(tokenId: string, userId: string, now: Date): Promise<boolean>;
}

export interface PresenceTokenDeps {
  store?: PresenceTokenStore;
  now?: Date;
  /** The teams the person is in now; defaults to their team memberships. */
  teamIds?: (userId: string) => Promise<string[]>;
}

export interface PresencePrincipal {
  kind: 'user';
  userId: string;
  tokenId: string;
  teamIds: string[];
}

/**
 * Issue a token for this person on this machine. One per machine: a live token
 * with the same label is revoked first. Null when nothing can be signed.
 */
export async function issuePresenceToken(userId: string, label: unknown, deps: PresenceTokenDeps = {}): Promise<string | null> {
  if (!signingKey()) return null;
  const store = deps.store ?? drizzlePresenceTokenStore;
  const now = deps.now ?? new Date();
  const name = normalizePresenceTokenLabel(label);
  await store.revokeActiveForLabel(userId, name, now);
  const { id } = await store.insert(userId, name, now);
  return mintPresenceToken({ tokenId: id, userId });
}

/** The person behind a live presence token who is still in at least one team; null otherwise. */
export async function authenticatePresenceToken(token: string | null | undefined, deps: PresenceTokenDeps = {}): Promise<PresencePrincipal | null> {
  const claims = verifyPresenceTokenSignature(token);
  if (!claims) return null;
  const store = deps.store ?? drizzlePresenceTokenStore;
  const now = deps.now ?? new Date();
  const row = await store.find(claims.tokenId);
  if (!row || row.revokedAt || row.userId !== claims.userId) return null;
  const teamIds = await (deps.teamIds ?? defaultTeamIds)(claims.userId);
  if (teamIds.length === 0) return null;
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= TOUCH_INTERVAL_MS) {
    try { await store.touch(claims.tokenId, now); } catch { /* telemetry only */ }
  }
  return { kind: 'user', userId: claims.userId, tokenId: claims.tokenId, teamIds };
}

/** Revoke the token presented (e.g. by `buildd logout`). True if it was live. */
export async function revokePresenceToken(token: string | null | undefined, deps: PresenceTokenDeps = {}): Promise<boolean> {
  const claims = verifyPresenceTokenSignature(token);
  if (!claims) return false;
  const store = deps.store ?? drizzlePresenceTokenStore;
  return store.revoke(claims.tokenId, claims.userId, deps.now ?? new Date());
}

async function defaultTeamIds(userId: string): Promise<string[]> {
  const { getUserTeamIds } = await import('@/lib/team-access');
  return getUserTeamIds(userId);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const drizzlePresenceTokenStore: PresenceTokenStore = {
  async insert(userId, label, now) {
    const [row] = await db.insert(presenceTokens).values({ userId, label, createdAt: now }).returning({ id: presenceTokens.id });
    return row;
  },
  async revokeActiveForLabel(userId, label, now) {
    await db.update(presenceTokens).set({ revokedAt: now })
      .where(and(eq(presenceTokens.userId, userId), eq(presenceTokens.label, label), isNull(presenceTokens.revokedAt)));
  },
  async find(tokenId) {
    // A signed token always names a uuid; anything else is not ours.
    if (!UUID_RE.test(tokenId)) return null;
    const row = await db.query.presenceTokens.findFirst({
      where: eq(presenceTokens.id, tokenId),
      columns: { userId: true, revokedAt: true, lastUsedAt: true },
    });
    return row ?? null;
  },
  async touch(tokenId, now) {
    await db.update(presenceTokens).set({ lastUsedAt: now }).where(eq(presenceTokens.id, tokenId));
  },
  async revoke(tokenId, userId, now) {
    if (!UUID_RE.test(tokenId)) return false;
    const rows = await db.update(presenceTokens).set({ revokedAt: now })
      .where(and(eq(presenceTokens.id, tokenId), eq(presenceTokens.userId, userId), isNull(presenceTokens.revokedAt)))
      .returning({ id: presenceTokens.id });
    return rows.length > 0;
  },
};

/** This person's tokens, newest first, for settings. Never includes a token value. */
export async function listPresenceTokens(userId: string) {
  return db.query.presenceTokens.findMany({
    where: eq(presenceTokens.userId, userId),
    columns: { id: true, label: true, createdAt: true, lastUsedAt: true, revokedAt: true },
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
}
