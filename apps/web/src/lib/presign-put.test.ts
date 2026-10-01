/**
 * A presigned PUT must not carry a body checksum.
 *
 * With the SDK's default checksum mode, presigning a PutObject puts
 * x-amz-checksum-crc32 (the CRC32 of an EMPTY body, AAAAAA==) and
 * x-amz-sdk-checksum-algorithm into the query. R2 ignores it; S3 checks the
 * real body against it and rejects the upload.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/web/src/lib/presign-put.test.ts
 */

import { describe, it, expect } from 'bun:test';
import { S3Client } from '@aws-sdk/client-s3';
import { presignPutObject } from './presign-put';

const client = new S3Client({
  region: 'us-east-1',
  endpoint: 'https://s3.example.invalid',
  credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secretexample' },
  forcePathStyle: true,
});

function checksumParams(url: string): string[] {
  return [...new URL(url).searchParams.keys()].filter((k) => {
    const lower = k.toLowerCase();
    return lower.startsWith('x-amz-checksum') || lower === 'x-amz-sdk-checksum-algorithm';
  });
}

describe('presignPutObject', () => {
  it('produces a SigV4 PutObject URL with no checksum params', async () => {
    const url = await presignPutObject(
      client,
      { Bucket: 'b', Key: 'artifacts/ws/u/report.pdf', ContentType: 'application/pdf', ContentLength: 1234 },
      { expiresIn: 600, signableHeaders: new Set(['content-length']) },
    );
    const params = new URL(url).searchParams;
    expect(params.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(params.get('x-id')).toBe('PutObject');
    expect(checksumParams(url)).toEqual([]);
  });

  it('keeps the requested signed headers', async () => {
    const url = await presignPutObject(
      client,
      { Bucket: 'b', Key: 'k', ContentType: 'text/plain', ContentLength: 5 },
      { expiresIn: 600, signableHeaders: new Set(['content-length', 'content-type']) },
    );
    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
  });
});
