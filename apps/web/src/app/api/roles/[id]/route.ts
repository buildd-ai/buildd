import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { db } from '@buildd/core/db';
import { workspaceSkills } from '@buildd/core/db/schema';
import { eq, or, and, isNull, inArray, ne } from 'drizzle-orm';
import { canSeeRole, findSharedSlugClash, isPersonalRole, mayEditPersonalRole, validatePersonalRoleConfig } from '@/lib/personal-roles';
import { resolveRolesCaller } from '@/lib/roles-caller';
import { getUserTeamIds, getUserWorkspaceIds } from '@/lib/team-access';
import { packageRoleConfig, uploadRoleConfig, deleteRoleConfig } from '@/lib/role-config';
import { isStorageConfigured } from '@/lib/storage';
import { normalizeBackend } from '@/lib/normalize-backend';
import { isUuid } from '@/lib/uuid';
import { applyRoutingPatch, parseRoutingPatch } from '@/lib/role-routing';
import { parseOperatorGrantInput, withOperatorGrantMetadata, type OperatorGrantConfig } from '@/lib/operator-capability';
import { AGENT_CAPABILITY_NAMES, roleMayHold } from '@/lib/permission-registry';
import { can } from '@/lib/permissions';

function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Find a role the user can access (team-level or workspace-scoped). */
async function findAccessibleRole(roleId: string, userId: string, bearerTeamId: string | null = null) {
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

  // Another member's private personal role is invisible, not forbidden. An
  // OAuth session's bearer sees only its own team's roles.
  const visible = role && canSeeRole(role, userId) && (bearerTeamId === null || role.teamId === bearerTeamId);
  return { role: visible ? role : undefined, teamIds, wsIds };
}

/**
 * manage_agent_roles in the row's team, asked only when the row is a role or
 * is being made one. A plain skill stays writable by any member who can see it.
 */
async function mayManageRole(
  userId: string,
  row: { id?: string; teamId: string; isRole: boolean; ownerUserId?: string | null; visibility?: string | null },
  makesRole: unknown,
): Promise<boolean> {
  // A personal role: its owner, or manage_agent_roles once it is shared.
  if (isPersonalRole(row)) return mayEditPersonalRole(userId, row);
  if (!row.isRole && makesRole !== true) return true;
  return can({ kind: 'user', userId }, 'manage_agent_roles', row.teamId);
}

const FORBIDDEN = { error: 'Managing agent roles requires team admin' };

// GET /api/roles/[id] — fetch any role by ID
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid role id: expected a UUID, got "${id}".` }, { status: 404 });
  }
  const who = await resolveRolesCaller(req);
  if (!who.ok) return who.response;
  const user = { id: who.caller.userId };

  try {
    const { role } = await findAccessibleRole(id, user.id, who.caller.bearerTeamId);
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
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid role id: expected a UUID, got "${id}".` }, { status: 404 });
  }
  const who = await resolveRolesCaller(req);
  if (!who.ok) return who.response;
  const user = { id: who.caller.userId };

  try {
    const { role: existing, wsIds } = await findAccessibleRole(id, user.id, who.caller.bearerTeamId);
    if (!existing) {
      return NextResponse.json({ error: 'Role not found' }, { status: 404 });
    }

    const body = await req.json();
    const { name, description, content, model, allowedTools, canDelegateTo,
      background, maxTurns, color, mcpServers, requiredEnvVars, connectorRefs, isRole,
      repoUrl, enabled, defaultBackend } = body;

    if (!(await mayManageRole(user.id, existing, isRole))) {
      return NextResponse.json(FORBIDDEN, { status: 403 });
    }

    // Routing text (role-routing.md §2): validated, never truncated.
    const routing = parseRoutingPatch(body);
    if (!routing.ok) return NextResponse.json({ error: routing.error }, { status: 400 });

    // A personal role stays team-level, owns no operator grant, and may use
    // only its owner's secrets and connectors the team can use.
    if (isPersonalRole(existing)) {
      if ('workspaceId' in body) {
        return NextResponse.json({ error: 'workspaceId: a personal role is always team-level and has no workspace overrides', field: 'workspaceId' }, { status: 400 });
      }
      const check = await validatePersonalRoleConfig({ teamId: existing.teamId, ownerUserId: existing.ownerUserId!, body });
      if (!check.ok) return NextResponse.json({ error: check.error, field: check.field }, { status: 400 });
    }

    // Agent capability grant (docs/specs/agent-capabilities.md): only a role
    // with a capability ceiling can hold one at all — writing it on any other
    // role would be inert, so reject it rather than silently storing dead config.
    let operatorConfig: OperatorGrantConfig | null = null;
    let hasOperatorGrant = false;
    if ('operatorGrant' in body) {
      hasOperatorGrant = true;
      if (!AGENT_CAPABILITY_NAMES.some(c => roleMayHold(existing.slug, c))) {
        return NextResponse.json({ error: `Role "${existing.slug}" holds no agent capabilities; operatorGrant has no effect for it` }, { status: 400 });
      }
      if (body.operatorGrant !== null) {
        const parsed = parseOperatorGrantInput(body.operatorGrant);
        if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
        operatorConfig = parsed.config;
      }
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    let metadata = existing.metadata;
    if (routing.patch) metadata = applyRoutingPatch(metadata, routing.patch);
    if (hasOperatorGrant) metadata = withOperatorGrantMetadata(metadata, operatorConfig);
    if (routing.patch || hasOperatorGrant) updates.metadata = metadata;
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
    // Role opt-in to team connectors (spec §2). Persisted for team-level roles so
    // the claim route can resolve connectorRefs on the team-default (workspaceId
    // IS NULL) row; without this, promoting a role to team-level dropped its refs.
    if (connectorRefs !== undefined) updates.connectorRefs = connectorRefs;
    if (isRole !== undefined) updates.isRole = isRole;
    if (repoUrl !== undefined) updates.repoUrl = repoUrl;
    if (enabled !== undefined) updates.enabled = enabled;
    if (defaultBackend !== undefined) updates.defaultBackend = normalizeBackend(defaultBackend);

    // Scope change: workspaceId = null (promote to team-level) or UUID (demote to workspace-scoped)
    if ('workspaceId' in body) {
      const newWorkspaceId = body.workspaceId as string | null;
      if (newWorkspaceId === null) {
        // Promoting to team-level: ensure no other team role (or shared
        // personal role) holds the slug. A private personal role does not count.
        const conflict = await findSharedSlugClash({ teamId: existing.teamId, slug: existing.slug, excludeId: id });
        if (conflict) {
          return NextResponse.json(
            {
              error: `A team-level role with slug "${existing.slug}" already exists`,
              conflictingRoleId: conflict.id,
              conflictingRoleSlug: conflict.slug,
              conflictingRoleName: conflict.name,
              editTeamDefaultPath: `/app/settings/roles/${conflict.slug}/edit`,
              resolution: [
                `Edit the existing team default at /app/settings/roles/${conflict.slug}/edit`,
                'Or keep this role as a workspace-specific override (the current row is already a workspace override — only promote it if you want it to become the new team default)',
              ],
            },
            { status: 409 }
          );
        }
      } else {
        // Demoting to workspace-scoped: verify workspace access + no slug conflict
        if (!wsIds.includes(newWorkspaceId)) {
          return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
        }
        const conflict = await db.query.workspaceSkills.findFirst({
          where: and(
            eq(workspaceSkills.workspaceId, newWorkspaceId),
            eq(workspaceSkills.slug, existing.slug),
            ne(workspaceSkills.id, id),
          ),
        });
        if (conflict) {
          return NextResponse.json(
            { error: `A role with slug "${existing.slug}" already exists in this workspace` },
            { status: 409 }
          );
        }
      }
      updates.workspaceId = newWorkspaceId;
    }

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
          // MCP is injected solely at claim time from connectors (spec §3); the
          // R2 role bundle carries no MCP server config or env mapping.
          mcpConfig: {},
          envMapping: {},
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
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid role id: expected a UUID, got "${id}".` }, { status: 404 });
  }
  const who = await resolveRolesCaller(req);
  if (!who.ok) return who.response;
  const user = { id: who.caller.userId };

  try {
    const { role: existing } = await findAccessibleRole(id, user.id, who.caller.bearerTeamId);
    if (!existing) {
      return NextResponse.json({ error: 'Role not found' }, { status: 404 });
    }
    if (!(await mayManageRole(user.id, existing, false))) {
      return NextResponse.json(FORBIDDEN, { status: 403 });
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
