/**
 * Integration test: Heartbeat checklist CRUD
 *
 * Tests:
 *   1. GET checklist (initially empty)
 *   2. PATCH to set checklist items
 *   3. PATCH validates array-of-strings format
 *   4. GET returns updated checklist
 *   5. PATCH to clear checklist
 *
 * Prerequisites:
 *   - BUILDD_TEST_SERVER set (preview or local URL)
 *   - BUILDD_ADMIN_API_KEY or BUILDD_API_KEY set (heartbeat endpoints require admin-level key)
 *
 * Usage:
 *   bun test apps/web/tests/integration/heartbeat-checklist.test.ts
 */

import { describe, test, beforeAll, afterAll, expect } from 'bun:test';
import { requireTestEnv, createTestApi } from '../../../../tests/test-utils';

const TIMEOUT = 30_000;

const { server, apiKey: _defaultKey } = requireTestEnv();

// Heartbeat endpoints require admin-level API key
const ADMIN_KEY = process.env.BUILDD_ADMIN_API_KEY || process.env.BUILDD_API_KEY;
if (!ADMIN_KEY) {
  console.log('⏭️  Skipping: BUILDD_ADMIN_API_KEY (or BUILDD_API_KEY) not set (heartbeat tests require admin key)');
  process.exit(0);
}

const { api, apiRaw } = createTestApi(server, ADMIN_KEY);

describe('Heartbeat Checklist', () => {
  let workspaceId: string;

  beforeAll(async () => {
    const { workspaces } = await api('/api/workspaces');
    if (!workspaces.length) throw new Error('No workspaces available for testing');
    workspaceId = workspaces[0].id;
    console.log(`  Using workspace: ${workspaces[0].name} (${workspaceId})`);
  }, TIMEOUT);

  afterAll(async () => {
    // Reset checklist to empty
    await api(`/api/workspaces/${workspaceId}/heartbeat`, {
      method: 'PATCH',
      body: JSON.stringify({ checklist: [] }),
    }).catch(() => {});
  });

  test('GET heartbeat returns checklist (array)', async () => {
    const { checklist } = await api(`/api/workspaces/${workspaceId}/heartbeat`);
    expect(Array.isArray(checklist)).toBe(true);
  }, TIMEOUT);

  test('PATCH heartbeat sets checklist items', async () => {
    const items = [
      'Check API response times < 500ms',
      'Verify all workers are healthy',
      'Review error rate dashboard',
    ];
    const { checklist } = await api(`/api/workspaces/${workspaceId}/heartbeat`, {
      method: 'PATCH',
      body: JSON.stringify({ checklist: items }),
    });
    expect(checklist).toEqual(items);
  }, TIMEOUT);

  test('GET heartbeat returns updated checklist', async () => {
    const { checklist } = await api(`/api/workspaces/${workspaceId}/heartbeat`);
    expect(checklist).toHaveLength(3);
    expect(checklist[0]).toContain('API response');
  }, TIMEOUT);

  test('PATCH rejects non-array checklist', async () => {
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/heartbeat`, {
      method: 'PATCH',
      body: JSON.stringify({ checklist: 'not an array' }),
    });
    expect(status).toBe(400);
    expect(body.error).toContain('array of strings');
  }, TIMEOUT);

  test('PATCH rejects array with non-string items', async () => {
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/heartbeat`, {
      method: 'PATCH',
      body: JSON.stringify({ checklist: ['valid', 123, true] }),
    });
    expect(status).toBe(400);
    expect(body.error).toContain('array of strings');
  }, TIMEOUT);

  test('PATCH clears checklist with empty array', async () => {
    const { checklist } = await api(`/api/workspaces/${workspaceId}/heartbeat`, {
      method: 'PATCH',
      body: JSON.stringify({ checklist: [] }),
    });
    expect(checklist).toEqual([]);
  }, TIMEOUT);
});
