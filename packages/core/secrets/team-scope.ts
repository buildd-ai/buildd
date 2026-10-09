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
import { agentKeyStorageIndex, type AgentKeyProvider } from '../providers/agent-keys';

/**
 * Purposes a row may carry a `userId` for. Everything else is team-owned only.
 *
 * `pushover_personal` is one person's Pushover user key, where their away-alerts
 * go (apps/web/src/lib/personal-pushover.ts). It is a separate purpose from the
 * team's `pushover` channel on purpose: team reads of `pushover` stay
 * unambiguous, and a personal alert can never resolve to the team key
 * (knowledge-base: buildd/design/subscriptions-and-notifications.md, decision 1).
 */
export const PERSONAL_SECRET_PURPOSES = ['inference_key', 'pushover_personal'] as const;
export type PersonalSecretPurpose = (typeof PERSONAL_SECRET_PURPOSES)[number];

export function isPersonalSecretPurpose(purpose: string): purpose is PersonalSecretPurpose {
  return (PERSONAL_SECRET_PURPOSES as readonly string[]).includes(purpose);
}

/** Purposes that are never personal, so a team read of them is always well-defined. */
export type TeamCredentialPurpose = Exclude<SecretPurpose, PersonalSecretPurpose>;

/**
 * Purposes a team read may name: the never-personal ones, plus `inference_key`,
 * the canonical storage of a team's model API key. A personal `inference_key`
 * shares the purpose (and label) with the team's, which is why it is not a
 * `TeamCredentialPurpose`; through this helper the read is still only the
 * team's row, because `user_id IS NULL` is pinned below whatever is asked for.
 */
export type TeamReadablePurpose = TeamCredentialPurpose | 'inference_key';

export interface TeamCredentialFilter {
  purpose: TeamReadablePurpose | readonly TeamReadablePurpose[];
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

/** The scope a credential is being resolved for: a task in workspace W claimed by account A. */
export interface CredentialScopeTarget {
  accountId?: string | null;
  workspaceId?: string | null;
}

/** The columns precedence needs. Any missing one reads as NULL. */
export interface ScopedCredentialRow {
  accountId?: string | null;
  workspaceId?: string | null;
  userId?: string | null;
  healthStatus?: string | null;
  updatedAt?: Date | null;
}

/**
 * Specificity of a row for a target, per docs/credentials-architecture.md
 * ("most specific wins"): a workspace match outranks an account match, which
 * outranks a team-wide row. Returns -1 for a row that does not apply at all: a
 * personal row (`userId` set), or one scoped to another workspace or account.
 */
export function credentialScopeRank(row: ScopedCredentialRow, target: CredentialScopeTarget): number {
  if (row.userId) return -1;
  if (row.workspaceId && row.workspaceId !== target.workspaceId) return -1;
  if (row.accountId && row.accountId !== target.accountId) return -1;
  return (row.workspaceId ? 2 : 0) + (row.accountId ? 1 : 0);
}

/**
 * The one precedence pick for single-valued agent credentials: drop rows that
 * do not apply, then prefer a live row over a revoked one (a revoked leftover
 * must never shadow a working credential, whatever its scope), then the most
 * specific scope, then the most recently updated. A revoked row is still
 * returned when it is the only candidate.
 *
 * Callers still filter in SQL with `teamCredentialWhere`; this re-check of
 * `userId` and scope is defense in depth for the pick itself.
 */
export function pickMostSpecificCredential<T extends ScopedCredentialRow>(
  rows: readonly T[],
  target: CredentialScopeTarget,
): T | undefined {
  const revoked = (r: T) => (r.healthStatus === 'revoked' ? 1 : 0);
  return rows
    .map(r => ({ r, rank: credentialScopeRank(r, target) }))
    .filter(x => x.rank >= 0)
    .sort((a, b) =>
      revoked(a.r) - revoked(b.r) ||
      b.rank - a.rank ||
      (b.r.updatedAt?.getTime() ?? 0) - (a.r.updatedAt?.getTime() ?? 0))[0]?.r;
}

/** The columns the agent-key pick needs on top of precedence's. */
export interface AgentKeyCandidateRow extends ScopedCredentialRow {
  purpose: string;
  label?: string | null;
}

/**
 * The team's API key for an agent backend (`../providers/agent-keys`): rows
 * that are not this provider's key are dropped, then `pickMostSpecificCredential`'s
 * order (live over revoked, most specific scope, newest) with one step before
 * recency: within a scope, canonical storage over a legacy alias. A team that
 * has only legacy rows gets exactly the row `pickMostSpecificCredential` picks.
 */
export function pickTeamAgentApiKey<T extends AgentKeyCandidateRow>(
  rows: readonly T[],
  target: CredentialScopeTarget,
  provider: AgentKeyProvider,
): T | undefined {
  const revoked = (r: T) => (r.healthStatus === 'revoked' ? 1 : 0);
  return rows
    .map(r => ({ r, rank: credentialScopeRank(r, target), storage: agentKeyStorageIndex(r, provider) }))
    .filter(x => x.rank >= 0 && x.storage >= 0)
    .sort((a, b) =>
      revoked(a.r) - revoked(b.r) ||
      b.rank - a.rank ||
      a.storage - b.storage ||
      (b.r.updatedAt?.getTime() ?? 0) - (a.r.updatedAt?.getTime() ?? 0))[0]?.r;
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
