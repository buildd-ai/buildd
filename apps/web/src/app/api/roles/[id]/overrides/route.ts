import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { db } from '@buildd/core/db';
import { workspaceSkills } from '@buildd/core/db/schema';
import { eq, and, isNull, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, getUserWorkspaceIds, verifyWorkspaceAccess } from '@/lib/team-access';
import { packageRoleConfig, uploadRoleConfig } from '@/lib/role-config';
import { isStorageConfigured } from '@/lib/storage';
import { normalizeBackend } from '@/lib/normalize-backend';
import { isUuid } from '@/lib/uuid';
import { parseOperatorGrantInput, withOperatorGrantMetadata, type OperatorGrantConfig } from '@/lib/operator-capability';
import { AGENT_CAPABILITY_NAMES, roleMayHold } from '@/lib/permission-registry';

function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * POST /api/roles/[id]/overrides
 *
 * Create or update a workspace-specific override for a team-level role.
 * Only the fields passed in the body are overridden; everything else inherits
 * from the team default at claim time (the override row IS the complete resolved
 * config, so we copy non-overridden fields from the team default).
 *
 * Body: { workspaceId: string, allowedTools?, content?, mcpServers?, ... }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid role id: expected a UUID, got "${id}".` }, { status: 404 });
  }
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { workspaceId } = body;

    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }

    const [teamIds, wsIds] = await Promise.all([
      getUserTeamIds(user.id),
      getUserWorkspaceIds(user.id),
    ]);

    // Find the team-level role (the one being overridden)
    const teamDefault = await db.query.workspaceSkills.findFirst({
      where: and(
        eq(workspaceSkills.id, id),
        isNull(workspaceSkills.workspaceId),
        teamIds.length > 0 ? inArray(workspaceSkills.teamId, teamIds) : undefined,
      ),
    });

    if (!teamDefault) {
      return NextResponse.json(
        { error: 'Team-level role not found or not accessible' },
        { status: 404 }
      );
    }

    // Verify user has access to the target workspace
    if (!wsIds.includes(workspaceId)) {
      const hasAccess = await verifyWorkspaceAccess(user.id, workspaceId);
      if (!hasAccess) {
        return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
      }
    }

    // Agent capability grant (docs/specs/agent-capabilities.md): same rule as
    // the team-default PATCH route — only a role with a capability ceiling can
    // hold a grant at all.
    let operatorConfig: OperatorGrantConfig | null = null;
    let hasOperatorGrant = false;
    if ('operatorGrant' in body) {
      hasOperatorGrant = true;
      if (!AGENT_CAPABILITY_NAMES.some(c => roleMayHold(teamDefault.slug, c))) {
        return NextResponse.json({ error: `Role "${teamDefault.slug}" holds no agent capabilities; operatorGrant has no effect for it` }, { status: 400 });
      }
      if (body.operatorGrant !== null) {
        const parsed = parseOperatorGrantInput(body.operatorGrant);
        if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
        operatorConfig = parsed.config;
      }
    }

    // Determine which fields are overridden (explicitly passed)
    const overriddenFields: Record<string, unknown> = {};
    if (body.allowedTools !== undefined) overriddenFields.allowedTools = body.allowedTools;
    if (body.content !== undefined) {
      overriddenFields.content = body.content;
      overriddenFields.contentHash = computeContentHash(body.content);
    }
    if (body.mcpServers !== undefined) overriddenFields.mcpServers = body.mcpServers;
    if (body.requiredEnvVars !== undefined) overriddenFields.requiredEnvVars = body.requiredEnvVars;
    if (body.model !== undefined) overriddenFields.model = body.model;
    if (body.canDelegateTo !== undefined) overriddenFields.canDelegateTo = body.canDelegateTo;
    if (body.background !== undefined) overriddenFields.background = body.background;
    if (body.maxTurns !== undefined) overriddenFields.maxTurns = body.maxTurns;
    if (body.color !== undefined) overriddenFields.color = body.color;
    if (body.name !== undefined) overriddenFields.name = body.name;
    if (body.description !== undefined) overriddenFields.description = body.description;
    if (body.enabled !== undefined) overriddenFields.enabled = body.enabled;
    if (body.defaultBackend !== undefined) overriddenFields.defaultBackend = normalizeBackend(body.defaultBackend);

    // Check for existing override
    const existing = await db.query.workspaceSkills.findFirst({
      where: and(
        eq(workspaceSkills.teamId, teamDefault.teamId),
        eq(workspaceSkills.slug, teamDefault.slug),
        eq(workspaceSkills.workspaceId, workspaceId),
      ),
    });

    let result;
    if (existing) {
      // Update existing override
      if (hasOperatorGrant) overriddenFields.metadata = withOperatorGrantMetadata(existing.metadata, operatorConfig);
      const [updated] = await db
        .update(workspaceSkills)
        .set({ ...overriddenFields, updatedAt: new Date() })
        .where(eq(workspaceSkills.id, existing.id))
        .returning();
      result = updated;

      if (result.isRole && isStorageConfigured()) {
        const bundle = await packageRoleConfig(workspaceId, {
          slug: result.slug,
          claudeMd: result.content,
          // MCP is injected solely at claim time from connectors (spec §3); the
          // R2 role bundle carries no MCP server config or env mapping.
          mcpConfig: {},
          envMapping: {},
          skillSlugs: [],
          type: result.repoUrl ? 'builder' : 'service',
          repoUrl: result.repoUrl,
        });
        const { configHash, configStorageKey } = await uploadRoleConfig(bundle);
        await db.update(workspaceSkills)
          .set({ configHash, configStorageKey })
          .where(eq(workspaceSkills.id, result.id));
        result.configHash = configHash;
        result.configStorageKey = configStorageKey;
      }

      return NextResponse.json({ skill: result });
    }

    // Create new workspace override, inheriting all non-overridden fields from
    // team default — except the operator grant, which is never inherited: it
    // is the workspace's own opt-in, not a copy of the team's ceiling config.
    if (hasOperatorGrant) overriddenFields.metadata = withOperatorGrantMetadata({}, operatorConfig);
    const [inserted] = await db
      .insert(workspaceSkills)
      .values({
        teamId: teamDefault.teamId,
        workspaceId,
        slug: teamDefault.slug,
        name: teamDefault.name,
        description: teamDefault.description,
        content: teamDefault.content,
        contentHash: teamDefault.contentHash,
        source: 'manual',
        origin: 'manual',
        enabled: true,
        isRole: teamDefault.isRole,
        model: teamDefault.model,
        allowedTools: teamDefault.allowedTools,
        canDelegateTo: teamDefault.canDelegateTo,
        background: teamDefault.background,
        maxTurns: teamDefault.maxTurns,
        color: teamDefault.color,
        mcpServers: teamDefault.mcpServers as Record<string, unknown>,
        requiredEnvVars: teamDefault.requiredEnvVars as Record<string, string>,
        // Inherit connector opt-ins from the team default (spec §2); otherwise a new
        // workspace override would start with empty connectorRefs and silently lose
        // the team role's mounted connectors at claim time.
        connectorRefs: (teamDefault.connectorRefs as string[] | null) ?? [],
        repoUrl: teamDefault.repoUrl,
        defaultBackend: teamDefault.defaultBackend,
        // Apply override fields on top
        ...overriddenFields,
      })
      .returning();
    result = inserted;

    if (result.isRole && isStorageConfigured()) {
      const bundle = await packageRoleConfig(workspaceId, {
        slug: result.slug,
        claudeMd: result.content,
        // MCP is injected solely at claim time from connectors (spec §3); the
        // R2 role bundle carries no MCP server config or env mapping.
        mcpConfig: {},
        envMapping: {},
        skillSlugs: [],
        type: result.repoUrl ? 'builder' : 'service',
        repoUrl: result.repoUrl,
      });
      const { configHash, configStorageKey } = await uploadRoleConfig(bundle);
      await db.update(workspaceSkills)
        .set({ configHash, configStorageKey })
        .where(eq(workspaceSkills.id, result.id));
      result.configHash = configHash;
      result.configStorageKey = configStorageKey;
    }

    return NextResponse.json({ skill: result }, { status: 201 });
  } catch (error) {
    console.error('POST /api/roles/[id]/overrides error:', error);
    return NextResponse.json({ error: 'Failed to create override' }, { status: 500 });
  }
}
