/**
 * Default SecretsProvider backed by Postgres (secrets + secret_refs tables).
 * Uses AES-256-GCM encryption for values at rest.
 */

import { db } from '../db/client';
import { secrets, secretRefs } from '../db/schema';
import { eq, and, lt } from 'drizzle-orm';
import { encrypt, decrypt } from './crypto';
import type { SecretsProvider, SecretMetadata, SecretRecord } from './types';
import { randomBytes } from 'crypto';

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

  async createRef(secretId: string, scopedTo: string, ttlSeconds = 300): Promise<string> {
    const ref = `sref_${randomBytes(24).toString('hex')}`;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    await db.insert(secretRefs).values({
      ref,
      secretId,
      scopedToWorkerId: scopedTo,
      expiresAt,
    });

    return ref;
  }

  async redeemRef(ref: string, claimedBy: string): Promise<string | null> {
    // Atomic single-use: only succeed if not redeemed and not expired and scoped correctly
    const now = new Date();
    const updated = await db.update(secretRefs)
      .set({ redeemed: true })
      .where(and(
        eq(secretRefs.ref, ref),
        eq(secretRefs.redeemed, false),
        eq(secretRefs.scopedToWorkerId, claimedBy),
      ))
      .returning({ secretId: secretRefs.secretId, expiresAt: secretRefs.expiresAt });

    if (updated.length === 0) return null;

    // Check expiry after atomic update
    if (updated[0].expiresAt < now) return null;

    return this.get(updated[0].secretId);
  }

  async cleanupExpiredRefs(): Promise<number> {
    const now = new Date();
    const deleted = await db.delete(secretRefs)
      .where(lt(secretRefs.expiresAt, now))
      .returning({ id: secretRefs.id });
    return deleted.length;
  }
}
