/**
 * Credential health state machine.
 *
 * Called from two paths:
 *   1. Worker PATCH route (status=failed + auth error) → recordAuthFailure
 *   2. Worker PATCH route (status=completed)           → recordAuthSuccess
 *   3. Cron / verify endpoint                          → recordAuthSuccess / recordAuthFailure
 *
 * Health transitions:
 *   unknown/healthy → degraded  : first auth failure (severity=degraded)
 *   unknown/healthy → revoked   : first revocation-class failure (severity=revoked)
 *   degraded        → revoked   : ≥3 consecutive failures OR revocation-class
 *   any             → healthy   : successful use/verification
 */

import { db } from '@buildd/core/db';
import { secrets } from '@buildd/core/db/schema';
import { and, eq, or, isNull } from 'drizzle-orm';
import { classifyAuthErrorSeverity } from '@buildd/core/auth-error-classifier';
import { CLAUDE_CREDENTIAL_PURPOSES, claudeCredentialRank } from './claude-credential-rows';
import { teamCredentialWhere } from '@buildd/core/secrets/team-scope';

export type { CredentialHealthStatus } from '@buildd/core/secrets';

export const CONSECUTIVE_FAILURE_REVOKE_THRESHOLD = 3;

export interface RecordFailureResult {
  /** New health status after this failure. */
  newStatus: 'degraded' | 'revoked';
  /** True when this failure caused a healthy/unknown → revoked transition. */
  becameRevoked: boolean;
  /** The secret ID that was updated (undefined if no matching credential found). */
  secretId: string | undefined;
}

/**
 * Record an auth failure against a specific credential row.
 * Transitions: unknown/healthy → degraded/revoked, degraded → revoked after threshold.
 */
export async function recordCredentialAuthFailure(
  secretId: string,
  errorMessage: string,
): Promise<RecordFailureResult | null> {
  const severity = classifyAuthErrorSeverity(errorMessage);
  if (severity === 'none') return null;

  const row = await db.query.secrets.findFirst({
    where: eq(secrets.id, secretId),
    columns: {
      healthStatus: true,
      consecutiveAuthFailures: true,
    },
  });

  if (!row) return null;

  const newCount = row.consecutiveAuthFailures + 1;
  const isRevoked = severity === 'revoked' || newCount >= CONSECUTIVE_FAILURE_REVOKE_THRESHOLD;
  const newStatus: 'degraded' | 'revoked' = isRevoked ? 'revoked' : 'degraded';
  const wasHealthy = row.healthStatus === 'healthy' || row.healthStatus === 'unknown';
  const becameRevoked = newStatus === 'revoked' && (wasHealthy || row.healthStatus === 'degraded');

  await db
    .update(secrets)
    .set({
      healthStatus: newStatus,
      lastFailureAt: new Date(),
      lastFailureMessage: errorMessage.slice(0, 500),
      consecutiveAuthFailures: newCount,
      updatedAt: new Date(),
    })
    .where(eq(secrets.id, secretId));

  return { newStatus, becameRevoked, secretId };
}

/**
 * Find the active Claude credential for a team, optionally scoped to a
 * workspace: a seat token (oauth_token) first, else the team's Anthropic API
 * key in either storage agent runs read, canonical (`inference_key` + label
 * `anthropic`) before the legacy `anthropic_api_key`. Team rows only (a
 * personal key is never named). Returns the secretId or null.
 */
export async function getActiveClaudeSecretId(
  teamId: string,
  workspaceId?: string | null,
): Promise<string | null> {
  const scopeFilter = workspaceId
    ? or(isNull(secrets.workspaceId), eq(secrets.workspaceId, workspaceId))
    : isNull(secrets.workspaceId);

  const rows = await db.query.secrets.findMany({
    where: teamCredentialWhere({ teamId, purpose: [...CLAUDE_CREDENTIAL_PURPOSES] }, scopeFilter),
    columns: { id: true, purpose: true, label: true, userId: true },
  });
  // Seat token first (more likely to be the active cred), then canonical, then legacy.
  const best = rows
    .map((r) => ({ r, rank: claudeCredentialRank(r) }))
    .filter((x) => x.rank >= 0)
    .sort((a, b) => a.rank - b.rank)[0]?.r;
  return best?.id ?? null;
}

/**
 * Record a successful auth/verify for a credential.
 * Resets health state to healthy and clears consecutive failure counter.
 */
export async function recordCredentialAuthSuccess(secretId: string): Promise<void> {
  await db
    .update(secrets)
    .set({
      healthStatus: 'healthy',
      consecutiveAuthFailures: 0,
      lastSuccessAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(secrets.id, secretId));
}
