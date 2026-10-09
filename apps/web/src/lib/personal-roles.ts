/**
 * Personal agent roles: a `workspaceSkills` row with `ownerUserId` set.
 *
 * - Any member holding `create_personal_roles` may create one for themselves.
 *   It is always team-level (workspaceId NULL) and starts `private`: only its
 *   owner sees it or runs it.
 * - Sharing (`visibility = 'team'`) makes it usable by the whole team. Its
 *   owner and `manage_agent_roles` holders may then edit it; nobody else.
 * - A shared personal role's slug must not clash with a team role (owner NULL)
 *   or another shared personal role in the same team.
 * - A personal role never carries an operator grant, may map env vars only to
 *   its owner's own secrets (`secrets.userId = owner`), and may mount only
 *   connectors its team can use: owned by or shared to the team (the same
 *   visibility claim-time connector injection applies —
 *   connector-capabilities-store.ts). Catalog policy (a blocked provider) is
 *   enforced at the claim boundary, as for team roles.
 *
 * Spec: docs/specs/team-permissions.md ("Personal roles").
 */
import { db } from '@buildd/core/db';
import { connectors, connectorShares, secrets, workspaceSkills } from '@buildd/core/db/schema';
import { and, eq, inArray, isNull, isNotNull, ne, or } from 'drizzle-orm';
import { can } from '@/lib/permissions';
import { getUserTeamIds } from '@/lib/team-access';

export type RoleVisibility = 'private' | 'team';

interface RoleRowLike {
  id?: string;
  teamId: string;
  ownerUserId?: string | null;
  visibility?: string | null;
}

/**
 * Env vars every runner supplies itself. Mirrors RUNNER_PROVIDED_ROLE_ENV in
 * apps/web/src/app/api/workers/claim/role-env-injection.ts (not imported, so
 * this module does not pull the claim route's dependency graph into every
 * roles route). A role may declare them without a backing secret.
 */
export const RUNNER_PROVIDED_ENV: ReadonlySet<string> = new Set(['BUILDD_API_KEY']);

export function isPersonalRole(row: RoleRowLike): boolean {
  return row.ownerUserId != null;
}

/**
 * May `userId` see this row at all? Team rows: yes (team reach is checked by
 * the caller). Personal rows: its owner always; anyone else only once shared.
 * `userId = null` (an API key) sees shared personal rows only.
 */
export function canSeeRole(row: RoleRowLike, userId: string | null): boolean {
  if (!isPersonalRole(row)) return true;
  if (userId && row.ownerUserId === userId) return true;
  return row.visibility === 'team';
}

/**
 * May this signed-in user edit, delete or re-share a personal row? Its owner,
 * or a `manage_agent_roles` holder in its team once it is shared. Another
 * member's private role is never editable (nor visible) to anyone else.
 */
export async function mayEditPersonalRole(userId: string, row: RoleRowLike): Promise<boolean> {
  if (row.ownerUserId === userId) return true;
  if (row.visibility !== 'team') return false;
  return can({ kind: 'user', userId }, 'manage_agent_roles', row.teamId);
}

export type PersonalConfigCheck = { ok: true } | { ok: false; field: string; error: string };

function refuse(field: string, error: string): PersonalConfigCheck {
  return { ok: false, field, error };
}

function isNonEmptyMcpServers(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return !!value && typeof value === 'object' && Object.keys(value as object).length > 0;
}

/**
 * Validate the parts of a create/update body that a personal role may not
 * carry. Checks only the fields present in `body`. The error names the field.
 */
export async function validatePersonalRoleConfig(
  input: { teamId: string; ownerUserId: string; body: Record<string, unknown> },
): Promise<PersonalConfigCheck> {
  const { teamId, ownerUserId, body } = input;

  if (body.operatorGrant !== undefined) {
    return refuse('operatorGrant', 'operatorGrant: a personal role cannot hold an operator grant. Promote it to a team role first.');
  }

  if (body.mcpServers !== undefined && isNonEmptyMcpServers(body.mcpServers)) {
    return refuse('mcpServers', 'mcpServers: a personal role cannot carry raw MCP server config; mount a connector with connectorRefs instead.');
  }

  if (body.requiredEnvVars !== undefined && body.requiredEnvVars !== null) {
    const map = body.requiredEnvVars;
    if (typeof map !== 'object' || Array.isArray(map)) {
      return refuse('requiredEnvVars', 'requiredEnvVars must be an object of ENV_NAME -> secret label');
    }
    const entries = Object.entries(map as Record<string, unknown>).filter(([env]) => !RUNNER_PROVIDED_ENV.has(env));
    if (entries.some(([, label]) => typeof label !== 'string' || label.length === 0)) {
      return refuse('requiredEnvVars', 'requiredEnvVars values must be secret labels');
    }
    const labels = [...new Set(entries.map(([, label]) => label as string))];
    if (labels.length > 0) {
      const own = await db.query.secrets.findMany({
        where: and(eq(secrets.teamId, teamId), eq(secrets.userId, ownerUserId), inArray(secrets.label, labels)),
        columns: { label: true },
      });
      const ownLabels = new Set(own.map(s => s.label));
      const foreign = entries.filter(([, label]) => !ownLabels.has(label as string)).map(([env]) => env);
      if (foreign.length > 0) {
        return refuse(
          'requiredEnvVars',
          `requiredEnvVars: ${foreign.join(', ')} must map to a secret you own. A personal role can only use its owner's own secrets.`,
        );
      }
    }
  }

  if (body.connectorRefs !== undefined && body.connectorRefs !== null) {
    const refs = body.connectorRefs;
    if (!Array.isArray(refs) || refs.some(r => typeof r !== 'string')) {
      return refuse('connectorRefs', 'connectorRefs must be an array of connector ids');
    }
    const ids = [...new Set(refs as string[])];
    if (ids.length > 0) {
      const shares = await db.query.connectorShares.findMany({
        where: and(eq(connectorShares.sharedWithTeamId, teamId), inArray(connectorShares.connectorId, ids)),
        columns: { connectorId: true },
      });
      const sharedIds = shares.map(s => s.connectorId);
      const rows = await db.query.connectors.findMany({
        where: and(
          inArray(connectors.id, ids),
          sharedIds.length > 0 ? or(eq(connectors.teamId, teamId), inArray(connectors.id, sharedIds)) : eq(connectors.teamId, teamId),
        ),
        columns: { id: true },
      });
      // Catalog policy (a blocked provider) is not checked here: every
      // boundary that hands a connector to an agent already asks
      // connector-access-policy.ts, and core may not import that module.
      const usable = new Set(rows.map(r => r.id));
      const unusable = ids.filter(id => !usable.has(id));
      if (unusable.length > 0) {
        return refuse(
          'connectorRefs',
          `connectorRefs: ${unusable.join(', ')} is not a connector your team can use (neither owned by nor shared to the team).`,
        );
      }
    }
  }

  return { ok: true };
}

/**
 * A row that a shared role with `slug` in `teamId` would clash with: a team
 * role (owner NULL, workspace NULL) or another shared personal role.
 */
export async function findSharedSlugClash(
  input: { teamId: string; slug: string; excludeId?: string },
) {
  const { teamId, slug, excludeId } = input;
  return db.query.workspaceSkills.findFirst({
    where: and(
      eq(workspaceSkills.teamId, teamId),
      eq(workspaceSkills.slug, slug),
      isNull(workspaceSkills.workspaceId),
      excludeId ? ne(workspaceSkills.id, excludeId) : undefined,
      or(
        isNull(workspaceSkills.ownerUserId),
        and(isNotNull(workspaceSkills.ownerUserId), eq(workspaceSkills.visibility, 'team')),
      ),
    ),
    columns: { id: true, slug: true, name: true, ownerUserId: true },
  });
}

/**
 * True when a write lost the race for a team-level slug: the database's
 * `ws_skills_team_slug_idx` holds team roles and shared personal roles in one
 * namespace, so this is the same clash `findSharedSlugClash` reports.
 */
export function isSharedSlugViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } } | null;
  const c = e?.code === '23505' ? e : e?.cause?.code === '23505' ? e.cause : null;
  if (!c) return false;
  return !c.constraint || c.constraint === 'ws_skills_team_slug_idx';
}

export function sharedSlugClashBody(clash: { id: string; slug: string; ownerUserId: string | null }) {
  const kind = clash.ownerUserId ? 'a shared personal role' : 'a team role';
  return {
    error: `The team already has ${kind} with slug "${clash.slug}". Rename this role before sharing it.`,
    conflictingRoleId: clash.id,
  };
}

/**
 * A team-level row (team role or personal role) in one of the user's teams
 * that the user may see. Another member's private role resolves to undefined.
 */
export async function findVisibleTeamLevelRole(roleId: string, userId: string) {
  const teamIds = await getUserTeamIds(userId);
  if (teamIds.length === 0) return undefined;
  const row = await db.query.workspaceSkills.findFirst({
    where: and(
      eq(workspaceSkills.id, roleId),
      isNull(workspaceSkills.workspaceId),
      inArray(workspaceSkills.teamId, teamIds),
    ),
  });
  return row && canSeeRole(row, userId) ? row : undefined;
}
