/**
 * Team credential lookups: the one place a `secrets` row is found by purpose
 * and label on behalf of a team.
 *
 * `secrets.userId` marks a row as one person's own (today only `inference_key`,
 * resolved by packages/core/inference-keys.ts, which serves it to its owner
 * alone). A personal row can share (team, purpose, label) with the team row, so
 * a lookup that ignores `userId` can hand one person's token to a task, a
 * status page or a refresh sweep as if it were the team's. Every team read goes
 * through `teamCredentialWhere`, which pins `user_id IS NULL` as a top-level
 * conjunct that no caller-supplied condition can widen (drizzle wraps each
 * `or(...)` argument in its own parentheses).
 *
 * Guard: packages/core/__tests__/team-credential-guard.test.ts fails if a
 * raw `secrets.label` predicate (or a purpose predicate for a label-keyed
 * credential) appears outside this file and the personal-aware allowlist.
 *
 * Kept out of secrets/index.ts on purpose: many tests mock '@buildd/core/secrets'
 * with a partial stub, and a helper exported from there would vanish under them.
 */

import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { secrets } from '../db/schema';
import type { SecretPurpose } from './types';

/**
 * Purposes a row may carry a `userId` for. Everything else is team-owned only.
 *
 * `pushover_personal` is one person's Pushover user key, where their away-alerts
 * go (apps/web/src/lib/personal-pushover.ts). It is a separate purpose from the
 * team's `pushover` channel on purpose: team reads of `pushover` stay
 * unambiguous, and a personal alert can never resolve to the team key
 * (docs/design/subscriptions-and-notifications.md, decision 1).
 */
export const PERSONAL_SECRET_PURPOSES = ['inference_key', 'pushover_personal'] as const;
export type PersonalSecretPurpose = (typeof PERSONAL_SECRET_PURPOSES)[number];

export function isPersonalSecretPurpose(purpose: string): purpose is PersonalSecretPurpose {
  return (PERSONAL_SECRET_PURPOSES as readonly string[]).includes(purpose);
}

/** Purposes that are never personal, so a team read of them is always well-defined. */
export type TeamCredentialPurpose = Exclude<SecretPurpose, PersonalSecretPurpose>;

export interface TeamCredentialFilter {
  purpose: TeamCredentialPurpose | readonly TeamCredentialPurpose[];
  /** Owning team(s). Omit only for cross-team sweeps (crons). */
  teamId?: string | readonly string[];
  /** Label(s): connector id, env-var name, provider name. */
  label?: string | readonly string[];
}

function oneOrMany<T>(col: Parameters<typeof eq>[0], v: T | readonly T[]): SQL {
  return Array.isArray(v) ? inArray(col, v as T[]) : eq(col, v as T);
}

/**
 * WHERE clause for reading team-owned credential rows. Always excludes personal
 * rows (`user_id IS NULL`) as a top-level AND conjunct, so an `or(...)` in
 * `extra` cannot reach them. Parameter order is team, purpose, label, then
 * `extra`. Uses only drizzle operators that route tests already stub.
 */
export function teamCredentialWhere(filter: TeamCredentialFilter, ...extra: (SQL | undefined)[]): SQL {
  const conds: (SQL | undefined)[] = [];
  if (filter.teamId !== undefined) conds.push(oneOrMany(secrets.teamId, filter.teamId));
  conds.push(oneOrMany(secrets.purpose, filter.purpose));
  if (filter.label !== undefined) conds.push(oneOrMany(secrets.label, filter.label));
  conds.push(...extra);
  return and(isNull(secrets.userId), ...conds)!;
}

/**
 * Write-side counterpart: throws when a row would be created with a `userId`
 * for a purpose that has no personal semantics. Called by the secrets provider
 * so no route can mint a personal connector or MCP credential by accident.
 */
export function assertPersonalScopeAllowed(purpose: string | undefined, userId: string | null | undefined): void {
  if (userId && !(purpose && isPersonalSecretPurpose(purpose))) {
    throw new Error(
      `A personal (userId-scoped) secret is only supported for: ${PERSONAL_SECRET_PURPOSES.join(', ')}`,
    );
  }
}
