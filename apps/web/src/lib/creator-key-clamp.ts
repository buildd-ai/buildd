/**
 * Keep a person's API keys inside what their current team role may mint.
 *
 * key-level-policy.ts bounds a key when it is minted. This is the other half:
 * when the person who minted it (`accounts.created_by_user_id`) is demoted,
 * removed, or leaves, their keys in that team are lowered to the most the new
 * standing may mint. Keys are clamped, never revoked, and never raised.
 *
 *   new role still holds manage_team_keys → nothing changes (no query)
 *   new role does not, or they left       → level admin → worker, and the
 *                                            admin-grant scopes are dropped
 *
 * Keys with no recorded creator (NULL) are never touched: there is no person
 * to compare against.
 *
 * One atomic UPDATE ... WHERE ... RETURNING. The WHERE matches only rows that
 * actually change, so the returned count is the number of keys clamped.
 */
import { db } from '@buildd/core/db';
import { accounts } from '@buildd/core/db/schema';
import { TOKEN_SCOPES, requiresTeamAdminToGrant } from '@buildd/core/token-scopes';
import { and, eq, or, sql } from 'drizzle-orm';
import { maxKeyLevelForRole, type ApiKeyLevel, type TeamRole } from './key-level-policy';
import type { PermissionOverrides } from './permission-registry';
import { getTeamPermissionOverrides } from './permissions';
import { invalidateAccountCacheByHash } from './api-auth';

/** Every scope only a manage_team_keys holder may put on a token. */
export const ADMIN_GRANT_SCOPES: readonly string[] = TOKEN_SCOPES.filter(requiresTeamAdminToGrant);

/**
 * The highest key level a person's keys may keep in a team. `role` null means
 * they are no longer in it: they keep what a member may mint, and team
 * overrides cannot lift that, since they no longer hold a role at all.
 */
export function keyCeilingFor(role: TeamRole | null, overrides: PermissionOverrides | null): ApiKeyLevel {
  return role === null ? 'worker' : maxKeyLevelForRole(role, overrides);
}

/** The clamp statement. Exported for the real-Postgres test of its WHERE. */
export function creatorKeyClampStatement(teamId: string, userId: string) {
  const adminGrant = JSON.stringify(ADMIN_GRANT_SCOPES);
  const hasAdminGrantScope = sql`(jsonb_typeof(${accounts.scopes}) = 'array' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(${accounts.scopes}) AS s(scope)
    WHERE s.scope IN (SELECT jsonb_array_elements_text(${adminGrant}::jsonb))))`;

  return db
    .update(accounts)
    .set({
      level: sql`CASE WHEN ${accounts.level} = 'admin' THEN 'worker' ELSE ${accounts.level} END`,
      scopes: sql`CASE WHEN jsonb_typeof(${accounts.scopes}) = 'array' THEN (
        SELECT COALESCE(jsonb_agg(to_jsonb(s.scope) ORDER BY s.ord), '[]'::jsonb)
        FROM jsonb_array_elements_text(${accounts.scopes}) WITH ORDINALITY AS s(scope, ord)
        WHERE s.scope NOT IN (SELECT jsonb_array_elements_text(${adminGrant}::jsonb))
      ) ELSE ${accounts.scopes} END`,
    })
    .where(and(
      eq(accounts.teamId, teamId),
      eq(accounts.createdByUserId, userId),
      or(eq(accounts.level, 'admin'), hasAdminGrantScope),
    ))
    .returning({ id: accounts.id, apiKey: accounts.apiKey });
}

/**
 * Clamp `userId`'s keys in `teamId` to what `role` may mint (null = they left
 * or were removed). Call it after the membership write succeeded. Returns how
 * many keys changed.
 */
export async function clampCreatorKeys(opts: {
  teamId: string;
  userId: string;
  role: TeamRole | null;
  overrides?: PermissionOverrides | null;
}): Promise<number> {
  const overrides = opts.role === null
    ? null
    : opts.overrides !== undefined ? opts.overrides : await getTeamPermissionOverrides(opts.teamId);
  if (keyCeilingFor(opts.role, overrides) === 'admin') return 0;

  const clamped = await creatorKeyClampStatement(opts.teamId, opts.userId);
  for (const row of clamped) invalidateAccountCacheByHash(row.apiKey);
  return clamped.length;
}
