/**
 * Is the backend credential healthy enough to resume a session into?
 *
 * A parked question can sit for hours. In that time the runner has already
 * deleted the worker's per-worker Claude config dir (`startSession`'s `finally`
 * block runs for a park too) and deregistered it from the credential broker, so
 * nothing refreshes it while the question waits. On resume the runner
 * re-materialises it from the broker and, failing that, from the access token
 * delivered at CLAIM time — which for a long park is stale. The result is a
 * session that dies saying it is not logged in, after the human has already
 * answered.
 *
 * So the credential is checked, and refreshed if needed, BEFORE the resume
 * decision is taken — and an unhealthy one is reported to the owner at answer
 * time rather than discovered as a death.
 *
 * Two grades of unhealthy, because the caller acts differently on them: a
 * REVOKED credential is refused outright by `/respond` (nothing written, the
 * question stays parked), while one that is merely expired-and-unrefreshable
 * degrades to a cold continuation so the answer still lands durably. See
 * `CredentialPreflightResult.revoked`.
 *
 * See docs/specs/answered-question-resume.md.
 */
import { db } from '@buildd/core/db';
import { secrets } from '@buildd/core/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { refreshClaudeCredential } from './claude-credential';
import { refreshCodexCredential } from './codex-credential';
import type { CredentialPreflightState } from './answer-resume';

/**
 * A token expiring inside this window is treated as already expired and a
 * refresh is attempted. Resuming on a token with two minutes left buys a
 * session that dies two minutes in.
 */
export const CREDENTIAL_PREFLIGHT_MARGIN_MS = 5 * 60 * 1000;

const BACKEND_PURPOSE = {
  claude: 'claude_credential',
  codex: 'codex_credential',
} as const;

export type PreflightBackend = keyof typeof BACKEND_PURPOSE;

export interface CredentialPreflightResult {
  state: CredentialPreflightState;
  /** Short owner-facing detail; present when the state is not `ok`. */
  detail?: string;
  /**
   * The credential is REVOKED, not merely expiring — the provider has rejected
   * it, so no refresh recovers it and nothing will run until a human
   * reconnects the account.
   *
   * This is a stronger statement than `state: 'unhealthy'` and the answer path
   * treats it differently: an expired-and-unrefreshable credential still lets
   * the answer land durably as a cold continuation, whereas a revoked one is
   * refused outright so the question stays parked. Refusing is the better
   * outcome for a revoked credential precisely because the continuation could
   * not run either — the claim rail already declines to inject a revoked
   * credential — and keeping the session parked preserves the transcript and
   * worktree, so the re-answer after reconnecting can still take the RESUME
   * path instead of starting cold for nothing.
   */
  revoked?: boolean;
  /** Raw provider failure text, when the row recorded one. Owner-facing. */
  lastFailureMessage?: string | null;
}

type SecretRow = {
  id: string;
  tokenExpiresAt: Date | null;
  healthStatus: 'healthy' | 'degraded' | 'revoked' | 'unknown';
  lastFailureMessage: string | null;
};

/**
 * Resolve the credential that would actually be used: a workspace-scoped row
 * overrides the team-wide one, matching the scoping precedence in
 * docs/credentials-architecture.md.
 */
async function resolveScopedSecret(
  teamId: string,
  workspaceId: string | null | undefined,
  purpose: (typeof BACKEND_PURPOSE)[PreflightBackend],
): Promise<SecretRow | null> {
  const columns = {
    id: true, tokenExpiresAt: true, healthStatus: true, lastFailureMessage: true,
  } as const;

  if (workspaceId) {
    const scoped = await db.query.secrets.findFirst({
      where: and(
        eq(secrets.teamId, teamId),
        eq(secrets.purpose, purpose),
        eq(secrets.workspaceId, workspaceId),
      ),
      columns,
    });
    if (scoped) return scoped as SecretRow;
  }

  const teamWide = await db.query.secrets.findFirst({
    where: and(
      eq(secrets.teamId, teamId),
      eq(secrets.purpose, purpose),
      isNull(secrets.workspaceId),
    ),
    columns,
  });
  return (teamWide as SecretRow | undefined) ?? null;
}

function isExpiredNow(row: SecretRow, now: number): boolean {
  return row.tokenExpiresAt != null
    && row.tokenExpiresAt.getTime() - CREDENTIAL_PREFLIGHT_MARGIN_MS <= now;
}

/**
 * Check — and, when it is expiring, refresh — the credential the resumed
 * session would authenticate with.
 *
 * Fail-safe in both directions:
 *  - An ABSENT managed credential is `unknown`, never `unhealthy`. Accounts
 *    that supply their own key have no row here, and reading absence as
 *    breakage would route every one of their answers cold forever.
 *  - Any thrown error, timeout or lock contention is `unknown` too. A
 *    transient failure of the credential service must not permanently degrade
 *    the answer path; only a credential we can positively see is dead does.
 */
export async function preflightBackendCredential(opts: {
  teamId: string | null | undefined;
  workspaceId: string | null | undefined;
  backend: PreflightBackend;
  now?: number;
}): Promise<CredentialPreflightResult> {
  const now = opts.now ?? Date.now();
  if (!opts.teamId) return { state: 'unknown' };

  const purpose = BACKEND_PURPOSE[opts.backend];

  try {
    const row = await resolveScopedSecret(opts.teamId, opts.workspaceId, purpose);
    if (!row) return { state: 'unknown' };

    // Revoked is terminal: the provider has rejected this credential, so a
    // refresh cannot recover it and attempting one only burns a round trip.
    if (row.healthStatus === 'revoked') {
      return {
        state: 'unhealthy',
        revoked: true,
        detail: `the ${opts.backend} credential for this workspace has been revoked`,
        lastFailureMessage: row.lastFailureMessage,
      };
    }

    if (!isExpiredNow(row, now)) return { state: 'ok' };

    const result = opts.backend === 'claude'
      ? await refreshClaudeCredential(row.id)
      : await refreshCodexCredential(row.id);

    if (result === 'revoked') {
      return {
        state: 'unhealthy',
        revoked: true,
        detail: `the ${opts.backend} credential was revoked while refreshing it`,
      };
    }

    // Whatever the refresh reported, the row is the truth. `locked` means a
    // concurrent refresh is in flight, and re-reading is exactly how we find
    // out whether it landed.
    const after = await resolveScopedSecret(opts.teamId, opts.workspaceId, purpose);
    if (!after) return { state: 'unknown' };
    if (after.healthStatus === 'revoked') {
      return {
        state: 'unhealthy',
        revoked: true,
        detail: `the ${opts.backend} credential was revoked while refreshing it`,
        lastFailureMessage: after.lastFailureMessage,
      };
    }
    if (isExpiredNow(after, now)) {
      return {
        state: 'unhealthy',
        detail: `the ${opts.backend} credential for this workspace is expired and could not be refreshed`,
        lastFailureMessage: after.lastFailureMessage,
      };
    }
    return { state: 'ok' };
  } catch {
    // Advisory on error — see the fail-safe note above.
    return { state: 'unknown' };
  }
}
