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
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { lazyRequester, pickVisibleRoleRowLazy, roleRowsInScope } from '@buildd/core/role-visibility';
import { resolveClaudeAiArtifactAccess, type ClaimTasksResponse, type SkillBundle } from '@buildd/shared';
import { generateDownloadUrl, isStorageConfigured } from '@/lib/storage';
import { noteBodyReads } from '@/lib/body-read-monitor';

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
    const bodyIds: string[] = [];
    for (const ws of wsSkills) {
      foundSlugs.add(ws.slug);
      bodyIds.push(ws.id);
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
        bodyIds.push(ws.id);
        bundles.push(toSkillBundle(ws));
      }
    }

    if (bundles.length > 0) {
      (cw as any).skillBundles = bundles;
      // Counted for the bulk-read alert; a claim is never refused for it.
      await noteBodyReads(accountId, bodyIds, 'claim_skills', { enforce: false });
    }
  }
}

type RoleRow = typeof workspaceSkills.$inferSelect;

/**
 * Every enabled role row for `roleSlug` a task in `wsId` could run under,
 * personal rows included (team-level, any owner). Not yet filtered by who the
 * task is for — `resolveRoleRow` does that — so callers can cache this per
 * (team, slug, workspace) and still pick per task.
 */
export async function loadRoleCandidateRows(roleSlug: string, teamId: string, wsId: string): Promise<RoleRow[]> {
  return db.select()
    .from(workspaceSkills)
    .where(and(
      roleRowsInScope({ teamId, workspaceId: wsId }),
      eq(workspaceSkills.slug, roleSlug),
      eq(workspaceSkills.enabled, true),
      eq(workspaceSkills.isRole, true),
    ));
}

/**
 * Resolve a role row by slug with the role-visibility precedence
 * (@buildd/core/role-visibility): workspace override > the requester's own
 * personal row > a shared personal row > team default. Another member's
 * private role is never returned. Falls back to the legacy account-level row
 * when no team scope resolves anything. Shared by `attachRoleConfig`
 * (persona/bundle) and `attachRoleEnvSecrets` (role-env-injection.ts) so the
 * precedence rule lives in exactly one place — a second, divergent copy is
 * how the two end up disagreeing about which role a task actually runs under.
 *
 * `task` supplies the requester (`lazyRequester`), resolved only when a
 * personal row for the slug exists; null = no person.
 */
export async function resolveRoleRow(
  roleSlug: string,
  teamId: string | undefined,
  wsId: string,
  accountId: string,
  task: object | null,
  candidates?: RoleRow[],
): Promise<RoleRow | undefined> {
  let role: RoleRow | null | undefined;

  if (teamId) {
    const rows = candidates ?? await loadRoleCandidateRows(roleSlug, teamId, wsId);
    role = await pickVisibleRoleRowLazy(rows, roleSlug, { teamId, workspaceId: wsId }, lazyRequester(task));
  }

  // Legacy account-level fallback (never a personal row)
  if (!role) {
    role = await db.query.workspaceSkills.findFirst({
      where: and(
        eq(workspaceSkills.accountId, accountId),
        eq(workspaceSkills.slug, roleSlug),
        eq(workspaceSkills.enabled, true),
        eq(workspaceSkills.isRole, true),
        isNull(workspaceSkills.ownerUserId),
      ),
    });
  }

  return role ?? undefined;
}

/**
 * claude.ai artifact access for this session: the role's
 * `metadata.claudeAiArtifacts` flag, overridden by the task's
 * `context.claudeAiArtifacts`. Sent only when not `off`, so an older runner
 * and a default session look the same. See @buildd/shared claude-ai-artifacts.
 */
function attachClaudeAiArtifacts(
  cw: ClaimTasksResponse['workers'][number],
  roleMetadata: Record<string, unknown> | null,
  taskContext: Record<string, unknown> | null,
): void {
  const access = resolveClaudeAiArtifactAccess({ roleMetadata, taskContext });
  if (access !== 'off') cw.claudeAiArtifacts = access;
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
 */
export async function attachRoleConfig(
  claimedWorkers: ClaimTasksResponse['workers'],
  claimedTasks: readonly ClaimedTask[],
  accountId: string,
): Promise<void> {
  const storageConfigured = isStorageConfigured();

  for (const cw of claimedWorkers) {
    const task = claimedTasks.find(t => t.id === cw.taskId);
    const taskContext = ((task as any)?.context ?? (cw as any).task?.context ?? null) as Record<string, unknown> | null;
    const roleSlug = (task as any)?.roleSlug as string | null;
    const wsId = task?.workspaceId;
    if (!roleSlug || !wsId) {
      // A task can opt in to claude.ai artifact reads with no role.
      attachClaudeAiArtifacts(cw, null, taskContext);
      continue;
    }

    const teamId = (task as any).workspace?.teamId as string | undefined;
    const role = await resolveRoleRow(roleSlug, teamId, wsId, accountId, task ?? null);
    attachClaudeAiArtifacts(cw, (role?.metadata ?? null) as Record<string, unknown> | null, taskContext);

    // Persona first — independent of packaging. A blank body attaches nothing
    // rather than an empty "## Role: X" section. An unedited seeded default
    // role is delivered as the deployment currently resolves it (prompts
    // table, then overrides, then public text), not as last written.
    const delivered = (!role
      ? ''
      : role.source === 'system' && role.content
        ? await (await import('@/lib/default-roles')).deliverSeededRoleContent(role)
        : role.content) ?? '';
    if (role && delivered.trim()) {
      (cw as any).roleInstructions = {
        slug: role.slug,
        name: role.name?.trim() || role.slug,
        content: delivered,
      };
      await noteBodyReads(accountId, [role.id], 'claim_role', { enforce: false });
    }

    if (storageConfigured && role?.configStorageKey && role?.configHash) {
      const configUrl = await generateDownloadUrl(role.configStorageKey);
      await noteBodyReads(accountId, [role.id], 'claim_role_bundle', { enforce: false });
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
  }
}
