import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import {
  consumeAuthCode,
  consumeRefreshToken,
  createRefreshToken,
} from '@/lib/oauth/storage';
import { signAccessToken } from '@/lib/oauth/tokens';
import { db } from '@buildd/core/db';
import { accounts, workspaces, users } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { hashApiKey, extractApiKeyPrefix } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

function generateApiKey(): string {
  return `bld_${randomBytes(32).toString('hex')}`;
}

/**
 * Option B: ensure the workspace's team has a type='user' account so
 * authenticateOauthJwt can find one. Users who authorize the MCP connector
 * for the first time (without having gone through device/CLI auth) won't
 * have one yet. Creates a minimal account and silently skips on any error
 * so the token response is never blocked.
 */
async function ensureUserAccount(userId: string, workspaceId: string): Promise<void> {
  try {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { teamId: true },
    });
    if (!workspace) return;

    const existing = await db.query.accounts.findFirst({
      where: and(eq(accounts.teamId, workspace.teamId), eq(accounts.type, 'user')),
      columns: { id: true },
    });
    if (existing) return;

    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { name: true, email: true },
    });

    const plaintextKey = generateApiKey();
    await db.insert(accounts).values({
      name: `${user?.name || user?.email || 'User'}'s Account`,
      type: 'user',
      authType: 'oauth',
      apiKey: hashApiKey(plaintextKey),
      apiKeyPrefix: extractApiKeyPrefix(plaintextKey),
      maxConcurrentWorkers: 10,
      teamId: workspace.teamId,
    });
  } catch {
    // Non-fatal: the token is valid even if account provisioning fails.
    // The user may 401 on MCP tool calls until the account is created.
  }
}

function tokenError(error: string, description?: string, status = 400) {
  return NextResponse.json(
    description ? { error, error_description: description } : { error },
    {
      status,
      headers: { 'cache-control': 'no-store', pragma: 'no-cache' },
    },
  );
}

/**
 * OAuth 2.1 token endpoint. Supports two grants:
 *   - authorization_code (with PKCE verifier)
 *   - refresh_token (rotates the refresh token on every use)
 *
 * Issues a workspace-scoped JWT bearer + a refresh token. The workspace
 * binding is carried from the auth code (or prior refresh token) into the
 * new access token's `workspace_id` claim and `aud` URL.
 */
export async function POST(req: NextRequest) {
  const contentType = req.headers.get('content-type') ?? '';
  let form: URLSearchParams;
  if (contentType.includes('application/x-www-form-urlencoded')) {
    form = new URLSearchParams(await req.text());
  } else if (contentType.includes('application/json')) {
    const body = (await req.json().catch(() => ({}))) as Record<string, string>;
    form = new URLSearchParams(body);
  } else {
    return tokenError('invalid_request', 'unsupported content-type');
  }

  const grantType = form.get('grant_type');

  if (grantType === 'authorization_code') {
    const code = form.get('code');
    const clientId = form.get('client_id');
    const redirectUri = form.get('redirect_uri');
    const codeVerifier = form.get('code_verifier');

    if (!code || !clientId || !redirectUri || !codeVerifier) {
      return tokenError('invalid_request', 'missing required parameter');
    }

    const result = await consumeAuthCode({ code, clientId, redirectUri, codeVerifier });
    if ('error' in result) return tokenError(result.error);

    await ensureUserAccount(result.userId, result.workspaceId);

    const scope = result.scope ?? 'mcp';
    const { token, expiresIn } = await signAccessToken({
      userId: result.userId,
      workspaceId: result.workspaceId,
      clientId,
      scope,
    });
    const refreshToken = await createRefreshToken({
      clientId,
      userId: result.userId,
      workspaceId: result.workspaceId,
      scope: result.scope,
    });

    return NextResponse.json(
      {
        access_token: token,
        refresh_token: refreshToken,
        token_type: 'Bearer',
        expires_in: expiresIn,
        scope,
      },
      { headers: { 'cache-control': 'no-store', pragma: 'no-cache' } },
    );
  }

  if (grantType === 'refresh_token') {
    const refreshToken = form.get('refresh_token');
    const clientId = form.get('client_id');
    if (!refreshToken || !clientId) {
      return tokenError('invalid_request', 'missing required parameter');
    }

    const result = await consumeRefreshToken({ token: refreshToken, clientId });
    if ('error' in result) return tokenError(result.error);

    await ensureUserAccount(result.userId, result.workspaceId);

    const scope = result.scope ?? 'mcp';
    const { token, expiresIn } = await signAccessToken({
      userId: result.userId,
      workspaceId: result.workspaceId,
      clientId,
      scope,
    });
    // Rotate: prior refresh token was revoked by consume, mint a new one.
    const newRefreshToken = await createRefreshToken({
      clientId,
      userId: result.userId,
      workspaceId: result.workspaceId,
      scope: result.scope,
    });

    return NextResponse.json(
      {
        access_token: token,
        refresh_token: newRefreshToken,
        token_type: 'Bearer',
        expires_in: expiresIn,
        scope,
      },
      { headers: { 'cache-control': 'no-store', pragma: 'no-cache' } },
    );
  }

  return tokenError('unsupported_grant_type');
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
    },
  });
}
