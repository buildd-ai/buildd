/**
 * Decrypt tenant-encrypted secrets from Dispatch.
 * Local copy of packages/core/tenant-crypto.ts — avoids cross-package dependency
 * that causes Bun test runner to hang (neon-serverless side effects).
 */
import { createDecipheriv } from 'crypto';

const ALGORITHM = 'aes-256-gcm';

export interface EncryptedSecret {
  encryptedValue: string;
  iv: string;
  authTag: string;
}

export interface TenantContext {
  tenantId: string;
  displayName?: string;
  encryptedOauthToken?: EncryptedSecret;
  dispatchUrl?: string;
}

function getMasterKey(): Buffer {
  const hex = process.env.TENANT_MASTER_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'TENANT_MASTER_KEY must be a 64-char hex string (32 bytes). ' +
        'Generate with: openssl rand -hex 32',
    );
  }
  return Buffer.from(hex, 'hex');
}

export function decryptTenantSecret(secret: EncryptedSecret): string {
  const key = getMasterKey();
  const iv = Buffer.from(secret.iv, 'hex');
  const authTag = Buffer.from(secret.authTag, 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(secret.encryptedValue, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Extract and validate tenant context from a task's context field.
 * Returns null if no tenant context is present.
 */
export function extractTenantContext(
  taskContext: Record<string, unknown> | null | undefined,
): TenantContext | null {
  if (!taskContext) return null;

  const tc = taskContext.tenantContext as TenantContext | undefined;
  if (!tc || !tc.tenantId) return null;

  return tc;
}
