import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { NextRequest, NextResponse } from 'next/server';
import { applyRoutingPatch, parseRoutingPatch } from '@/lib/role-routing';
import { patchClaudeAiArtifactsMetadata } from '@buildd/shared';
import { createHash } from 'crypto';
import { db } from '@buildd/core/db';
import { workspaceSkills, workspaces } from '@buildd/core/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { bodyReadRefused, noteBodyReads } from '@/lib/body-read-monitor';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { getTeamPermissionOverrides, roleHas } from '@/lib/permissions';
import { packageRoleConfig, uploadRoleConfig, deleteRoleConfig } from '@/lib/role-config';
import { isStorageConfigured } from '@/lib/storage';
import { normalizeBackend } from '@/lib/normalize-backend';

async function authenticateRequest(req: NextRequest) {
    const authHeader = req.headers.get('authorization');
    const apiKey = authHeader?.replace('Bearer ', '') || null;

    if (apiKey) {
        const account = await authenticateApiKey(apiKey, req);
        if (account) {
            // Skills management requires admin-level access. Worker/trigger tokens
            // are rejected here; OAuth JWTs are always resolved as admin.
            if (!hasTokenRouteAdminAccess(account, req, req.method === 'GET' ? 'tasks:read' : undefined)) {
                return { type: 'denied' as const };
            }
            return { type: 'api' as const, account };
        }
        // Invalid/unrecognized token — fall through to session auth
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
 * manage_agent_roles for a session touching a role (an existing role, or a row
 * being made one). API keys were already held to admin in authenticateRequest;
 * a plain skill stays writable by anyone who can reach the workspace.
 */
async function sessionMayManageRole(
    access: { teamId: string; role: string } | null,
    touchesRole: boolean,
): Promise<boolean> {
    if (!access || !touchesRole) return true;
    return roleHas(access.role, 'manage_agent_roles', await getTeamPermissionOverrides(access.teamId));
}

const ROLE_FORBIDDEN = { error: 'Managing agent roles requires team admin' };

function computeContentHash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
}

// GET /api/workspaces/[id]/skills/[skillId]
export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string; skillId: string }> }
) {
    const { id, skillId } = await params;
    const auth = await authenticateRequest(req);
    if (!auth || auth.type === 'denied') {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (auth.type === 'session') {
        const access = await verifyWorkspaceAccess(auth.user.id, id);
        if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    } else if (auth.type === 'api') {
        const hasAccess = await verifyAccountWorkspaceAccess(auth.account.id, id);
        if (!hasAccess) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    try {
        // First look for a workspace-scoped skill. If not found, fall back to a
        // team-level skill accessible from this workspace's team (read-only).
        let skill = await db.query.workspaceSkills.findFirst({
            where: and(
                eq(workspaceSkills.id, skillId),
                eq(workspaceSkills.workspaceId, id)
            ),
        });

        if (!skill) {
            const ws = await db.query.workspaces.findFirst({
                where: eq(workspaces.id, id),
                columns: { teamId: true },
            });
            if (ws) {
                skill = await db.query.workspaceSkills.findFirst({
                    where: and(
                        eq(workspaceSkills.id, skillId),
                        isNull(workspaceSkills.workspaceId),
                        eq(workspaceSkills.teamId, ws.teamId),
                        // Personal roles are read through /api/roles/[id].
                        isNull(workspaceSkills.ownerUserId),
                    ),
                }) ?? undefined;
            }
        }

        if (!skill) {
            return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
        }

        // Bulk-read guard (lib/body-read-monitor.ts): token callers only.
        if (auth.type === 'api') {
            const verdict = await noteBodyReads(auth.account.id, [skill.id], 'skill_get');
            if (!verdict.allowed) return bodyReadRefused();
        }

        return NextResponse.json({ skill });
    } catch (error) {
        console.error('Get workspace skill error:', error);
        return NextResponse.json({ error: 'Failed to get workspace skill' }, { status: 500 });
    }
}

// PATCH /api/workspaces/[id]/skills/[skillId]
export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string; skillId: string }> }
) {
    const { id, skillId } = await params;
    const auth = await authenticateRequest(req);
    if (!auth || auth.type === 'denied') {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let sessionAccess: { teamId: string; role: string } | null = null;
    if (auth.type === 'session') {
        sessionAccess = await verifyWorkspaceAccess(auth.user.id, id);
        if (!sessionAccess) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    } else if (auth.type === 'api') {
        const hasAccess = await verifyAccountWorkspaceAccess(auth.account.id, id);
        if (!hasAccess) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    try {
        const body = await req.json();
        const { name, description, content, source, metadata, enabled,
            model, defaultBackend, allowedTools, canDelegateTo, background, maxTurns, color,
            mcpServers, requiredEnvVars, connectorRefs, isRole, repoUrl, accountId } = body;

        const existing = await db.query.workspaceSkills.findFirst({
            where: and(
                eq(workspaceSkills.id, skillId),
                eq(workspaceSkills.workspaceId, id)
            ),
        });

        if (!existing) {
            return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
        }
        if (!(await sessionMayManageRole(sessionAccess, existing.isRole || isRole === true))) {
            return NextResponse.json(ROLE_FORBIDDEN, { status: 403 });
        }

        // Routing text (role-routing.md §2): validated, never truncated.
        const routing = parseRoutingPatch(body);
        if (!routing.ok) return NextResponse.json({ error: routing.error }, { status: 400 });

        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (name !== undefined) updates.name = name;
        if (description !== undefined) updates.description = description;
        if (content !== undefined) {
            updates.content = content;
            updates.contentHash = computeContentHash(content);
        }
        if (source !== undefined) updates.source = source;
        if (metadata !== undefined) updates.metadata = metadata;
        if (routing.patch) updates.metadata = applyRoutingPatch(metadata ?? existing.metadata, routing.patch);
        // claude.ai artifact access (@buildd/shared claude-ai-artifacts.ts), kept in metadata.
        if (body.claudeAiArtifacts !== undefined) {
            const patched = patchClaudeAiArtifactsMetadata(updates.metadata ?? existing.metadata, body.claudeAiArtifacts);
            if (!patched.ok) return NextResponse.json({ error: patched.error }, { status: 400 });
            updates.metadata = patched.metadata;
        }
        if (enabled !== undefined) updates.enabled = enabled;
        if (model !== undefined) updates.model = model;
        if (defaultBackend !== undefined) updates.defaultBackend = normalizeBackend(defaultBackend);
        if (allowedTools !== undefined) updates.allowedTools = allowedTools;
        if (canDelegateTo !== undefined) updates.canDelegateTo = canDelegateTo;
        if (background !== undefined) updates.background = background;
        if (maxTurns !== undefined) updates.maxTurns = maxTurns;
        if (color !== undefined) updates.color = color;
        if (mcpServers !== undefined) updates.mcpServers = mcpServers;
        if (requiredEnvVars !== undefined) updates.requiredEnvVars = requiredEnvVars;
        if (connectorRefs !== undefined) updates.connectorRefs = connectorRefs;
        if (isRole !== undefined) updates.isRole = isRole;
        if (repoUrl !== undefined) updates.repoUrl = repoUrl;
        if (accountId !== undefined) updates.accountId = accountId;

        const [updated] = await db
            .update(workspaceSkills)
            .set(updates)
            .where(eq(workspaceSkills.id, skillId))
            .returning();

        const updatedSkill = updated;
        if (updatedSkill.isRole && isStorageConfigured()) {
            const oldStorageKey = existing.configStorageKey;
            const bundle = await packageRoleConfig(id, {
                slug: updatedSkill.slug,
                claudeMd: updatedSkill.content,
                // MCP is injected solely at claim time from connectors (spec §3);
                // the R2 role bundle carries no MCP server config or env mapping.
                mcpConfig: {},
                envMapping: {},
                skillSlugs: body.skillSlugs || [],
                type: updatedSkill.repoUrl ? 'builder' : 'service',
                repoUrl: updatedSkill.repoUrl,
            });
            const { configHash, configStorageKey } = await uploadRoleConfig(bundle);

            // Update DB with new hash and storage key
            await db.update(workspaceSkills)
                .set({ configHash, configStorageKey, updatedAt: new Date() })
                .where(eq(workspaceSkills.id, skillId));

            // Clean up old config
            if (oldStorageKey && oldStorageKey !== configStorageKey) {
                await deleteRoleConfig(oldStorageKey).catch(() => {});
            }

            // Merge into response
            updatedSkill.configHash = configHash;
            updatedSkill.configStorageKey = configStorageKey;
        }

        return NextResponse.json({ skill: updatedSkill });
    } catch (error) {
        console.error('Update workspace skill error:', error);
        return NextResponse.json({ error: 'Failed to update workspace skill' }, { status: 500 });
    }
}

// DELETE /api/workspaces/[id]/skills/[skillId]
export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ id: string; skillId: string }> }
) {
    const { id, skillId } = await params;
    const auth = await authenticateRequest(req);
    if (!auth || auth.type === 'denied') {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let sessionAccess: { teamId: string; role: string } | null = null;
    if (auth.type === 'session') {
        sessionAccess = await verifyWorkspaceAccess(auth.user.id, id);
        if (!sessionAccess) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    } else if (auth.type === 'api') {
        const hasAccess = await verifyAccountWorkspaceAccess(auth.account.id, id);
        if (!hasAccess) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    try {
        const existing = await db.query.workspaceSkills.findFirst({
            where: and(
                eq(workspaceSkills.id, skillId),
                eq(workspaceSkills.workspaceId, id)
            ),
        });

        if (!existing) {
            return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
        }
        if (!(await sessionMayManageRole(sessionAccess, existing.isRole))) {
            return NextResponse.json(ROLE_FORBIDDEN, { status: 403 });
        }

        // Clean up R2 config for roles
        if (existing.configStorageKey && isStorageConfigured()) {
            await deleteRoleConfig(existing.configStorageKey).catch(() => {});
        }

        await db
            .delete(workspaceSkills)
            .where(eq(workspaceSkills.id, skillId));

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Delete workspace skill error:', error);
        return NextResponse.json({ error: 'Failed to delete workspace skill' }, { status: 500 });
    }
}
