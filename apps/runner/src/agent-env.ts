/**
 * Base environment for a runner-spawned agent: an allowlist of the runner's
 * own env, never the whole thing (the runner holds coordination secrets).
 */
import { applyAgentPlaywrightEnv, type BrowserDetection } from './browser-capability';

export const RUNNER_ENV_PASSTHROUGH: ReadonlySet<string> = new Set([
  // Shell essentials
  'HOME', 'USER', 'LOGNAME', 'USERNAME', 'SHELL', 'PATH',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_NUMERIC', 'LC_TIME',
  'TZ', 'TERM', 'COLORTERM', 'TMPDIR', 'TEMP', 'TMP', 'XDG_RUNTIME_DIR',
  // Git identity (may also be in git config, but SDK may read env)
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  // Node / Bun runtime (needed for tools the agent runs)
  'NODE_ENV', 'NODE_PATH', 'BUN_INSTALL', 'npm_config_cache',
  // Proxy / network (needed for egress from agent tools)
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
  // Display (Linux headless — needed for Playwright/browser tools)
  'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY',
  // Where Playwright's browsers live. Images install to a system path because
  // a home volume hides ~/.cache; without this the agent's Playwright looks
  // there and fails even though the runner advertised `browser`.
  'PLAYWRIGHT_BROWSERS_PATH',
  // GitHub CLI (non-secret — identifies endpoint only)
  'GH_HOST', 'GITHUB_SERVER_URL',
  // Anthropic SDK: endpoint override (not secret) + operator-configured LLM creds.
  // Operator API keys are intentionally passed through — they are the agent's own
  // LLM credentials, not runner coordination secrets. Server-managed keys (below)
  // override them when present.
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  // OpenAI key — needed for Codex tasks and any agent that calls OpenAI APIs
  'OPENAI_API_KEY',
  // GitHub token — needed for gh CLI (PRs, issues). Not a runner secret.
  'GITHUB_TOKEN', 'GH_TOKEN',
  // Claude Code: no telemetry, error reporting or auto-update calls. Set by the
  // --once container image (apps/runner/Dockerfile.once), where every outbound
  // call goes through an egress proxy. Not secret.
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
]);

/**
 * Allowlisted copy of `source`, plus PLAYWRIGHT_BROWSERS_PATH pointed at the
 * Playwright dir whose build passed the runner's launch probe when the runner
 * itself has none set — so what the runner advertises is what the agent finds.
 */
export function buildAgentBaseEnv(
  source: Record<string, string | undefined> = process.env,
  browser?: BrowserDetection,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of RUNNER_ENV_PASSTHROUGH) {
    const val = source[key];
    if (val !== undefined) env[key] = val;
  }
  return browser === undefined ? applyAgentPlaywrightEnv(env) : applyAgentPlaywrightEnv(env, browser);
}
