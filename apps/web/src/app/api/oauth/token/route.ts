import { NextRequest, NextResponse } from 'next/server';
import {
  consumeAuthCode,
  consumeRefreshToken,
  createRefreshToken,
  userHasWorkspaceMembership,
  revokeRefreshTokensForUserWorkspace,
  type RefreshTokenFamily,
  type TokenBinding,
} from '@/lib/oauth/storage';
import { signAccessToken, signGrantAccessToken } from '@/lib/oauth/tokens';
import { resolveGrant, revokeRefreshTokensForGrant } from '@/lib/mcp-grants';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { ensureTeamSessionAccount } from '@/lib/oauth/ensure-session-account';

export const dynamic = 'force-dynamic';

/** The session account for the workspace's team (lib/oauth/ensure-session-account.ts). */
async function ensureUserAccount(userId: string, workspaceId: string): Promise<void> {
  try {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { teamId: true },
    });
    if (workspace) await ensureTeamSessionAccount(userId, workspace.teamId);
  } catch {
    // Non-fatal: the token is valid even if account provisioning fails.
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
 * Mint an access + refresh pair for a binding, after re-checking it.
 *
 * Legacy (workspace) binding: the user must still be a member of the
 * workspace's team. Grant binding: the grant must still be the user's, issued
 * to this client, not revoked or expired, and still reach at least one
 * workspace (its workspaces ∩ current membership, lib/mcp-grants.ts). The
 * grant's workspaces and acts-as kind stay on the grant row; the new refresh
 * token carries the same grant id, so a refresh can never widen or change
 * either.
 *
 * `family` is the consumed refresh token's family on a refresh, so the new
 * token keeps the sign-in's family id and issue time (and with it the
 * family's absolute lifetime); a code exchange omits it and starts a family.
 *
 * `onRefuse` runs when the re-check fails (refresh revokes the rest of the
 * family there). Error descriptions never name a workspace or grant.
 */
async function issuePair(args: {
  binding: TokenBinding;
  userId: string;
  clientId: string;
  scope: string | null;
  family?: RefreshTokenFamily;
  onRefuse?: () => Promise<void>;
}) {
  const { binding, userId, clientId } = args;
  const scope = args.scope ?? 'mcp';
  const family = args.family ? { family: args.family } : {};

  if (typeof binding.grantId === 'string') {
    const grant = await resolveGrant(binding.grantId, userId, clientId);
    if (!grant || grant.workspaces.length === 0) {
      await args.onRefuse?.();
      return tokenError('invalid_grant', 'this connection no longer grants access');
    }
    for (const teamId of new Set(grant.workspaces.map((w) => w.teamId))) {
      await ensureTeamSessionAccount(userId, teamId);
    }
    const { token, expiresIn } = await signGrantAccessToken({ userId, grantId: binding.grantId, clientId, scope });
    const refreshToken = await createRefreshToken({ clientId, userId, grantId: binding.grantId, scope: args.scope, ...family });
    return tokenResponse(token, refreshToken, expiresIn, scope);
  }

  const workspaceId = binding.workspaceId as string;
  // Tokens are issued only to a current member of the workspace's team.
  if (!(await userHasWorkspaceMembership(userId, workspaceId))) {
    await args.onRefuse?.();
    return tokenError('invalid_grant', 'no longer a member of this workspace team');
  }
  await ensureUserAccount(userId, workspaceId);
  const { token, expiresIn } = await signAccessToken({ userId, workspaceId, clientId, scope });
  const refreshToken = await createRefreshToken({ clientId, userId, workspaceId, scope: args.scope, ...family });
  return tokenResponse(token, refreshToken, expiresIn, scope);
}

function tokenResponse(accessToken: string, refreshToken: string, expiresIn: number, scope: string) {
  return NextResponse.json(
    {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      scope,
    },
    { headers: { 'cache-control': 'no-store', pragma: 'no-cache' } },
  );
}

/**
 * OAuth 2.1 token endpoint. Supports two grants:
 *   - authorization_code (with PKCE verifier)
 *   - refresh_token (rotates the refresh token on every use, within the
 *     sign-in's family; presenting an already-rotated token revokes the
 *     family, lib/oauth/storage.ts)
 *
 * Issues either a legacy workspace-scoped JWT (the code or refresh token is
 * bound to one workspace) or an account-level JWT naming an MCP grant (it is
 * bound to a grant), plus a refresh token with the same binding.
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

    const { userId, scope, ...binding } = result;
    return issuePair({ binding: binding as TokenBinding, userId, clientId, scope });
  }

  if (grantType === 'refresh_token') {
    const refreshToken = form.get('refresh_token');
    const clientId = form.get('client_id');
    if (!refreshToken || !clientId) {
      return tokenError('invalid_request', 'missing required parameter');
    }

    const result = await consumeRefreshToken({ token: refreshToken, clientId });
    if ('error' in result) return tokenError(result.error);

    // The binding is re-checked on every refresh. When it no longer holds,
    // no new pair is minted and the user's remaining refresh tokens for that
    // workspace or grant are revoked (the presented one already is).
    const { userId, scope, family, ...binding } = result;
    return issuePair({
      binding: binding as TokenBinding,
      userId,
      clientId,
      scope,
      family,
      onRefuse: () => typeof binding.grantId === 'string'
        ? revokeRefreshTokensForGrant(binding.grantId)
        : revokeRefreshTokensForUserWorkspace(userId, binding.workspaceId as string),
    });
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
