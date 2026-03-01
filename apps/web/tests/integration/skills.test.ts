/**
 * Integration Tests: Skills API
 *
 * Tests the full skills CRUD lifecycle, sync, and install
 * endpoints against a real server with a real database.
 *
 * Covers:
 *   1. List skills (GET /api/workspaces/[id]/skills)
 *   2. Create skill (POST /api/workspaces/[id]/skills)
 *   3. Get skill by ID (GET /api/workspaces/[id]/skills/[skillId])
 *   4. Update skill (PATCH /api/workspaces/[id]/skills/[skillId])
 *   5. Delete skill (DELETE /api/workspaces/[id]/skills/[skillId])
 *   6. Install skill (POST /api/workspaces/[id]/skills/install)
 *   7. Sync skills (POST /api/workspaces/[id]/skills/sync)
 *   8. Workspace access control
 *   9. Skill content validation
 *  10. Skill deduplication on sync
 *
 * Prerequisites:
 *   - BUILDD_TEST_SERVER set (preview or local URL)
 *   - BUILDD_API_KEY set (or in ~/.buildd/config.json)
 *
 * Usage:
 *   bun test apps/web/tests/integration/skills.test.ts
 */

import { describe, test, beforeAll, afterAll, expect } from 'bun:test';
import { createHash } from 'crypto';
import { requireTestEnv, createTestApi, createCleanup } from '../../../../tests/test-utils';

const TIMEOUT = 30_000;

const { server: SERVER, apiKey: API_KEY } = requireTestEnv();
const { api, apiRaw } = createTestApi(SERVER, API_KEY);
const cleanup = createCleanup(api);

let workspaceId: string;
const createdSkillIds: string[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function uniqueName(base: string): string {
  return `[INTEG-TEST] ${base}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function uniqueSlug(base: string): string {
  return `test-${base}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createSkill(overrides: Record<string, unknown> = {}) {
  const name = uniqueName('skill');
  const slug = uniqueSlug('skill');
  const content = `# ${name}\nTest skill content for integration testing.`;

  const { skill } = await api(`/api/workspaces/${workspaceId}/skills`, {
    method: 'POST',
    body: JSON.stringify({ name, slug, content, ...overrides }),
  });
  createdSkillIds.push(skill.id);
  return skill;
}

async function deleteSkill(id: string) {
  try {
    await api(`/api/workspaces/${workspaceId}/skills/${id}`, { method: 'DELETE', retries: 0 });
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (process.env.BUILDD_WORKSPACE_ID) {
    workspaceId = process.env.BUILDD_WORKSPACE_ID;
  } else {
    const { workspaces } = await api('/api/workspaces');
    if (!workspaces.length) throw new Error('No workspaces available for testing');
    const ws = workspaces.find((w: any) => w.name?.includes('buildd')) || workspaces[0];
    workspaceId = ws.id;
    console.log(`  Using workspace: ${ws.name} (${workspaceId})`);
  }
});

afterAll(async () => {
  // Clean up all skills created during tests
  for (const id of createdSkillIds) {
    await deleteSkill(id);
  }
  await cleanup.runCleanup();
  cleanup.dispose();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Skills CRUD', () => {
  let skillId: string;
  let skillSlug: string;

  test('create a skill', async () => {
    const name = uniqueName('create');
    const slug = uniqueSlug('create');
    const content = '# Test Skill\nThis is a test skill.';

    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/skills`, {
      method: 'POST',
      body: JSON.stringify({ name, slug, content, description: 'A test skill' }),
    });

    expect(status).toBe(201);
    expect(body.skill).toBeTruthy();
    expect(body.skill.name).toBe(name);
    expect(body.skill.slug).toBe(slug);
    expect(body.skill.content).toBe(content);
    expect(body.skill.description).toBe('A test skill');
    expect(body.skill.enabled).toBe(true);
    expect(body.skill.origin).toBe('manual');
    expect(body.skill.contentHash).toBe(computeContentHash(content));
    expect(body.skill.workspaceId).toBe(workspaceId);

    skillId = body.skill.id;
    skillSlug = body.skill.slug;
    createdSkillIds.push(skillId);
  }, TIMEOUT);

  test('get skill by ID', async () => {
    expect(skillId).toBeTruthy();

    const { skill } = await api(`/api/workspaces/${workspaceId}/skills/${skillId}`);

    expect(skill.id).toBe(skillId);
    expect(skill.slug).toBe(skillSlug);
    expect(skill.workspaceId).toBe(workspaceId);
  }, TIMEOUT);

  test('list skills returns created skill', async () => {
    const { skills } = await api(`/api/workspaces/${workspaceId}/skills`);

    expect(Array.isArray(skills)).toBe(true);
    const found = skills.find((s: any) => s.id === skillId);
    expect(found).toBeTruthy();
    expect(found.slug).toBe(skillSlug);
  }, TIMEOUT);

  test('update skill fields', async () => {
    expect(skillId).toBeTruthy();

    const newContent = '# Updated\nNew content here.';
    const { skill } = await api(`/api/workspaces/${workspaceId}/skills/${skillId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: 'Updated Skill Name',
        description: 'Updated description',
        content: newContent,
        enabled: false,
      }),
    });

    expect(skill.name).toBe('Updated Skill Name');
    expect(skill.description).toBe('Updated description');
    expect(skill.content).toBe(newContent);
    expect(skill.enabled).toBe(false);
    expect(skill.contentHash).toBe(computeContentHash(newContent));
  }, TIMEOUT);

  test('update skill partial fields (only enabled)', async () => {
    expect(skillId).toBeTruthy();

    const { skill: before } = await api(`/api/workspaces/${workspaceId}/skills/${skillId}`);
    expect(before.enabled).toBe(false);

    const { skill } = await api(`/api/workspaces/${workspaceId}/skills/${skillId}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: true }),
    });

    expect(skill.enabled).toBe(true);
    // Other fields unchanged
    expect(skill.name).toBe(before.name);
    expect(skill.content).toBe(before.content);
  }, TIMEOUT);

  test('delete skill', async () => {
    expect(skillId).toBeTruthy();

    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/skills/${skillId}`, {
      method: 'DELETE',
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);

    // Verify it's gone
    const { status: getStatus } = await apiRaw(`/api/workspaces/${workspaceId}/skills/${skillId}`);
    expect(getStatus).toBe(404);

    // Remove from cleanup list since already deleted
    const idx = createdSkillIds.indexOf(skillId);
    if (idx !== -1) createdSkillIds.splice(idx, 1);
  }, TIMEOUT);
});

describe('Skills list filtering', () => {
  let enabledSkillId: string;
  let disabledSkillId: string;

  beforeAll(async () => {
    const enabled = await createSkill({ enabled: true });
    enabledSkillId = enabled.id;

    const disabled = await createSkill({ enabled: false });
    disabledSkillId = disabled.id;
  });

  test('filter by enabled=true', async () => {
    const { skills } = await api(`/api/workspaces/${workspaceId}/skills?enabled=true`);

    expect(Array.isArray(skills)).toBe(true);
    const foundEnabled = skills.find((s: any) => s.id === enabledSkillId);
    const foundDisabled = skills.find((s: any) => s.id === disabledSkillId);

    expect(foundEnabled).toBeTruthy();
    expect(foundDisabled).toBeFalsy();
  }, TIMEOUT);

  test('filter by enabled=false', async () => {
    const { skills } = await api(`/api/workspaces/${workspaceId}/skills?enabled=false`);

    expect(Array.isArray(skills)).toBe(true);
    const foundEnabled = skills.find((s: any) => s.id === enabledSkillId);
    const foundDisabled = skills.find((s: any) => s.id === disabledSkillId);

    expect(foundEnabled).toBeFalsy();
    expect(foundDisabled).toBeTruthy();
  }, TIMEOUT);

  test('no filter returns all', async () => {
    const { skills } = await api(`/api/workspaces/${workspaceId}/skills`);

    const foundEnabled = skills.find((s: any) => s.id === enabledSkillId);
    const foundDisabled = skills.find((s: any) => s.id === disabledSkillId);

    expect(foundEnabled).toBeTruthy();
    expect(foundDisabled).toBeTruthy();
  }, TIMEOUT);
});

describe('Skills validation', () => {
  test('rejects missing name', async () => {
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/skills`, {
      method: 'POST',
      body: JSON.stringify({ content: 'some content' }),
    });

    expect(status).toBe(400);
    expect(body.error).toContain('name and content are required');
  }, TIMEOUT);

  test('rejects missing content', async () => {
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/skills`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Test Skill' }),
    });

    expect(status).toBe(400);
    expect(body.error).toContain('name and content are required');
  }, TIMEOUT);

  test('rejects invalid slug format', async () => {
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/skills`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Test',
        content: 'content',
        slug: 'INVALID_SLUG!',
      }),
    });

    expect(status).toBe(400);
    expect(body.error).toContain('slug must be lowercase alphanumeric');
  }, TIMEOUT);

  test('rejects slug starting with hyphen', async () => {
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/skills`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Test',
        content: 'content',
        slug: '-invalid',
      }),
    });

    expect(status).toBe(400);
    expect(body.error).toContain('slug must be lowercase alphanumeric');
  }, TIMEOUT);

  test('auto-generates slug from name when not provided', async () => {
    const name = uniqueName('auto-slug');
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/skills`, {
      method: 'POST',
      body: JSON.stringify({ name, content: 'test content' }),
    });

    expect(status).toBe(201);
    expect(body.skill.slug).toBeTruthy();
    // Slug should be lowercase and use hyphens
    expect(body.skill.slug).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    createdSkillIds.push(body.skill.id);
  }, TIMEOUT);

  test('get non-existent skill returns 404', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const { status } = await apiRaw(`/api/workspaces/${workspaceId}/skills/${fakeId}`);
    expect(status).toBe(404);
  }, TIMEOUT);

  test('update non-existent skill returns 404', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const { status } = await apiRaw(`/api/workspaces/${workspaceId}/skills/${fakeId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Nope' }),
    });
    expect(status).toBe(404);
  }, TIMEOUT);

  test('delete non-existent skill returns 404', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const { status } = await apiRaw(`/api/workspaces/${workspaceId}/skills/${fakeId}`, {
      method: 'DELETE',
    });
    expect(status).toBe(404);
  }, TIMEOUT);
});

describe('Skills upsert (POST deduplication)', () => {
  test('POST with same slug updates existing skill (200) instead of creating duplicate', async () => {
    const slug = uniqueSlug('upsert');
    const name1 = uniqueName('upsert-v1');
    const content1 = 'Version 1 content';

    // Create
    const { status: createStatus, body: createBody } = await apiRaw(
      `/api/workspaces/${workspaceId}/skills`,
      {
        method: 'POST',
        body: JSON.stringify({ name: name1, slug, content: content1 }),
      },
    );
    expect(createStatus).toBe(201);
    const originalId = createBody.skill.id;
    createdSkillIds.push(originalId);

    // Upsert with same slug
    const name2 = uniqueName('upsert-v2');
    const content2 = 'Version 2 content';
    const { status: upsertStatus, body: upsertBody } = await apiRaw(
      `/api/workspaces/${workspaceId}/skills`,
      {
        method: 'POST',
        body: JSON.stringify({ name: name2, slug, content: content2 }),
      },
    );

    expect(upsertStatus).toBe(200); // 200, not 201
    expect(upsertBody.skill.id).toBe(originalId); // Same ID
    expect(upsertBody.skill.name).toBe(name2);
    expect(upsertBody.skill.content).toBe(content2);
    expect(upsertBody.skill.contentHash).toBe(computeContentHash(content2));
  }, TIMEOUT);
});

describe('Skills sync', () => {
  test('sync creates new skills', async () => {
    const slug1 = uniqueSlug('sync-a');
    const slug2 = uniqueSlug('sync-b');
    const content1 = 'Sync skill A content';
    const content2 = 'Sync skill B content';

    const { results } = await api(`/api/workspaces/${workspaceId}/skills/sync`, {
      method: 'POST',
      body: JSON.stringify({
        skills: [
          {
            slug: slug1,
            name: 'Sync Skill A',
            content: content1,
            contentHash: computeContentHash(content1),
          },
          {
            slug: slug2,
            name: 'Sync Skill B',
            content: content2,
            contentHash: computeContentHash(content2),
            description: 'A synced skill',
          },
        ],
      }),
    });

    expect(results).toHaveLength(2);
    expect(results[0].slug).toBe(slug1);
    expect(results[0].action).toBe('created');
    expect(results[0].skill).toBeTruthy();
    expect(results[1].slug).toBe(slug2);
    expect(results[1].action).toBe('created');

    // Track for cleanup
    createdSkillIds.push(results[0].skill.id);
    createdSkillIds.push(results[1].skill.id);
  }, TIMEOUT);

  test('sync deduplication: unchanged content returns unchanged', async () => {
    const slug = uniqueSlug('sync-dedup');
    const content = 'Dedup test content';
    const contentHash = computeContentHash(content);

    // First sync — creates
    const { results: first } = await api(`/api/workspaces/${workspaceId}/skills/sync`, {
      method: 'POST',
      body: JSON.stringify({
        skills: [{ slug, name: 'Dedup Skill', content, contentHash }],
      }),
    });
    expect(first[0].action).toBe('created');
    createdSkillIds.push(first[0].skill.id);

    // Second sync with same content — unchanged
    const { results: second } = await api(`/api/workspaces/${workspaceId}/skills/sync`, {
      method: 'POST',
      body: JSON.stringify({
        skills: [{ slug, name: 'Dedup Skill', content, contentHash }],
      }),
    });
    expect(second[0].action).toBe('unchanged');
    expect(second[0].skill).toBeUndefined();
  }, TIMEOUT);

  test('sync updates when content changes', async () => {
    const slug = uniqueSlug('sync-update');
    const content1 = 'Original sync content';
    const content2 = 'Updated sync content';

    // Create
    const { results: first } = await api(`/api/workspaces/${workspaceId}/skills/sync`, {
      method: 'POST',
      body: JSON.stringify({
        skills: [{
          slug,
          name: 'Sync Update Skill',
          content: content1,
          contentHash: computeContentHash(content1),
        }],
      }),
    });
    expect(first[0].action).toBe('created');
    createdSkillIds.push(first[0].skill.id);

    // Sync with different content
    const { results: second } = await api(`/api/workspaces/${workspaceId}/skills/sync`, {
      method: 'POST',
      body: JSON.stringify({
        skills: [{
          slug,
          name: 'Sync Update Skill v2',
          content: content2,
          contentHash: computeContentHash(content2),
        }],
      }),
    });
    expect(second[0].action).toBe('updated');
    expect(second[0].skill).toBeTruthy();
    expect(second[0].skill.content).toBe(content2);
    expect(second[0].skill.origin).toBe('scan');
  }, TIMEOUT);

  test('sync skips invalid entries', async () => {
    const validSlug = uniqueSlug('sync-valid');
    const validContent = 'Valid content';

    const { results } = await api(`/api/workspaces/${workspaceId}/skills/sync`, {
      method: 'POST',
      body: JSON.stringify({
        skills: [
          // Invalid: missing slug
          { name: 'No Slug', content: 'x', contentHash: 'abc' },
          // Invalid: bad slug format
          { slug: 'BAD SLUG!', name: 'Bad', content: 'x', contentHash: 'abc' },
          // Valid
          {
            slug: validSlug,
            name: 'Valid Skill',
            content: validContent,
            contentHash: computeContentHash(validContent),
          },
        ],
      }),
    });

    // Only the valid entry should be in results
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe(validSlug);
    expect(results[0].action).toBe('created');
    createdSkillIds.push(results[0].skill.id);
  }, TIMEOUT);

  test('sync rejects empty skills array', async () => {
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/skills/sync`, {
      method: 'POST',
      body: JSON.stringify({ skills: [] }),
    });

    expect(status).toBe(400);
    expect(body.error).toContain('skills array is required');
  }, TIMEOUT);
});

describe('Skills install', () => {
  test('install by skillId returns requestId', async () => {
    const skill = await createSkill();

    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/skills/install`, {
      method: 'POST',
      body: JSON.stringify({ skillId: skill.id }),
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.requestId).toBeTruthy();
    expect(typeof body.requestId).toBe('string');
  }, TIMEOUT);

  test('install rejects when neither skillId nor installerCommand provided', async () => {
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/skills/install`, {
      method: 'POST',
      body: JSON.stringify({}),
    });

    expect(status).toBe(400);
    expect(body.error).toContain('Either skillId or installerCommand is required');
  }, TIMEOUT);

  test('install rejects when both skillId and installerCommand provided', async () => {
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/skills/install`, {
      method: 'POST',
      body: JSON.stringify({
        skillId: '00000000-0000-0000-0000-000000000000',
        installerCommand: 'buildd skill install test',
      }),
    });

    expect(status).toBe(400);
    expect(body.error).toContain('not both');
  }, TIMEOUT);

  test('install with non-existent skillId returns 404', async () => {
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/skills/install`, {
      method: 'POST',
      body: JSON.stringify({ skillId: '00000000-0000-0000-0000-000000000000' }),
    });

    expect(status).toBe(404);
    expect(body.error).toContain('Skill not found');
  }, TIMEOUT);
});

describe('Workspace access control', () => {
  test('list skills with invalid auth returns 401', async () => {
    const { apiRaw: badApiRaw } = createTestApi(SERVER, 'invalid-api-key-that-does-not-exist');
    const { status } = await badApiRaw(`/api/workspaces/${workspaceId}/skills`);
    expect(status).toBe(401);
  }, TIMEOUT);

  test('create skill with invalid auth returns 401', async () => {
    const { apiRaw: badApiRaw } = createTestApi(SERVER, 'invalid-api-key-that-does-not-exist');
    const { status } = await badApiRaw(`/api/workspaces/${workspaceId}/skills`, {
      method: 'POST',
      body: JSON.stringify({ name: 'test', content: 'test' }),
    });
    expect(status).toBe(401);
  }, TIMEOUT);

  test('access non-existent workspace returns 404', async () => {
    const fakeWorkspaceId = '00000000-0000-0000-0000-000000000000';
    const { status } = await apiRaw(`/api/workspaces/${fakeWorkspaceId}/skills`);
    expect(status).toBe(404);
  }, TIMEOUT);
});
