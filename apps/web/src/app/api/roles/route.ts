import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { db } from '@buildd/core/db';
import { workspaces, workspaceSkills } from '@buildd/core/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserWorkspaceIds, getUserTeamIds } from '@/lib/team-access';
import { getAccountWorkspacePermissions } from '@/lib/account-workspace-cache';
import { getWorkspaceRoles } from '@/lib/mission-context';
import { packageRoleConfig, uploadRoleConfig } from '@/lib/role-config';
import { isStorageConfigured } from '@/lib/storage';

function generateSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizeBackend(raw: unknown): 'claude' | 'codex' | null {
  return raw === 'claude' || raw === 'codex' ? raw : null;
}

// GET /api/roles — list roles with current load
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    let wsIds: string[];
    if (apiAccount) {
      const [perms, openWs] = await Promise.all([
        getAccountWorkspacePermissions(apiAccount.id),
        db.query.workspaces.findMany({
          where: eq(workspaces.accessMode, 'open'),
          columns: { id: true },
        }),
      ]);
      const linkedIds = perms.map(p => p.workspaceId);
      const openIds = openWs.map(w => w.id);
      wsIds = [...new Set([...linkedIds, ...openIds])];
    } else {
      wsIds = await getUserWorkspaceIds(user!.id);
    }

    if (wsIds.length === 0) {
      return NextResponse.json({ roles: [] });
    }

    // Fetch roles across all workspaces, merge by slug
    const allRoles = [];
    for (const wsId of wsIds) {
      const wsRoles = await getWorkspaceRoles(wsId);
      allRoles.push(...wsRoles);
    }

    // Deduplicate by slug (keep first occurrence)
    const seenSlugs = new Set<string>();
    const roles = allRoles.filter(r => {
      if (seenSlugs.has(r.slug)) return false;
      seenSlugs.add(r.slug);
      return true;
    });

    return NextResponse.json({ roles });
  } catch (error) {
    console.error('GET /api/roles error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/roles — create a team-level role (workspaceId = null)
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

    const teamIds = await getUserTeamIds(user.id);
    if (teamIds.length === 0) {
      return NextResponse.json({ error: 'No team found for user' }, { status: 400 });
    }
    const teamId = teamIds[0];

    const slug = body.slug || generateSlug(name);
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) {
      return NextResponse.json(
        { error: 'slug must be lowercase alphanumeric with hyphens' },
        { status: 400 }
      );
    }

    const contentHash = computeContentHash(content);

    // Check for existing team-level role with same slug
    const existing = await db.query.workspaceSkills.findFirst({
      where: and(
        eq(workspaceSkills.teamId, teamId),
        eq(workspaceSkills.slug, slug),
        isNull(workspaceSkills.workspaceId),
      ),
    });

    if (existing) {
      return NextResponse.json(
        { error: `A team-level role with slug "${slug}" already exists` },
        { status: 409 }
      );
    }

    const [skill] = await db
      .insert(workspaceSkills)
      .values({
        teamId,
        workspaceId: null,
        slug,
        name,
        description: description || null,
        content,
        contentHash,
        source: 'manual',
        origin: 'manual',
        enabled: true,
        isRole: isRole !== undefined ? isRole : true,
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
