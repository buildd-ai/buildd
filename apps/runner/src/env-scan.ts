import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir, platform, arch, hostname } from 'os';
import type { WorkerEnvironment, WorkerTool } from '@buildd/shared';
import { CAPABILITY_BROWSER, CAPABILITY_MCP_GROUP_TOOLS, CAPABILITY_SANDBOX_MOUNT_ALLOWLIST } from '@buildd/shared';

export type { McpServerInfo } from './mcp-json';
import { extractVarReferences, parseMcpJsonContent, type McpServerInfo } from './mcp-json';
import { resolveClaudeCliVersion } from './sdk-binary-path';
import { posixShell } from './posix-shell';
import { selectedBrowserCapability, getBrowserProviderProbe } from './browser-provider';
import { localCodexAuthPath } from './host-seat';
import { CLAUDE_INNER_SANDBOX_UNSHARE, probeBwrapNamespacesDetailed } from './isolation-probe';
import { runnerHostName } from './runner-host';

export interface ScanConfig {
  extraEnvKeys?: string[];
  extraTools?: Array<{ name: string; cmd: string }>;
  /** Repo root paths to scan for .mcp.json files */
  repoRoots?: string[];
}

export const DEFAULT_TOOLS = [
  'node', 'bun', 'deno', 'python', 'vercel', 'aws', 'gcloud', 'docker',
  'gh', 'git', 'terraform', 'kubectl', 'psql', 'mysql', 'redis-cli',
  'fly', 'railway', 'supabase', 'wrangler', 'turso',
  // Structural merge driver (gitConfig.mergiraf, sibling conflict probe): the
  // runner's reported tools say whether a workspace's opt-in can take effect.
  'mergiraf',
];

const DEFAULT_ENV_KEYS = [
  // Cloud providers
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'AWS_PROFILE',
  'GOOGLE_APPLICATION_CREDENTIALS', 'GCLOUD_PROJECT',
  'AZURE_CLIENT_ID', 'AZURE_TENANT_ID',
  // Platforms
  'VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID',
  'NETLIFY_AUTH_TOKEN', 'FLY_API_TOKEN', 'RAILWAY_TOKEN', 'CLOUDFLARE_API_TOKEN',
  // Database
  'DATABASE_URL', 'POSTGRES_URL', 'MYSQL_URL', 'REDIS_URL',
  'NEON_DATABASE_URL', 'SUPABASE_URL', 'TURSO_DATABASE_URL',
  // CI/CD
  'GITHUB_TOKEN', 'GITHUB_ACTIONS', 'CI',
  'GITLAB_TOKEN', 'BITBUCKET_TOKEN',
  // AI
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_HOME',
  // Messaging
  'SLACK_TOKEN', 'SLACK_WEBHOOK_URL', 'DISCORD_TOKEN',
  // General
  'NPM_TOKEN', 'DOCKER_USERNAME',
];

/**
 * Self-check: does bwrap (bubblewrap) support the given namespaces on this runner?
 *
 * The cause, when it doesn't, is kept by probeBwrapNamespacesDetailed
 * (./isolation-probe); consumers that only gate on it read the boolean.
 */
function probeBwrapNamespaces(unshareFlags: readonly string[], loaderBinds = false): boolean {
  return probeBwrapNamespacesDetailed(unshareFlags, loaderBinds).ok;
}

/**
 * Self-check for Claude Code's INNER sandbox.
 *
 * Mirrors all three namespace types it uses internally: --unshare-user (user),
 * --unshare-pid (PID), --unshare-net (network). Testing only --unshare-user is
 * insufficient: some container configs (seccomp, AppArmor) allow user namespace
 * creation but block network or PID namespace creation, causing every Bash tool
 * call to fail with "No permissions to create a new namespace" even when the
 * user-ns check passes. Confirmed by inspecting the Claude Code binary: it always
 * passes all three --unshare flags to bwrap.
 *
 * Binds the ELF loader dirs too (loaderBinds): without them the probe reads
 * false on every merged-usr host whatever the kernel allows, which forced the
 * inner sandbox and subprocess env scrub off there.
 *
 * This is the STRICTEST of the runner's bwrap requirements. Do not reuse it for a
 * consumer that unshares less — see checkBwrapMountIsolationSupport.
 */
export function checkBwrapSupport(): boolean {
  return probeBwrapNamespaces(CLAUDE_INNER_SANDBOX_UNSHARE, true);
}

/**
 * Self-check for the OUTER mount-allowlist wrapper (buildWorkerBwrapArgv).
 *
 * That argv unshares user and pid and deliberately does NOT unshare net — the
 * agent needs egress (git push, API calls). Probing for a network namespace it
 * never creates reported the wrapper unavailable on hosts where it works, which
 * silently downgraded mount isolation to nothing. The manual acceptance probe
 * (apps/runner/src/__tests__/mount-isolation.e2e.ts) guards with exactly these
 * two namespaces, which is the requirement of record.
 */
export function checkBwrapMountIsolationSupport(): boolean {
  // The wrapper's own argv binds /bin, /lib and /lib64 (SYSTEM_RO_BINDS), so the
  // probe does too.
  return probeBwrapNamespaces(['--unshare-user', '--unshare-pid'], true);
}

/**
 * Browser capability lives in ./browser-capability (discovery + launch probe +
 * cached re-scan). Re-exported so existing importers keep working.
 */
export { checkBrowserCapability } from './browser-capability';

export function probeTool(name: string, cmd?: string): WorkerTool | null {
  try {
    // POSIX `command -v`, not `which`: `which` is absent from minimal images.
    // posixShell(): Git for Windows' sh on win32, where cmd.exe has no `command`.
    execSync(`command -v ${cmd || name}`, { timeout: 2000, stdio: 'pipe', shell: posixShell() });
  } catch {
    return null;
  }

  try {
    const output = execSync(`${cmd || name} --version`, {
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();

    const versionMatch = output.match(/(\d+\.\d+(?:\.\d+)?)/);
    return { name, version: versionMatch?.[1] };
  } catch {
    return { name };
  }
}

function scanEnvKeys(extraKeys?: string[]): string[] {
  const keysToCheck = [...DEFAULT_ENV_KEYS, ...(extraKeys || [])];
  return keysToCheck.filter(key =>
    process.env[key] !== undefined && process.env[key] !== ''
  );
}

function scanMcpServers(): string[] {
  const servers: string[] = [];
  const paths = [
    join(homedir(), '.claude', 'settings.json'),
    join(process.cwd(), '.claude', 'settings.json'),
  ];

  for (const filePath of paths) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        servers.push(...Object.keys(parsed.mcpServers));
      }
    } catch {
      // File doesn't exist or isn't valid JSON
    }
  }

  return [...new Set(servers)];
}


/** Parse a .mcp.json file and extract server names + required env vars */
export function parseMcpJson(filePath: string): McpServerInfo[] {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return parseMcpJsonContent(content);
  } catch {
    return [];
  }
}

/** Scan .mcp.json files and return rich server info with resolved status */
export function scanMcpServersRich(
  mcpJsonPaths: string[],
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): McpServerInfo[] {
  const serverMap = new Map<string, Set<string>>();

  for (const filePath of mcpJsonPaths) {
    const servers = parseMcpJson(filePath);
    for (const server of servers) {
      const existing = serverMap.get(server.name);
      if (existing) {
        for (const v of server.requiredVars) existing.add(v);
      } else {
        serverMap.set(server.name, new Set(server.requiredVars));
      }
    }
  }

  const result: McpServerInfo[] = [];
  for (const [name, vars] of serverMap) {
    const requiredVars = [...vars];
    const resolved = requiredVars.every(v => env[v] !== undefined && env[v] !== '');
    result.push({ name, requiredVars, resolved });
  }
  return result;
}

/** Pre-flight check: verify all MCP server env vars are present. Returns warnings (non-blocking). */
export function checkMcpPreFlight(
  mcpJsonPath: string,
  env: Record<string, string | undefined>,
): { missing: string[]; warnings: string[] } {
  if (!existsSync(mcpJsonPath)) {
    return { missing: [], warnings: [] };
  }

  const servers = parseMcpJson(mcpJsonPath);
  const allMissing: string[] = [];
  const warnings: string[] = [];

  for (const server of servers) {
    const missing = server.requiredVars.filter(v => !env[v] || env[v] === '');
    if (missing.length > 0) {
      allMissing.push(...missing);
      warnings.push(`MCP server "${server.name}" missing env vars: ${missing.join(', ')}`);
    }
  }

  return { missing: [...new Set(allMissing)], warnings };
}

export function scanEnvironment(config?: ScanConfig): WorkerEnvironment {
  const tools: WorkerTool[] = [];

  for (const name of DEFAULT_TOOLS) {
    const result = probeTool(name);
    if (result) tools.push(result);
  }

  if (config?.extraTools) {
    for (const { name, cmd } of config.extraTools) {
      const result = probeTool(name, cmd);
      if (result) tools.push(result);
    }
  }

  // Scan .mcp.json files from repo roots
  const mcpJsonPaths: string[] = [];
  if (config?.repoRoots) {
    for (const root of config.repoRoots) {
      const mcpPath = join(root, '.mcp.json');
      if (existsSync(mcpPath)) {
        mcpJsonPaths.push(mcpPath);
      }
    }
  }
  // Also check cwd
  const cwdMcpPath = join(process.cwd(), '.mcp.json');
  if (existsSync(cwdMcpPath) && !mcpJsonPaths.includes(cwdMcpPath)) {
    mcpJsonPaths.push(cwdMcpPath);
  }

  const mcpServers = scanMcpServersRich(mcpJsonPaths);

  // CAPABILITY_MCP_GROUP_TOOLS: this build matches buildd actions on the group
  // tools, so the MCP server may serve its worker sessions those.
  const envKeys = [...new Set([...scanEnvKeys(config?.extraEnvKeys), 'backend:codex', CAPABILITY_MCP_GROUP_TOOLS])];

  // A plain `codex login` on this machine (~/.codex/auth.json, no CODEX_HOME
  // set) is local Codex auth too: advertise it under the same key the claim
  // route already reads, so a runner with only its own login is offered Codex
  // tasks. Presence only; the file is never read here.
  if (!envKeys.includes('CODEX_HOME') && localCodexAuthPath()) {
    envKeys.push('CODEX_HOME');
  }

  // Self-check: does headless Chromium actually launch on this runner?
  // Logs one line with what was found or why not (see browser-capability.ts).
  if (selectedBrowserCapability()) {
    envKeys.push(CAPABILITY_BROWSER);
  }

  // Advertise mount isolation only when it is actually ENFORCED: the runner has
  // opted in AND the host can create the namespace the wrapper needs. This
  // capability is the only truthful signal the dashboard has for "the mount
  // allowlist is on", so an opted-in runner on a kernel that refuses the
  // namespace must not claim it.
  if (
    process.env.BUILDD_SANDBOX_MOUNT_ALLOWLIST === '1'
    && process.env.BUILDD_DISABLE_SANDBOX !== '1'
    && checkBwrapMountIsolationSupport()
  ) {
    envKeys.push(CAPABILITY_SANDBOX_MOUNT_ALLOWLIST);
  }

  return {
    tools,
    envKeys,
    mcp: scanMcpServers(),
    mcpServers,
    labels: {
      type: 'local',
      os: platform(),
      arch: arch(),
      hostname: runnerHostName(),
    },
    scannedAt: new Date().toISOString(),
    browserProvider: getBrowserProviderProbe(),
    claudeCliVersion: resolveClaudeCliVersion(),
  };
}
