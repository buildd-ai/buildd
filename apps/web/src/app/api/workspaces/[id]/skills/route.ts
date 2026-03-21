import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { db } from '@buildd/core/db';
import { workspaceSkills, workspaces, accounts } from '@buildd/core/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { hashApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { packageRoleConfig, uploadRoleConfig } from '@/lib/role-config';
import { isStorageConfigured } from '@/lib/storage';

/** Convert mcpServers (legacy string[] or new Record) into .mcp.json mcpServers format */
function normalizeMcpToConfig(raw: unknown): Record<string, unknown> {
    if (Array.isArray(raw)) {
        const servers: Record<string, object> = {};
        for (const name of raw) {
            if (typeof name === 'string') servers[name] = {};
        }
        return { mcpServers: servers };
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return { mcpServers: raw };
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

function generateSlug(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function computeContentHash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
}

// GET /api/workspaces/[id]/skills
export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
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
        const url = new URL(req.url);
        const enabledParam = url.searchParams.get('enabled');

        const conditions = [eq(workspaceSkills.workspaceId, id)];

        if (enabledParam === 'true') {
            conditions.push(eq(workspaceSkills.enabled, true));
        } else if (enabledParam === 'false') {
            conditions.push(eq(workspaceSkills.enabled, false));
        }

        const isRoleParam = url.searchParams.get('isRole');
        if (isRoleParam === 'true') {
            conditions.push(eq(workspaceSkills.isRole, true));
        } else if (isRoleParam === 'false') {
            conditions.push(eq(workspaceSkills.isRole, false));
        }

        const results = await db
            .select()
            .from(workspaceSkills)
            .where(and(...conditions))
            .orderBy(desc(workspaceSkills.createdAt));

        return NextResponse.json({ skills: results });
    } catch (error) {
        console.error('List workspace skills error:', error);
        return NextResponse.json({ error: 'Failed to list workspace skills' }, { status: 500 });
    }
}

// POST /api/workspaces/[id]/skills — create/upsert by (workspaceId, slug)
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
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

        if (!name || !content) {
            return NextResponse.json(
                { error: 'name and content are required' },
                { status: 400 }
            );
        }

        const slug = body.slug || generateSlug(name);

        if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) {
            return NextResponse.json(
                { error: 'slug must be lowercase alphanumeric with hyphens (e.g., "ui-audit")' },
                { status: 400 }
            );
        }

        const contentHash = computeContentHash(content);

        // Verify workspace exists
        const workspace = await db.query.workspaces.findFirst({
            where: eq(workspaces.id, id),
            columns: { id: true },
        });
        if (!workspace) {
            return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
        }

        // Upsert by (workspaceId, slug)
        const existing = await db.query.workspaceSkills.findFirst({
            where: and(eq(workspaceSkills.workspaceId, id), eq(workspaceSkills.slug, slug)),
        });

        if (existing) {
            const [updated] = await db
                .update(workspaceSkills)
                .set({
                    name,
                    description: description || null,
                    content,
                    contentHash,
                    source: source || null,
                    metadata: metadata || {},
                    enabled: enabled !== undefined ? enabled : existing.enabled,
                    ...(model !== undefined ? { model } : {}),
                    ...(allowedTools !== undefined ? { allowedTools } : {}),
                    ...(canDelegateTo !== undefined ? { canDelegateTo } : {}),
                    ...(background !== undefined ? { background } : {}),
                    ...(maxTurns !== undefined ? { maxTurns } : {}),
                    ...(color !== undefined ? { color } : {}),
                    ...(mcpServers !== undefined ? { mcpServers } : {}),
                    ...(requiredEnvVars !== undefined ? { requiredEnvVars } : {}),
                    ...(isRole !== undefined ? { isRole } : {}),
                    ...(repoUrl !== undefined ? { repoUrl } : {}),
                    ...(accountId !== undefined ? { accountId } : {}),
                    updatedAt: new Date(),
                })
                .where(eq(workspaceSkills.id, existing.id))
                .returning();

            if (updated.isRole && isStorageConfigured()) {
                const bundle = await packageRoleConfig(id, {
                    slug: updated.slug,
                    claudeMd: updated.content,
                    mcpConfig: normalizeMcpToConfig(updated.mcpServers),
                    envMapping: (updated.requiredEnvVars as Record<string, string>) || {},
                    skillSlugs: body.skillSlugs || [],
                    type: updated.repoUrl ? 'builder' : 'service',
                    repoUrl: updated.repoUrl,
                });
                const { configHash, configStorageKey } = await uploadRoleConfig(bundle);
                await db.update(workspaceSkills)
                    .set({ configHash, configStorageKey })
                    .where(eq(workspaceSkills.id, updated.id));
            }

            return NextResponse.json({ skill: updated });
        }

        const [skill] = await db
            .insert(workspaceSkills)
            .values({
                workspaceId: id,
                slug,
                name,
                description: description || null,
                content,
                contentHash,
                source: source || null,
                enabled: enabled !== undefined ? enabled : true,
                origin: 'manual',
                metadata: metadata || {},
                ...(model ? { model } : {}),
                ...(allowedTools ? { allowedTools } : {}),
                ...(canDelegateTo ? { canDelegateTo } : {}),
                ...(background !== undefined ? { background } : {}),
                ...(maxTurns !== undefined ? { maxTurns } : {}),
                ...(color ? { color } : {}),
                ...(mcpServers ? { mcpServers } : {}),
                ...(requiredEnvVars ? { requiredEnvVars } : {}),
                ...(isRole !== undefined ? { isRole } : {}),
                ...(repoUrl !== undefined ? { repoUrl } : {}),
                ...(accountId ? { accountId } : {}),
            })
            .returning();

        if (skill.isRole && isStorageConfigured()) {
            const bundle = await packageRoleConfig(id, {
                slug: skill.slug,
                claudeMd: skill.content,
                mcpConfig: normalizeMcpToConfig(skill.mcpServers),
                envMapping: (skill.requiredEnvVars as Record<string, string>) || {},
                skillSlugs: body.skillSlugs || [],
                type: skill.repoUrl ? 'builder' : 'service',
                repoUrl: skill.repoUrl,
            });
            const { configHash, configStorageKey } = await uploadRoleConfig(bundle);
            await db.update(workspaceSkills)
                .set({ configHash, configStorageKey })
                .where(eq(workspaceSkills.id, skill.id));
        }

        return NextResponse.json({ skill }, { status: 201 });
    } catch (error) {
        console.error('Create workspace skill error:', error);
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        const isDatabaseError = errorMsg.includes('constraint') || errorMsg.includes('foreign key');
        return NextResponse.json({
            error: 'Failed to create workspace skill',
            detail: isDatabaseError ? 'Invalid reference (workspace may not exist)' : errorMsg.slice(0, 100),
        }, { status: 500 });
    }
}
