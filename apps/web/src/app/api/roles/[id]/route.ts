import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { db } from '@buildd/core/db';
import { workspaceSkills } from '@buildd/core/db/schema';
import { eq, or, and, isNull, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, getUserWorkspaceIds } from '@/lib/team-access';
import { packageRoleConfig, uploadRoleConfig, deleteRoleConfig } from '@/lib/role-config';
import { isStorageConfigured } from '@/lib/storage';

function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizeBackend(raw: unknown): 'claude' | 'codex' | null {
  return raw === 'claude' || raw === 'codex' ? raw : null;
}

/** Find a role the user can access (team-level or workspace-scoped). */
async function findAccessibleRole(roleId: string, userId: string) {
  const [teamIds, wsIds] = await Promise.all([
    getUserTeamIds(userId),
    getUserWorkspaceIds(userId),
  ]);

  const role = await db.query.workspaceSkills.findFirst({
    where: and(
      eq(workspaceSkills.id, roleId),
      or(
        teamIds.length > 0 ? and(isNull(workspaceSkills.workspaceId), inArray(workspaceSkills.teamId, teamIds)) : undefined,
        wsIds.length > 0 ? inArray(workspaceSkills.workspaceId, wsIds) : undefined,
      ),
    ),
  });

  return { role, teamIds, wsIds };
}

// GET /api/roles/[id] — fetch any role by ID
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { role } = await findAccessibleRole(id, user.id);
    if (!role) {
      return NextResponse.json({ error: 'Role not found' }, { status: 404 });
    }
    return NextResponse.json({ skill: role });
  } catch (error) {
    console.error('GET /api/roles/[id] error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PATCH /api/roles/[id] — update any role by ID
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { role: existing, wsIds } = await findAccessibleRole(id, user.id);
    if (!existing) {
      return NextResponse.json({ error: 'Role not found' }, { status: 404 });
    }

    const body = await req.json();
    const { name, description, content, model, allowedTools, canDelegateTo,
      background, maxTurns, color, mcpServers, requiredEnvVars, isRole,
      repoUrl, enabled, defaultBackend } = body;

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (content !== undefined) {
      updates.content = content;
      updates.contentHash = computeContentHash(content);
    }
    if (model !== undefined) updates.model = model;
    if (allowedTools !== undefined) updates.allowedTools = allowedTools;
    if (canDelegateTo !== undefined) updates.canDelegateTo = canDelegateTo;
    if (background !== undefined) updates.background = background;
    if (maxTurns !== undefined) updates.maxTurns = maxTurns;
    if (color !== undefined) updates.color = color;
    if (mcpServers !== undefined) updates.mcpServers = mcpServers;
    if (requiredEnvVars !== undefined) updates.requiredEnvVars = requiredEnvVars;
    if (isRole !== undefined) updates.isRole = isRole;
    if (repoUrl !== undefined) updates.repoUrl = repoUrl;
    if (enabled !== undefined) updates.enabled = enabled;
    if (defaultBackend !== undefined) updates.defaultBackend = normalizeBackend(defaultBackend);

    const [updated] = await db
      .update(workspaceSkills)
      .set(updates)
      .where(eq(workspaceSkills.id, id))
      .returning();

    if (updated.isRole && isStorageConfigured()) {
      const wsIdForBundle = updated.workspaceId ?? wsIds[0];
      if (wsIdForBundle) {
        const oldStorageKey = existing.configStorageKey;
        const bundle = await packageRoleConfig(wsIdForBundle, {
          slug: updated.slug,
          claudeMd: updated.content,
          mcpConfig: (updated.mcpServers as Record<string, unknown>) || {},
          envMapping: (updated.requiredEnvVars as Record<string, string>) || {},
          skillSlugs: body.skillSlugs || [],
          type: updated.repoUrl ? 'builder' : 'service',
          repoUrl: updated.repoUrl,
        });
        const { configHash, configStorageKey } = await uploadRoleConfig(bundle);
        await db.update(workspaceSkills)
          .set({ configHash, configStorageKey })
          .where(eq(workspaceSkills.id, id));
        if (oldStorageKey && oldStorageKey !== configStorageKey) {
          await deleteRoleConfig(oldStorageKey).catch(() => {});
        }
        updated.configHash = configHash;
        updated.configStorageKey = configStorageKey;
      }
    }

    return NextResponse.json({ skill: updated });
  } catch (error) {
    console.error('PATCH /api/roles/[id] error:', error);
    return NextResponse.json({ error: 'Failed to update role' }, { status: 500 });
  }
}

// DELETE /api/roles/[id] — delete any role by ID
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { role: existing } = await findAccessibleRole(id, user.id);
    if (!existing) {
      return NextResponse.json({ error: 'Role not found' }, { status: 404 });
    }

    if (existing.configStorageKey && isStorageConfigured()) {
      await deleteRoleConfig(existing.configStorageKey).catch(() => {});
    }

    await db.delete(workspaceSkills).where(eq(workspaceSkills.id, id));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('DELETE /api/roles/[id] error:', error);
    return NextResponse.json({ error: 'Failed to delete role' }, { status: 500 });
  }
}
