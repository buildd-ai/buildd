import { NextRequest, NextResponse } from 'next/server';
import { applyRoutingPatch, parseRoutingPatch } from '@/lib/role-routing';
import { createHash } from 'crypto';
import { db } from '@buildd/core/db';
import { users, workspaceSkills } from '@buildd/core/db/schema';
import { eq, and, inArray, isNull, isNotNull, or } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserWorkspaceIds, getUserTeamIds, resolveActiveTeamId } from '@/lib/team-access';
import { canSeeRole, findSharedSlugClash, sharedSlugClashBody, validatePersonalRoleConfig } from '@/lib/personal-roles';
import { getAccountWorkspacePermissions } from '@/lib/account-workspace-cache';
import { listOpenWorkspaces } from '@/lib/open-workspaces';
import { getWorkspaceRoles } from '@/lib/mission-context';
import { packageRoleConfig, uploadRoleConfig } from '@/lib/role-config';
import { isStorageConfigured } from '@/lib/storage';
import { isReservedRoleSlug } from '@/lib/reserved-slugs';
import { normalizeBackend } from '@/lib/normalize-backend';
import { can } from '@/lib/permissions';

function generateSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// GET /api/roles — list roles with current load
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey, req);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    let wsIds: string[];
    let teamIds: string[];
    if (apiAccount) {
      const [perms, openWs] = await Promise.all([
        getAccountWorkspacePermissions(apiAccount.id),
        // "Open" is open within the account's own team.
        listOpenWorkspaces([apiAccount.teamId], { id: true }),
      ]);
      const linkedIds = perms.map(p => p.workspaceId);
      const openIds = openWs.map(w => w.id);
      wsIds = [...new Set([...linkedIds, ...openIds])];
      teamIds = [apiAccount.teamId];
    } else {
      [wsIds, teamIds] = await Promise.all([getUserWorkspaceIds(user!.id), getUserTeamIds(user!.id)]);
    }

    // Personal roles in the caller's teams: their own (any visibility) and
    // others' shared ones. An API key has no person behind it, so it sees
    // shared ones only. Never another member's private role.
    const viewerId = apiAccount ? null : user!.id;
    const personalRows = teamIds.length === 0 ? [] : (await db.query.workspaceSkills.findMany({
      where: and(
        inArray(workspaceSkills.teamId, teamIds),
        isNotNull(workspaceSkills.ownerUserId),
        eq(workspaceSkills.isRole, true),
        eq(workspaceSkills.enabled, true),
      ),
      columns: {
        id: true, teamId: true, slug: true, name: true, model: true, color: true,
        description: true, ownerUserId: true, visibility: true,
      },
    })).filter(r => canSeeRole(r, viewerId));

    const ownerIds = [...new Set(personalRows.map(r => r.ownerUserId!))];
    const owners = ownerIds.length === 0 ? [] : await db.query.users.findMany({
      where: inArray(users.id, ownerIds),
      columns: { id: true, name: true },
    });
    const ownerName = new Map(owners.map(o => [o.id, o.name ?? null]));
    const personalRoles = personalRows.map(r => ({
      ...r,
      personal: true as const,
      ownerName: ownerName.get(r.ownerUserId!) ?? null,
    }));

    if (wsIds.length === 0) {
      return NextResponse.json({ roles: personalRoles });
    }

    // Fetch roles across all workspaces, merge by slug
    const allRoles = [];
    for (const wsId of wsIds) {
      const wsRoles = await getWorkspaceRoles(wsId);
      allRoles.push(...wsRoles);
    }

    // The workspace view also reads team-level personal rows, so keep only
    // slugs that a team role or workspace override actually backs; personal
    // roles are listed on their own below, filtered by visibility.
    const teamRoleSlugs = new Set((await db.query.workspaceSkills.findMany({
      where: and(
        eq(workspaceSkills.isRole, true),
        isNull(workspaceSkills.ownerUserId),
        or(
          teamIds.length > 0 ? and(isNull(workspaceSkills.workspaceId), inArray(workspaceSkills.teamId, teamIds)) : undefined,
          inArray(workspaceSkills.workspaceId, wsIds),
        ),
      ),
      columns: { slug: true },
    })).map(r => r.slug));

    // Deduplicate by slug (keep first occurrence)
    const seenSlugs = new Set<string>();
    const teamRoles = allRoles.filter(r => {
      if (!teamRoleSlugs.has(r.slug)) return false;
      if (seenSlugs.has(r.slug)) return false;
      seenSlugs.add(r.slug);
      return true;
    });

    const roles = [...teamRoles, ...personalRoles];

    return NextResponse.json({ roles });
  } catch (error) {
    console.error('GET /api/roles error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/roles — create a team-level role (workspaceId = null), or with
// `personal: true` a personal role owned by the caller (starts private).
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { name, description, content, model, allowedTools, canDelegateTo,
      background, maxTurns, color, mcpServers, requiredEnvVars, connectorRefs, isRole,
      repoUrl, defaultBackend } = body;

    if (!name || !content) {
      return NextResponse.json({ error: 'name and content are required' }, { status: 400 });
    }

    // Routing text (role-routing.md §2): validated, never truncated.
    const routing = parseRoutingPatch(body);
    if (!routing.ok) return NextResponse.json({ error: routing.error }, { status: 400 });

    // Target team: an explicit body.teamId (must be one of the caller's
    // teams), else the active team (`buildd-team` cookie, else the shell's
    // default pick) — never an arbitrary first membership.
    const teamIds = await getUserTeamIds(user.id);
    if (teamIds.length === 0) {
      return NextResponse.json({ error: 'No team found for user' }, { status: 400 });
    }
    let teamId: string | null;
    if (body.teamId !== undefined) {
      if (typeof body.teamId !== 'string' || !teamIds.includes(body.teamId)) {
        return NextResponse.json({ error: 'Team not found' }, { status: 404 });
      }
      teamId = body.teamId;
    } else {
      teamId = await resolveActiveTeamId(user.id, req.cookies.get('buildd-team')?.value ?? null);
    }
    if (!teamId) {
      return NextResponse.json({ error: 'teamId is required: pick the team this role belongs to' }, { status: 400 });
    }

    const personal = body.personal === true;
    const caller = { kind: 'user' as const, userId: user.id };
    if (personal) {
      if (isRole === false) {
        return NextResponse.json({ error: 'A personal row is always a role; drop isRole: false' }, { status: 400 });
      }
      if (!(await can(caller, 'create_personal_roles', teamId))) {
        return NextResponse.json({ error: 'Creating personal roles is turned off for your team role' }, { status: 403 });
      }
      const check = await validatePersonalRoleConfig({ teamId, ownerUserId: user.id, body });
      if (!check.ok) return NextResponse.json({ error: check.error, field: check.field }, { status: 400 });
    } else {
      // manage_agent_roles for a role (the default); a plain skill stays member-writable.
      const createsRole = isRole !== undefined ? Boolean(isRole) : true;
      if (createsRole && !(await can(caller, 'manage_agent_roles', teamId))) {
        return NextResponse.json({ error: 'Managing agent roles requires team admin' }, { status: 403 });
      }
    }

    const slug = body.slug || generateSlug(name);
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) {
      return NextResponse.json(
        { error: 'slug must be lowercase alphanumeric with hyphens' },
        { status: 400 }
      );
    }

    // `/app/team/new` is a static route, so a role with this slug could never
    // reach its own detail page. See lib/reserved-slugs.ts.
    if (isReservedRoleSlug(slug)) {
      return NextResponse.json(
        { error: `"${slug}" is reserved because /app/team/${slug} is a built-in page. Pick a different slug.` },
        { status: 400 }
      );
    }

    const contentHash = computeContentHash(content);

    if (personal) {
      // One slug per owner per team (ws_skills_owner_slug_idx). A private
      // personal role may share a team role's slug; sharing it may not.
      const own = await db.query.workspaceSkills.findFirst({
        where: and(
          eq(workspaceSkills.teamId, teamId),
          eq(workspaceSkills.ownerUserId, user.id),
          eq(workspaceSkills.slug, slug),
        ),
        columns: { id: true },
      });
      if (own) {
        return NextResponse.json({ error: `You already have a personal role with slug "${slug}"` }, { status: 409 });
      }
    } else {
      // A team role may not take the slug of another team role or of a
      // shared personal role (a private personal role does not count).
      const clash = await findSharedSlugClash({ teamId, slug });
      if (clash) {
        return NextResponse.json(
          clash.ownerUserId ? sharedSlugClashBody(clash) : { error: `A team-level role with slug "${slug}" already exists` },
          { status: 409 }
        );
      }
    }

    const [skill] = await db
      .insert(workspaceSkills)
      .values({
        teamId,
        workspaceId: null,
        ...(personal ? { ownerUserId: user.id, visibility: 'private' as const } : {}),
        slug,
        name,
        description: description || null,
        content,
        contentHash,
        source: 'manual',
        origin: 'manual',
        enabled: true,
        ...(routing.patch ? { metadata: applyRoutingPatch({}, routing.patch) } : {}),
        isRole: personal ? true : (isRole !== undefined ? isRole : true),
        ...(model ? { model } : {}),
        ...(allowedTools ? { allowedTools } : {}),
        ...(canDelegateTo ? { canDelegateTo } : {}),
        ...(background !== undefined ? { background } : {}),
        ...(maxTurns !== undefined ? { maxTurns } : {}),
        ...(color ? { color } : {}),
        ...(mcpServers ? { mcpServers } : {}),
        ...(requiredEnvVars ? { requiredEnvVars } : {}),
        // Role opt-in to team connectors (spec §2).
        ...(connectorRefs !== undefined ? { connectorRefs } : {}),
        ...(repoUrl !== undefined ? { repoUrl } : {}),
        ...(defaultBackend !== undefined ? { defaultBackend: normalizeBackend(defaultBackend) } : {}),
      })
      .returning();

    if (skill.isRole && isStorageConfigured()) {
      const wsIds = await getUserWorkspaceIds(user.id);
      const firstWsId = wsIds[0];
      if (firstWsId) {
        const bundle = await packageRoleConfig(firstWsId, {
          slug: skill.slug,
          claudeMd: skill.content,
          // MCP is injected solely at claim time from connectors (spec §3); the
          // R2 role bundle carries no MCP server config or env mapping.
          mcpConfig: {},
          envMapping: {},
          skillSlugs: [],
          type: skill.repoUrl ? 'builder' : 'service',
          repoUrl: skill.repoUrl,
        });
        const { configHash, configStorageKey } = await uploadRoleConfig(bundle);
        await db.update(workspaceSkills)
          .set({ configHash, configStorageKey })
          .where(eq(workspaceSkills.id, skill.id));
      }
    }

    return NextResponse.json({ skill }, { status: 201 });
  } catch (error) {
    console.error('POST /api/roles error:', error);
    return NextResponse.json({ error: 'Failed to create role' }, { status: 500 });
  }
}
