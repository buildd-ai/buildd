import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir, platform, arch, hostname } from 'os';
import type { WorkerEnvironment, WorkerTool } from '@buildd/shared';

export interface ScanConfig {
  extraEnvKeys?: string[];
  extraTools?: Array<{ name: string; cmd: string }>;
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

  return {
    tools,
    envKeys: scanEnvKeys(config?.extraEnvKeys),
    mcp: scanMcpServers(),
    labels: {
      type: 'local',
      os: platform(),
      arch: arch(),
      hostname: hostname(),
    },
    scannedAt: new Date().toISOString(),
  };
}
