import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '@buildd/core/config';

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

export async function generateUploadUrl(key: string, contentType: string): Promise<string> {
  const client = getClient();
  const command = new PutObjectCommand({
    Bucket: config.storageBucket,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(client, command, { expiresIn: 600 }); // 10 min
}

/**
 * Presigned PUT whose maximum body size is bound into the signature itself.
 *
 * `generateUploadUrl` above signs only Bucket/Key/ContentType, so the resulting
 * URL permits an unbounded body — the holder can PUT gigabytes. Signing
 * `content-length` makes the exact byte count part of the canonical request:
 * a PUT with any other length fails SigV4 verification at R2, before a single
 * byte is stored. Use this for anything a runner or browser uploads directly.
 */
export async function generateConstrainedUploadUrl(
  key: string,
  contentType: string,
  contentLength: number,
): Promise<string> {
  const client = getClient();
  const command = new PutObjectCommand({
    Bucket: config.storageBucket,
    Key: key,
    ContentType: contentType,
    ContentLength: contentLength,
  });
  return getSignedUrl(client, command, {
    expiresIn: 600, // 10 min
    signableHeaders: new Set(['content-length', 'content-type']),
  });
}

/**
 * True when an object already exists at `key`. Used to enforce write-once keys.
 * Throws on anything other than a definite "not found" so callers can fail
 * closed rather than hand out a signature that might overwrite history.
 */
export async function objectExists(key: string): Promise<boolean> {
  const client = getClient();
  try {
    await client.send(new HeadObjectCommand({ Bucket: config.storageBucket, Key: key }));
    return true;
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    const name = (err as { name?: string })?.name;
    if (status === 404 || name === 'NotFound' || name === 'NoSuchKey') return false;
    throw err;
  }
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
