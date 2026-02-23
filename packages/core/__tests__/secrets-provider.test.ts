import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import type { SecretsProvider, SecretRecord, SecretMetadata } from '../secrets/types';
import { encrypt, decrypt } from '../secrets/crypto';
import { randomUUID } from 'crypto';

// Set a test encryption key
const TEST_KEY = 'test-encryption-key-that-is-at-least-32-chars-long!!';

/**
 * In-memory SecretsProvider that mirrors PostgresSecretsProvider logic
 * without requiring a database connection. Tests the contract/interface.
 */
class InMemorySecretsProvider implements SecretsProvider {
  private secrets = new Map<string, { encrypted: string; meta: SecretRecord }>();
  private refs = new Map<string, { secretId: string; scopedTo: string; redeemed: boolean; expiresAt: Date }>();

  async set(id: string | null, value: string, metadata: Partial<SecretMetadata>): Promise<string> {
    const encryptedValue = encrypt(value);

    if (id) {
      const existing = this.secrets.get(id);
      if (!existing) throw new Error(`Secret ${id} not found`);
      existing.encrypted = encryptedValue;
      existing.meta.updatedAt = new Date();
      return id;
    }

    if (!metadata.teamId) throw new Error('teamId is required');
    if (!metadata.purpose) throw new Error('purpose is required');

    const newId = randomUUID();
    this.secrets.set(newId, {
      encrypted: encryptedValue,
      meta: {
        id: newId,
        teamId: metadata.teamId,
        accountId: metadata.accountId || null,
        workspaceId: metadata.workspaceId || null,
        purpose: metadata.purpose,
        label: metadata.label || null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    return newId;
  }

  async get(id: string): Promise<string | null> {
    const entry = this.secrets.get(id);
    if (!entry) return null;
    return decrypt(entry.encrypted);
  }

  async delete(id: string): Promise<void> {
    this.secrets.delete(id);
  }

  async list(teamId: string): Promise<SecretRecord[]> {
    return Array.from(this.secrets.values())
      .filter(s => s.meta.teamId === teamId)
      .map(s => s.meta);
  }

  async createRef(secretId: string, scopedTo: string, ttlSeconds = 300): Promise<string> {
    const ref = `sref_${randomUUID().replace(/-/g, '')}`;
    this.refs.set(ref, {
      secretId,
      scopedTo,
      redeemed: false,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    });
    return ref;
  }

  async redeemRef(ref: string, claimedBy: string): Promise<string | null> {
    const entry = this.refs.get(ref);
    if (!entry) return null;
    if (entry.redeemed) return null;
    if (entry.scopedTo !== claimedBy) return null;
    if (entry.expiresAt < new Date()) return null;

    entry.redeemed = true;
    return this.get(entry.secretId);
  }

  async cleanupExpiredRefs(): Promise<number> {
    const now = new Date();
    let count = 0;
    for (const [key, entry] of this.refs) {
      if (entry.expiresAt < now) {
        this.refs.delete(key);
        count++;
      }
    }
    return count;
  }
}

describe('SecretsProvider contract', () => {
  let provider: SecretsProvider;
  let originalKey: string | undefined;

  const TEAM_ID = randomUUID();
  const ACCOUNT_ID = randomUUID();
  const WORKER_ID = randomUUID();

  beforeAll(() => {
    originalKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = TEST_KEY;
    provider = new InMemorySecretsProvider();
  });

  afterAll(() => {
    if (originalKey !== undefined) {
      process.env.ENCRYPTION_KEY = originalKey;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
  });

  test('set + get: store and retrieve a secret', async () => {
    const id = await provider.set(null, 'sk-ant-secret', {
      teamId: TEAM_ID,
      accountId: ACCOUNT_ID,
      purpose: 'anthropic_api_key',
      label: 'My API Key',
    });

    expect(id).toBeTruthy();
    const value = await provider.get(id);
    expect(value).toBe('sk-ant-secret');
  });

  test('set with existing id: updates value', async () => {
    const id = await provider.set(null, 'old-value', {
      teamId: TEAM_ID,
      purpose: 'custom',
    });

    await provider.set(id, 'new-value', {});
    const value = await provider.get(id);
    expect(value).toBe('new-value');
  });

  test('get: returns null for non-existent id', async () => {
    const value = await provider.get(randomUUID());
    expect(value).toBeNull();
  });

  test('delete: removes a secret', async () => {
    const id = await provider.set(null, 'to-delete', {
      teamId: TEAM_ID,
      purpose: 'custom',
    });

    await provider.delete(id);
    const value = await provider.get(id);
    expect(value).toBeNull();
  });

  test('list: returns metadata without values', async () => {
    const otherTeam = randomUUID();
    await provider.set(null, 'team-secret', {
      teamId: TEAM_ID,
      purpose: 'webhook_token',
      label: 'Webhook',
    });
    await provider.set(null, 'other-team-secret', {
      teamId: otherTeam,
      purpose: 'custom',
    });

    const secrets = await provider.list(TEAM_ID);
    expect(secrets.length).toBeGreaterThanOrEqual(1);
    // Metadata only — no encrypted values
    for (const s of secrets) {
      expect(s.teamId).toBe(TEAM_ID);
      expect(s).toHaveProperty('id');
      expect(s).toHaveProperty('purpose');
      expect(s).not.toHaveProperty('encryptedValue');
      expect(s).not.toHaveProperty('value');
    }

    const otherSecrets = await provider.list(otherTeam);
    expect(otherSecrets.length).toBe(1);
    expect(otherSecrets[0].teamId).toBe(otherTeam);
  });

  test('set: requires teamId for new secrets', async () => {
    await expect(provider.set(null, 'value', { purpose: 'custom' })).rejects.toThrow('teamId');
  });

  test('set: requires purpose for new secrets', async () => {
    await expect(provider.set(null, 'value', { teamId: TEAM_ID })).rejects.toThrow('purpose');
  });

  describe('secret refs', () => {
    let secretId: string;

    beforeAll(async () => {
      secretId = await provider.set(null, 'ref-test-secret', {
        teamId: TEAM_ID,
        accountId: ACCOUNT_ID,
        purpose: 'anthropic_api_key',
      });
    });

    test('createRef + redeemRef: single-use works', async () => {
      const ref = await provider.createRef(secretId, WORKER_ID, 300);
      expect(ref).toMatch(/^sref_/);

      const value = await provider.redeemRef(ref, WORKER_ID);
      expect(value).toBe('ref-test-secret');
    });

    test('second redeem fails (single-use)', async () => {
      const ref = await provider.createRef(secretId, WORKER_ID, 300);

      // First redeem succeeds
      const value = await provider.redeemRef(ref, WORKER_ID);
      expect(value).toBe('ref-test-secret');

      // Second redeem fails
      const value2 = await provider.redeemRef(ref, WORKER_ID);
      expect(value2).toBeNull();
    });

    test('wrong worker scope: redeem fails', async () => {
      const ref = await provider.createRef(secretId, WORKER_ID, 300);
      const wrongWorker = randomUUID();

      const value = await provider.redeemRef(ref, wrongWorker);
      expect(value).toBeNull();
    });

    test('expired ref: redeem fails', async () => {
      // Create with 0 TTL (immediately expired)
      const ref = await provider.createRef(secretId, WORKER_ID, 0);

      // Wait a tick for expiration
      await new Promise(r => setTimeout(r, 10));

      const value = await provider.redeemRef(ref, WORKER_ID);
      expect(value).toBeNull();
    });

    test('non-existent ref: redeem returns null', async () => {
      const value = await provider.redeemRef('sref_nonexistent', WORKER_ID);
      expect(value).toBeNull();
    });

    test('cleanupExpiredRefs removes expired entries', async () => {
      // Create an expired ref
      await provider.createRef(secretId, WORKER_ID, 0);
      await new Promise(r => setTimeout(r, 10));

      const cleaned = await provider.cleanupExpiredRefs();
      expect(cleaned).toBeGreaterThanOrEqual(1);
    });
  });
});
