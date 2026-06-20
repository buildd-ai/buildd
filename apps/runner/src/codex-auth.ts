import * as fs from 'fs';
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
 * Directory is created at 0o700 (mkdtempSync guarantees this on POSIX).
 * auth.json is written then explicitly chmod'd to 0o600.
 * Call cleanupCodexAuth() in the finally block to remove the temp dir.
 */
export function materializeCodexAuth(workerId: string, credential: CodexCredential): { codexHome: string } {
  // mkdtempSync guarantees 0o700 on POSIX — no need to re-chmod the dir.
  const codexHome = fs.mkdtempSync(join(tmpdir(), 'codex-'));
  const authJson = {
    access_token: credential.accessToken,
    refresh_token: credential.refreshToken,
    account_id: credential.accountId,
  };
  const authPath = join(codexHome, 'auth.json');
  // Write first (no mode option — avoids a Bun 1.3.x bug where writeFileSync
  // with { mode } silently fails to create the file), then chmod explicitly.
  fs.writeFileSync(authPath, JSON.stringify(authJson));
  fs.chmodSync(authPath, 0o600);
  console.log(`[Worker ${workerId}] Materialized Codex auth.json at ${codexHome}`);
  return { codexHome };
}

export interface CodexMcpConfig {
  builddServer: string;
  workspaceId: string;
  workerId: string;
  bearerTokenEnvVar: string;
}

/** Create a temporary CODEX_HOME for runs that only need transient Codex config. */
export function materializeCodexHome(workerId: string): { codexHome: string } {
  const codexHome = fs.mkdtempSync(join(tmpdir(), 'codex-'));
  console.log(`[Worker ${workerId}] Materialized Codex config dir at ${codexHome}`);
  return { codexHome };
}

/** Write Buildd MCP configuration into a temp CODEX_HOME/config.toml. */
export function writeCodexMcpConfig(codexHome: string, config: CodexMcpConfig): void {
  fs.mkdirSync(codexHome, { recursive: true });
  const mcpUrl = `${config.builddServer}/api/mcp?workspace=${encodeURIComponent(config.workspaceId)}&worker=${encodeURIComponent(config.workerId)}`;
  const content = [
    '[mcp_servers.buildd]',
    `url = ${tomlString(mcpUrl)}`,
    `bearer_token_env_var = ${tomlString(config.bearerTokenEnvVar)}`,
    'enabled = true',
    '',
  ].join('\n');
  fs.writeFileSync(join(codexHome, 'config.toml'), content);
}

/** Remove the temp CODEX_HOME directory created by materializeCodexAuth. */
export function cleanupCodexAuth(workerId: string, codexHome: string): void {
  try {
    fs.rmSync(codexHome, { recursive: true, force: true });
    console.log(`[Worker ${workerId}] Cleaned up Codex auth temp dir`);
  } catch (err) {
    console.warn(`[Worker ${workerId}] Failed to clean up Codex auth dir:`, err);
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
