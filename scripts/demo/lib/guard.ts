/**
 * Fail-closed environment for the demo TS tooling (seed / advance / storyboard).
 *
 * Mirrors scripts/demo/env.sh: fills in the loopback defaults when a variable is
 * unset, and refuses to run when any of them points anywhere but this machine.
 * Import this FIRST — before anything that loads dotenv — so a stray .env can
 * never supply the database URL.
 */
import { assertLoopbackUrl } from '../../../packages/core/db/neon-local';
import { tmpdir } from 'os';
import { join } from 'path';

const PG_PORT = process.env.DEMO_PG_PORT ?? '55432';
const NEON_PORT = process.env.DEMO_NEON_PORT ?? '54444';
const SOKETI_PORT = process.env.DEMO_SOKETI_PORT ?? '56001';
const APP_PORT = process.env.DEMO_APP_PORT ?? '3217';
const S3_PORT = process.env.DEMO_S3_PORT ?? '59000';

process.env.DATABASE_URL ??= `postgres://demo:demo@localhost:${PG_PORT}/buildd_demo`;
process.env.NEON_LOCAL_FETCH_ENDPOINT ??= `http://127.0.0.1:${NEON_PORT}/sql`;
process.env.DEMO_BASE_URL ??= `http://localhost:${APP_PORT}`;
process.env.DEMO_SOKETI_URL ??= `http://127.0.0.1:${SOKETI_PORT}`;
process.env.DEMO_S3_URL ??= `http://127.0.0.1:${S3_PORT}`;

for (const key of ['DATABASE_URL', 'NEON_LOCAL_FETCH_ENDPOINT', 'DEMO_BASE_URL', 'DEMO_SOKETI_URL', 'DEMO_S3_URL']) {
  try {
    assertLoopbackUrl(key, process.env[key]);
  } catch (err) {
    console.error(`[demo] ${(err as Error).message}`);
    process.exit(1);
  }
}

export const DEMO = {
  databaseUrl: process.env.DATABASE_URL!,
  baseUrl: process.env.DEMO_BASE_URL!,
  soketiUrl: process.env.DEMO_SOKETI_URL!,
  userEmail: 'demo@example.com',
  pusher: { appId: 'demo-app', key: 'demo-key', secret: 'demo-secret' },
  // Artifact bytes: blob-server.ts serves DEMO_BLOB_DIR at DEMO_S3_URL, the
  // app's STORAGE_ENDPOINT (serve.sh). Keep the defaults in step with env.sh.
  s3: {
    endpoint: process.env.DEMO_S3_URL!,
    bucket: 'buildd-demo',
    blobDir: process.env.DEMO_BLOB_DIR ?? join(process.env.TMPDIR ?? tmpdir(), `buildd-demo-blobs-${S3_PORT}`),
  },
};
