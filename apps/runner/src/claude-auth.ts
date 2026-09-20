import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { isolatedClaudeConfigDirPath as _isolatedClaudeConfigDirPath } from './isolation-paths.js';

export { isolatedClaudeConfigDirPath } from './isolation-paths.js';

/**
 * Build the `.credentials.json` payload Claude Code expects.
 *
 * Kept separate from the filesystem write so the shape — the part that actually
 * broke — is unit-testable without touching disk.
 */
export function buildClaudeCredentialsFile(accessToken: string, expiresAt: Date | null) {
  return {
    claudeAiOauth: {
      accessToken,
      // Deliberately null — workers must not rotate tokens. Not '', which the
      // CLI reads as a dead-token tombstone.
      refreshToken: null,
      // epoch MILLISECONDS — the CLI stores Date.now() + expires_in * 1000 and
      // compares with (expiresAt - Date.now()).
      expiresAt: expiresAt != null ? expiresAt.getTime() : null,
      scopes: ['user:inference'],
      subscriptionType: null,
    },
  };
}

/**
 * Materialize a per-worker CLAUDE_CONFIG_DIR containing a `.credentials.json`
 * with ONLY the access token (no refreshToken).
 *
 * The Claude Code SDK reads `${CLAUDE_CONFIG_DIR}/.credentials.json` and looks
 * the credential up under the `claudeAiOauth` key with camelCase fields —
 * `{ accessToken, refreshToken, expiresAt, scopes, subscriptionType }`, where
 * expiresAt is epoch MILLISECONDS. There is no code path in the CLI that reads a
 * top-level snake_case `access_token` from this file. Writing the flat shape
 * produced a file the CLI silently ignored, so every worker on this path died
 * with "Not logged in · Please run /login" (verified against CLI 2.1.217: the
 * same token in the flat shape gives "Not logged in", in the nested shape it
 * reaches the API and returns 401 for a bad token).
 *
 * refreshToken is null rather than "" — the CLI treats an empty-string
 * refreshToken as a tombstone marking a revoked token family. Null matches what
 * the CLI itself synthesizes when authenticating from CLAUDE_CODE_OAUTH_TOKEN.
 * By omitting a usable refreshToken, the SDK cannot call the Anthropic token
 * refresh endpoint — eliminating the token family revocation cascade that
 * occurs when multiple workers rotate concurrently.
 *
 * The server handles all token refresh centrally (claim-gate + cron), so
 * workers only need a valid access_token to operate within their session.
 *
 * Returns the path to the temp dir so the caller can set CLAUDE_CONFIG_DIR.
 * Call cleanupClaudeConfigDir() in the finally block when the worker finishes.
 */
export function materializeClaudeConfigDir(
  workerId: string,
  accessToken: string,
  expiresAt: Date | null,
  options?: { isolationRoot?: string; workspaceId?: string },
): { claudeConfigDir: string } {
  let claudeConfigDir: string;
  if (options?.isolationRoot && options?.workspaceId) {
    // Tier 3B: place credential dir under workspace-scoped path rather than /tmp.
    claudeConfigDir = _isolatedClaudeConfigDirPath(options.workspaceId, workerId, options.isolationRoot);
    fs.mkdirSync(claudeConfigDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(claudeConfigDir, 0o700); } catch {}
  } else {
    claudeConfigDir = fs.mkdtempSync(join(tmpdir(), 'claude-cfg-'));
    fs.chmodSync(claudeConfigDir, 0o700);
  }

  const credentials = buildClaudeCredentialsFile(accessToken, expiresAt);

  const credPath = join(claudeConfigDir, '.credentials.json');
  fs.writeFileSync(credPath, JSON.stringify(credentials));
  fs.chmodSync(credPath, 0o600);

  console.log(`[Worker ${workerId}] Materialized Claude config dir at ${claudeConfigDir} (access-only, no refreshToken)`);
  return { claudeConfigDir };
}

/** Remove the per-worker CLAUDE_CONFIG_DIR created by materializeClaudeConfigDir. */
export function cleanupClaudeConfigDir(workerId: string, claudeConfigDir: string): void {
  try {
    fs.rmSync(claudeConfigDir, { recursive: true, force: true });
    console.log(`[Worker ${workerId}] Cleaned up Claude config dir`);
  } catch (err) {
    console.warn(`[Worker ${workerId}] Failed to clean up Claude config dir:`, err);
  }
}

/**
 * Refuse to resume a parked session on a claim-time token we can already see is
 * expired.
 *
 * A worker parked on a question keeps its worktree and its transcript, but NOT
 * its credential: `startSession`'s `finally` block deletes the per-worker config
 * dir and deregisters it from the broker, so nothing refreshes it while the
 * question waits. On resume the broker is asked first; when the broker has
 * nothing, the fallback is the access token delivered at CLAIM time — which for
 * a question answered hours later is stale. Spawning on it produced a session
 * that died saying it was not logged in, long after the human had answered.
 *
 * Returns the error message to throw, or null when the token is usable. A named
 * failure before the spawn is visible in error traces and failure analytics;
 * "Not logged in" hundreds of turns deep is not.
 *
 * Only guards RESUME invocations: a fresh session's claim-time token was minted
 * moments earlier by the claim gate, and hard-failing there on a clock skew
 * would break the common path to fix the rare one.
 *
 * See docs/specs/answered-question-resume.md.
 */
export function staleResumeCredentialError(opts: {
  isResume: boolean;
  /** True when the token came from the broker, i.e. it is as fresh as the runner can make it. */
  fromBroker: boolean;
  /** Expiry of the claim-delivered token, when known. */
  tokenExpiresAt: Date | null | undefined;
  now?: number;
}): string | null {
  if (!opts.isResume || opts.fromBroker) return null;
  // Unknown expiry is not evidence of staleness — do not fail closed on it.
  if (!opts.tokenExpiresAt) return null;
  if (opts.tokenExpiresAt.getTime() > (opts.now ?? Date.now())) return null;

  return 'Cannot resume this session: the agent credential delivered when the task was '
    + 'claimed has expired and the credential broker has no fresher one. Reconnect the '
    + 'account in Settings → Credentials, then answer the question again.';
}
