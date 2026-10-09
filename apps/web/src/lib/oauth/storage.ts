import { randomBytes, randomUUID, createHash } from 'crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { oauthClients, oauthCodes, oauthRefreshTokens, teamMembers, workspaces } from '@buildd/core/db/schema';
import {
  AUTH_CODE_BYTES,
  AUTH_CODE_TTL_SECONDS,
  REFRESH_TOKEN_ABSOLUTE_LIFETIME_SECONDS,
  REFRESH_TOKEN_BYTES,
  REFRESH_TOKEN_TTL_SECONDS,
} from './config';

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Schemes that are dangerous in any redirect context and that no legitimate
 * OAuth client registers. Checked against the URL parser's normalised,
 * lowercased protocol, so `JavaScript:` and `java\tscript:` are covered too.
 */
const DANGEROUS_REDIRECT_SCHEMES = new Set([
  'javascript:',
  'data:',
  'vbscript:',
  'file:',
  'blob:',
]);

/**
 * Minimum bar for a redirect_uri, applied both at registration (RFC 7591 open
 * registration is unauthenticated) and at authorize time — the latter so a
 * client row that predates this validation can't be used either.
 *
 * Deliberately NOT a strict https-plus-loopback allowlist: native/desktop
 * clients legitimately register private-use schemes, and non-loopback `http:`
 * is still accepted here. Tightening that needs an audit of the redirect URIs
 * already registered.
 */
export function isSafeRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (DANGEROUS_REDIRECT_SCHEMES.has(url.protocol.toLowerCase())) return false;
  // RFC 6749 §3.1.2: the redirection endpoint URI must not include a fragment.
  if (url.hash !== '') return false;
  return true;
}

export async function createClient(args: {
  clientName?: string;
  redirectUris: string[];
}): Promise<{ clientId: string }> {
  const clientId = `c_${randomToken(16)}`;
  await db.insert(oauthClients).values({
    clientId,
    clientName: args.clientName ?? null,
    redirectUris: args.redirectUris,
    grantTypes: ['authorization_code', 'refresh_token'],
    tokenEndpointAuthMethod: 'none',
  });
  return { clientId };
}

export async function getClient(clientId: string) {
  const rows = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).limit(1);
  return rows[0] ?? null;
}

/**
 * What a code or refresh token is bound to: one workspace (the legacy
 * per-workspace connection) or one account-level grant (lib/mcp-grants.ts).
 * Exactly one; the table CHECKs enforce the same.
 */
export type TokenBinding = { workspaceId: string; grantId?: never } | { grantId: string; workspaceId?: never };

function bindingColumns(b: TokenBinding): { workspaceId: string | null; grantId: string | null } {
  if (typeof b.grantId === 'string') return { workspaceId: null, grantId: b.grantId };
  return { workspaceId: b.workspaceId ?? null, grantId: null };
}

function bindingFromRow(row: { workspaceId: string | null; grantId: string | null }): TokenBinding | null {
  if (row.grantId && !row.workspaceId) return { grantId: row.grantId };
  if (row.workspaceId && !row.grantId) return { workspaceId: row.workspaceId };
  return null;
}

export async function createAuthCode(args: TokenBinding & {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string | null;
}): Promise<string> {
  const code = randomToken(AUTH_CODE_BYTES);
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000);
  await db.insert(oauthCodes).values({
    code,
    clientId: args.clientId,
    userId: args.userId,
    ...bindingColumns(args),
    redirectUri: args.redirectUri,
    codeChallenge: args.codeChallenge,
    codeChallengeMethod: args.codeChallengeMethod,
    scope: args.scope,
    expiresAt,
  });
  return code;
}

export type ConsumedAuthCode = TokenBinding & {
  userId: string;
  scope: string | null;
};

/**
 * Exchange an auth code. Single use: the code is claimed by one conditional
 * UPDATE ... WHERE consumed_at IS NULL RETURNING, so of two concurrent
 * exchanges exactly one gets the row (neon-http has no interactive
 * transactions, so a read-then-write would not be). The remaining checks run
 * on the claimed row; a code that fails them stays consumed.
 */
export async function consumeAuthCode(args: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<ConsumedAuthCode | { error: string }> {
  const rows = await db
    .update(oauthCodes)
    .set({ consumedAt: new Date() })
    .where(and(eq(oauthCodes.code, args.code), isNull(oauthCodes.consumedAt)))
    .returning();
  const row = rows[0];
  if (!row) return { error: 'invalid_grant' };
  if (row.expiresAt.getTime() < Date.now()) return { error: 'invalid_grant' };
  if (row.clientId !== args.clientId) return { error: 'invalid_grant' };
  if (row.redirectUri !== args.redirectUri) return { error: 'invalid_grant' };

  // PKCE verification: SHA256(codeVerifier) base64url-encoded must match codeChallenge.
  const computed = createHash('sha256').update(args.codeVerifier).digest('base64url');
  if (computed !== row.codeChallenge) return { error: 'invalid_grant' };

  const binding = bindingFromRow(row);
  if (!binding) return { error: 'invalid_grant' };
  return { ...binding, userId: row.userId, scope: row.scope };
}

/**
 * The stored form of a refresh token: SHA-256, lowercase hex. Rows are looked
 * up by it, never by the token. Migration 0283 hashed the rows that existed
 * before this with the same function (`encode(sha256(convert_to(token,
 * 'UTF8')), 'hex')`), so those tokens still refresh.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * The sign-in a refresh token descends from. Set once at the
 * authorization-code exchange and carried unchanged by every rotation.
 */
export type RefreshTokenFamily = { familyId: string; familyIssuedAt: Date };

function familyEndsAt(family: RefreshTokenFamily): number {
  return family.familyIssuedAt.getTime() + REFRESH_TOKEN_ABSOLUTE_LIFETIME_SECONDS * 1000;
}

/**
 * Mint a refresh token. Without `family` this is a sign-in and starts a new
 * family; a rotation passes the consumed token's family. Expiry is the sooner
 * of the sliding per-token TTL and the family's absolute lifetime.
 */
export async function createRefreshToken(args: TokenBinding & {
  clientId: string;
  userId: string;
  scope: string | null;
  family?: RefreshTokenFamily;
}): Promise<string> {
  const token = randomToken(REFRESH_TOKEN_BYTES);
  const now = new Date();
  const family = args.family ?? { familyId: randomUUID(), familyIssuedAt: now };
  const expiresAt = new Date(Math.min(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000, familyEndsAt(family)));
  await db.insert(oauthRefreshTokens).values({
    tokenHash: hashRefreshToken(token),
    clientId: args.clientId,
    userId: args.userId,
    ...bindingColumns(args),
    scope: args.scope,
    familyId: family.familyId,
    familyIssuedAt: family.familyIssuedAt,
    expiresAt,
    createdAt: now,
  });
  return token;
}

export type ConsumedRefreshToken = TokenBinding & {
  userId: string;
  scope: string | null;
  family: RefreshTokenFamily;
};

/**
 * Rotate a refresh token. The token is spent by one conditional
 * UPDATE ... WHERE token = hash AND client_id = client AND revoked_at IS NULL
 * RETURNING, so it mints at most one new pair even under concurrent refreshes,
 * and a request naming another client spends nothing. The caller mints the
 * new token in the same family.
 *
 * When nothing was spent and the hash names a token of this client that is
 * already revoked (rotated earlier), every live token of its family is
 * revoked by a second UPDATE, so the sign-in has to start over. Both
 * statements are single atomic UPDATEs: neon-http has no interactive
 * transactions.
 */
export async function consumeRefreshToken(args: {
  token: string;
  clientId: string;
}): Promise<ConsumedRefreshToken | { error: string }> {
  const tokenHash = hashRefreshToken(args.token);
  const now = new Date();
  const rows = await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: now })
    .where(and(
      eq(oauthRefreshTokens.tokenHash, tokenHash),
      eq(oauthRefreshTokens.clientId, args.clientId),
      isNull(oauthRefreshTokens.revokedAt),
    ))
    .returning();
  const row = rows[0];
  if (!row) {
    await db
      .update(oauthRefreshTokens)
      .set({ revokedAt: now })
      .where(and(
        sql`${oauthRefreshTokens.familyId} in (select family_id from oauth_refresh_tokens where token = ${tokenHash} and client_id = ${args.clientId} and revoked_at is not null)`,
        isNull(oauthRefreshTokens.revokedAt),
      ));
    return { error: 'invalid_grant' };
  }
  if (row.clientId !== args.clientId) return { error: 'invalid_grant' };
  if (row.expiresAt.getTime() <= now.getTime()) return { error: 'invalid_grant' };
  const family = { familyId: row.familyId, familyIssuedAt: row.familyIssuedAt };
  if (familyEndsAt(family) <= now.getTime()) return { error: 'invalid_grant' };

  const binding = bindingFromRow(row);
  if (!binding) return { error: 'invalid_grant' };
  return { ...binding, userId: row.userId, scope: row.scope, family };
}

/** True when the user has a team_members row on the workspace's team. */
export async function userHasWorkspaceMembership(userId: string, workspaceId: string): Promise<boolean> {
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { teamId: true },
  });
  if (!ws) return false;
  const membership = await db.query.teamMembers.findFirst({
    where: and(eq(teamMembers.teamId, ws.teamId), eq(teamMembers.userId, userId)),
    columns: { role: true },
  });
  return !!membership;
}

/** Revoke every outstanding refresh token a user holds for a workspace. */
export async function revokeRefreshTokensForUserWorkspace(userId: string, workspaceId: string): Promise<void> {
  await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(
      eq(oauthRefreshTokens.userId, userId),
      eq(oauthRefreshTokens.workspaceId, workspaceId),
      isNull(oauthRefreshTokens.revokedAt),
    ));
}
