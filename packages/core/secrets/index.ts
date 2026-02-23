/**
 * Secrets provider factory.
 *
 * Default: PostgresSecretsProvider (requires ENCRYPTION_KEY env var).
 * Override: call setSecretsProvider() for custom backends (Vault, AWS SM, etc.).
 */

import type { SecretsProvider } from './types';
import { PostgresSecretsProvider } from './postgres-provider';

let _provider: SecretsProvider | null = null;

/** Get the active secrets provider (lazy-initializes Postgres default). */
export function getSecretsProvider(): SecretsProvider {
  if (!_provider) {
    _provider = new PostgresSecretsProvider();
  }
  return _provider;
}

/** Override the default provider (BYOSM). */
export function setSecretsProvider(provider: SecretsProvider): void {
  _provider = provider;
}

export type { SecretsProvider, SecretMetadata, SecretRecord, SecretPurpose } from './types';
