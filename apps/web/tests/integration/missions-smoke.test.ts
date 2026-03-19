/**
 * Smoke Tests: Missions API
 *
 * Lightweight guards that always run in CI. Catches endpoint renames,
 * auth regressions, and basic CRUD breakage.
 *
 * Prerequisites:
 *   - BUILDD_TEST_SERVER set (preview or local URL)
 *   - BUILDD_ADMIN_API_KEY or BUILDD_API_KEY set
 *
 * Usage:
 *   bun run test:integration missions-smoke
 */

import { describe, test, beforeAll, afterAll, expect } from 'bun:test';
import { requireTestEnv, createTestApi, createCleanup } from '../../../../tests/test-utils';

const TIMEOUT = 15_000;

const { server: SERVER, apiKey: API_KEY } = requireTestEnv();
const { api, apiRaw } = createTestApi(SERVER, API_KEY);

let cleanup: ReturnType<typeof createCleanup>;
let missionId: string;

beforeAll(() => { cleanup = createCleanup(api); });
afterAll(async () => { await cleanup.runCleanup(); cleanup.dispose(); });

describe('Missions smoke', () => {
  test('POST /api/missions — create', async () => {
    const mission = await api('/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Smoke test mission', description: 'CI smoke test' }),
    });
    expect(mission.id).toBeDefined();
    missionId = mission.id;
    cleanup.trackMission(missionId);
  }, TIMEOUT);

  test('GET /api/missions/{id} — read', async () => {
    const mission = await api(`/api/missions/${missionId}`);
    expect(mission.id).toBe(missionId);
    expect(mission.title).toBe('Smoke test mission');
  }, TIMEOUT);

  test('PATCH /api/missions/{id} — update', async () => {
    const updated = await api(`/api/missions/${missionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Updated smoke mission' }),
    });
    expect(updated.title).toBe('Updated smoke mission');
  }, TIMEOUT);

  test('GET /api/missions — list includes created', async () => {
    const list = await api('/api/missions');
    const missions = Array.isArray(list) ? list : list.missions ?? list.data ?? [];
    const found = missions.find((m: any) => m.id === missionId);
    expect(found).toBeDefined();
  }, TIMEOUT);

  test('DELETE /api/missions/{id} — cleanup', async () => {
    const { status } = await apiRaw(`/api/missions/${missionId}`, { method: 'DELETE' });
    expect(status).toBe(200);
  }, TIMEOUT);

  test('GET /api/missions — 401 without auth', async () => {
    const res = await fetch(`${SERVER}/api/missions`, {
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(401);
  }, TIMEOUT);

  test('GET /api/missions/{id} — verify missions endpoint works', async () => {
    const res = await fetch(`${SERVER}/api/missions/${missionId}`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
    });
    expect(res.status).toBe(200);
  }, TIMEOUT);
});
