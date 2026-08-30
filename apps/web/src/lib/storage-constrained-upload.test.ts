/**
 * The size cap must live in the SIGNATURE, not just in a server-side `if`.
 *
 * A signer that covers only Bucket/Key/ContentType leaves the URL it returns
 * permitting an unbounded body — a compromised runner could PUT gigabytes.
 * `generateConstrainedUploadUrl` binds `content-length` (and `content-type`)
 * into the canonical request, so R2 rejects any other body length before
 * storing a byte.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/web/src/lib/storage-constrained-upload.test.ts
 */

import { describe, it, expect, mock } from 'bun:test';

mock.module('@buildd/core/config', () => ({
  config: {
    storageEndpoint: 'https://storage.example.invalid',
    storageRegion: 'auto',
    storageBucket: 'test-bucket',
    storageAccessKey: 'test-access-key',
    storageSecretKey: 'test-secret-key',
    storagePublicUrl: '',
  },
}));

const { generateConstrainedUploadUrl, isStorageConfigured } = await import('./storage');

const KEY = 'sessions/team/workspace/worker/transcript.jsonl';

describe('generateConstrainedUploadUrl', () => {
  it('signs content-length so the URL cannot be reused for a larger body', async () => {
    const url = await generateConstrainedUploadUrl(KEY, 'application/x-ndjson', 4096);
    const signed = decodeURIComponent(new URL(url).searchParams.get('X-Amz-SignedHeaders') || '');
    expect(signed.split(';')).toContain('content-length');
  });

  it('signs content-type as well', async () => {
    const url = await generateConstrainedUploadUrl(KEY, 'application/x-ndjson', 128);
    const signed = decodeURIComponent(new URL(url).searchParams.get('X-Amz-SignedHeaders') || '');
    expect(signed.split(';')).toContain('content-type');
  });

  it('produces a different signature for a different declared length', async () => {
    const a = await generateConstrainedUploadUrl(KEY, 'application/x-ndjson', 100);
    const b = await generateConstrainedUploadUrl(KEY, 'application/x-ndjson', 200);
    expect(new URL(a).searchParams.get('X-Amz-Signature')).not.toBe(
      new URL(b).searchParams.get('X-Amz-Signature')
    );
  });

  it('targets the derived key and nothing else', async () => {
    const url = await generateConstrainedUploadUrl(KEY, 'application/x-ndjson', 10);
    expect(new URL(url).pathname).toContain(KEY);
  });

  it('expires — the signature is short-lived', async () => {
    const url = await generateConstrainedUploadUrl(KEY, 'application/x-ndjson', 10);
    expect(Number(new URL(url).searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(600);
  });

  it('reports configured when credentials are present', () => {
    expect(isStorageConfigured()).toBe(true);
  });
});
