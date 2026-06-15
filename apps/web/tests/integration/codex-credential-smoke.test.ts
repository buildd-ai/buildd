/**
 * Smoke Tests: Codex Credential API
 *
 * Lightweight guards covering endpoint existence, auth, and CRUD basics.
 *
 * Prerequisites:
 *   - BUILDD_TEST_SERVER set (preview or local URL)
 *   - BUILDD_API_KEY or ~/.buildd/config.json
 *
 * Usage:
 *   bun run test:integration codex-credential-smoke
 */

import { describe, test, beforeAll, expect } from 'bun:test';
import { requireTestEnv, createTestApi } from '../../../../tests/test-utils';

const TIMEOUT = 15_000;

const { server: SERVER, apiKey } = requireTestEnv();
const { api, apiRaw } = createTestApi(SERVER, apiKey);

let workspaceId: string;

beforeAll(async () => {
  if (process.env.BUILDD_WORKSPACE_ID) {
    workspaceId = process.env.BUILDD_WORKSPACE_ID;
  } else {
    const { workspaces } = await api('/api/workspaces');
    if (!workspaces?.length) throw new Error('No workspaces available for smoke test');
    workspaceId = workspaces[0].id;
  }
});

describe('Codex credential smoke', () => {
  test('GET /api/workspaces/[id]/codex-credential — returns 200 with status shape', async () => {
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/codex-credential`);
    expect(status).toBe(200);
    expect(typeof body.connected).toBe('boolean');
    expect(typeof body.expired).toBe('boolean');
  }, TIMEOUT);

  test('GET /api/workspaces/[id]/codex-credential — 401 without auth', async () => {
    const res = await fetch(`${SERVER}/api/workspaces/${workspaceId}/codex-credential`);
    expect(res.status).toBe(401);
  }, TIMEOUT);

  test('DELETE /api/workspaces/[id]/codex-credential — returns 204 (idempotent)', async () => {
    const { status } = await apiRaw(`/api/workspaces/${workspaceId}/codex-credential`, { method: 'DELETE' });
    expect(status).toBe(204);
  }, TIMEOUT);

  test('GET after DELETE — connected: false', async () => {
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/codex-credential`);
    expect(status).toBe(200);
    expect(body.connected).toBe(false);
  }, TIMEOUT);
});
