import { PutObjectCommand, type PutObjectCommandInput, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

type PresignOptions = NonNullable<Parameters<typeof getSignedUrl>[2]>;

/**
 * Presign a PutObject with no precomputed body checksum.
 *
 * The SDK's default checksum mode adds x-amz-checksum-crc32 and
 * x-amz-sdk-checksum-algorithm to a presigned PutObject, computed over the
 * EMPTY body at signing time. R2 ignores it; S3 checks the real body against
 * it and rejects the upload. The body is unknown when presigning, so there is
 * no checksum to sign. Every presigned PUT should go through here.
 */
export async function presignPutObject(
  client: S3Client,
  input: PutObjectCommandInput,
  options: PresignOptions,
): Promise<string> {
  const command = new PutObjectCommand(input);
  // The checksum middleware is attached only when the command resolves, so it
  // cannot be removed up front. Strip its output later in the build step; the
  // presigner intercepts in finalizeRequest and never sends the request.
  command.middlewareStack.add(
    (next) => async (args) => {
      const headers = (args.request as { headers?: Record<string, string> }).headers;
      if (headers) {
        for (const name of Object.keys(headers)) {
          const lower = name.toLowerCase();
          if (lower.startsWith('x-amz-checksum-') || lower === 'x-amz-sdk-checksum-algorithm') delete headers[name];
        }
      }
      return next(args);
    },
    { step: 'build', priority: 'low', name: 'stripPresignChecksum' },
  );
  return getSignedUrl(client, command, options);
}
