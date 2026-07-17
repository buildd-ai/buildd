/**
 * Pluggable secrets provider interface (BYOSM — Bring Your Own Secrets Manager).
 *
 * Default implementation: PostgresSecretsProvider (uses `secrets` table).
 * Override with setSecretsProvider() for custom backends (Vault, AWS Secrets Manager, etc.).
 */

export type SecretPurpose = 'anthropic_api_key' | 'oauth_token' | 'codex_credential' | 'webhook_token' | 'custom' | 'mcp_credential' | 'vercel_token' | 'pushover' | 'notify_webhook' | 'mcp_connector_credential' | 'signing_key';

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
}
