import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { connectors } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser, getUserFromRequest } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserTeamIds } from '@/lib/team-access';
import {
  generateCodeVerifier,
  deriveCodeChallenge,
  buildAuthorizationUrl,
  signOAuthState,
  OAUTH_STATE_COOKIE,
} from '@/lib/mcp-oauth';
import { randomBytes } from 'crypto';

async function authenticateRequest(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  if (apiKey) {
    const account = await authenticateApiKey(apiKey);
    if (account) {
      if (account.level !== 'admin') return { type: 'denied' as const };
      return { type: 'api' as const, account };
    }
  }

  if (process.env.NODE_ENV !== 'development') {
    const user = await getCurrentUser();
    if (user) return { type: 'session' as const, user };
  } else {
    return { type: 'dev' as const };
  }

  return null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await authenticateRequest(req);
  if (!auth || auth.type === 'denied') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (auth.type === 'dev') {
    return NextResponse.json({ authorizationUrl: 'http://localhost:3000/fake-oauth' });
  }

  const teamIds = auth.type === 'api' ? [auth.account.teamId] : await getUserTeamIds(auth.user.id);

  const connector = await db.query.connectors.findFirst({
    where: eq(connectors.id, id),
  });
  if (!connector || !teamIds.includes(connector.teamId)) {
    return NextResponse.json({ error: 'Connector not found' }, { status: 404 });
  }

  if (connector.authMode !== 'oauth') {
    return NextResponse.json({ error: 'Connector does not use OAuth' }, { status: 400 });
  }

  const meta = connector.discoveredMetadata as {
    authMode: 'oauth';
    authorizationServer: {
      authorization_endpoint: string;
      token_endpoint: string;
      scopes_supported?: string[];
      [key: string]: unknown;
    };
  } | null;

  if (!meta || meta.authMode !== 'oauth') {
    return NextResponse.json({ error: 'OAuth metadata not yet discovered; re-run discovery first' }, { status: 400 });
  }

  if (!connector.clientId) {
    return NextResponse.json({ error: 'No client ID configured; re-create connector to trigger DCR' }, { status: 400 });
  }

  // Resolve user identity (needed for state JWT)
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Could not resolve user identity' }, { status: 401 });
  }

  try {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = deriveCodeChallenge(codeVerifier);
    const state = randomBytes(16).toString('hex');

    const stateJwt = await signOAuthState({
      state,
      connectorId: id,
      codeVerifier,
      userId: user.id,
    });

    const authorizationUrl = buildAuthorizationUrl(
      meta.authorizationServer as Parameters<typeof buildAuthorizationUrl>[0],
      connector.clientId,
      connector.url,
      state,
      codeChallenge,
      req.nextUrl.origin,
    );

    const response = NextResponse.json({ authorizationUrl });
    response.cookies.set(OAUTH_STATE_COOKIE, stateJwt, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 15 * 60,
      path: '/',
    });

    return response;
  } catch (error) {
    console.error('Connect error:', error);
    return NextResponse.json({ error: 'Failed to initiate OAuth flow' }, { status: 500 });
  }
}
