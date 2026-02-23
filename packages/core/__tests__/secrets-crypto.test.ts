import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { encrypt, decrypt } from '../secrets/crypto';

// Set a test encryption key for all crypto tests
const TEST_KEY = 'test-encryption-key-that-is-at-least-32-chars-long!!';

describe('secrets/crypto', () => {
  let originalKey: string | undefined;

  beforeAll(() => {
    originalKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = TEST_KEY;
  });

  afterAll(() => {
    if (originalKey !== undefined) {
      process.env.ENCRYPTION_KEY = originalKey;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
  });

  test('encrypt → decrypt round-trip', () => {
    const plaintext = 'sk-ant-api03-secret-key-value';
    const encrypted = encrypt(plaintext);
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  test('encrypted value is base64 and different from plaintext', () => {
    const plaintext = 'my-secret-value';
    const encrypted = encrypt(plaintext);
    // Should be valid base64
    expect(() => Buffer.from(encrypted, 'base64')).not.toThrow();
    // Should not contain the plaintext
    expect(encrypted).not.toContain(plaintext);
  });

  test('each encryption produces unique ciphertext (random IV/salt)', () => {
    const plaintext = 'same-input';
    const encrypted1 = encrypt(plaintext);
    const encrypted2 = encrypt(plaintext);
    expect(encrypted1).not.toBe(encrypted2);
    // Both decrypt to same value
    expect(decrypt(encrypted1)).toBe(plaintext);
    expect(decrypt(encrypted2)).toBe(plaintext);
  });

  test('wrong key fails to decrypt', () => {
    const plaintext = 'secret-data';
    const encrypted = encrypt(plaintext);

    // Change the key
    process.env.ENCRYPTION_KEY = 'different-key-that-is-at-least-32-characters!!';
    expect(() => decrypt(encrypted)).toThrow();

    // Restore
    process.env.ENCRYPTION_KEY = TEST_KEY;
  });

  test('tampered ciphertext fails to decrypt', () => {
    const plaintext = 'secret-data';
    const encrypted = encrypt(plaintext);

    // Tamper with the middle of the base64 string
    const buf = Buffer.from(encrypted, 'base64');
    buf[buf.length - 5] ^= 0xff; // Flip bits in ciphertext
    const tampered = buf.toString('base64');

    expect(() => decrypt(tampered)).toThrow();
  });

  test('empty string round-trip', () => {
    const encrypted = encrypt('');
    expect(decrypt(encrypted)).toBe('');
  });

  test('unicode round-trip', () => {
    const plaintext = '🔑 Clé secrète — 秘密鍵';
    const encrypted = encrypt(plaintext);
    expect(decrypt(encrypted)).toBe(plaintext);
  });

  test('long value round-trip', () => {
    const plaintext = 'x'.repeat(10000);
    const encrypted = encrypt(plaintext);
    expect(decrypt(encrypted)).toBe(plaintext);
  });

  test('throws when ENCRYPTION_KEY is missing', () => {
    const saved = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    expect(() => encrypt('test')).toThrow('ENCRYPTION_KEY');
    process.env.ENCRYPTION_KEY = saved;
  });

  test('throws when ENCRYPTION_KEY is too short', () => {
    const saved = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'short';
    expect(() => encrypt('test')).toThrow('ENCRYPTION_KEY');
    process.env.ENCRYPTION_KEY = saved;
  });
});
