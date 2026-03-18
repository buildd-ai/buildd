/**
 * Default SecretsProvider backed by Postgres (secrets table).
 * Uses AES-256-GCM encryption for values at rest.
 */

import { db } from '../db/client';
import { secrets } from '../db/schema';
import { eq } from 'drizzle-orm';
import { encrypt, decrypt } from './crypto';
import type { SecretsProvider, SecretMetadata, SecretRecord } from './types';

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
        purpose: metadata.purpose,
        label: metadata.label || null,
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
      where: eq(secrets.teamId, teamId),
      columns: {
        id: true,
        teamId: true,
        accountId: true,
        workspaceId: true,
        purpose: true,
        label: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return rows as SecretRecord[];
  }
}
