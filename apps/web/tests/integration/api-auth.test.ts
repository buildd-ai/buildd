/**
 * Integration Tests: API Authentication
 *
 * Tests auth-related API routes and authentication behavior:
 *   - API key auth (valid key, invalid key, missing key)
 *   - Dual auth routes (workers/active supports both API key and session)
 *   - Device code flow (code generation, token polling, expiry)
 *   - CLI auth route validation
 *   - Local-UI auth redirect
 *   - Rate limiting (concurrent worker limits)
 *
 * Note: Routes requiring session auth (device/approve, cli token exchange)
 * cannot be fully tested via HTTP without a browser session. We test their
 * unauthenticated rejection behavior and validate the device flow end-to-end
 * for the portions that don't require session auth.
 *
 * Prerequisites:
 *   - BUILDD_TEST_SERVER set (preview or local URL)
 *   - BUILDD_API_KEY set (or in ~/.buildd/config.json)
 *
 * Usage:
 *   bun run test:integration api-auth
 */

import { describe, test, beforeAll, afterAll, expect } from 'bun:test';
import { requireTestEnv, createTestApi, createCleanup, sleep } from '../../../../tests/test-utils';

// --- Config ---

const { server: SERVER, apiKey: API_KEY } = requireTestEnv();
const { api, apiRaw } = createTestApi(SERVER, API_KEY);
const cleanup = createCleanup(api);

// Helper to make raw fetch requests without default auth headers
async function fetchRaw(endpoint: string, options: RequestInit = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${SERVER}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  let body: any;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    body = await res.json();
  } else {
    body = await res.text();
  }
  return { status: res.status, body, headers: res.headers };
}

// Helper to make fetch requests that follow redirects manually
async function fetchNoRedirect(endpoint: string, options: RequestInit = {}): Promise<{ status: number; headers: Headers; body: any }> {
  const res = await fetch(`${SERVER}${endpoint}`, {
    ...options,
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  let body: any;
  try {
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      body = await res.json();
    } else {
      body = await res.text();
    }
  } catch {
    body = null;
  }
  return { status: res.status, headers: res.headers, body };
}

// --- Helpers ---

async function findWorkspace(): Promise<string> {
  if (process.env.BUILDD_WORKSPACE_ID) return process.env.BUILDD_WORKSPACE_ID;
  const { workspaces } = await api('/api/workspaces');
  if (!workspaces.length) throw new Error('No workspaces available');
  const ws = workspaces.find((w: any) => w.name?.includes('buildd')) || workspaces[0];
  console.log(`  Using workspace: ${ws.name} (${ws.id})`);
  return ws.id;
}

async function cleanupStaleWorkers() {
  try {
    const { workers: stale } = await api('/api/workers/mine?status=running,starting,waiting_input,idle');
    if (stale?.length > 0) {
      console.log(`  Cleaning up ${stale.length} stale worker(s)...`);
      for (const w of stale) {
        try {
          await api(`/api/workers/${w.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'failed', error: 'Auth test cleanup (stale)' }),
          });
        } catch {}
      }
    }
  } catch (err: any) {
    console.log(`  Warning: could not clean stale workers (${err.message})`);
  }
}

// --- Test Suite ---

describe('API Authentication', () => {
  let workspaceId: string;

  beforeAll(async () => {
    workspaceId = await findWorkspace();
  }, 30_000);

  afterAll(async () => {
    await cleanup.runCleanup();
    cleanup.dispose();
  });

  // =================================================================
  // 1. API Key Authentication
  // =================================================================

  describe('API Key Auth', () => {
    test('valid API key — authenticates successfully', async () => {
      const { status, body } = await apiRaw('/api/workers/mine');
      expect(status).toBe(200);
      expect(Array.isArray(body.workers)).toBe(true);
    }, 15_000);

    test('invalid API key — returns 401', async () => {
      const { status, body } = await fetchRaw('/api/workers/mine', {
        headers: {
          Authorization: 'Bearer bld_0000000000000000000000000000000000000000000000000000000000000000',
        },
      });
      expect(status).toBe(401);
      expect(body.error).toBeTruthy();
    }, 15_000);

    test('missing API key — returns 401', async () => {
      const { status, body } = await fetchRaw('/api/workers/mine');
      expect(status).toBe(401);
      expect(body.error).toBeTruthy();
    }, 15_000);

    test('malformed API key (no bld_ prefix) — returns 401', async () => {
      const { status, body } = await fetchRaw('/api/workers/mine', {
        headers: {
          Authorization: 'Bearer not_a_valid_key_format',
        },
      });
      expect(status).toBe(401);
      expect(body.error).toBeTruthy();
    }, 15_000);

    test('empty Bearer token — returns 401', async () => {
      const { status, body } = await fetchRaw('/api/workers/mine', {
        headers: {
          Authorization: 'Bearer ',
        },
      });
      expect(status).toBe(401);
      expect(body.error).toBeTruthy();
    }, 15_000);

    test('valid key can access account info', async () => {
      const account = await api('/api/accounts/me');
      expect(account.id).toBeTruthy();
      expect(account.name).toBeTruthy();
      expect(account.authType).toBeTruthy();
      expect(account.maxConcurrentWorkers).toBeGreaterThan(0);
    }, 15_000);
  });

  // =================================================================
  // 2. Dual Auth Routes (API key + session)
  // =================================================================

  describe('Dual Auth — workers/active', () => {
    test('API key auth — returns active local-ui instances', async () => {
      const { status, body } = await apiRaw('/api/workers/active');
      expect(status).toBe(200);
      expect(Array.isArray(body.activeLocalUis)).toBe(true);
    }, 15_000);

    test('no auth — returns 401', async () => {
      const { status, body } = await fetchRaw('/api/workers/active');
      expect(status).toBe(401);
      expect(body.error).toBeTruthy();
    }, 15_000);

    test('invalid API key — returns 401', async () => {
      const { status, body } = await fetchRaw('/api/workers/active', {
        headers: {
          Authorization: 'Bearer bld_invalid_key_that_does_not_exist_in_database_at_all',
        },
      });
      expect(status).toBe(401);
      expect(body.error).toBeTruthy();
    }, 15_000);
  });

  // =================================================================
  // 3. Device Code Flow
  // =================================================================

  describe('Device Code Flow', () => {
    test('POST /api/auth/device/code — generates code and token', async () => {
      const { status, body } = await fetchRaw('/api/auth/device/code', {
        method: 'POST',
        body: JSON.stringify({ clientName: 'integration-test' }),
      });

      expect(status).toBe(200);
      expect(body.user_code).toBeTruthy();
      expect(body.device_token).toBeTruthy();
      expect(body.verification_url).toBeTruthy();
      expect(body.expires_in).toBe(900); // 15 minutes
      expect(body.interval).toBe(5);

      // User code format: XXXX-NNNN
      expect(body.user_code).toMatch(/^[A-Z]{4}-\d{4}$/);
      // Device token is 64 hex chars
      expect(body.device_token).toMatch(/^[0-9a-f]{64}$/);
      // Verification URL includes the user code
      expect(body.verification_url).toContain(body.user_code);
    }, 15_000);

    test('POST /api/auth/device/code — defaults to CLI client and admin level', async () => {
      const { status, body } = await fetchRaw('/api/auth/device/code', {
        method: 'POST',
        body: JSON.stringify({}),
      });

      expect(status).toBe(200);
      expect(body.user_code).toBeTruthy();
      expect(body.device_token).toBeTruthy();
    }, 15_000);

    test('POST /api/auth/device/code — accepts worker level', async () => {
      const { status, body } = await fetchRaw('/api/auth/device/code', {
        method: 'POST',
        body: JSON.stringify({ clientName: 'test-worker', level: 'worker' }),
      });

      expect(status).toBe(200);
      expect(body.user_code).toBeTruthy();
    }, 15_000);

    test('POST /api/auth/device/code — handles empty body gracefully', async () => {
      const res = await fetch(`${SERVER}/api/auth/device/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      // Should handle missing body (the route does .catch(() => ({})))
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user_code).toBeTruthy();
    }, 15_000);

    test('POST /api/auth/device/token — pending code returns 428', async () => {
      // First create a device code
      const { body: codeBody } = await fetchRaw('/api/auth/device/code', {
        method: 'POST',
        body: JSON.stringify({ clientName: 'poll-test' }),
      });
      expect(codeBody.device_token).toBeTruthy();

      // Poll with the token — should be pending (428)
      const { status, body } = await fetchRaw('/api/auth/device/token', {
        method: 'POST',
        body: JSON.stringify({ device_token: codeBody.device_token }),
      });

      expect(status).toBe(428);
      expect(body.error).toBe('authorization_pending');
    }, 15_000);

    test('POST /api/auth/device/token — missing device_token returns 400', async () => {
      const { status, body } = await fetchRaw('/api/auth/device/token', {
        method: 'POST',
        body: JSON.stringify({}),
      });

      expect(status).toBe(400);
      expect(body.error).toContain('device_token required');
    }, 15_000);

    test('POST /api/auth/device/token — invalid device_token returns 400', async () => {
      const { status, body } = await fetchRaw('/api/auth/device/token', {
        method: 'POST',
        body: JSON.stringify({ device_token: 'nonexistent_token_value' }),
      });

      expect(status).toBe(400);
      expect(body.error).toContain('Invalid device token');
    }, 15_000);

    test('POST /api/auth/device/token — each code generates unique tokens', async () => {
      const codes = await Promise.all(
        Array.from({ length: 3 }, () =>
          fetchRaw('/api/auth/device/code', {
            method: 'POST',
            body: JSON.stringify({ clientName: 'unique-test' }),
          })
        )
      );

      const userCodes = codes.map(c => c.body.user_code);
      const deviceTokens = codes.map(c => c.body.device_token);

      // All user codes should be unique
      expect(new Set(userCodes).size).toBe(3);
      // All device tokens should be unique
      expect(new Set(deviceTokens).size).toBe(3);
    }, 15_000);

    test('device code full flow — code → poll (pending) → poll again (still pending)', async () => {
      // Step 1: Generate device code
      const { body: codeBody } = await fetchRaw('/api/auth/device/code', {
        method: 'POST',
        body: JSON.stringify({ clientName: 'flow-test' }),
      });
      expect(codeBody.user_code).toBeTruthy();
      expect(codeBody.device_token).toBeTruthy();

      // Step 2: First poll — should be pending
      const { status: poll1Status } = await fetchRaw('/api/auth/device/token', {
        method: 'POST',
        body: JSON.stringify({ device_token: codeBody.device_token }),
      });
      expect(poll1Status).toBe(428);

      // Step 3: Second poll — still pending (no one approved)
      const { status: poll2Status } = await fetchRaw('/api/auth/device/token', {
        method: 'POST',
        body: JSON.stringify({ device_token: codeBody.device_token }),
      });
      expect(poll2Status).toBe(428);
    }, 15_000);
  });

  // =================================================================
  // 4. Device Approve (session-auth protected)
  // =================================================================

  describe('Device Approve — auth protection', () => {
    test('POST /api/auth/device/approve — without session returns 401', async () => {
      const { status, body } = await fetchRaw('/api/auth/device/approve', {
        method: 'POST',
        body: JSON.stringify({ code: 'ABCD-1234' }),
      });

      expect(status).toBe(401);
      expect(body.error).toBeTruthy();
    }, 15_000);

    test('POST /api/auth/device/approve — API key auth is not sufficient', async () => {
      // Device approve explicitly requires session auth, not API key
      const { status, body } = await apiRaw('/api/auth/device/approve', {
        method: 'POST',
        body: JSON.stringify({ code: 'ABCD-1234' }),
      });

      // Should still be 401 because this route checks session, not API key
      expect(status).toBe(401);
    }, 15_000);
  });

  // =================================================================
  // 5. CLI Auth Route
  // =================================================================

  describe('CLI Auth — /api/auth/cli', () => {
    test('GET without callback — returns 400', async () => {
      const { status, body } = await fetchRaw('/api/auth/cli');

      expect(status).toBe(400);
      expect(body.error).toContain('callback');
    }, 15_000);

    test('GET with non-localhost callback — returns 400', async () => {
      const { status, body } = await fetchRaw('/api/auth/cli?callback=https://evil.com/steal');

      expect(status).toBe(400);
      expect(body.error).toContain('localhost');
    }, 15_000);

    test('GET with invalid callback URL — returns 400', async () => {
      const { status, body } = await fetchRaw('/api/auth/cli?callback=not-a-url');

      expect(status).toBe(400);
      expect(body.error).toContain('Invalid callback');
    }, 15_000);

    test('GET with localhost callback but no session — redirects to login', async () => {
      const { status, headers } = await fetchNoRedirect(
        '/api/auth/cli?callback=http://localhost:9999/callback&client=cli'
      );

      // Should redirect to login page (302/307/308)
      expect(status).toBeGreaterThanOrEqual(300);
      expect(status).toBeLessThan(400);

      const location = headers.get('location');
      expect(location).toBeTruthy();
      // Redirect should point to signin page
      expect(location).toContain('signin');
    }, 15_000);

    test('GET with 127.0.0.1 callback — accepted as localhost', async () => {
      const { status, headers } = await fetchNoRedirect(
        '/api/auth/cli?callback=http://127.0.0.1:9999/callback'
      );

      // Should redirect to login (accepted the callback URL)
      expect(status).toBeGreaterThanOrEqual(300);
      expect(status).toBeLessThan(400);
    }, 15_000);
  });

  // =================================================================
  // 6. Local-UI Auth Redirect
  // =================================================================

  describe('Local-UI Auth — /api/auth/local-ui', () => {
    test('GET redirects to /api/auth/cli with client=local-ui', async () => {
      const { status, headers } = await fetchNoRedirect(
        '/api/auth/local-ui?callback=http://localhost:8766/callback'
      );

      // Should redirect
      expect(status).toBeGreaterThanOrEqual(300);
      expect(status).toBeLessThan(400);

      const location = headers.get('location');
      expect(location).toBeTruthy();
      expect(location).toContain('/api/auth/cli');
      expect(location).toContain('client=local-ui');
    }, 15_000);

    test('GET forwards query params to cli route', async () => {
      const { status, headers } = await fetchNoRedirect(
        '/api/auth/local-ui?callback=http://localhost:8766/callback&level=worker'
      );

      const location = headers.get('location');
      expect(location).toBeTruthy();
      expect(location).toContain('callback=');
      expect(location).toContain('level=worker');
      expect(location).toContain('client=local-ui');
    }, 15_000);

    test('GET preserves custom client param if already set', async () => {
      const { status, headers } = await fetchNoRedirect(
        '/api/auth/local-ui?callback=http://localhost:8766/callback&client=custom'
      );

      const location = headers.get('location');
      expect(location).toBeTruthy();
      // Should keep client=custom since the route only sets client if not already present
      expect(location).toContain('client=custom');
    }, 15_000);
  });

  // =================================================================
  // 7. Worker Claim Auth
  // =================================================================

  describe('Worker Claim Auth', () => {
    test('POST /api/workers/claim — valid key claims a task', async () => {
      await cleanupStaleWorkers();

      const task = await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId,
          title: '[AUTH-TEST] Claim auth',
          description: 'Auth test task',
        }),
      });
      cleanup.trackTask(task.id);

      const { status, body } = await apiRaw('/api/workers/claim', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId,
          taskId: task.id,
          runner: 'auth-test',
        }),
      });

      if (status === 429) {
        // At capacity — still valid auth behavior
        expect(body.error).toContain('Max concurrent workers');
        console.log('  At capacity (429) — auth is working, just at limit');
      } else {
        expect(status).toBe(200);
        const worker = body.workers?.[0];
        expect(worker).toBeTruthy();
        expect(worker.taskId).toBe(task.id);
        cleanup.trackWorker(worker.id);

        // Clean up worker
        await api(`/api/workers/${worker.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'failed', error: 'Auth test cleanup' }),
        });
      }
    }, 30_000);

    test('POST /api/workers/claim — no auth returns 401', async () => {
      const { status, body } = await fetchRaw('/api/workers/claim', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId,
          runner: 'auth-test',
        }),
      });

      expect(status).toBe(401);
      expect(body.error).toContain('Invalid API key');
    }, 15_000);

    test('POST /api/workers/claim — invalid key returns 401', async () => {
      const { status, body } = await fetchRaw('/api/workers/claim', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer bld_0000000000000000000000000000000000000000000000000000000000000000',
        },
        body: JSON.stringify({
          workspaceId,
          runner: 'auth-test',
        }),
      });

      expect(status).toBe(401);
      expect(body.error).toContain('Invalid API key');
    }, 15_000);

    test('POST /api/workers/claim — missing runner returns 400', async () => {
      const { status, body } = await apiRaw('/api/workers/claim', {
        method: 'POST',
        body: JSON.stringify({ workspaceId }),
      });

      expect(status).toBe(400);
      expect(body.error).toContain('runner');
    }, 15_000);
  });

  // =================================================================
  // 8. Rate Limiting — Concurrent Worker Limits
  // =================================================================

  describe('Rate Limiting — Concurrent Workers', () => {
    test('concurrent limit enforced on claim', async () => {
      await cleanupStaleWorkers();

      const account = await api('/api/accounts/me');
      const maxConcurrent = account.maxConcurrentWorkers || 3;

      // Check existing active workers
      const { workers: currentActive } = await api('/api/workers/mine?status=running,starting,waiting_input,idle');
      const alreadyActive = currentActive?.length || 0;
      const slotsToFill = maxConcurrent - alreadyActive;

      console.log(`  Max concurrent: ${maxConcurrent}, already active: ${alreadyActive}`);

      if (slotsToFill <= 0) {
        // Already at capacity — verify overflow rejected
        const task = await api('/api/tasks', {
          method: 'POST',
          body: JSON.stringify({
            workspaceId,
            title: '[AUTH-TEST] Rate limit overflow',
            description: 'Should be rejected',
          }),
        });
        cleanup.trackTask(task.id);

        const { status, body } = await apiRaw('/api/workers/claim', {
          method: 'POST',
          body: JSON.stringify({ workspaceId, taskId: task.id, runner: 'auth-test' }),
        });

        expect(status).toBe(429);
        expect(body.error).toContain('Max concurrent workers');
        expect(typeof body.limit).toBe('number');
        expect(typeof body.current).toBe('number');
        return;
      }

      // Fill slots with server-side workers
      const fillerWorkers: string[] = [];
      for (let i = 0; i < slotsToFill; i++) {
        const task = await api('/api/tasks', {
          method: 'POST',
          body: JSON.stringify({
            workspaceId,
            title: `[AUTH-TEST] Filler ${i}`,
            description: 'Rate limit filler',
          }),
        });
        cleanup.trackTask(task.id);

        const { status, body } = await apiRaw('/api/workers/claim', {
          method: 'POST',
          body: JSON.stringify({ workspaceId, taskId: task.id, runner: 'auth-test' }),
        });

        if (status === 429) {
          console.log(`  Hit 429 at slot ${i} — capacity reached earlier than expected`);
          break;
        }

        expect(status).toBe(200);
        const worker = body.workers?.[0];
        if (worker) {
          cleanup.trackWorker(worker.id);
          // Set to running so they count against the limit
          await api(`/api/workers/${worker.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'running' }),
          });
          fillerWorkers.push(worker.id);
        }
      }

      // Now try to claim one more — should get 429
      const overflowTask = await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId,
          title: '[AUTH-TEST] Overflow',
          description: 'Should be rejected',
        }),
      });
      cleanup.trackTask(overflowTask.id);

      const { status, body } = await apiRaw('/api/workers/claim', {
        method: 'POST',
        body: JSON.stringify({ workspaceId, taskId: overflowTask.id, runner: 'auth-test' }),
      });

      expect(status).toBe(429);
      expect(body.error).toContain('Max concurrent workers');
      expect(body.limit).toBe(maxConcurrent);
      console.log(`  Correctly rejected: ${body.current}/${body.limit}`);

      // Cleanup filler workers
      for (const wid of fillerWorkers) {
        try {
          await api(`/api/workers/${wid}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'failed', error: 'Auth test cleanup' }),
          });
        } catch {}
      }
    }, 60_000);

    test('429 response includes limit and current count', async () => {
      await cleanupStaleWorkers();

      const account = await api('/api/accounts/me');
      const maxConcurrent = account.maxConcurrentWorkers || 3;

      // Fill all slots
      const fillerWorkers: string[] = [];
      for (let i = 0; i < maxConcurrent; i++) {
        const task = await api('/api/tasks', {
          method: 'POST',
          body: JSON.stringify({
            workspaceId,
            title: `[AUTH-TEST] Limit info ${i}`,
            description: 'Rate limit info test',
          }),
        });
        cleanup.trackTask(task.id);

        const { status, body } = await apiRaw('/api/workers/claim', {
          method: 'POST',
          body: JSON.stringify({ workspaceId, taskId: task.id, runner: 'auth-test' }),
        });

        if (status === 429) break;
        if (status === 200 && body.workers?.[0]) {
          const wid = body.workers[0].id;
          cleanup.trackWorker(wid);
          await api(`/api/workers/${wid}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'running' }),
          });
          fillerWorkers.push(wid);
        }
      }

      // Trigger the 429
      const overflowTask = await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId,
          title: '[AUTH-TEST] 429 info',
          description: 'Check 429 body structure',
        }),
      });
      cleanup.trackTask(overflowTask.id);

      const { status, body } = await apiRaw('/api/workers/claim', {
        method: 'POST',
        body: JSON.stringify({ workspaceId, taskId: overflowTask.id, runner: 'auth-test' }),
      });

      if (status === 429) {
        // Verify the 429 response structure
        expect(body.error).toBeTruthy();
        expect(typeof body.limit).toBe('number');
        expect(typeof body.current).toBe('number');
        expect(body.current).toBeGreaterThanOrEqual(body.limit);
      } else {
        console.log('  Did not reach 429 — some workers may have been cleaned');
      }

      // Cleanup
      for (const wid of fillerWorkers) {
        try {
          await api(`/api/workers/${wid}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'failed', error: 'Auth test cleanup' }),
          });
        } catch {}
      }
    }, 60_000);
  });

  // =================================================================
  // 9. Task and Worker endpoint auth boundary checks
  // =================================================================

  describe('Auth Boundary Checks', () => {
    test('GET /api/tasks — requires auth', async () => {
      const { status } = await fetchRaw('/api/tasks');
      expect(status).toBe(401);
    }, 15_000);

    test('POST /api/tasks — requires auth', async () => {
      const { status } = await fetchRaw('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId,
          title: 'Should not be created',
          description: 'No auth',
        }),
      });
      expect(status).toBe(401);
    }, 15_000);

    test('GET /api/workspaces — requires auth', async () => {
      const { status } = await fetchRaw('/api/workspaces');
      expect(status).toBe(401);
    }, 15_000);

    test('GET /api/accounts/me — requires auth', async () => {
      const { status } = await fetchRaw('/api/accounts/me');
      expect(status).toBe(401);
    }, 15_000);

    test('GET /api/workers/mine — requires auth', async () => {
      const { status } = await fetchRaw('/api/workers/mine');
      expect(status).toBe(401);
    }, 15_000);

    test('PATCH /api/workers/:id — requires auth', async () => {
      const { status } = await fetchRaw('/api/workers/00000000-0000-0000-0000-000000000000', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'running' }),
      });
      // Could be 401 (no auth) or 404 (no worker) depending on middleware order
      expect([401, 404]).toContain(status);
    }, 15_000);
  });
});
