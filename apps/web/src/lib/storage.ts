import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '@buildd/core/config';
import { assertNormalizedObjectKey } from './storage-keys';

let _client: S3Client | null = null;

function getClient(): S3Client {
  if (!_client) {
    _client = new S3Client({
      region: config.storageRegion,
      endpoint: config.storageEndpoint,
      credentials: {
        accessKeyId: config.storageAccessKey,
        secretAccessKey: config.storageSecretKey,
      },
      forcePathStyle: true,
    });
  }
  return _client;
}

export function isStorageConfigured(): boolean {
  return !!(config.storageEndpoint && config.storageAccessKey && config.storageSecretKey);
}

/**
 * Presign a PUT whose body size is fixed by the signature.
 *
 * A presigned PUT with no size in the signature authorises a body of any
 * length, so the caller's declared size is signed rather than merely checked:
 * `content-length` is listed in `X-Amz-SignedHeaders`, which means a request
 * that sends a different length fails the signature check at the bucket. The
 * key is asserted normalised first, so the grant covers the prefix the key
 * names rather than whatever it would resolve to.
 */
export async function generateSizedUploadUrl(
  key: string,
  contentType: string,
  contentLength: number,
): Promise<string> {
  assertNormalizedObjectKey(key);
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    throw new Error('contentLength must be a positive integer');
  }

  const client = getClient();
  const command = new PutObjectCommand({
    Bucket: config.storageBucket,
    Key: key,
    ContentType: contentType,
    ContentLength: contentLength,
  });
  return getSignedUrl(client, command, {
    expiresIn: 600, // 10 min
    // Explicit so the binding does not depend on the SDK's default choice of
    // which headers to sign.
    signableHeaders: new Set(['content-length']),
  });
}

export async function generateDownloadUrl(key: string): Promise<string> {
  const client = getClient();
  const command = new GetObjectCommand({
    Bucket: config.storageBucket,
    Key: key,
  });
  return getSignedUrl(client, command, { expiresIn: 3600 }); // 1 hour
}

export async function uploadBuffer(key: string, body: Buffer, contentType: string): Promise<void> {
  assertNormalizedObjectKey(key);
  const client = getClient();
  await client.send(new PutObjectCommand({
    Bucket: config.storageBucket,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
}

export async function deleteObject(key: string): Promise<void> {
  const client = getClient();
  await client.send(new DeleteObjectCommand({
    Bucket: config.storageBucket,
    Key: key,
  }));
}
