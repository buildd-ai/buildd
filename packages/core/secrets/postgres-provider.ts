/**
 * Default SecretsProvider backed by Postgres (secrets table).
 * Uses AES-256-GCM encryption for values at rest.
 */

import { db } from '../db/client';
import { secrets } from '../db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { encrypt, decrypt } from './crypto';
import type { SecretsProvider, SecretMetadata, SecretRecord } from './types';

/**
 * The exact, NULL-aware scope a singleton credential occupies. A personal key
 * and the team key share (team, purpose, label) and differ only in `user_id`,
 * so the user dimension must be part of the match — otherwise saving your own
 * key deletes the team's, and saving the team's deletes everyone's.
 */
export function secretScopeWhere(metadata: SecretMetadata) {
  const accountId = metadata.accountId ?? null;
  const workspaceId = metadata.workspaceId ?? null;
  const userId = metadata.userId ?? null;
  const label = metadata.label ?? null;
  return and(
    eq(secrets.teamId, metadata.teamId),
    eq(secrets.purpose, metadata.purpose),
    accountId ? eq(secrets.accountId, accountId) : isNull(secrets.accountId),
    workspaceId ? eq(secrets.workspaceId, workspaceId) : isNull(secrets.workspaceId),
    userId ? eq(secrets.userId, userId) : isNull(secrets.userId),
    label ? eq(secrets.label, label) : isNull(secrets.label),
  );
}

export class PostgresSecretsProvider implements SecretsProvider {

  async set(id: string | null, value: string, metadata: Partial<SecretMetadata>): Promise<string> {
    const encryptedValue = encrypt(value);

    if (id) {
      // Update existing
      const updated = await db.update(secrets)
        .set({
          encryptedValue,
          ...(metadata.label !== undefined ? { label: metadata.label } : {}),
          ...(metadata.purpose ? { purpose: metadata.purpose } : {}),
          updatedAt: new Date(),
        })
        .where(eq(secrets.id, id))
        .returning({ id: secrets.id });

      if (updated.length === 0) throw new Error(`Secret ${id} not found`);
      return updated[0].id;
    }

    // Insert new
    if (!metadata.teamId) throw new Error('teamId is required for new secrets');
    if (!metadata.purpose) throw new Error('purpose is required for new secrets');

    const [row] = await db.insert(secrets)
      .values({
        teamId: metadata.teamId,
        accountId: metadata.accountId || null,
        workspaceId: metadata.workspaceId || null,
        userId: metadata.userId || null,
        purpose: metadata.purpose,
        label: metadata.label || null,
        encryptedValue,
      })
      .returning({ id: secrets.id });

    return row.id;
  }

  async replaceScoped(value: string, metadata: SecretMetadata): Promise<string> {
    if (!metadata.teamId) throw new Error('teamId is required');
    if (!metadata.purpose) throw new Error('purpose is required');

    const encryptedValue = encrypt(value);

    // Delete any existing row(s) at the exact scope (NULL-aware) so a re-save
    // replaces rather than appends. A single UPDATE would leave stale health
    // columns (a replaced 'revoked' row must not stay revoked); delete+insert
    // gives a clean row that defaults to health 'unknown'.
    await db.delete(secrets).where(secretScopeWhere(metadata));

    const [row] = await db.insert(secrets)
      .values({
        teamId: metadata.teamId,
        accountId: metadata.accountId ?? null,
        workspaceId: metadata.workspaceId ?? null,
        userId: metadata.userId ?? null,
        purpose: metadata.purpose,
        label: metadata.label ?? null,
        encryptedValue,
      })
      .returning({ id: secrets.id });

    return row.id;
  }

  async get(id: string): Promise<string | null> {
    const row = await db.query.secrets.findFirst({
      where: eq(secrets.id, id),
      columns: { encryptedValue: true },
    });
    if (!row) return null;
    return decrypt(row.encryptedValue);
  }

  async delete(id: string): Promise<void> {
    await db.delete(secrets).where(eq(secrets.id, id));
  }

  async list(teamId: string): Promise<SecretRecord[]> {
    const rows = await db.query.secrets.findMany({
      // Personal keys are one person's, not the team's: never listed here, so
      // no team-wide list or delete path can reach them.
      where: and(eq(secrets.teamId, teamId), isNull(secrets.userId)),
      columns: {
        id: true,
        teamId: true,
        accountId: true,
        workspaceId: true,
        purpose: true,
        label: true,
        healthStatus: true,
        lastFailureAt: true,
        lastFailureMessage: true,
        consecutiveAuthFailures: true,
        lastSuccessAt: true,
        lastVerifiedAt: true,
        lastVerificationError: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return rows as SecretRecord[];
  }
}
