/**
 * Server-side loader for an agent role's effective grant in one workspace
 * (rules: `operator-capability.ts`). Reads the role's team default row and
 * the workspace's override row: the same two rows effective-roles.ts picks
 * between, except both are passed on, because the team row is a ceiling.
 *
 * `import * as schema` so a route test that mocks the schema without
 * `workspaceSkills` still links (see permissions.ts).
 */
import { db } from '@buildd/core/db';
import * as schema from '@buildd/core/db/schema';
import { and, eq, isNull, or } from 'drizzle-orm';
import { resolveOperatorGrant, type OperatorGrant } from './operator-capability';
import { roleMayHold, AGENT_CAPABILITY_NAMES } from './permission-registry';

/**
 * The effective grant of `roleSlug` in `workspaceId`. Deny-shaped (enabled
 * false, nothing granted) for an unknown workspace, a role with no capability
 * ceiling, or a failed read; never throws, so a caller can authorize on it
 * directly.
 */
export async function loadOperatorGrant(workspaceId: string, roleSlug: string): Promise<OperatorGrant> {
  const denied = resolveOperatorGrant({ roleSlug, workspaceId });
  // No read for a role that can hold nothing: builder & co. never touch the db here.
  if (!AGENT_CAPABILITY_NAMES.some(c => roleMayHold(roleSlug, c))) return denied;
  try {
    const ws = await db.query.workspaces.findFirst({
      where: eq(schema.workspaces.id, workspaceId),
      columns: { teamId: true },
    });
    if (!ws?.teamId) return denied;
    const rows = await db.query.workspaceSkills.findMany({
      where: and(
        eq(schema.workspaceSkills.teamId, ws.teamId),
        eq(schema.workspaceSkills.slug, roleSlug),
        eq(schema.workspaceSkills.isRole, true),
        or(isNull(schema.workspaceSkills.workspaceId), eq(schema.workspaceSkills.workspaceId, workspaceId)),
      ),
      columns: { workspaceId: true, enabled: true, metadata: true },
    });
    return resolveOperatorGrant({
      roleSlug,
      workspaceId,
      teamRow: rows.find(r => r.workspaceId === null) ?? null,
      workspaceRow: rows.find(r => r.workspaceId === workspaceId) ?? null,
    });
  } catch (err) {
    console.warn(`[operator-capability] grant read failed for role "${roleSlug}" in workspace ${workspaceId}; denying:`, err instanceof Error ? err.message : err);
    return denied;
  }
}
