import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { NextRequest, NextResponse } from 'next/server';
import { applyRoutingPatch, parseRoutingPatch } from '@/lib/role-routing';
import { patchClaudeAiArtifactsMetadata } from '@buildd/shared';
import { createHash } from 'crypto';
import { db } from '@buildd/core/db';
import { workspaceSkills, workspaces } from '@buildd/core/db/schema';
import { eq, and, or, isNull, desc } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { bodyReadRefused, noteBodyReads } from '@/lib/body-read-monitor';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { packageRoleConfig, uploadRoleConfig } from '@/lib/role-config';
import { isStorageConfigured } from '@/lib/storage';
import { isReservedRoleSlug } from '@/lib/reserved-slugs';
import { normalizeBackend } from '@/lib/normalize-backend';
import { getTeamPermissionOverrides, roleHas } from '@/lib/permissions';

/** Coerce a defaultBackend value to the enum or null (null clears the role's preference). */
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
    if (!auth || auth.type === 'denied') {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (auth.type === 'session') {
        const access = await verifyWorkspaceAccess(auth.user.id, id);
        if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    } else if (auth.type === 'api') {
        const hasAccess = await verifyAccountWorkspaceAccess(auth.account, id);
        if (!hasAccess) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    try {
        const url = new URL(req.url);
        const enabledParam = url.searchParams.get('enabled');
        const isRoleParam = url.searchParams.get('isRole');

        // Resolve team for this workspace so we can include team-level rows.
        const ws = await db.query.workspaces.findFirst({
            where: eq(workspaces.id, id),
            columns: { teamId: true },
        });

        const extraFilters: ReturnType<typeof eq>[] = [];
        if (enabledParam === 'true') extraFilters.push(eq(workspaceSkills.enabled, true));
        else if (enabledParam === 'false') extraFilters.push(eq(workspaceSkills.enabled, false));
        if (isRoleParam === 'true') extraFilters.push(eq(workspaceSkills.isRole, true));
        else if (isRoleParam === 'false') extraFilters.push(eq(workspaceSkills.isRole, false));

        // Fetch workspace-scoped AND team-level skills in one query.
        // Workspace-scoped rows (workspaceId = id) take precedence over team-level
        // rows (workspaceId IS NULL, teamId = ws.teamId) for the same slug.
        // Personal roles (ownerUserId set) are listed by GET /api/roles,
        // which filters them by owner and visibility; never here.
        const scopeClause = ws
            ? or(
                eq(workspaceSkills.workspaceId, id),
                and(isNull(workspaceSkills.workspaceId), eq(workspaceSkills.teamId, ws.teamId), isNull(workspaceSkills.ownerUserId)),
              )
            : eq(workspaceSkills.workspaceId, id);

        const allRows = await db
            .select()
            .from(workspaceSkills)
            .where(extraFilters.length > 0 ? and(scopeClause, ...extraFilters) : scopeClause)
            .orderBy(desc(workspaceSkills.createdAt));

        // Deduplicate by slug: workspace-scoped override wins over team default.
        const seenSlugs = new Map<string, typeof allRows[0]>();
        for (const row of allRows) {
            const existing = seenSlugs.get(row.slug);
            if (!existing || (row.workspaceId !== null && existing.workspaceId === null)) {
                seenSlugs.set(row.slug, row);
            }
        }
        const results = [...seenSlugs.values()];

        // Bulk-read guard (lib/body-read-monitor.ts): token callers only.
        if (auth.type === 'api') {
            const verdict = await noteBodyReads(auth.account.id, results.map(r => r.id), 'skills_list');
            if (!verdict.allowed) return bodyReadRefused();
        }

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
    if (!auth || auth.type === 'denied') {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let sessionAccess: { teamId: string; role: string } | null = null;
    if (auth.type === 'session') {
        sessionAccess = await verifyWorkspaceAccess(auth.user.id, id);
        if (!sessionAccess) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    } else if (auth.type === 'api') {
        const hasAccess = await verifyAccountWorkspaceAccess(auth.account, id);
        if (!hasAccess) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    try {
        const body = await req.json();
        const { name, description, content, source, metadata, enabled,
            model, allowedTools, canDelegateTo, background, maxTurns, color,
            mcpServers, requiredEnvVars, connectorRefs, isRole, repoUrl, accountId, defaultBackend } = body;

        // Personal roles are team-level rows owned by one member; they are
        // created and edited through /api/roles, never as workspace skills.
        if (body.personal !== undefined || body.ownerUserId !== undefined) {
            return NextResponse.json(
                { error: 'Personal roles are created with POST /api/roles { personal: true } and shared with POST /api/roles/[id]/share' },
                { status: 400 }
            );
        }

        if (!name || !content) {
            return NextResponse.json(
                { error: 'name and content are required' },
                { status: 400 }
            );
        }

        // Routing text (role-routing.md §2): validated, never truncated.
        const routing = parseRoutingPatch(body);
        if (!routing.ok) return NextResponse.json({ error: routing.error }, { status: 400 });

        // claude.ai artifact access (@buildd/shared claude-ai-artifacts.ts), kept in metadata.
        const artifactCheck = body.claudeAiArtifacts === undefined ? null : patchClaudeAiArtifactsMetadata({}, body.claudeAiArtifacts);
        if (artifactCheck && !artifactCheck.ok) return NextResponse.json({ error: artifactCheck.error }, { status: 400 });
        const withArtifactAccess = (meta: Record<string, unknown>): Record<string, unknown> => body.claudeAiArtifacts === undefined
            ? meta
            : (patchClaudeAiArtifactsMetadata(meta, body.claudeAiArtifacts) as { metadata: Record<string, unknown> }).metadata;

        const slug = body.slug || generateSlug(name);

        if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) {
            return NextResponse.json(
                { error: 'slug must be lowercase alphanumeric with hyphens (e.g., "ui-audit")' },
                { status: 400 }
            );
        }

        // `/app/settings/roles/new` is a static route, so a role with this slug could
        // never reach its own detail page. See lib/reserved-slugs.ts.
        if (isReservedRoleSlug(slug)) {
            return NextResponse.json(
                { error: `"${slug}" is reserved because /app/settings/roles/${slug} is a built-in page. Pick a different slug.` },
                { status: 400 }
            );
        }

        const contentHash = computeContentHash(content);

        // Verify workspace exists
        const workspace = await db.query.workspaces.findFirst({
            where: eq(workspaces.id, id),
            columns: { id: true, teamId: true },
        });
        if (!workspace) {
            return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
        }

        // Upsert by (workspaceId, slug)
        const existing = await db.query.workspaceSkills.findFirst({
            where: and(eq(workspaceSkills.workspaceId, id), eq(workspaceSkills.slug, slug)),
        });
        if (!(await sessionMayManageRole(sessionAccess, isRole === true || Boolean(existing?.isRole)))) {
            return NextResponse.json(ROLE_FORBIDDEN, { status: 403 });
        }

        if (existing) {
            const [updated] = await db
                .update(workspaceSkills)
                .set({
                    name,
                    description: description || null,
                    content,
                    contentHash,
                    source: source || null,
                    // A re-register without metadata keeps the row's own (routing
                    // text, seeded version stamp) instead of wiping it.
                    metadata: withArtifactAccess(routing.patch
                        ? applyRoutingPatch(metadata ?? existing.metadata, routing.patch)
                        : (metadata ?? existing.metadata ?? {})),
                    enabled: enabled !== undefined ? enabled : existing.enabled,
                    ...(model !== undefined ? { model } : {}),
                    ...(allowedTools !== undefined ? { allowedTools } : {}),
                    ...(canDelegateTo !== undefined ? { canDelegateTo } : {}),
                    ...(background !== undefined ? { background } : {}),
                    ...(maxTurns !== undefined ? { maxTurns } : {}),
                    ...(color !== undefined ? { color } : {}),
                    ...(mcpServers !== undefined ? { mcpServers } : {}),
                    ...(requiredEnvVars !== undefined ? { requiredEnvVars } : {}),
                    ...(connectorRefs !== undefined ? { connectorRefs } : {}),
                    ...(isRole !== undefined ? { isRole } : {}),
                    ...(repoUrl !== undefined ? { repoUrl } : {}),
                    ...(accountId !== undefined ? { accountId } : {}),
                    ...(defaultBackend !== undefined ? { defaultBackend: normalizeBackend(defaultBackend) } : {}),
                    updatedAt: new Date(),
                })
                .where(eq(workspaceSkills.id, existing.id))
                .returning();

            if (updated.isRole && isStorageConfigured()) {
                const bundle = await packageRoleConfig(id, {
                    slug: updated.slug,
                    claudeMd: updated.content,
                    // MCP is injected solely at claim time from connectors (spec §3);
                    // the R2 role bundle carries no MCP server config or env mapping.
                    mcpConfig: {},
                    envMapping: {},
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
                teamId: workspace.teamId,
                workspaceId: id,
                slug,
                name,
                description: description || null,
                content,
                contentHash,
                source: source || null,
                enabled: enabled !== undefined ? enabled : true,
                origin: 'manual',
                metadata: withArtifactAccess(routing.patch ? applyRoutingPatch(metadata, routing.patch) : (metadata || {})),
                ...(model ? { model } : {}),
                ...(allowedTools ? { allowedTools } : {}),
                ...(canDelegateTo ? { canDelegateTo } : {}),
                ...(background !== undefined ? { background } : {}),
                ...(maxTurns !== undefined ? { maxTurns } : {}),
                ...(color ? { color } : {}),
                ...(mcpServers ? { mcpServers } : {}),
                ...(requiredEnvVars ? { requiredEnvVars } : {}),
                ...(connectorRefs ? { connectorRefs } : {}),
                ...(isRole !== undefined ? { isRole } : {}),
                ...(repoUrl !== undefined ? { repoUrl } : {}),
                ...(accountId ? { accountId } : {}),
                ...(defaultBackend !== undefined ? { defaultBackend: normalizeBackend(defaultBackend) } : {}),
            })
            .returning();

        if (skill.isRole && isStorageConfigured()) {
            const bundle = await packageRoleConfig(id, {
                slug: skill.slug,
                claudeMd: skill.content,
                // MCP is injected solely at claim time from connectors (spec §3);
                // the R2 role bundle carries no MCP server config or env mapping.
                mcpConfig: {},
                envMapping: {},
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
