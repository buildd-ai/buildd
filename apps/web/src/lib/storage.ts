import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
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

export async function generateDownloadUrl(key: string): Promise<string> {
  const client = getClient();
  const command = new GetObjectCommand({
    Bucket: config.storageBucket,
    Key: key,
  });
  return getSignedUrl(client, command, { expiresIn: 3600 }); // 1 hour
}

export async function deleteObject(key: string): Promise<void> {
  const client = getClient();
  await client.send(new DeleteObjectCommand({
    Bucket: config.storageBucket,
    Key: key,
  }));
}
