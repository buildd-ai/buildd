import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { stableCodexHomeIsolatedPath as _stableCodexHomeIsolatedPath } from './isolation-paths.js';

export { stableCodexHomeIsolatedPath } from './isolation-paths.js';

export interface CodexCredential {
  credentialType: 'oauth' | 'api_key';
  // OAuth fields (present when credentialType === 'oauth')
  accessToken?: string;
  refreshToken?: string;
  accountId?: string;
  // id_token is REQUIRED by codex-cli 0.144's auth.json parser — without it the CLI
  // errors "missing field `id_token`" (verified live). It also carries the account
  // claim the CLI uses for the `chatgpt-account-id` backend header.
  idToken?: string;
  // API key (present when credentialType === 'api_key')
  apiKey?: string;
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
export function ensureStableCodexHome(workerId: string, explicitPath?: string): { codexHome: string } {
  const codexHome = explicitPath ?? stableCodexHomePath(workerId);
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(codexHome, 0o700); } catch {}
  return { codexHome };
}

/**
 * (Re)write auth.json into an existing CODEX_HOME. Idempotent.
 *
 * OAuth credentials MUST use codex-cli's NESTED shape
 * (`{ tokens: { access_token, refresh_token, account_id, id_token }, last_refresh }`).
 * codex-cli 0.144 rejects a flat `{access_token,…}` blob's account and 401s the
 * backend (the CLI derives the `chatgpt-account-id` header from `tokens.account_id`),
 * and it hard-errors "missing field `id_token`/`refresh_token`" if either is absent.
 * Verified live against codex-cli 0.144.1. API-key creds are unaffected — resolveAuth
 * reads `api_key` and passes it to the SDK directly, bypassing auth.json parsing.
 */
export function writeCodexAuthJson(codexHome: string, credential: CodexCredential): void {
  const authJson = credential.credentialType === 'api_key'
    ? { api_key: credential.apiKey }
    : {
        OPENAI_API_KEY: null,
        tokens: {
          access_token: credential.accessToken,
          refresh_token: credential.refreshToken,
          account_id: credential.accountId,
          id_token: credential.idToken,
        },
        last_refresh: new Date().toISOString(),
      };
  const authPath = join(codexHome, 'auth.json');
  fs.writeFileSync(authPath, JSON.stringify(authJson));
  fs.chmodSync(authPath, 0o600);
}

/**
 * Write an API key into a CODEX_HOME/auth.json as `{api_key: "..."}`.
 * resolveAuth in codex-backend.ts reads this field and authenticates via OPENAI_API_KEY.
 */
export function writeCodexApiKeyToHome(codexHome: string, apiKey: string): void {
  fs.mkdirSync(codexHome, { recursive: true });
  const authPath = join(codexHome, 'auth.json');
  fs.writeFileSync(authPath, JSON.stringify({ api_key: apiKey }));
  fs.chmodSync(authPath, 0o600);
}

/**
 * Seed auth.json into a stable CODEX_HOME ONLY IF it is absent. Unlike
 * materializeStableCodexHome (which always rewrites), this preserves any
 * tokens that the Codex CLI refreshed during a previous run — mirroring
 * OpenAI's "seed only if missing" CI/CD guidance. Idempotent and non-throwing.
 */
export function seedCodexAuthIfMissing(workerId: string, credential: CodexCredential, explicitPath?: string): { codexHome: string } {
  const codexHome = explicitPath ?? stableCodexHomePath(workerId);
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(codexHome, 0o700); } catch {}
  const authPath = join(codexHome, 'auth.json');
  if (!fs.existsSync(authPath)) {
    writeCodexAuthJson(codexHome, credential);
    console.log(`[Worker ${workerId}] Seeded Codex auth.json (was missing)`);
  } else {
    console.log(`[Worker ${workerId}] Codex auth.json already present — not overwriting (preserving CLI-refreshed tokens)`);
  }
  return { codexHome };
}

/**
 * Read the current auth.json from the stable per-worker CODEX_HOME.
 * Returns null when auth.json is absent or cannot be parsed.
 * Used for write-back after a session: the Codex CLI may have refreshed
 * the tokens during the run and written them back to auth.json.
 */
export function readCodexAuthJson(workerId: string): { access_token?: string; refresh_token?: string; account_id?: string; id_token?: string; expires_in?: number } | null {
  const authPath = join(stableCodexHomePath(workerId), 'auth.json');
  if (!fs.existsSync(authPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(authPath, 'utf-8')) as Record<string, unknown>;
    // Normalize: Codex CLI nests under `tokens`
    const src = (raw.tokens && typeof raw.tokens === 'object' ? raw.tokens : raw) as Record<string, unknown>;
    return {
      ...(typeof src.access_token === 'string' ? { access_token: src.access_token } : {}),
      ...(typeof src.refresh_token === 'string' ? { refresh_token: src.refresh_token } : {}),
      ...(typeof src.account_id === 'string' ? { account_id: src.account_id } : {}),
      ...(typeof src.id_token === 'string' ? { id_token: src.id_token } : {}),
      ...(typeof src.expires_in === 'number' ? { expires_in: src.expires_in } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Preflight check for an expired Codex credential. Returns a human-readable
 * error string if the credential is definitely expired, or null if it looks usable.
 *
 * "Definitely expired" means: expiresAt is set AND in the past AND the credential
 * is not an API key (API keys don't carry short-lived JWTs in the same way).
 * When expiresAt is null (no expiry metadata) we allow it through — the token may
 * still work, and the CLI will surface a real error if it doesn't.
 */
export function checkCodexCredentialExpiry(credential: Pick<CodexCredential, 'credentialType' | 'accountId' | 'expiresAt'>): string | null {
  if (credential.credentialType === 'api_key') return null;
  if (!credential.expiresAt) return null;
  if (new Date(credential.expiresAt) > new Date()) return null;
  const ts = new Date(credential.expiresAt).toISOString();
  const accountHint = credential.accountId ? ` for accountId=${credential.accountId}` : '';
  return (
    `Codex credential${accountHint} expired at ${ts}. ` +
    `Re-connect your ChatGPT account in Settings → Credentials, or configure a Codex API key instead.`
  );
}

/**
 * Tear down a stable per-worker CODEX_HOME. Call ONLY when the worker is truly
 * terminal (purged past the follow-up TTL) — never on normal run cleanup, or
 * resumable sessions would be destroyed. Idempotent and non-throwing.
 */
export function teardownStableCodexHome(workerId: string, isolationRoot?: string, workspaceId?: string): void {
  const paths: string[] = [stableCodexHomePath(workerId)];
  if (isolationRoot && workspaceId) {
    paths.push(_stableCodexHomeIsolatedPath(workspaceId, workerId, isolationRoot));
  }
  for (const codexHome of paths) {
    if (!fs.existsSync(codexHome)) continue;
    try {
      fs.rmSync(codexHome, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[Worker ${workerId}] Failed to tear down stable Codex home at ${codexHome}:`, err);
    }
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
  /**
   * Reasoning effort (Phase 3C). `ThreadOptions` has no reasoning-effort field,
   * so buildd's configuredEffort is mapped to the codex-cli top-level config key
   * `model_reasoning_effort`. buildd's `max` collapses to codex `high` (codex
   * supports minimal|low|medium|high only). When omitted, no key is emitted and
   * the model uses its default effort.
   */
  effort?: 'low' | 'medium' | 'high' | 'max';
  /**
   * Additional workspace/role HTTP MCP servers to inject alongside buildd.
   * Each entry emits a `[mcp_servers.<name>]` TOML block. The bearer token
   * must already be set in the worker's env under `bearerTokenEnvVar` — the
   * value is never written into config.toml; only the env var name is.
   */
  additionalMcpServers?: Array<{
    name: string;
    url: string;
    bearerTokenEnvVar: string;
  }>;
}

/**
 * Map buildd's effort scale to a codex `model_reasoning_effort` value.
 * Verified against codex-cli 0.140 via `codex exec --strict-config`:
 *   - `model_reasoning_effort = "high"` is accepted (CLI prints `reasoning effort: high`).
 *   - `reasoning_effort` (no `model_` prefix) is rejected as an unknown field.
 * Codex has no `max`, so buildd `max` → codex `high`.
 */
function codexReasoningEffort(effort: 'low' | 'medium' | 'high' | 'max'): 'low' | 'medium' | 'high' {
  return effort === 'max' ? 'high' : effort;
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
    // Reasoning effort (Phase 3C) MUST be a TOP-LEVEL key emitted BEFORE any
    // `[table]` header — otherwise TOML scopes it INTO the table
    // (`mcp_servers.buildd.model_reasoning_effort`), which `--strict-config`
    // rejects as an unknown field. Verified live against codex-cli 0.140.
    ...(config.effort ? [`model_reasoning_effort = ${tomlString(codexReasoningEffort(config.effort))}`, ''] : []),
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
    // Additional workspace/role MCP servers resolved from .mcp.json.
    // Same approval + network rules as buildd; bearer token is in env, not here.
    ...(config.additionalMcpServers || []).flatMap(server => [
      `[mcp_servers.${tomlBareKey(server.name)}]`,
      `url = ${tomlString(server.url)}`,
      `bearer_token_env_var = ${tomlString(server.bearerTokenEnvVar)}`,
      'enabled = true',
      'default_tools_approval_mode = "approve"',
      '',
    ]),
    // Codex's `workspace-write` sandbox DISABLES outbound network by default, which
    // makes the remote buildd HTTP MCP unreachable (no create_pr / update_progress)
    // AND blocks `git push`. Enable network access so a Codex worker can actually
    // report progress and open PRs. Key verified against codex-cli 0.140 via
    // `--strict-config` (CLI prints "network access enabled").
    '[sandbox_workspace_write]',
    'network_access = true',
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

function tomlBareKey(name: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(name)) return name;
  return JSON.stringify(name);
}
