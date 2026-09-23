import { randomBytes, createHash } from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { oauthClients, oauthCodes, oauthRefreshTokens, teamMembers, workspaces } from '@buildd/core/db/schema';
import {
  AUTH_CODE_BYTES,
  AUTH_CODE_TTL_SECONDS,
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

export async function createAuthCode(args: {
  clientId: string;
  userId: string;
  workspaceId: string;
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
    workspaceId: args.workspaceId,
    redirectUri: args.redirectUri,
    codeChallenge: args.codeChallenge,
    codeChallengeMethod: args.codeChallengeMethod,
    scope: args.scope,
    expiresAt,
  });
  return code;
}

export type ConsumedAuthCode = {
  userId: string;
  workspaceId: string;
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

  return { userId: row.userId, workspaceId: row.workspaceId, scope: row.scope };
}

export async function createRefreshToken(args: {
  clientId: string;
  userId: string;
  workspaceId: string;
  scope: string | null;
}): Promise<string> {
  const token = randomToken(REFRESH_TOKEN_BYTES);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);
  await db.insert(oauthRefreshTokens).values({
    token,
    clientId: args.clientId,
    userId: args.userId,
    workspaceId: args.workspaceId,
    scope: args.scope,
    expiresAt,
  });
  return token;
}

export type ConsumedRefreshToken = {
  userId: string;
  workspaceId: string;
  scope: string | null;
};

/**
 * Rotate a refresh token. Single use: revoked by one conditional
 * UPDATE ... WHERE revoked_at IS NULL RETURNING, so a token can mint at most
 * one new pair even under concurrent refreshes. The caller mints the new one.
 */
export async function consumeRefreshToken(args: {
  token: string;
  clientId: string;
}): Promise<ConsumedRefreshToken | { error: string }> {
  const rows = await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(oauthRefreshTokens.token, args.token), isNull(oauthRefreshTokens.revokedAt)))
    .returning();
  const row = rows[0];
  if (!row) return { error: 'invalid_grant' };
  if (row.expiresAt.getTime() < Date.now()) return { error: 'invalid_grant' };
  if (row.clientId !== args.clientId) return { error: 'invalid_grant' };

  return { userId: row.userId, workspaceId: row.workspaceId, scope: row.scope };
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
