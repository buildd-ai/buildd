import { createHash } from 'crypto';
import { db } from '@buildd/core/db';
import { accounts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';

/**
 * SHA-256 hash of an API key (hex encoded).
 * Used to store hashed keys in the DB instead of plaintext.
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Extract the display prefix from a plaintext key (first 12 chars).
 * e.g. "bld_abc12345..." -> "bld_abc12345"
 */
export function extractApiKeyPrefix(key: string): string {
  return key.substring(0, 12);
}

/**
 * Authenticate an incoming API key by hashing it and looking up the hash.
 * Returns the account if found, null otherwise.
 */
export async function authenticateApiKey(apiKey: string | null) {
  if (!apiKey) return null;

  const hashed = hashApiKey(apiKey);
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.apiKey, hashed),
  });

  return account || null;
}
