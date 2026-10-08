import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { connectors, connectorShares, secrets, teamMembers } from '@buildd/core/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserTeamIds } from '@/lib/team-access';
import { getSecretsProvider } from '@buildd/core/secrets';
import { encrypt } from '@buildd/core/secrets';
import { discoverAndRegister, registrationRefusalBody } from '@/lib/connector-provision';
import { loadBlockedCatalogs, connectorBlock } from '@/lib/connector-access-policy';
import { deriveConnectorStatus as deriveStatus } from '@/lib/connector-status';
import { resolveConnectorIconData } from '@/lib/connector-icon';
import { scheduleStaleIconRefresh } from '@/lib/connector-icon-refresh';
import { teamCredentialWhere } from '@buildd/core/secrets/team-scope';
import { roleHas, getTeamPermissionOverrides } from '@/lib/permissions';

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

/**
 * Team-admin gate for connector writes (spec §6). A session user must be an
 * owner/admin of the team to create a connector; a plain `member` is rejected
 * with 403. Personal teams have no `team_members` row — absence => allowed
 * (the user implicitly owns their personal team, and `getUserTeamIds` already
 * scopes `teamId` to teams the user belongs to).
 */
async function isTeamAdmin(userId: string, teamId: string): Promise<boolean> {
  const membership = await db.query.teamMembers.findFirst({
    where: and(eq(teamMembers.userId, userId), eq(teamMembers.teamId, teamId)),
    columns: { role: true },
  });
  // No row = the caller's personal team, which they own.
  if (!membership) return true;
  return roleHas(membership.role, 'manage_connectors', await getTeamPermissionOverrides(teamId));
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
    // Precedence: explicit ?teamId → active-team cookie → first team. Without the cookie
    // fallback the list always showed teamIds[0], so connectors owned by any other team
    // (the one you've switched to) were invisible — which drives duplicate re-creation.
    const qTeamId = req.nextUrl.searchParams.get('teamId');
    const cookieTeamId = req.cookies.get('buildd-team')?.value;
    teamId = (qTeamId && teamIds.includes(qTeamId)) ? qTeamId
      : (cookieTeamId && teamIds.includes(cookieTeamId)) ? cookieTeamId
      : teamIds[0];
  }

  try {
    const rows = await db.query.connectors.findMany({
      where: eq(connectors.teamId, teamId),
    });

    // Cross-team sharing (spec §1b): visibility = owned ∪ shared-in. Shared-in
    // connectors are joined via connector_shares; their credentials stay on the
    // owner team and are never exposed here.
    const shareRows = await db.query.connectorShares.findMany({
      where: eq(connectorShares.sharedWithTeamId, teamId),
      with: { connector: { with: { team: { columns: { name: true } } } } },
    });
    const ownedIds = new Set(rows.map(r => r.id));
    const sharedIn = shareRows
      .map(s => s.connector)
      .filter((c): c is NonNullable<typeof c> => !!c && !ownedIds.has(c.id));

    let secretMap = new Map<string, { tokenExpiresAt: Date | null; lastVerificationError: string | null }>();
    const connectorIds = [...rows.map(r => r.id), ...sharedIn.map(c => c.id)];
    if (connectorIds.length > 0) {
      // Credential status is keyed on each connector's OWNER team (§1b):
      // shared-in connectors' secrets live under the owner's teamId.
      const secretTeamIds = [...new Set([teamId, ...sharedIn.map(c => c.teamId)])];
      const secretRows = await db.query.secrets.findMany({
        where: teamCredentialWhere({ teamId: secretTeamIds, purpose: 'mcp_connector_credential', label: connectorIds }),
        columns: { label: true, tokenExpiresAt: true, lastVerificationError: true },
      });
      for (const s of secretRows) {
        if (s.label) secretMap.set(s.label, { tokenExpiresAt: s.tokenExpiresAt, lastVerificationError: s.lastVerificationError });
      }
    }

    // Team catalog policy: a blocked entry's connector stays listed (nothing is
    // silently deleted) but is flagged, since agents can no longer use it.
    const blockedCatalogs = await loadBlockedCatalogs([teamId, ...sharedIn.map(c => c.teamId)]);

    // Credential-free projection — never include clientId/encryptedClientSecret.
    const project = (c: typeof rows[number]) => ({
      blockedByPolicy: !!connectorBlock(c, teamId, blockedCatalogs),
      id: c.id,
      name: c.name,
      url: c.url,
      authMode: c.authMode,
      transport: c.transport,
      status: deriveStatus(secretMap.get(c.id)),
      // Migrated legacy placeholders (spec §4) carry needsReview in discoveredMetadata;
      // the role editor surfaces a "needs review" badge from this flag.
      needsReview: (c.discoveredMetadata as { needsReview?: boolean } | null)?.needsReview === true,
      iconUrl: c.iconUrl ?? null,
    });

    const result = [
      ...rows.map(project),
      ...sharedIn.map(c => ({
        ...project(c),
        shared: true as const,
        ownerTeamId: c.teamId,
        ownerTeamName: (c as { team?: { name?: string } }).team?.name ?? null,
      })),
    ];

    // Rows created before icons were resolved (or whose server was down) get
    // looked up again after the response; never blocks the list.
    try { scheduleStaleIconRefresh([...rows, ...sharedIn]); } catch { /* best effort */ }

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
    // Create the connector under the ACTIVE team (cookie), not always the first team —
    // otherwise "Add connection" while viewing another team silently created it in
    // teamIds[0], stranding it where the user wasn't looking.
    const cookieTeamId = req.cookies.get('buildd-team')?.value;
    teamId = (cookieTeamId && teamIds.includes(cookieTeamId)) ? cookieTeamId : teamIds[0];
    // Spec §6: only a team owner/admin may create a connector.
    if (!(await isTeamAdmin(auth.user.id, teamId))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  let body: {
    name: string;
    url?: string;
    transport?: 'http' | 'stdio';
    command?: string;
    args?: string[];
    envMapping?: Record<string, string>;
    authMode?: 'none' | 'header' | 'oauth' | 'assertion';
    headerName?: string;
    headerValue?: string;
    clientId?: string;
    clientSecret?: string;
    reuseIfExists?: boolean;
    assertionAudience?: string;
    assertionTokenEndpoint?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const {
    name, url, command, args, envMapping,
    authMode: rawAuthMode, headerName, headerValue,
    clientId: bodyClientId, clientSecret: bodyClientSecret, reuseIfExists,
    assertionAudience: bodyAssertionAudience,
    assertionTokenEndpoint: bodyAssertionTokenEndpoint,
  } = body;

  const transport: 'http' | 'stdio' = body.transport === 'stdio' ? 'stdio' : 'http';

  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }

  // Transport-specific requirements (spec §1 invariants + AC-2/AC-3).
  if (transport === 'stdio') {
    if (!command) {
      return NextResponse.json({ error: 'command_required' }, { status: 400 });
    }
  } else {
    if (!url) {
      return NextResponse.json({ error: 'url is required' }, { status: 400 });
    }
    // `new URL('ttps://…')` parses fine (any scheme does), so a dropped
    // character only surfaced later as a discovery throw → bare 500.
    let protocol: string | null = null;
    try { protocol = new URL(url).protocol; } catch { /* unparsable */ }
    if (protocol !== 'https:' && protocol !== 'http:') {
      return NextResponse.json(
        { error: 'invalid_url', message: 'URL must start with https:// (or http://).' },
        { status: 400 },
      );
    }
  }

  // stdio auth is env-only → authMode forced to 'none'. http defaults to oauth.
  const authMode: 'none' | 'header' | 'oauth' | 'assertion' = transport === 'stdio' ? 'none' : (rawAuthMode ?? 'oauth');

  if (authMode === 'header' && !headerName) {
    return NextResponse.json({ error: 'header_name_required' }, { status: 400 });
  }

  if (authMode === 'assertion') {
    if (!bodyAssertionAudience) {
      return NextResponse.json({ error: 'assertion_audience_required' }, { status: 400 });
    }
    if (!bodyAssertionTokenEndpoint) {
      return NextResponse.json({ error: 'assertion_token_endpoint_required' }, { status: 400 });
    }
  }

  try {
    // (teamId, name) uniqueness (spec §1 AC-4). Registry install passes
    // reuseIfExists to adopt the existing row instead of erroring (spec §5 AC-3).
    const existing = await db.query.connectors.findFirst({
      where: and(eq(connectors.teamId, teamId), eq(connectors.name, name)),
    });
    if (existing) {
      if (reuseIfExists) {
        return NextResponse.json({ connector: existing, reused: true });
      }
      return NextResponse.json({ error: 'connector_name_taken' }, { status: 409 });
    }

    let discoveredMetadata: Record<string, unknown> | undefined;
    let clientId = bodyClientId;
    let encryptedClientSecret: string | undefined;

    // Icon lookup runs alongside discovery; it never fails the create. A header
    // credential lets `initialize` answer with serverInfo.icons; OAuth servers
    // are re-checked with the bearer once the callback has one.
    const iconAuth = authMode === 'header' && headerName && headerValue ? { [headerName]: headerValue } : undefined;
    const iconPromise = transport === 'http' && url
      ? resolveConnectorIconData(url, { headers: iconAuth }).catch(() => null)
      : Promise.resolve(null);

    if (authMode === 'oauth' && url) {
      try {
        const setup = await discoverAndRegister(url, req.nextUrl.origin, clientId);
        discoveredMetadata = setup.discoveredMetadata ?? undefined;
        clientId = setup.clientId ?? undefined;
        encryptedClientSecret = setup.encryptedClientSecret ?? undefined;
      } catch (err) {
        const refusal = registrationRefusalBody(err, url);
        if (refusal) return NextResponse.json(refusal, { status: 422 });
        return NextResponse.json(
          { error: 'discovery_failed', message: `Could not reach this MCP server: ${(err as Error).message}` },
          { status: 422 },
        );
      }
    }

    if (bodyClientSecret && !encryptedClientSecret) {
      encryptedClientSecret = encrypt(bodyClientSecret);
    }

    const [connector] = await db.insert(connectors).values({
      teamId,
      name,
      // `connectors.url` is NOT NULL in the (frozen) schema; stdio connectors
      // carry no url, so store an empty string for them.
      url: url ?? '',
      transport,
      command: transport === 'stdio' ? (command ?? null) : null,
      args: transport === 'stdio' ? (args ?? []) : [],
      envMapping: transport === 'stdio' ? (envMapping ?? {}) : {},
      authMode,
      headerName: authMode === 'header' ? (headerName ?? null) : null,
      discoveredMetadata: discoveredMetadata ?? null,
      clientId: clientId ?? null,
      encryptedClientSecret: encryptedClientSecret ?? null,
      assertionAudience: authMode === 'assertion' ? (bodyAssertionAudience ?? null) : null,
      assertionTokenEndpoint: authMode === 'assertion' ? (bodyAssertionTokenEndpoint ?? null) : null,
      iconUrl: await iconPromise,
      iconCheckedAt: transport === 'http' && url ? new Date() : null,
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
