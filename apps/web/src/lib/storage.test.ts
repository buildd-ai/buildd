import { describe, it, expect, mock } from 'bun:test';

mock.module('@buildd/core/config', () => ({
  config: {
    storageRegion: 'auto',
    storageEndpoint: 'https://example.r2.cloudflarestorage.com',
    storageAccessKey: 'AKIAEXAMPLE',
    storageSecretKey: 'secretexample',
    storageBucket: 'test-bucket',
  },
}));

const { generateSizedUploadUrl } = await import('./storage');

function query(url: string, name: string): string | null {
  return new URL(url).searchParams.get(name);
}

describe('generateSizedUploadUrl', () => {
  const key = 'artifacts/ws-1/upload-1/report.pdf';

  it('binds the declared size into the signed headers', async () => {
    const url = await generateSizedUploadUrl(key, 'application/pdf', 1234);
    const signed = query(url, 'X-Amz-SignedHeaders') ?? '';
    expect(signed.split(';')).toContain('content-length');
  });

  it('produces a different signature for a different declared size', async () => {
    const [small, large] = await Promise.all([
      generateSizedUploadUrl(key, 'application/pdf', 1234),
      generateSizedUploadUrl(key, 'application/pdf', 50 * 1024 * 1024),
    ]);
    expect(query(small, 'X-Amz-Signature')).not.toBe(query(large, 'X-Amz-Signature'));
  });

  it('signs the requested key path verbatim', async () => {
    const url = await generateSizedUploadUrl(key, 'application/pdf', 10);
    expect(new URL(url).pathname).toBe(`/test-bucket/${key}`);
  });

  it('rejects a size that is not a positive integer', async () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      await expect(generateSizedUploadUrl(key, 'application/pdf', bad)).rejects.toThrow();
    }
  });

  it('rejects a key that carries path structure it should not', async () => {
    await expect(
      generateSizedUploadUrl('artifacts/ws-1/upload-1/../../x', 'application/pdf', 10),
    ).rejects.toThrow();
    await expect(generateSizedUploadUrl('/leading', 'application/pdf', 10)).rejects.toThrow();
  });

  it('expires the grant quickly', async () => {
    const url = await generateSizedUploadUrl(key, 'application/pdf', 10);
    expect(Number(query(url, 'X-Amz-Expires'))).toBeLessThanOrEqual(600);
  });
});
