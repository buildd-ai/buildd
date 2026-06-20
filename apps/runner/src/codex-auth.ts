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
 * Root for STABLE per-worker CODEX_HOME directories (Phase 1C / R5).
 *
 * Unlike the temp `mkdtemp` homes, a stable home is keyed by worker id and
 * survives across runs/restarts so `codex exec ... resume <thread_id>` can find
 * the rollout under `$CODEX_HOME/sessions/`. Override with CODEX_HOME_ROOT for a
 * persistent location; defaults under the OS temp dir (good enough — only torn
 * down on true terminal teardown, past the follow-up TTL).
 */
function codexHomeRoot(): string {
  return process.env.CODEX_HOME_ROOT || join(tmpdir(), 'buildd-codex-homes');
}

/** Absolute path of the stable per-worker CODEX_HOME (not created here). */
export function stableCodexHomePath(workerId: string): string {
  // Sanitize the worker id so it can never escape the root dir.
  const safe = workerId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(codexHomeRoot(), safe);
}

/**
 * Ensure a STABLE per-worker CODEX_HOME exists and (re)seed auth.json into it,
 * WITHOUT touching the `sessions/` subtree (so resumable rollouts survive a
 * re-run/restart). Idempotent: safe to call on every start.
 *
 * Returns the codexHome path so the caller can set cleanEnv.CODEX_HOME before
 * spawning the backend. The dir is created 0o700; auth.json is written 0o600.
 */
export function materializeStableCodexHome(
  workerId: string,
  credential: CodexCredential,
): { codexHome: string } {
  const codexHome = stableCodexHomePath(workerId);
  // recursive mkdir is a no-op if it already exists — sessions/ is untouched.
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  // Re-chmod in case it pre-existed with a looser mode.
  try { fs.chmodSync(codexHome, 0o700); } catch {}
  writeCodexAuthJson(codexHome, credential);
  console.log(`[Worker ${workerId}] Stable Codex home ready at ${codexHome} (sessions preserved)`);
  return { codexHome };
}

/**
 * Ensure a STABLE per-worker CODEX_HOME exists for runs that only need transient
 * Codex config (no OAuth credential — e.g. API-key auth via OPENAI_API_KEY).
 * Idempotent; preserves `sessions/`.
 */
export function ensureStableCodexHome(workerId: string): { codexHome: string } {
  const codexHome = stableCodexHomePath(workerId);
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(codexHome, 0o700); } catch {}
  return { codexHome };
}

/** (Re)write auth.json into an existing CODEX_HOME. Idempotent. */
export function writeCodexAuthJson(codexHome: string, credential: CodexCredential): void {
  const authJson = {
    access_token: credential.accessToken,
    refresh_token: credential.refreshToken,
    account_id: credential.accountId,
  };
  const authPath = join(codexHome, 'auth.json');
  fs.writeFileSync(authPath, JSON.stringify(authJson));
  fs.chmodSync(authPath, 0o600);
}

/**
 * Tear down a stable per-worker CODEX_HOME. Call ONLY when the worker is truly
 * terminal (purged past the follow-up TTL) — never on normal run cleanup, or
 * resumable sessions would be destroyed. Idempotent and non-throwing.
 */
export function teardownStableCodexHome(workerId: string): void {
  const codexHome = stableCodexHomePath(workerId);
  try {
    fs.rmSync(codexHome, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[Worker ${workerId}] Failed to tear down stable Codex home:`, err);
  }
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
  // Write first (no mode option — avoids a Bun 1.3.x bug where writeFileSync
  // with { mode } silently fails to create the file), then chmod explicitly.
  writeCodexAuthJson(codexHome, credential);
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
    // Headless `codex exec` runs with approval policy "never", which AUTO-CANCELS
    // every MCP tool call ("user cancelled MCP tool call") because there is no TTY
    // to grant approval. The Codex SDK exposes no approval flag, so the only lever
    // is this per-server setting in config.toml. "approve" auto-grants tool calls
    // for the buildd server only — scoped, so we don't loosen approvals globally.
    // Key verified against codex-cli 0.140 (`--strict-config` accepts it).
    'default_tools_approval_mode = "approve"',
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
