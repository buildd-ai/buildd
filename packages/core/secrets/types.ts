/**
 * Pluggable secrets provider interface (BYOSM — Bring Your Own Secrets Manager).
 *
 * Default implementation: PostgresSecretsProvider (uses `secrets` + `secret_refs` tables).
 * Override with setSecretsProvider() for custom backends (Vault, AWS Secrets Manager, etc.).
 */

export type SecretPurpose = 'anthropic_api_key' | 'oauth_token' | 'webhook_token' | 'custom';

export interface SecretMetadata {
  teamId: string;
  accountId?: string;
  workspaceId?: string;
  purpose: SecretPurpose;
  label?: string;
}

export interface SecretRecord {
  id: string;
  teamId: string;
  accountId: string | null;
  workspaceId: string | null;
  purpose: SecretPurpose;
  label: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SecretsProvider {
  /** Store or update an encrypted secret. Returns the secret ID. */
  set(id: string | null, value: string, metadata: Partial<SecretMetadata>): Promise<string>;

  /** Retrieve a decrypted secret value by ID. */
  get(id: string): Promise<string | null>;

  /** Delete a secret by ID. */
  delete(id: string): Promise<void>;

  /** List secret metadata (never values) for a team. */
  list(teamId: string): Promise<SecretRecord[]>;

  /** Create a single-use, time-limited reference to a secret. */
  createRef(secretId: string, scopedTo: string, ttlSeconds?: number): Promise<string>;

  /** Redeem a secret ref — returns decrypted value if valid, null if expired/used/wrong scope. */
  redeemRef(ref: string, claimedBy: string): Promise<string | null>;

  /** Clean up expired refs. */
  cleanupExpiredRefs(): Promise<number>;
}
