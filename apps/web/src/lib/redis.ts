import { Redis } from '@upstash/redis';

// Cache open workspace IDs for 5 minutes
const CACHE_KEY = 'buildd:open_workspaces';
const CACHE_TTL = 5 * 60; // 5 minutes in seconds

// Upstash Redis client (optional - gracefully degrades if not configured)
let redis: Redis | null = null;

// Support both Upstash direct and Vercel KV env var names
const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

if (redisUrl && redisToken) {
  redis = new Redis({ url: redisUrl, token: redisToken });
} else {
  console.log('[Redis] Not configured - caching disabled');
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
