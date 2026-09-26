/**
 * blob-server.ts — the demo stack's stand-in for object storage (lib/blobs.ts).
 *
 *   bun run scripts/demo/blob-server.ts        (serve.sh starts and stops it)
 *
 * Answers the dashboard's signed, path-style GETs (`/<bucket>/<key>?X-Amz-…`)
 * from DEMO_BLOB_DIR, which seed.ts fills. Reads only, loopback only.
 */
import { DEMO } from './lib/guard';
import { existsSync } from 'fs';
import { blobFileFor, contentTypeOf } from './lib/blobs';

const port = Number(new URL(DEMO.s3.endpoint).port);
Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch(req) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('read-only', { status: 405 });
    const file = blobFileFor(DEMO.s3.blobDir, DEMO.s3.bucket, new URL(req.url).pathname);
    if (!file || !existsSync(file)) return new Response('not found', { status: 404 });
    return new Response(Bun.file(file), { headers: { 'content-type': contentTypeOf(file), 'cache-control': 'private, max-age=3600' } });
  },
});
console.log(`[demo] blob server on ${DEMO.s3.endpoint} (dir ${DEMO.s3.blobDir})`);
