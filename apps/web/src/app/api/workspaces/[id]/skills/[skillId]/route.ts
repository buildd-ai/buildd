import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { db } from '@buildd/core/db';
import { workspaceSkills, accounts } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { hashApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { packageRoleConfig, uploadRoleConfig, deleteRoleConfig } from '@/lib/role-config';
import { isStorageConfigured } from '@/lib/storage';

/** Convert mcpServers (legacy string[] or new Record) into .mcp.json mcpServers format */
function normalizeMcpToConfig(raw: unknown): Record<string, unknown> {
    if (Array.isArray(raw)) {
        // Legacy: ["github", "slack"] → { mcpServers: { github: {}, slack: {} } }
        const servers: Record<string, object> = {};
        for (const name of raw) {
            if (typeof name === 'string') servers[name] = {};
        }
        return { mcpServers: servers };
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        // Auto-add type: "http" to any server that has a url field
        const servers = raw as Record<string, Record<string, unknown>>;
        for (const config of Object.values(servers)) {
            if (config && typeof config === 'object' && 'url' in config && !config.type) {
                config.type = 'http';
            }
        }
        return { mcpServers: servers };
    }
    return {};
}

async function authenticateRequest(req: NextRequest) {
    const authHeader = req.headers.get('authorization');
    const apiKey = authHeader?.replace('Bearer ', '') || null;

    if (apiKey) {
        const account = await db.query.accounts.findFirst({
            where: eq(accounts.apiKey, hashApiKey(apiKey)),
        });
        if (account) return { type: 'api' as const, account };
    }

    if (process.env.NODE_ENV !== 'development') {
        const user = await getCurrentUser();
        if (user) return { type: 'session' as const, user };
    } else {
        return { type: 'dev' as const };
    }

    return null;
}

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
    if (!auth) {
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
        const skill = await db.query.workspaceSkills.findFirst({
            where: and(
                eq(workspaceSkills.id, skillId),
                eq(workspaceSkills.workspaceId, id)
            ),
        });

        if (!skill) {
            return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
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
    if (!auth) {
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
        const body = await req.json();
        const { name, description, content, source, metadata, enabled,
            model, allowedTools, canDelegateTo, background, maxTurns, color,
            mcpServers, requiredEnvVars, isRole, repoUrl, accountId } = body;

        const existing = await db.query.workspaceSkills.findFirst({
            where: and(
                eq(workspaceSkills.id, skillId),
                eq(workspaceSkills.workspaceId, id)
            ),
        });

        if (!existing) {
            return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
        }

        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (name !== undefined) updates.name = name;
        if (description !== undefined) updates.description = description;
        if (content !== undefined) {
            updates.content = content;
            updates.contentHash = computeContentHash(content);
        }
        if (source !== undefined) updates.source = source;
        if (metadata !== undefined) updates.metadata = metadata;
        if (enabled !== undefined) updates.enabled = enabled;
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
                mcpConfig: normalizeMcpToConfig(updatedSkill.mcpServers),
                envMapping: (updatedSkill.requiredEnvVars as Record<string, string>) || {},
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
    if (!auth) {
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
        const existing = await db.query.workspaceSkills.findFirst({
            where: and(
                eq(workspaceSkills.id, skillId),
                eq(workspaceSkills.workspaceId, id)
            ),
        });

        if (!existing) {
            return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
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
