import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir, platform, arch, hostname } from 'os';
import type { WorkerEnvironment, WorkerTool } from '@buildd/shared';

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
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
  // Messaging
  'SLACK_TOKEN', 'SLACK_WEBHOOK_URL', 'DISCORD_TOKEN',
  // General
  'NPM_TOKEN', 'DOCKER_USERNAME',
];

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

  return {
    tools,
    envKeys: scanEnvKeys(config?.extraEnvKeys),
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
