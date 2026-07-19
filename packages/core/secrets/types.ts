/**
 * Pluggable secrets provider interface (BYOSM — Bring Your Own Secrets Manager).
 *
 * Default implementation: PostgresSecretsProvider (uses `secrets` table).
 * Override with setSecretsProvider() for custom backends (Vault, AWS Secrets Manager, etc.).
 */

export type SecretPurpose = 'anthropic_api_key' | 'oauth_token' | 'codex_credential' | 'claude_credential' | 'webhook_token' | 'custom' | 'mcp_credential' | 'vercel_token' | 'pushover' | 'notify_webhook' | 'mcp_connector_credential' | 'signing_key';

export interface SecretMetadata {
  teamId: string;
  accountId?: string;
  workspaceId?: string;
  purpose: SecretPurpose;
  label?: string;
}

export type CredentialHealthStatus = 'healthy' | 'degraded' | 'revoked' | 'unknown';

export interface SecretRecord {
  id: string;
  teamId: string;
  accountId: string | null;
  workspaceId: string | null;
  purpose: SecretPurpose;
  label: string | null;
  healthStatus: CredentialHealthStatus;
  lastFailureAt: Date | null;
  lastFailureMessage: string | null;
  consecutiveAuthFailures: number;
  lastSuccessAt: Date | null;
  lastVerifiedAt?: Date | null;
  lastVerificationError?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SecretsProvider {
  /** Store or update an encrypted secret. Returns the secret ID. */
  set(id: string | null, value: string, metadata: Partial<SecretMetadata>): Promise<string>;

  /**
   * Replace any existing secret at the same scope with a fresh value, returning
   * the new secret ID. "Scope" is the NULL-aware tuple
   * (teamId, accountId, workspaceId, purpose, label): existing rows matching it
   * are deleted before the new row is inserted, so a re-save REPLACES rather than
   * appending a duplicate. Because it inserts a fresh row, health state resets to
   * 'unknown' — a replaced credential is never left flagged 'revoked'.
   *
   * Use for singleton-per-scope credentials (oauth_token, anthropic_api_key,
   * claude_credential, mcp_credential, …). NOT for rotation-style secrets that
   * intentionally keep multiple rows (signing_key).
   */
  replaceScoped(value: string, metadata: SecretMetadata): Promise<string>;

  /** Retrieve a decrypted secret value by ID. */
  get(id: string): Promise<string | null>;

  /** Delete a secret by ID. */
  delete(id: string): Promise<void>;

  /** List secret metadata (never values) for a team. */
  list(teamId: string): Promise<SecretRecord[]>;
}
