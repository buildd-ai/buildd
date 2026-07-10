import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { connectors, secrets } from '@buildd/core/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserTeamIds } from '@/lib/team-access';
import { getSecretsProvider } from '@buildd/core/secrets';
import { encrypt } from '@buildd/core/secrets';
import { discoverOAuthMetadata, registerClient, getCallbackUrl } from '@/lib/mcp-oauth';

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

function deriveStatus(secret: { tokenExpiresAt: Date | null } | undefined): 'connected' | 'expired' | 'not_connected' {
  if (!secret) return 'not_connected';
  if (secret.tokenExpiresAt && secret.tokenExpiresAt < new Date()) return 'expired';
  return 'connected';
}

export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth || auth.type === 'denied') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (auth.type === 'dev') {
    return NextResponse.json({ connectors: [] });
  }

  let teamId: string;
  if (auth.type === 'api') {
    teamId = auth.account.teamId;
  } else {
    const teamIds = await getUserTeamIds(auth.user.id);
    if (teamIds.length === 0) return NextResponse.json({ connectors: [] });
    const qTeamId = req.nextUrl.searchParams.get('teamId');
    teamId = (qTeamId && teamIds.includes(qTeamId)) ? qTeamId : teamIds[0];
  }

  try {
    const rows = await db.query.connectors.findMany({
      where: eq(connectors.teamId, teamId),
    });

    let secretMap = new Map<string, { tokenExpiresAt: Date | null }>();
    const connectorIds = rows.map(r => r.id);
    if (connectorIds.length > 0) {
      const secretRows = await db.query.secrets.findMany({
        where: and(
          eq(secrets.teamId, teamId),
          eq(secrets.purpose, 'mcp_connector_credential'),
          inArray(secrets.label, connectorIds),
        ),
        columns: { label: true, tokenExpiresAt: true },
      });
      for (const s of secretRows) {
        if (s.label) secretMap.set(s.label, { tokenExpiresAt: s.tokenExpiresAt });
      }
    }

    const result = rows.map(c => ({
      id: c.id,
      name: c.name,
      url: c.url,
      authMode: c.authMode,
      status: deriveStatus(secretMap.get(c.id)),
    }));

    return NextResponse.json({ connectors: result });
  } catch (error) {
    console.error('List connectors error:', error);
    return NextResponse.json({ error: 'Failed to list connectors' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth || auth.type === 'denied') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (auth.type === 'dev') {
    return NextResponse.json({ connector: { id: 'dev-id', name: 'dev', url: 'http://localhost', authMode: 'none' } });
  }

  let teamId: string;
  if (auth.type === 'api') {
    teamId = auth.account.teamId;
  } else {
    const teamIds = await getUserTeamIds(auth.user.id);
    if (teamIds.length === 0) return NextResponse.json({ error: 'No team found' }, { status: 400 });
    teamId = teamIds[0];
  }

  let body: {
    name: string;
    url: string;
    authMode?: 'none' | 'header' | 'oauth';
    headerName?: string;
    headerValue?: string;
    clientId?: string;
    clientSecret?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { name, url, authMode: rawAuthMode, headerName, headerValue, clientId: bodyClientId, clientSecret: bodyClientSecret } = body;

  if (!name || !url) {
    return NextResponse.json({ error: 'name and url are required' }, { status: 400 });
  }

  const authMode: 'none' | 'header' | 'oauth' = rawAuthMode ?? 'oauth';

  try {
    let discoveredMetadata: Record<string, unknown> | undefined;
    let clientId = bodyClientId;
    let encryptedClientSecret: string | undefined;

    if (authMode === 'oauth') {
      const discovered = await discoverOAuthMetadata(url);
      if (discovered.authMode === 'oauth') {
        discoveredMetadata = discovered as unknown as Record<string, unknown>;
        if (!clientId && discovered.authorizationServer.registration_endpoint) {
          const dcrResult = await registerClient(
            discovered.authorizationServer.registration_endpoint,
            getCallbackUrl(),
          );
          clientId = dcrResult.client_id;
          if (dcrResult.client_secret) {
            encryptedClientSecret = encrypt(dcrResult.client_secret);
          }
        }
      }
    }

    if (bodyClientSecret && !encryptedClientSecret) {
      encryptedClientSecret = encrypt(bodyClientSecret);
    }

    const [connector] = await db.insert(connectors).values({
      teamId,
      name,
      url,
      authMode,
      headerName: authMode === 'header' ? (headerName ?? null) : null,
      discoveredMetadata: discoveredMetadata ?? null,
      clientId: clientId ?? null,
      encryptedClientSecret: encryptedClientSecret ?? null,
    }).returning();

    if (authMode === 'header' && headerValue) {
      const provider = getSecretsProvider();
      await provider.set(null, headerValue, {
        teamId,
        purpose: 'mcp_connector_credential',
        label: connector.id,
      });
    }

    return NextResponse.json({ connector }, { status: 201 });
  } catch (error) {
    console.error('Create connector error:', error);
    return NextResponse.json({ error: 'Failed to create connector' }, { status: 500 });
  }
}
