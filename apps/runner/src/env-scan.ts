import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir, platform, arch, hostname } from 'os';
import type { WorkerEnvironment, WorkerTool } from '@buildd/shared';
import { CAPABILITY_BROWSER } from '@buildd/shared';

export type { McpServerInfo } from './mcp-json';
import { extractVarReferences, parseMcpJsonContent, type McpServerInfo } from './mcp-json';

export interface ScanConfig {
  extraEnvKeys?: string[];
  extraTools?: Array<{ name: string; cmd: string }>;
  /** Repo root paths to scan for .mcp.json files */
  repoRoots?: string[];
}

const DEFAULT_TOOLS = [
  'node', 'bun', 'deno', 'python', 'vercel', 'aws', 'gcloud', 'docker',
  'gh', 'git', 'terraform', 'kubectl', 'psql', 'mysql', 'redis-cli',
  'fly', 'railway', 'supabase', 'wrangler', 'turso',
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
 * Self-check: does bwrap (bubblewrap) support unprivileged user namespaces on this runner?
 *
 * Returns true if bwrap is installed and can create a user namespace. Returns false
 * if bwrap is missing or if the kernel has unprivileged_userns_clone=0. The result
 * is used by the runner to force-disable Claude Code sandboxing when namespaces are
 * unavailable — preventing every Bash tool call from failing with a bwrap error.
 */
export function checkBwrapSupport(): boolean {
  // Operator escape hatch — set when the kernel/container config is known-bad
  // and the proc-file approach below is insufficient (e.g. inside a user namespace
  // where the sysctl is not propagated correctly).
  if (process.env.BUILDD_DISABLE_SANDBOX === '1') return false;

  // Fast-path: read the kernel sysctl directly. If it's "0", user namespace
  // creation is disabled and every --unshare-user bwrap invocation will fail.
  if (process.platform === 'linux') {
    try {
      const val = readFileSync('/proc/sys/kernel/unprivileged_userns_clone', 'utf8').trim();
      if (val === '0') return false;
    } catch { /* sysctl not present on all kernel configs — fall through */ }
  }

  try {
    execSync('which bwrap', { timeout: 2000, stdio: 'pipe' });
  } catch {
    return false; // not installed — sandbox won't be attempted
  }
  try {
    // Must mirror all three namespace types Claude Code's sandbox uses internally:
    // --unshare-user (user namespace), --unshare-pid (PID namespace),
    // --unshare-net (network namespace). Testing only --unshare-user is insufficient:
    // some container configs (seccomp, AppArmor) allow user namespace creation but
    // block network or PID namespace creation, causing every Bash tool call to fail
    // with "No permissions to create a new namespace" even when the user-ns check
    // passes. Confirmed by inspecting the Claude Code binary: it always passes all
    // three --unshare flags to bwrap.
    execSync('bwrap --unshare-user --unshare-pid --unshare-net --uid 0 --gid 0 --ro-bind /usr /usr --proc /proc --dev /dev -- echo ok', {
      timeout: 5000,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Self-check: does headless Chromium actually launch on this runner?
 *
 * Checks system-installed Chromium binaries first (cheapest), then falls back
 * to scanning Playwright's browser cache directory for a downloaded binary.
 * This runs once at startup and determines whether the runner advertises the
 * 'browser' capability — making the flag truthful, not just image-intent.
 */
export function checkBrowserCapability(): boolean {
  // Check well-known system Chromium binary names
  const bins = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
  for (const bin of bins) {
    try {
      execSync(`which ${bin}`, { timeout: 2000, stdio: 'pipe' });
      // Verify the binary is actually functional (not just on PATH)
      const out = execSync(`${bin} --version`, { timeout: 5000, stdio: 'pipe' }).toString();
      if (/chromium|chrome/i.test(out)) return true;
    } catch { /* not found or broken, try next */ }
  }

  // Check Playwright's browser cache (populated by `playwright install chromium`)
  const cacheDir = process.env.PLAYWRIGHT_BROWSERS_PATH ||
    join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(cacheDir)) {
    try {
      // Fast binary existence check — avoids spawning a browser process
      const result = execSync(
        `find "${cacheDir}" -maxdepth 5 -name "chrome" -perm -u+x 2>/dev/null | head -1`,
        { timeout: 3000, stdio: 'pipe' },
      ).toString().trim();
      if (result.length > 0) return true;
    } catch { /* cache dir unreadable or find failed */ }
  }

  return false;
}

function probeTool(name: string, cmd?: string): WorkerTool | null {
  try {
    execSync(`which ${cmd || name}`, { timeout: 2000, stdio: 'pipe' });
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

  const envKeys = [...new Set([...scanEnvKeys(config?.extraEnvKeys), 'backend:codex'])];

  // Self-check: does headless Chromium actually launch on this runner?
  const hasBrowser = checkBrowserCapability();
  if (hasBrowser) {
    envKeys.push(CAPABILITY_BROWSER);
  } else {
    console.log('[env-scan] Headless Chromium not found — browser capability not advertised. Install via: bunx playwright install --with-deps chromium');
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
      hostname: hostname(),
    },
    scannedAt: new Date().toISOString(),
  };
}
