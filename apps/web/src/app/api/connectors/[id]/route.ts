import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
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
import { registrationRefusalBody } from '@/lib/connector-provision';
import { teamCredentialWhere } from '@buildd/core/secrets/team-scope';
import { isUuid } from '@/lib/uuid';
import { canWriteTeamConnectors } from '@/lib/connector-team-auth';
import { hasBearer, SESSION_REQUIRED } from '@/lib/capability-grants-auth';
import { parseToolPolicy, withReadOnlyTool } from '@/lib/connector-gateway';
import { withKeptBlocked } from '@/lib/connector-tool-review';
import { sqlWhere } from '@buildd/core/db/relational-sql';

const refuseWrite = () => NextResponse.json(
  { error: 'forbidden', message: 'Changing or deleting a connector requires the manage_connectors permission in its team.' },
  { status: 403 },
);

async function authenticateRequest(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  if (apiKey) {
    const account = await authenticateApiKey(apiKey, req);
    if (account) {
      if (!hasTokenRouteAdminAccess(account, req)) return { type: 'denied' as const };
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
    where: sqlWhere(eq(connectors.id, id)),
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
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid connector id: expected a UUID, got "${id}". Pass the full UUID.` }, { status: 404 });
  }
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
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid connector id: expected a UUID, got "${id}". Pass the full UUID.` }, { status: 404 });
  }
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
  if (!(await canWriteTeamConnectors(auth, connector.teamId))) return refuseWrite();

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
    toolPolicy?: unknown;
    /** One tool to treat as read-only, added to the saved toolPolicy (the gateway's one-step fix). */
    markReadOnly?: unknown;
    /** One tool a person chose to keep blocked from Home's tool review card: no card for it again. */
    keepBlocked?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Tool classification overrides decide what the connector gateway lets a
  // read-only run call, so only a signed-in person may change them: an agent
  // holds keys, and a key must never widen its own read class.
  let toolPolicy: { readOnlyTools: string[]; denyTools: string[] } | undefined;
  if (body.toolPolicy !== undefined) {
    if (auth.type === 'api' || hasBearer(req)) return NextResponse.json(SESSION_REQUIRED, { status: 403 });
    const parsed = parseToolPolicy(body.toolPolicy);
    if (!parsed) return NextResponse.json({ error: 'toolPolicy must be { readOnlyTools?: string[], denyTools?: string[] } with at most 200 exact tool names each' }, { status: 400 });
    toolPolicy = parsed;
  }
  if (body.markReadOnly !== undefined) {
    if (auth.type === 'api' || hasBearer(req)) return NextResponse.json(SESSION_REQUIRED, { status: 403 });
    if (body.toolPolicy !== undefined) return NextResponse.json({ error: 'Send toolPolicy or markReadOnly, not both' }, { status: 400 });
    const merged = withReadOnlyTool(connector.discoveredMetadata, body.markReadOnly as string);
    if (!merged) return NextResponse.json({ error: 'markReadOnly must be one exact tool name (no wildcards), with at most 200 read-only tools in all' }, { status: 400 });
    toolPolicy = merged;
  }
  let toolReview: { keptBlocked: string[] } | undefined;
  if (body.keepBlocked !== undefined) {
    if (auth.type === 'api' || hasBearer(req)) return NextResponse.json(SESSION_REQUIRED, { status: 403 });
    const kept = withKeptBlocked(connector.discoveredMetadata, body.keepBlocked);
    if (!kept) return NextResponse.json({ error: 'keepBlocked must be one exact tool name (no wildcards), with at most 200 kept blocked in all' }, { status: 400 });
    toolReview = kept;
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
        // Re-discovery replaces the OAuth metadata, never an admin's tool
        // overrides, the tools the gateway last saw, or the tools kept blocked.
        const prev = (connector.discoveredMetadata as Record<string, unknown> | null) ?? {};
        const kept = Object.fromEntries((['toolPolicy', 'toolSnapshot', 'toolReview'] as const)
          .filter(k => prev[k] !== undefined).map(k => [k, prev[k]]));
        updates.discoveredMetadata = { ...(discovered as unknown as Record<string, unknown>), ...kept };
        if (!body.clientId && !connector.clientId && discovered.authorizationServer.registration_endpoint) {
          let dcrResult;
          try {
            dcrResult = await registerClient(
              discovered.authorizationServer.registration_endpoint,
              getCallbackUrl(req.nextUrl.origin),
              { grantTypesSupported: discovered.authorizationServer.grant_types_supported },
            );
          } catch (err) {
            // Same 422 as create: an approval problem for the owner, not a 500.
            const refusal = registrationRefusalBody(err, targetUrl);
            if (refusal) return NextResponse.json(refusal, { status: 422 });
            throw err;
          }
          updates.clientId = dcrResult.client_id;
          if (dcrResult.client_secret) {
            updates.encryptedClientSecret = encrypt(dcrResult.client_secret);
          }
        }
      }
    }

    if (toolPolicy || toolReview) {
      updates.discoveredMetadata = {
        ...((updates.discoveredMetadata ?? connector.discoveredMetadata ?? {}) as Record<string, unknown>),
        ...(toolPolicy ? { toolPolicy } : {}),
        ...(toolReview ? { toolReview } : {}),
      };
    }

    const [updated] = await db.update(connectors)
      .set(updates)
      .where(eq(connectors.id, id))
      .returning();

    if (body.headerValue !== undefined && connector.authMode === 'header') {
      const provider = getSecretsProvider();
      const existingSecret = await db.query.secrets.findFirst({
        where: sqlWhere(teamCredentialWhere({ teamId: connector.teamId, purpose: 'mcp_connector_credential', label: id })),
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
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid connector id: expected a UUID, got "${id}". Pass the full UUID.` }, { status: 404 });
  }
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
  if (!(await canWriteTeamConnectors(auth, connector.teamId))) return refuseWrite();

  try {
    // Delete associated secrets first (cascade handles connectorWorkspaces)
    const secretRows = await db.query.secrets.findMany({
      where: sqlWhere(teamCredentialWhere({ teamId: connector.teamId, purpose: 'mcp_connector_credential', label: id })),
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
