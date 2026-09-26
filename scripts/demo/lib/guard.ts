/**
 * Fail-closed environment for the demo TS tooling (seed / advance / storyboard).
 *
 * Mirrors scripts/demo/env.sh: fills in the loopback defaults when a variable is
 * unset, and refuses to run when any of them points anywhere but this machine.
 * Import this FIRST — before anything that loads dotenv — so a stray .env can
 * never supply the database URL.
 */
import { assertLoopbackUrl } from '../../../packages/core/db/neon-local';

const PG_PORT = process.env.DEMO_PG_PORT ?? '55432';
const NEON_PORT = process.env.DEMO_NEON_PORT ?? '54444';
const SOKETI_PORT = process.env.DEMO_SOKETI_PORT ?? '56001';
const APP_PORT = process.env.DEMO_APP_PORT ?? '3217';

process.env.DATABASE_URL ??= `postgres://demo:demo@localhost:${PG_PORT}/buildd_demo`;
process.env.NEON_LOCAL_FETCH_ENDPOINT ??= `http://127.0.0.1:${NEON_PORT}/sql`;
process.env.DEMO_BASE_URL ??= `http://localhost:${APP_PORT}`;
process.env.DEMO_SOKETI_URL ??= `http://127.0.0.1:${SOKETI_PORT}`;

for (const key of ['DATABASE_URL', 'NEON_LOCAL_FETCH_ENDPOINT', 'DEMO_BASE_URL', 'DEMO_SOKETI_URL']) {
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
};
