import { Redis } from '@upstash/redis';

// Upstash Redis client (from Vercel KV)
export const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

// Cache open workspace IDs for 5 minutes
const CACHE_KEY = 'buildd:open_workspaces';
const CACHE_TTL = 5 * 60; // 5 minutes in seconds

export async function getCachedOpenWorkspaceIds(): Promise<string[] | null> {
  try {
    return await redis.get<string[]>(CACHE_KEY);
  } catch {
    return null; // Redis failure shouldn't break the app
  }
}

export async function setCachedOpenWorkspaceIds(ids: string[]): Promise<void> {
  try {
    await redis.setex(CACHE_KEY, CACHE_TTL, ids);
  } catch {
    // Redis failure is non-fatal
  }
}

export async function invalidateOpenWorkspacesCache(): Promise<void> {
  try {
    await redis.del(CACHE_KEY);
  } catch {
    // Ignore errors
  }
}
