/**
 * Shared test utilities for integration and E2E tests.
 *
 * Provides:
 *   - `requireTestEnv()` — resolves server + API key, skips if not configured
 *   - `createTestApi()` — returns `api()` and `apiRaw()` helpers
 *   - `createCleanup()` — tracked cleanup with SIGINT handler and force-delete
 */

import { readFileSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

interface TestConfig {
  server: string;
  apiKey: string;
}

function getFileConfig(): { apiKey?: string; builddServer?: string } {
  try {
    const configPath = join(process.env.HOME || '~', '.buildd', 'config.json');
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Resolve test server + API key. Skips the test suite (process.exit(0))
 * if BUILDD_TEST_SERVER is not set — prevents accidental production hits.
 *
 * Priority:
 *   1. BUILDD_TEST_SERVER env var (required — no fallback to production)
 *   2. BUILDD_API_KEY env var > ~/.buildd/config.json apiKey
 */
export function requireTestEnv(): TestConfig {
  const server = process.env.BUILDD_TEST_SERVER;
  if (!server) {
    console.log(
      '⏭️  Skipping: BUILDD_TEST_SERVER not set.\n' +
      '   Set it to a preview/local URL to run integration tests.\n' +
      '   Example: BUILDD_TEST_SERVER=http://localhost:3000 bun test:integration',
    );
    process.exit(0);
  }

  const fileConfig = getFileConfig();
  const apiKey = process.env.BUILDD_API_KEY || fileConfig.apiKey;
  if (!apiKey) {
    console.log('⏭️  Skipping: No API key found (set BUILDD_API_KEY or ~/.buildd/config.json)');
    process.exit(0);
  }

  return { server, apiKey };
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export function createTestApi(server: string, apiKey: string) {
  async function api(endpoint: string, options: RequestInit & { retries?: number } = {}) {
    const maxRetries = options.retries ?? 2;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(`${server}${endpoint}`, {
          ...options,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            ...options.headers,
          },
        });
        const body = await res.json();
        if (!res.ok) {
          if (res.status >= 500 && attempt < maxRetries) {
            lastError = new Error(`API ${options.method || 'GET'} ${endpoint} -> ${res.status}: ${JSON.stringify(body)}`);
            await sleep(1_000 * (attempt + 1));
            continue;
          }
          throw new Error(`API ${options.method || 'GET'} ${endpoint} -> ${res.status}: ${JSON.stringify(body)}`);
        }
        return body;
      } catch (err: any) {
        if (attempt < maxRetries && (err instanceof TypeError || err.message?.includes('fetch failed'))) {
          lastError = err;
          await sleep(1_000 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
    throw lastError || new Error(`API ${endpoint} failed after ${maxRetries} retries`);
  }

  async function apiRaw(endpoint: string, options: RequestInit = {}): Promise<{ status: number; body: any }> {
    const res = await fetch(`${server}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...options.headers,
      },
    });
    return { status: res.status, body: await res.json() };
  }

  return { api, apiRaw };
}

// ---------------------------------------------------------------------------
// Cleanup tracker
// ---------------------------------------------------------------------------

export function createCleanup(api: ReturnType<typeof createTestApi>['api']) {
  const taskIds: string[] = [];
  const workerIds: string[] = [];
  let cleanupDone = false;

  async function runCleanup() {
    if (cleanupDone) return;
    cleanupDone = true;

    console.log(`Cleanup: ${workerIds.length} workers, ${taskIds.length} tasks...`);

    // Clean workers and tasks in parallel to avoid timeouts
    await Promise.all([
      ...workerIds.map(wid =>
        api(`/api/workers/${wid}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'failed', error: 'Test cleanup' }),
        }).catch(err => {
          console.log(`  Warning: failed to clean worker ${wid}: ${err.message}`);
        })
      ),
      ...taskIds.map(tid =>
        api(`/api/tasks/${tid}?force=true`, { method: 'DELETE' }).catch(err => {
          console.log(`  Warning: failed to clean task ${tid}: ${err.message}`);
        })
      ),
    ]);
  }

  // Register SIGINT handler so Ctrl+C still cleans up
  const handler = () => {
    console.log('\nSIGINT received — running cleanup before exit...');
    runCleanup().finally(() => process.exit(1));
  };
  process.on('SIGINT', handler);

  return {
    trackTask(id: string) { taskIds.push(id); },
    trackWorker(id: string) { workerIds.push(id); },
    runCleanup,
    /** Remove SIGINT handler (call in afterAll after runCleanup) */
    dispose() { process.removeListener('SIGINT', handler); },
  };
}
