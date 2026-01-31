import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

// Don't throw during build - Vercel sets env vars at runtime
function required(key: string): string {
  return process.env[key] || '';
}

function optional(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

export const config = {
  port: parseInt(optional('PORT', '3001')),
  host: optional('HOST', '0.0.0.0'),
  nodeEnv: optional('NODE_ENV', 'development'),

  databaseUrl: required('DATABASE_URL'),

  anthropicApiKey: required('ANTHROPIC_API_KEY'),
  anthropicModel: optional('ANTHROPIC_MODEL', 'claude-sonnet-4-5-20250929'),
  
  storageEndpoint: optional('STORAGE_ENDPOINT', ''),
  storageRegion: optional('STORAGE_REGION', 'auto'),
  storageBucket: optional('STORAGE_BUCKET', 'buildd-artifacts'),
  storageAccessKey: optional('STORAGE_ACCESS_KEY', ''),
  storageSecretKey: optional('STORAGE_SECRET_KEY', ''),
  storagePublicUrl: optional('STORAGE_PUBLIC_URL', ''),
  
  defaultBranchPrefix: optional('DEFAULT_BRANCH_PREFIX', 'buildd/'),
  worktreeBasePath: optional('WORKTREE_BASE_PATH', '/tmp/buildd-worktrees'),
  
  maxTurns: parseInt(optional('MAX_TURNS', '100')),
  maxCostPerWorker: parseFloat(optional('MAX_COST_PER_WORKER', '10.0')),
} as const;
