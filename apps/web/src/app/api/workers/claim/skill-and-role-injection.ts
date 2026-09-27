/**
 * Skill and role injection — resolves the skill bundles a task asked for and
 * the role config its agent runs under, and attaches both to the claim
 * response.
 *
 * Both resolutions share the `workspace_skills` table: a skill is a row, a role
 * is a row with `isRole: true`.
 */
import { db } from '@buildd/core/db';
import { workspaceSkills } from '@buildd/core/db/schema';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { ClaimTasksResponse, SkillBundle } from '@buildd/shared';
import { generateDownloadUrl, isStorageConfigured } from '@/lib/storage';

/** The claim-candidate rows these blocks look tasks up in. */
type ClaimedTask = { id: string; workspaceId: string };

/**
 * Map a `workspace_skills` row to the wire shape the runner consumes.
 *
 * Shared by the workspace-level lookup and the account-level fallback below,
 * which carried byte-identical copies of this mapping.
 */
function toSkillBundle(ws: typeof workspaceSkills.$inferSelect): SkillBundle {
  const meta = ws.metadata as { referenceFiles?: Record<string, string> } | null;
  return {
    slug: ws.slug,
    name: ws.name,
    description: ws.description || undefined,
    content: ws.content,
    ...(meta?.referenceFiles ? { referenceFiles: meta.referenceFiles } : {}),
    model: (ws.model ?? 'inherit') as string,
    allowedTools: (ws.allowedTools as string[]) || [],
    canDelegateTo: (ws.canDelegateTo as string[]) || [],
    background: ws.background ?? false,
    maxTurns: ws.maxTurns ?? null,
    mcpServers: (ws.mcpServers as string[]) || [],
    requiredEnvVars: (ws.requiredEnvVars as Record<string, string>) || {},
  };
}

/**
 * Resolve the skill bundles named by `task.context.skillSlugs`.
 *
 * Workspace-level rows win; slugs still missing after that fall back to
 * account-level rows. Disabled rows are never returned.
 */
export async function attachSkillBundles(
  claimedWorkers: ClaimTasksResponse['workers'],
  claimedTasks: readonly ClaimedTask[],
  accountId: string,
): Promise<void> {
  for (const cw of claimedWorkers) {
    const ctx = (cw.task as any)?.context as { skillSlugs?: string[] } | undefined;
    if (!ctx?.skillSlugs || ctx.skillSlugs.length === 0) continue;

    const taskObj = claimedTasks.find(t => t.id === cw.taskId);
    const wsId = taskObj?.workspaceId;
    if (!wsId) continue;

    const slugs = ctx.skillSlugs;
    const bundles: SkillBundle[] = [];

    // Look up workspace-level skills (enabled only)
    const wsSkills = await db.query.workspaceSkills.findMany({
      where: and(
        eq(workspaceSkills.workspaceId, wsId),
        inArray(workspaceSkills.slug, slugs),
        eq(workspaceSkills.enabled, true),
      ),
    });

    const foundSlugs = new Set<string>();
    for (const ws of wsSkills) {
      foundSlugs.add(ws.slug);
      bundles.push(toSkillBundle(ws));
    }

    // Fallback: account-level skills for slugs not found at workspace level
    const missingSlugs = slugs.filter(s => !foundSlugs.has(s));
    if (missingSlugs.length > 0) {
      const acctSkills = await db.query.workspaceSkills.findMany({
        where: and(
          eq(workspaceSkills.accountId, accountId),
          inArray(workspaceSkills.slug, missingSlugs),
          eq(workspaceSkills.enabled, true),
        ),
      });
      for (const ws of acctSkills) {
        bundles.push(toSkillBundle(ws));
      }
    }

    if (bundles.length > 0) {
      (cw as any).skillBundles = bundles;
    }
  }
}

/**
 * Resolve a role row by slug: workspace override > team default (§C.2
 * precedence), falling back to the legacy account-level row when no team
 * scope resolves anything. Shared by `attachRoleConfig` (persona/bundle/CBM)
 * and `attachRoleEnvSecrets` (role-env-injection.ts) so the precedence rule
 * lives in exactly one place — a second, divergent copy is how the two ends
 * up disagreeing about which role a task actually runs under.
 */
export async function resolveRoleRow(
  roleSlug: string,
  teamId: string | undefined,
  wsId: string,
  accountId: string,
): Promise<typeof workspaceSkills.$inferSelect | undefined> {
  let role;

  if (teamId) {
    const rows = await db.select()
      .from(workspaceSkills)
      .where(and(
        eq(workspaceSkills.teamId, teamId),
        eq(workspaceSkills.slug, roleSlug),
        eq(workspaceSkills.enabled, true),
        eq(workspaceSkills.isRole, true),
        or(
          isNull(workspaceSkills.workspaceId),
          eq(workspaceSkills.workspaceId, wsId),
        ),
      ))
      .orderBy(sql`(${workspaceSkills.workspaceId} IS NOT NULL) DESC`)
      .limit(1);
    role = rows[0];
  }

  // Legacy account-level fallback
  if (!role) {
    role = await db.query.workspaceSkills.findFirst({
      where: and(
        eq(workspaceSkills.accountId, accountId),
        eq(workspaceSkills.slug, roleSlug),
        eq(workspaceSkills.enabled, true),
        eq(workspaceSkills.isRole, true),
      ),
    });
  }

  return role ?? undefined;
}

/**
 * Resolve the task's role (`task.roleSlug`) and attach it to the claim.
 *
 * Precedence is workspace override > team default (§C.2), with a legacy
 * account-level fallback.
 *
 * Two things ride the response, and only one of them needs R2:
 *
 * - `roleInstructions` — the persona — is attached whenever a role row
 *   resolves. This is the agent's identity, and a role that was never packaged
 *   to object storage (every seeded default role, and every role registered
 *   through `register_skill`) still has one. It used to reach nobody.
 * - `roleConfig` — the packaged bundle (skills, .mcp.json, env mapping) — needs
 *   a presigned download URL, so it is attached only when storage is configured
 *   AND the row carries both a key and a hash.
 *
 * The CBM opt-out is likewise a property of the row, not the bundle.
 */
export async function attachRoleConfig(
  claimedWorkers: ClaimTasksResponse['workers'],
  claimedTasks: readonly ClaimedTask[],
  accountId: string,
): Promise<void> {
  const storageConfigured = isStorageConfigured();

  for (const cw of claimedWorkers) {
    const task = claimedTasks.find(t => t.id === cw.taskId);
    const roleSlug = (task as any)?.roleSlug as string | null;
    if (!roleSlug) continue;

    const wsId = task?.workspaceId;
    if (!wsId) continue;

    const teamId = (task as any).workspace?.teamId as string | undefined;
    const role = await resolveRoleRow(roleSlug, teamId, wsId, accountId);

    // Persona first — independent of packaging. A blank body attaches nothing
    // rather than an empty "## Role: X" section.
    const personaContent = role?.content?.trim();
    if (role && personaContent) {
      (cw as any).roleInstructions = {
        slug: role.slug,
        name: role.name?.trim() || role.slug,
        content: role.content,
      };
    }

    if (storageConfigured && role?.configStorageKey && role?.configHash) {
      const configUrl = await generateDownloadUrl(role.configStorageKey);
      (cw as any).roleConfig = {
        slug: role.slug,
        configHash: role.configHash,
        configUrl,
        type: role.repoUrl ? 'builder' : 'service',
        repoUrl: role.repoUrl || undefined,
        model: role.model,
        allowedTools: (role.allowedTools as string[]) || [],
        canDelegateTo: (role.canDelegateTo as string[]) || [],
        background: role.background ?? false,
        maxTurns: role.maxTurns ?? null,
      };
    }

    // CBM escape hatch: a role opts out of CBM enforcement by setting
    // mcpServers['codebase-memory'] = false in its skill record (DB).
    // Checked independently of configStorageKey so opt-out works without R2.
    const roleMcpServers = role?.mcpServers as Record<string, unknown> | null | undefined;
    if (roleMcpServers?.['codebase-memory'] === false) {
      (cw as any).cbmDisabled = true;
    }
  }
}
