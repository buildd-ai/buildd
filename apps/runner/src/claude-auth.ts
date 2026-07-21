import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { isolatedClaudeConfigDirPath as _isolatedClaudeConfigDirPath } from './isolation-paths.js';

export { isolatedClaudeConfigDirPath } from './isolation-paths.js';

/**
 * Materialize a per-worker CLAUDE_CONFIG_DIR containing a `.credentials.json`
 * with ONLY the access_token (no refresh_token).
 *
 * The Claude Code SDK reads `${CLAUDE_CONFIG_DIR}/.credentials.json` for the
 * session's credential. By omitting refresh_token, the SDK cannot call the
 * Anthropic token refresh endpoint — eliminating the token family revocation
 * cascade that occurs when multiple workers rotate concurrently.
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

  const credentials = {
    type: 'oauth_token',
    access_token: accessToken,
    // expires_at: epoch seconds (the SDK reads this)
    ...(expiresAt != null ? { expires_at: Math.floor(expiresAt.getTime() / 1000) } : {}),
    // Deliberately no refresh_token — workers must not rotate tokens.
  };

  const credPath = join(claudeConfigDir, '.credentials.json');
  fs.writeFileSync(credPath, JSON.stringify(credentials));
  fs.chmodSync(credPath, 0o600);

  console.log(`[Worker ${workerId}] Materialized Claude config dir at ${claudeConfigDir} (access-only, no refresh_token)`);
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
