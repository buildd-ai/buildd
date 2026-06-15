import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export interface CodexCredential {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  expiresAt: Date | null;
}

/**
 * Write a temporary CODEX_HOME directory containing auth.json for the given
 * credential. Returns the path to the temp dir so the caller can set
 * cleanEnv.CODEX_HOME = codexHome before spawning the backend.
 *
 * The directory and auth.json are written with mode 0o600 so only the current
 * process can read them. Call cleanupCodexAuth() in the finally block to remove
 * the temp dir after the worker exits.
 */
export function materializeCodexAuth(workerId: string, credential: CodexCredential): { codexHome: string } {
  const codexHome = mkdtempSync(join(tmpdir(), 'codex-'));
  const authJson = {
    access_token: credential.accessToken,
    refresh_token: credential.refreshToken,
    account_id: credential.accountId,
  };
  writeFileSync(join(codexHome, 'auth.json'), JSON.stringify(authJson), { mode: 0o600 });
  console.log(`[Worker ${workerId}] Materialized Codex auth.json at ${codexHome}`);
  return { codexHome };
}

/** Remove the temp CODEX_HOME directory created by materializeCodexAuth. */
export function cleanupCodexAuth(workerId: string, codexHome: string): void {
  try {
    rmSync(codexHome, { recursive: true, force: true });
    console.log(`[Worker ${workerId}] Cleaned up Codex auth temp dir`);
  } catch (err) {
    console.warn(`[Worker ${workerId}] Failed to clean up Codex auth dir:`, err);
  }
}
