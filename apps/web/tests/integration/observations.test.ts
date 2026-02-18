/**
 * Integration Tests: Observation System
 *
 * Tests the observation/memory system (gotchas, patterns, decisions, discoveries, architecture)
 * which enables agent knowledge sharing across tasks within a workspace.
 *
 * Tests cover:
 *   1. Create observation (POST /api/workspaces/[id]/observations)
 *   2. List observations (GET /api/workspaces/[id]/observations)
 *   3. Search observations by type, keywords, files, concepts
 *   4. Batch observation creation
 *   5. Observation deduplication (same title/content should not create duplicates)
 *   6. FK validation (valid workspaceId required)
 *   7. All observation types: gotcha, pattern, decision, discovery, architecture
 *   8. Workspace isolation (observations from workspace A not visible in workspace B)
 *
 * Prerequisites:
 *   - BUILDD_TEST_SERVER set (preview or local URL)
 *   - BUILDD_API_KEY set (or in ~/.buildd/config.json)
 *
 * Usage:
 *   bun run test:integration observations
 *
 * Env vars:
 *   BUILDD_TEST_SERVER   - required (preview or local URL)
 *   BUILDD_API_KEY       - required (or config.json)
 *   BUILDD_WORKSPACE_ID  - optional, auto-picks first workspace
 */

import { describe, test, beforeAll, afterAll, expect } from 'bun:test';
import { requireTestEnv, createTestApi } from '../../../../tests/test-utils';

// --- Config ---

const TIMEOUT = 30_000;

const { server: SERVER, apiKey: API_KEY } = requireTestEnv();
const { api, apiRaw } = createTestApi(SERVER, API_KEY);

// --- Helpers ---

const createdObservationIds: string[] = [];
let workspaceId: string;

/** Generate a unique marker for test isolation */
function marker(): string {
  return `TEST_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function findWorkspace(): Promise<string> {
  if (process.env.BUILDD_WORKSPACE_ID) return process.env.BUILDD_WORKSPACE_ID;
  const { workspaces } = await api('/api/workspaces');
  if (!workspaces.length) throw new Error('No workspaces available');
  const ws = workspaces.find((w: any) => w.name?.includes('buildd')) || workspaces[0];
  console.log(`  Using workspace: ${ws.name} (${ws.id})`);
  return ws.id;
}

async function createObservation(wsId: string, data: {
  type: string;
  title: string;
  content: string;
  files?: string[];
  concepts?: string[];
}): Promise<any> {
  const { observation } = await api(`/api/workspaces/${wsId}/observations`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
  createdObservationIds.push(observation.id);
  return observation;
}

async function cleanupObservations() {
  // Best-effort cleanup — delete observations we created
  for (const id of createdObservationIds) {
    try {
      await api(`/api/workspaces/${workspaceId}/observations/${id}`, {
        method: 'DELETE',
        retries: 0,
      });
    } catch {}
  }
}

// --- Test suite ---

describe('Observation System', () => {
  beforeAll(async () => {
    workspaceId = await findWorkspace();
  }, TIMEOUT);

  afterAll(async () => {
    await cleanupObservations();
  });

  // ---------------------------------------------------------------
  // 1. Create observation — POST /api/workspaces/[id]/observations
  // ---------------------------------------------------------------

  test('create observation — returns 201 with observation data', async () => {
    const mk = marker();
    const observation = await createObservation(workspaceId, {
      type: 'discovery',
      title: `${mk} Test Discovery`,
      content: `Integration test: creating an observation with marker ${mk}`,
      files: ['tests/integration/observations.test.ts'],
      concepts: ['testing', 'observations'],
    });

    expect(observation.id).toBeTruthy();
    expect(observation.type).toBe('discovery');
    expect(observation.title).toContain(mk);
    expect(observation.content).toContain(mk);
    expect(observation.workspaceId).toBe(workspaceId);
    expect(observation.files).toContain('tests/integration/observations.test.ts');
    expect(observation.concepts).toContain('testing');
  }, TIMEOUT);

  test('create observation — returns 400 for invalid type', async () => {
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/observations`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'invalid_type',
        title: 'Bad type',
        content: 'This should fail',
      }),
    });

    expect(status).toBe(400);
    expect(body.error).toContain('Invalid type');
  }, TIMEOUT);

  test('create observation — returns 400 when title missing', async () => {
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/observations`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'discovery',
        content: 'Missing title',
      }),
    });

    expect(status).toBe(400);
    expect(body.error).toContain('title and content are required');
  }, TIMEOUT);

  test('create observation — returns 400 when content missing', async () => {
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/observations`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'discovery',
        title: 'Missing content',
      }),
    });

    expect(status).toBe(400);
    expect(body.error).toContain('title and content are required');
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 2. List observations — GET /api/workspaces/[id]/observations
  // ---------------------------------------------------------------

  test('list observations — returns observations array', async () => {
    const mk = marker();
    await createObservation(workspaceId, {
      type: 'pattern',
      title: `${mk} List Test`,
      content: `Created for listing test ${mk}`,
    });

    const { observations } = await api(
      `/api/workspaces/${workspaceId}/observations?limit=50`
    );

    expect(Array.isArray(observations)).toBe(true);
    expect(observations.some((o: any) => o.title.includes(mk))).toBe(true);
  }, TIMEOUT);

  test('list observations — filters by type', async () => {
    const mk = marker();
    await createObservation(workspaceId, {
      type: 'gotcha',
      title: `${mk} Gotcha Filter`,
      content: `Created for type filter test ${mk}`,
    });

    const { observations } = await api(
      `/api/workspaces/${workspaceId}/observations?type=gotcha&limit=50`
    );

    expect(observations.every((o: any) => o.type === 'gotcha')).toBe(true);
    expect(observations.some((o: any) => o.title.includes(mk))).toBe(true);
  }, TIMEOUT);

  test('list observations — supports text search', async () => {
    const mk = marker();
    const uniquePhrase = `UNIQUE_PHRASE_${mk}`;
    await createObservation(workspaceId, {
      type: 'discovery',
      title: `${mk} Searchable`,
      content: `This observation contains the ${uniquePhrase} for search testing`,
    });

    const { observations } = await api(
      `/api/workspaces/${workspaceId}/observations?search=${encodeURIComponent(uniquePhrase)}&limit=50`
    );

    expect(observations.length).toBeGreaterThanOrEqual(1);
    expect(observations.some((o: any) => o.content.includes(uniquePhrase))).toBe(true);
  }, TIMEOUT);

  test('list observations — respects limit and offset', async () => {
    const { observations: firstPage } = await api(
      `/api/workspaces/${workspaceId}/observations?limit=2&offset=0`
    );
    expect(firstPage.length).toBeLessThanOrEqual(2);

    if (firstPage.length === 2) {
      const { observations: secondPage } = await api(
        `/api/workspaces/${workspaceId}/observations?limit=2&offset=2`
      );
      // Second page should not contain first page items (they are ordered by createdAt desc)
      const firstIds = new Set(firstPage.map((o: any) => o.id));
      for (const obs of secondPage) {
        expect(firstIds.has(obs.id)).toBe(false);
      }
    }
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 3. Search observations — GET /api/workspaces/[id]/observations/search
  // ---------------------------------------------------------------

  test('search observations — by query keyword', async () => {
    const mk = marker();
    await createObservation(workspaceId, {
      type: 'decision',
      title: `${mk} Search Query`,
      content: `Keyword search test for ${mk}`,
    });

    const { results, total } = await api(
      `/api/workspaces/${workspaceId}/observations/search?query=${encodeURIComponent(mk)}`
    );

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(total).toBeGreaterThanOrEqual(1);
    expect(results.some((r: any) => r.title.includes(mk))).toBe(true);
    // Search returns compact format (no content field)
    expect(results[0].id).toBeTruthy();
    expect(results[0].title).toBeTruthy();
    expect(results[0].type).toBeTruthy();
  }, TIMEOUT);

  test('search observations — by type filter', async () => {
    const mk = marker();
    await createObservation(workspaceId, {
      type: 'architecture',
      title: `${mk} Arch Search`,
      content: `Architecture search test ${mk}`,
    });

    const { results } = await api(
      `/api/workspaces/${workspaceId}/observations/search?type=architecture&query=${encodeURIComponent(mk)}`
    );

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r: any) => r.type === 'architecture')).toBe(true);
  }, TIMEOUT);

  test('search observations — by file path', async () => {
    const mk = marker();
    const uniqueFile = `src/unique-file-${mk}.ts`;
    await createObservation(workspaceId, {
      type: 'pattern',
      title: `${mk} File Search`,
      content: `File search test ${mk}`,
      files: [uniqueFile, 'src/other.ts'],
    });

    const { results } = await api(
      `/api/workspaces/${workspaceId}/observations/search?files=${encodeURIComponent(uniqueFile)}`
    );

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r: any) => r.title.includes(mk))).toBe(true);
  }, TIMEOUT);

  test('search observations — returns pagination metadata', async () => {
    const { results, total, limit, offset } = await api(
      `/api/workspaces/${workspaceId}/observations/search?limit=5&offset=0`
    );

    expect(Array.isArray(results)).toBe(true);
    expect(typeof total).toBe('number');
    expect(limit).toBe(5);
    expect(offset).toBe(0);
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 4. Batch observation retrieval
  // ---------------------------------------------------------------

  test('batch get — retrieves multiple observations by ID', async () => {
    const mk = marker();
    const obs1 = await createObservation(workspaceId, {
      type: 'discovery',
      title: `${mk} Batch 1`,
      content: `Batch test 1 ${mk}`,
    });
    const obs2 = await createObservation(workspaceId, {
      type: 'gotcha',
      title: `${mk} Batch 2`,
      content: `Batch test 2 ${mk}`,
    });

    const { observations } = await api(
      `/api/workspaces/${workspaceId}/observations/batch?ids=${obs1.id},${obs2.id}`
    );

    expect(observations.length).toBe(2);
    const ids = observations.map((o: any) => o.id);
    expect(ids).toContain(obs1.id);
    expect(ids).toContain(obs2.id);
  }, TIMEOUT);

  test('batch get — returns 400 when ids param missing', async () => {
    const { status, body } = await apiRaw(
      `/api/workspaces/${workspaceId}/observations/batch`
    );

    expect(status).toBe(400);
    expect(body.error).toContain('ids');
  }, TIMEOUT);

  test('batch get — returns 400 for invalid UUID format', async () => {
    const { status, body } = await apiRaw(
      `/api/workspaces/${workspaceId}/observations/batch?ids=not-a-uuid`
    );

    expect(status).toBe(400);
    expect(body.error).toContain('Invalid UUID');
  }, TIMEOUT);

  test('batch get — returns empty array for non-existent IDs', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const { observations } = await api(
      `/api/workspaces/${workspaceId}/observations/batch?ids=${fakeId}`
    );

    expect(observations.length).toBe(0);
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 5. Observation deduplication
  // ---------------------------------------------------------------

  test('deduplication — creating same title+content yields distinct IDs (no server-side dedup)', async () => {
    const mk = marker();
    const data = {
      type: 'decision' as const,
      title: `${mk} Dedup Test`,
      content: `Dedup content test ${mk}`,
    };

    const obs1 = await createObservation(workspaceId, data);
    const obs2 = await createObservation(workspaceId, data);

    // The API creates distinct records (dedup is a client/MCP responsibility)
    expect(obs1.id).not.toBe(obs2.id);
    expect(obs1.title).toBe(obs2.title);
    expect(obs1.content).toBe(obs2.content);

    // Both should be retrievable
    const { observations } = await api(
      `/api/workspaces/${workspaceId}/observations?search=${encodeURIComponent(mk)}&limit=50`
    );
    const matching = observations.filter((o: any) => o.title.includes(mk));
    expect(matching.length).toBeGreaterThanOrEqual(2);
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 6. FK validation — valid workspaceId required
  // ---------------------------------------------------------------

  test('FK validation — non-existent workspace returns error', async () => {
    const fakeWorkspaceId = '00000000-0000-0000-0000-000000000000';
    const { status } = await apiRaw(`/api/workspaces/${fakeWorkspaceId}/observations`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'discovery',
        title: 'FK test',
        content: 'Should fail with bad workspace ID',
      }),
    });

    // Should return 404 (workspace not found) or 500 (FK violation)
    expect(status).toBeGreaterThanOrEqual(400);
  }, TIMEOUT);

  test('FK validation — non-existent workspace returns error on GET', async () => {
    const fakeWorkspaceId = '00000000-0000-0000-0000-000000000000';
    const { status } = await apiRaw(`/api/workspaces/${fakeWorkspaceId}/observations`);

    // Should return 404 (access denied / workspace not found)
    expect(status).toBeGreaterThanOrEqual(400);
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 7. All observation types — gotcha, pattern, decision, discovery, architecture
  // ---------------------------------------------------------------

  test('all types — each valid type can be created and retrieved', async () => {
    const mk = marker();
    const types = ['gotcha', 'pattern', 'decision', 'discovery', 'architecture'] as const;

    // Create one of each type
    const created: any[] = [];
    for (const type of types) {
      const obs = await createObservation(workspaceId, {
        type,
        title: `${mk} Type ${type}`,
        content: `Testing type ${type} with marker ${mk}`,
        files: [`src/${type}-example.ts`],
        concepts: [type, 'type-test'],
      });
      created.push(obs);
      expect(obs.type).toBe(type);
    }

    // Verify each type is filterable
    for (const type of types) {
      const { observations } = await api(
        `/api/workspaces/${workspaceId}/observations?type=${type}&search=${encodeURIComponent(mk)}&limit=50`
      );

      const matching = observations.filter((o: any) => o.title.includes(mk));
      expect(matching.length).toBeGreaterThanOrEqual(1);
      expect(matching.every((o: any) => o.type === type)).toBe(true);
    }
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 8. Workspace isolation
  // ---------------------------------------------------------------

  test('workspace isolation — observations scoped to their workspace', async () => {
    const mk = marker();

    // Create an observation in the primary workspace
    const obs = await createObservation(workspaceId, {
      type: 'discovery',
      title: `${mk} Isolation Test`,
      content: `Workspace isolation marker ${mk}`,
    });
    expect(obs.id).toBeTruthy();

    // Get all workspaces to find a second one
    const { workspaces } = await api('/api/workspaces');
    const otherWorkspace = workspaces.find((w: any) => w.id !== workspaceId);

    if (!otherWorkspace) {
      console.log('  SKIP: Only one workspace available — cannot test isolation');
      return;
    }

    console.log(`  Testing isolation between ${workspaceId} and ${otherWorkspace.id}`);

    // Search in the other workspace — should not find our observation
    const { results } = await api(
      `/api/workspaces/${otherWorkspace.id}/observations/search?query=${encodeURIComponent(mk)}`
    );

    const found = results.some((r: any) => r.id === obs.id);
    expect(found).toBe(false);

    // List from other workspace should also not contain our observation
    const { observations } = await api(
      `/api/workspaces/${otherWorkspace.id}/observations?search=${encodeURIComponent(mk)}&limit=50`
    );
    const foundInList = observations.some((o: any) => o.id === obs.id);
    expect(foundInList).toBe(false);

    // Batch get from other workspace should not return our observation
    const { observations: batchObs } = await api(
      `/api/workspaces/${otherWorkspace.id}/observations/batch?ids=${obs.id}`
    );
    expect(batchObs.length).toBe(0);
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 9. Compact digest
  // ---------------------------------------------------------------

  test('compact — returns markdown digest of observations', async () => {
    const mk = marker();
    await createObservation(workspaceId, {
      type: 'gotcha',
      title: `${mk} Compact Test`,
      content: `Compact digest test with marker ${mk}`,
    });

    const { markdown, count } = await api(
      `/api/workspaces/${workspaceId}/observations/compact`
    );

    expect(count).toBeGreaterThan(0);
    expect(typeof markdown).toBe('string');
    expect(markdown).toContain(mk);
    // Should contain section headers
    expect(markdown).toContain('Workspace Memory');
  }, TIMEOUT);
});
