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

// API key cache — key: buildd:api_key:{hash}, 5-min TTL
const API_KEY_TTL = 5 * 60;

export async function getCachedApiKey<T>(hash: string): Promise<T | null> {
  if (!redis) return null;
  try {
    return await redis.get<T>(`buildd:api_key:${hash}`);
  } catch {
    return null;
  }
}

export async function setCachedApiKey<T>(hash: string, account: T, ttlSec = API_KEY_TTL): Promise<void> {
  if (!redis) return;
  try {
    await redis.setex(`buildd:api_key:${hash}`, ttlSec, account);
  } catch {
    // Redis failure is non-fatal
  }
}

export async function invalidateCachedApiKey(hash: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(`buildd:api_key:${hash}`);
  } catch {
    // Ignore errors
  }
}

// Account-workspace permissions cache — key: buildd:acct_ws:{accountId}, 5-min TTL
const ACCT_WS_TTL = 5 * 60;

export async function getCachedAccountWorkspaces<T>(accountId: string): Promise<T | null> {
  if (!redis) return null;
  try {
    return await redis.get<T>(`buildd:acct_ws:${accountId}`);
  } catch {
    return null;
  }
}

export async function setCachedAccountWorkspaces<T>(accountId: string, perms: T, ttlSec = ACCT_WS_TTL): Promise<void> {
  if (!redis) return;
  try {
    await redis.setex(`buildd:acct_ws:${accountId}`, ttlSec, perms);
  } catch {
    // Redis failure is non-fatal
  }
}

export async function invalidateCachedAccountWorkspaces(accountId: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(`buildd:acct_ws:${accountId}`);
  } catch {
    // Ignore errors
  }
}
