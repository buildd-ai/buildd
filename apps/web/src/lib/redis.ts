import { Redis } from '@upstash/redis';

// Cache open workspace IDs for 5 minutes
const CACHE_KEY = 'buildd:open_workspaces';
const CACHE_TTL = 5 * 60; // 5 minutes in seconds

// Upstash Redis client (optional - gracefully degrades if not configured)
let redis: Redis | null = null;

// Only initialize if env vars are set
if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
  redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
  console.log('[Redis] Connected to Upstash');
} else {
  console.log('[Redis] Not configured - caching disabled (will query DB each time)');
}

export async function getCachedOpenWorkspaceIds(): Promise<string[] | null> {
  if (!redis) return null; // No Redis = no cache

  try {
    return await redis.get<string[]>(CACHE_KEY);
  } catch {
    return null; // Redis failure shouldn't break the app
  }
}

export async function setCachedOpenWorkspaceIds(ids: string[]): Promise<void> {
  if (!redis) return; // No-op if Redis not configured

  try {
    await redis.setex(CACHE_KEY, CACHE_TTL, ids);
  } catch {
    // Redis failure is non-fatal
  }
}

export async function invalidateOpenWorkspacesCache(): Promise<void> {
  if (!redis) return; // No-op if Redis not configured

  try {
    await redis.del(CACHE_KEY);
  } catch {
    // Ignore errors
  }
}
