/**
 * Refuse to open a real database connection from a unit-test process.
 *
 * Why: Bun auto-loads `.env` / `.env.local` from the cwd for `bun test`, and a
 * developer checkout's `apps/web/.env.local` can hold a live DATABASE_URL. Any
 * test that forgets to mock one DB-touching module (a route wrapped in
 * `withCronRun`, say) then writes its fixtures into that database — which is
 * how fake cron-run failures ended up in real run history and read as a real
 * error rate.
 *
 * The rule: under NODE_ENV=test (pinned by tests/setup.ts, and Bun's own
 * default for `bun test`) the DB client connects only to a loopback host.
 * A test that genuinely needs a remote database opts in explicitly with
 * BUILDD_TEST_ALLOW_REMOTE_DB=1. Integration and E2E tests are unaffected:
 * they talk to a running server over HTTP, and that server is not a test
 * process.
 */
import { isLoopbackHost } from './neon-local';

export const ALLOW_REMOTE_TEST_DB_ENV = 'BUILDD_TEST_ALLOW_REMOTE_DB';

export function assertTestDatabaseSafe(
  databaseUrl: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (env.NODE_ENV !== 'test') return;
  if (env[ALLOW_REMOTE_TEST_DB_ENV] === '1') return;

  let host: string | null = null;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    // Unparseable: treat as not-local. Never echo the URL, it carries a password.
  }
  if (host && isLoopbackHost(host)) return;

  throw new Error(
    `[db] refusing to connect to a non-local database from a test process ` +
      `(NODE_ENV=test, host ${host ? `"${host}"` : 'unparseable'}). ` +
      `Mock the module that touches the DB, or set ${ALLOW_REMOTE_TEST_DB_ENV}=1 ` +
      `if this test really needs a remote database.`,
  );
}
