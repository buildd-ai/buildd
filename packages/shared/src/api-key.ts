/**
 * `bld_` API key generation — the one definition for the monorepo.
 * Node-only (crypto), so it is a subpath export, not part of the index:
 * `import { generateApiKey } from '@buildd/shared/api-key'`.
 * Format: `bld_` + 64 lowercase hex chars (32 random bytes).
 */
import { randomBytes } from 'crypto';

export function generateApiKey(): string {
  return `bld_${randomBytes(32).toString('hex')}`;
}
