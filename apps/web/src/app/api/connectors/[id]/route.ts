import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { connectors, secrets } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
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

async function resolveConnector(id: string, teamIds: string[]) {
  const connector = await db.query.connectors.findFirst({
    where: eq(connectors.id, id),
  });
  if (!connector) return null;
  if (!teamIds.includes(connector.teamId)) return null;
  return connector;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await authenticateRequest(req);
  if (!auth || auth.type === 'denied') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (auth.type === 'dev') {
    return NextResponse.json({ connector: null });
  }

  const teamIds = auth.type === 'api' ? [auth.account.teamId] : await getUserTeamIds(auth.user.id);
  const connector = await resolveConnector(id, teamIds);
  if (!connector) {
    return NextResponse.json({ error: 'Connector not found' }, { status: 404 });
  }

  return NextResponse.json({ connector });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await authenticateRequest(req);
  if (!auth || auth.type === 'denied') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (auth.type === 'dev') {
    return NextResponse.json({ connector: null });
  }

  const teamIds = auth.type === 'api' ? [auth.account.teamId] : await getUserTeamIds(auth.user.id);
  const connector = await resolveConnector(id, teamIds);
  if (!connector) {
    return NextResponse.json({ error: 'Connector not found' }, { status: 404 });
  }

  let body: {
    name?: string;
    url?: string;
    rediscover?: boolean;
    headerName?: string;
    headerValue?: string;
    clientId?: string;
    clientSecret?: string;
    assertionAudience?: string;
    assertionTokenEndpoint?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    const updates: Partial<typeof connectors.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (body.name !== undefined) updates.name = body.name;
    if (body.url !== undefined) updates.url = body.url;
    if (body.headerName !== undefined) updates.headerName = body.headerName;
    if (body.clientId !== undefined) updates.clientId = body.clientId;
    if (body.clientSecret !== undefined) updates.encryptedClientSecret = encrypt(body.clientSecret);
    if (body.assertionAudience !== undefined) updates.assertionAudience = body.assertionAudience;
    if (body.assertionTokenEndpoint !== undefined) updates.assertionTokenEndpoint = body.assertionTokenEndpoint;

    const targetUrl = body.url ?? connector.url;
    if (body.rediscover || body.url) {
      const discovered = await discoverOAuthMetadata(targetUrl);
      if (discovered.authMode === 'oauth') {
        updates.discoveredMetadata = discovered as unknown as Record<string, unknown>;
        if (!body.clientId && !connector.clientId && discovered.authorizationServer.registration_endpoint) {
          const dcrResult = await registerClient(
            discovered.authorizationServer.registration_endpoint,
            getCallbackUrl(req.nextUrl.origin),
          );
          updates.clientId = dcrResult.client_id;
          if (dcrResult.client_secret) {
            updates.encryptedClientSecret = encrypt(dcrResult.client_secret);
          }
        }
      }
    }

    const [updated] = await db.update(connectors)
      .set(updates)
      .where(eq(connectors.id, id))
      .returning();

    if (body.headerValue !== undefined && connector.authMode === 'header') {
      const provider = getSecretsProvider();
      const existingSecret = await db.query.secrets.findFirst({
        where: and(
          eq(secrets.teamId, connector.teamId),
          eq(secrets.purpose, 'mcp_connector_credential'),
          eq(secrets.label, id),
        ),
        columns: { id: true },
      });
      await provider.set(existingSecret?.id ?? null, body.headerValue, {
        teamId: connector.teamId,
        purpose: 'mcp_connector_credential',
        label: id,
      });
    }

    return NextResponse.json({ connector: updated });
  } catch (error) {
    console.error('Update connector error:', error);
    return NextResponse.json({ error: 'Failed to update connector' }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await authenticateRequest(req);
  if (!auth || auth.type === 'denied') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (auth.type === 'dev') {
    return NextResponse.json({ success: true });
  }

  const teamIds = auth.type === 'api' ? [auth.account.teamId] : await getUserTeamIds(auth.user.id);
  const connector = await resolveConnector(id, teamIds);
  if (!connector) {
    return NextResponse.json({ error: 'Connector not found' }, { status: 404 });
  }

  try {
    // Delete associated secrets first (cascade handles connectorWorkspaces)
    const secretRows = await db.query.secrets.findMany({
      where: and(
        eq(secrets.teamId, connector.teamId),
        eq(secrets.purpose, 'mcp_connector_credential'),
        eq(secrets.label, id),
      ),
      columns: { id: true },
    });
    const provider = getSecretsProvider();
    await Promise.all(secretRows.map(s => provider.delete(s.id)));

    await db.delete(connectors).where(eq(connectors.id, id));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete connector error:', error);
    return NextResponse.json({ error: 'Failed to delete connector' }, { status: 500 });
  }
}
