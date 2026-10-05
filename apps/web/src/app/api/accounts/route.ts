import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts, accountWorkspaces, workspaces } from '@buildd/core/db/schema';
import { desc, eq, inArray } from 'drizzle-orm';
import { isTokenScope, requiresTeamAdminToGrant, scopedTokenLevel } from '@buildd/core/token-scopes';
import { randomBytes } from 'crypto';
import { getCurrentUser } from '@/lib/auth-helpers';
import { hashApiKey, extractApiKeyPrefix } from '@/lib/api-auth';
import { getUserTeamIds, getUserDefaultTeamId, getUserTeamRole } from '@/lib/team-access';
import { parseKeyLevel, isKeyLevelAllowed, keyLevelNotAllowedMessage, canAdministerTeamKeys } from '@/lib/key-level-policy';
import { resolveClaudeCredential, extractJwtSub } from '@/lib/claude-credential';
import { isOpenWithinTeams } from '@/lib/open-workspaces';
import { getTeamPermissionOverrides, roleHas } from '@/lib/permissions';

function generateApiKey(): string {
  return `bld_${randomBytes(32).toString('hex')}`;
}

export async function GET() {
  if (process.env.NODE_ENV === 'development' && (!process.env.DATABASE_URL || !process.env.DEV_USER_EMAIL)) {
    return NextResponse.json({ accounts: [] });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const teamIds = await getUserTeamIds(user.id);
    const allAccounts = teamIds.length > 0
      ? await db.query.accounts.findMany({
          where: inArray(accounts.teamId, teamIds),
          orderBy: desc(accounts.createdAt),
        })
      : [];

    return NextResponse.json({ accounts: allAccounts });
  } catch (error) {
    console.error('Get accounts error:', error);
    return NextResponse.json({ error: 'Failed to get accounts' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({
      id: 'dev-account',
      name: 'Dev Account',
      apiKey: 'bld_dev_key_123'
    });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { name, type, authType, maxConcurrentWorkers, level, teamId: requestedTeamId, workspaceId, scopes, workspaceIds: rawWorkspaceIds, expiresAt } = body;
    if (scopes !== undefined && (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every(isTokenScope))) return NextResponse.json({ error: 'Invalid token scopes' }, { status: 400 });
    if (rawWorkspaceIds != null && (!Array.isArray(rawWorkspaceIds) || rawWorkspaceIds.length === 0 || !rawWorkspaceIds.every((id: unknown) => typeof id === 'string'))) return NextResponse.json({ error: 'Invalid workspaces' }, { status: 400 });
    if (rawWorkspaceIds != null && scopes === undefined) return NextResponse.json({ error: 'Workspace restrictions require explicit scopes' }, { status: 400 });
    // Deduped up front: every id is validated before the account row exists.
    const workspaceIds: string[] | null = rawWorkspaceIds == null ? null : [...new Set<string>(rawWorkspaceIds)];
    const expiry = expiresAt == null ? null : new Date(expiresAt);
    if (expiry && (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now())) return NextResponse.json({ error: 'Expiry must be in the future' }, { status: 400 });

    if (!name || !type) {
      return NextResponse.json({ error: 'Name and type are required' }, { status: 400 });
    }

    const levelGiven = !(level === undefined || level === null || level === '');
    const parsedLevel = levelGiven ? parseKeyLevel(level) : 'worker';
    if (!parsedLevel) {
      return NextResponse.json({ error: 'level must be one of trigger, worker, admin' }, { status: 400 });
    }
    // A scoped token's level is derived from its scopes, never chosen: code
    // that still reads `level` must not see admin without the admin scope.
    const derivedLevel = scopes !== undefined ? scopedTokenLevel(scopes) : null;
    if (derivedLevel && levelGiven && parsedLevel !== derivedLevel) {
      return NextResponse.json({ error: `level must be ${derivedLevel} for these scopes (it is derived from them)` }, { status: 400 });
    }
    const requestedLevel = derivedLevel ?? parsedLevel;

    const plaintextKey = generateApiKey();

    // Use requested teamId if provided and user is a member, otherwise fall back to default
    let teamId: string | null = null;
    if (requestedTeamId) {
      const userTeamIds = await getUserTeamIds(user.id);
      if (userTeamIds.includes(requestedTeamId)) {
        teamId = requestedTeamId;
      }
    }
    if (!teamId) {
      teamId = await getUserDefaultTeamId(user.id);
    }
    if (!teamId) {
      return NextResponse.json({ error: 'No team found for user' }, { status: 500 });
    }

    // A key can never do more than its creator's team role allows.
    const role = await getUserTeamRole(user.id, teamId);
    if (!role) {
      return NextResponse.json({ error: 'You are not a member of this team' }, { status: 403 });
    }
    if (!isKeyLevelAllowed(role, requestedLevel, await getTeamPermissionOverrides(teamId))) {
      return NextResponse.json({ error: keyLevelNotAllowedMessage(role, requestedLevel, await getTeamPermissionOverrides(teamId)) }, { status: 403 });
    }

    if (!roleHas(role, 'manage_team_keys', await getTeamPermissionOverrides(teamId)) && scopes?.some((scope: string) => requiresTeamAdminToGrant(scope))) return NextResponse.json({error: 'Your team role cannot grant administrative scopes'}, {status:403});
    let selectedWorkspaces: string[] = [];
    // Explicit links: a scoped token's list, or a legacy key's single workspaceId.
    const requestedLinks: string[] | null = workspaceIds ?? (scopes === undefined && typeof workspaceId === 'string' && workspaceId ? [workspaceId] : null);
    if (scopes !== undefined || requestedLinks != null) {
      const keyTeamId: string = teamId;
      const teamWorkspaces = await db.query.workspaces.findMany({ where: eq(workspaces.teamId, teamId), columns: { id: true, teamId: true, accessMode: true } });
      const byId = new Map(teamWorkspaces.map(w => [w.id, w]));
      if (requestedLinks != null) {
        if (requestedLinks.some(id => !byId.has(id))) return NextResponse.json({ error: 'Workspace is outside this team' }, { status: 403 });
        // Restricted access mode admits an API token only through an explicit
        // link, which is a team owner/admin decision.
        if (!canAdministerTeamKeys(role, await getTeamPermissionOverrides(teamId)) && requestedLinks.some(id => !isOpenWithinTeams(byId.get(id), [keyTeamId]))) {
          return NextResponse.json({ error: 'Only a team owner or admin can grant a token access to a restricted workspace' }, { status: 403 });
        }
        selectedWorkspaces = requestedLinks;
      } else {
        // An unrestricted token is linked to open workspaces only; restricted
        // ones must be listed explicitly.
        selectedWorkspaces = teamWorkspaces.filter(w => isOpenWithinTeams(w, [keyTeamId])).map(w => w.id);
      }
    }
    const insertValues: Record<string, unknown> = {
      name,
      scopes: scopes ?? null,
      workspaceIds: workspaceIds ?? null,
      expiresAt: expiry,
      type: type as 'user' | 'service' | 'action',
      level: requestedLevel,
      authType: authType as 'api' | 'oauth' || 'oauth',
      apiKey: hashApiKey(plaintextKey),
      apiKeyPrefix: extractApiKeyPrefix(plaintextKey),
      maxConcurrentWorkers: maxConcurrentWorkers || 3,
      teamId,
    };

    const [account] = await db
      .insert(accounts)
      .values(insertValues as typeof accounts.$inferInsert)
      .returning();

    // For OAuth accounts, populate seatId from the team's Claude credential so
    // groupOauthAccountsBySeatId works immediately without waiting for re-auth.
    if (insertValues.authType === 'oauth' && account) {
      try {
        const cred = await resolveClaudeCredential({ teamId });
        if (cred) {
          const seatId = extractJwtSub(cred.accessToken);
          if (seatId) {
            await db.update(accounts).set({ seatId }).where(eq(accounts.id, account.id));
            account.seatId = seatId;
          }
        }
      } catch {
        // Non-fatal: account is created successfully; seatId can be set on next credential store.
      }
    }

    // Auto-create workspace binding if workspaceId provided
    for (const selectedWorkspaceId of selectedWorkspaces) {
      await db.insert(accountWorkspaces).values({
        accountId: account.id,
        workspaceId: selectedWorkspaceId,
        canClaim: true,
        canCreate: true,
      });
    }

    // Return plaintext key once - it won't be retrievable after this
    return NextResponse.json({ ...account, apiKey: plaintextKey });
  } catch (error) {
    console.error('Create account error:', error);
    return NextResponse.json({ error: 'Failed to create account' }, { status: 500 });
  }
}
