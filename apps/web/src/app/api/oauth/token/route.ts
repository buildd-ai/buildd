import { NextRequest, NextResponse } from 'next/server';
import {
  consumeAuthCode,
  consumeRefreshToken,
  createRefreshToken,
} from '@/lib/oauth/storage';
import { signAccessToken } from '@/lib/oauth/tokens';

export const dynamic = 'force-dynamic';

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
