/**
 * Integration Tests: Schedule Management
 *
 * Tests the complete schedule CRUD lifecycle and validation for
 * the /api/workspaces/[id]/schedules endpoints.
 *
 * Tests cover:
 *   - List schedules (GET /api/workspaces/[id]/schedules)
 *   - Create schedule (POST /api/workspaces/[id]/schedules)
 *   - Get single schedule (GET /api/workspaces/[id]/schedules/[scheduleId])
 *   - Update schedule (PATCH /api/workspaces/[id]/schedules/[scheduleId])
 *   - Delete schedule (DELETE /api/workspaces/[id]/schedules/[scheduleId])
 *   - Cron expression validation
 *   - Schedule enable/disable toggle
 *   - Timezone handling
 *   - Workspace access control
 *   - Trigger types (rss, http-json)
 *
 * Prerequisites:
 *   - BUILDD_TEST_SERVER set (preview or local URL)
 *   - BUILDD_API_KEY or BUILDD_ADMIN_API_KEY set (schedule endpoints require admin-level key)
 *
 * Usage:
 *   bun run test:integration schedules
 */

import { describe, test, beforeAll, afterAll, expect } from 'bun:test';
import { requireTestEnv, createTestApi, createCleanup } from '../../../../tests/test-utils';

const TIMEOUT = 30_000;

const { server: SERVER, apiKey: API_KEY } = requireTestEnv();

// Schedule endpoints require admin-level API key
const ADMIN_KEY = process.env.BUILDD_ADMIN_API_KEY || process.env.BUILDD_API_KEY;
if (!ADMIN_KEY) {
  console.log('⏭️  Skipping: BUILDD_ADMIN_API_KEY (or BUILDD_API_KEY) not set (schedule tests require admin key)');
  process.exit(0);
}

const { api, apiRaw } = createTestApi(SERVER, ADMIN_KEY);
const cleanup = createCleanup(api);

let workspaceId: string;
const scheduleIds: string[] = [];

async function findWorkspace(): Promise<string> {
  if (process.env.BUILDD_WORKSPACE_ID) return process.env.BUILDD_WORKSPACE_ID;
  const { workspaces } = await api('/api/workspaces');
  if (!workspaces.length) throw new Error('No workspaces available');
  const ws = workspaces.find((w: any) => w.name?.includes('buildd')) || workspaces[0];
  console.log(`  Using workspace: ${ws.name} (${ws.id})`);
  return ws.id;
}

async function deleteSchedule(id: string) {
  try {
    await api(`/api/workspaces/${workspaceId}/schedules/${id}`, { method: 'DELETE' });
  } catch { /* best effort */ }
}

// --- Setup / Teardown ---

beforeAll(async () => {
  workspaceId = await findWorkspace();
  console.log(`  Workspace: ${workspaceId} | Server: ${SERVER}`);
});

afterAll(async () => {
  // Clean up all test schedules
  for (const id of scheduleIds) {
    await deleteSchedule(id);
  }
  await cleanup.runCleanup();
  cleanup.dispose();
});

// --- Tests ---

describe('Schedule CRUD', () => {

  // ---------------------------------------------------------------
  // 1. Create schedule (POST)
  // ---------------------------------------------------------------

  test('create schedule — basic cron schedule', async () => {
    const name = `[TEST] basic-cron-${Date.now()}`;
    const { schedule } = await api(`/api/workspaces/${workspaceId}/schedules`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        cronExpression: '0 9 * * 1',
        enabled: false,
        taskTemplate: {
          title: 'Weekly Monday task',
          description: 'Integration test schedule',
        },
      }),
    });

    scheduleIds.push(schedule.id);

    expect(schedule.id).toBeTruthy();
    expect(schedule.name).toBe(name);
    expect(schedule.cronExpression).toBe('0 9 * * 1');
    expect(schedule.timezone).toBe('UTC');
    expect(schedule.enabled).toBe(false);
    expect(schedule.taskTemplate.title).toBe('Weekly Monday task');
    expect(schedule.taskTemplate.description).toBe('Integration test schedule');
    expect(schedule.totalRuns).toBe(0);
    expect(schedule.consecutiveFailures).toBe(0);
    expect(schedule.lastError).toBeNull();
    // nextRunAt should be null when disabled
    expect(schedule.nextRunAt).toBeNull();
  }, TIMEOUT);

  test('create schedule — enabled schedule has nextRunAt', async () => {
    const { schedule } = await api(`/api/workspaces/${workspaceId}/schedules`, {
      method: 'POST',
      body: JSON.stringify({
        name: `[TEST] enabled-${Date.now()}`,
        cronExpression: '*/30 * * * *',
        enabled: true,
        taskTemplate: {
          title: 'Every 30 min task',
          description: 'Test enabled schedule',
        },
      }),
    });

    scheduleIds.push(schedule.id);

    expect(schedule.id).toBeTruthy();
    expect(schedule.enabled).toBe(true);
    // Enabled schedule should have a computed nextRunAt
    expect(schedule.nextRunAt).toBeTruthy();
  }, TIMEOUT);

  test('create schedule — custom maxConcurrentFromSchedule and pauseAfterFailures', async () => {
    const { schedule } = await api(`/api/workspaces/${workspaceId}/schedules`, {
      method: 'POST',
      body: JSON.stringify({
        name: `[TEST] custom-limits-${Date.now()}`,
        cronExpression: '0 0 * * *',
        enabled: false,
        maxConcurrentFromSchedule: 3,
        pauseAfterFailures: 10,
        taskTemplate: {
          title: 'Custom limits task',
          description: 'Tests custom concurrency and failure limits',
        },
      }),
    });

    scheduleIds.push(schedule.id);

    expect(schedule.maxConcurrentFromSchedule).toBe(3);
    expect(schedule.pauseAfterFailures).toBe(10);
  }, TIMEOUT);

  test('create schedule — missing required fields returns 400', async () => {
    // Missing name
    const { status: s1, body: b1 } = await apiRaw(`/api/workspaces/${workspaceId}/schedules`, {
      method: 'POST',
      body: JSON.stringify({
        cronExpression: '0 0 * * *',
        taskTemplate: { title: 'Missing name' },
      }),
    });
    expect(s1).toBe(400);
    expect(b1.error).toBeTruthy();

    // Missing cronExpression
    const { status: s2, body: b2 } = await apiRaw(`/api/workspaces/${workspaceId}/schedules`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Missing cron',
        taskTemplate: { title: 'Missing cron' },
      }),
    });
    expect(s2).toBe(400);
    expect(b2.error).toBeTruthy();

    // Missing taskTemplate.title
    const { status: s3, body: b3 } = await apiRaw(`/api/workspaces/${workspaceId}/schedules`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Missing template title',
        cronExpression: '0 0 * * *',
        taskTemplate: { description: 'No title' },
      }),
    });
    expect(s3).toBe(400);
    expect(b3.error).toBeTruthy();
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 2. List schedules (GET)
  // ---------------------------------------------------------------

  test('list schedules — returns array with created schedules', async () => {
    const { schedules } = await api(`/api/workspaces/${workspaceId}/schedules`);

    expect(Array.isArray(schedules)).toBe(true);
    // Should contain at least the schedules we created
    const testSchedules = schedules.filter((s: any) => s.name?.startsWith('[TEST]'));
    expect(testSchedules.length).toBeGreaterThanOrEqual(2);

    // Verify ordering (most recent first)
    if (testSchedules.length >= 2) {
      const first = new Date(testSchedules[0].createdAt).getTime();
      const second = new Date(testSchedules[1].createdAt).getTime();
      expect(first).toBeGreaterThanOrEqual(second);
    }
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 3. Get single schedule (GET /[scheduleId])
  // ---------------------------------------------------------------

  test('get single schedule — returns correct schedule', async () => {
    const scheduleId = scheduleIds[0];
    expect(scheduleId).toBeTruthy();

    const { schedule } = await api(`/api/workspaces/${workspaceId}/schedules/${scheduleId}`);

    expect(schedule.id).toBe(scheduleId);
    expect(schedule.workspaceId).toBe(workspaceId);
    expect(schedule.cronExpression).toBe('0 9 * * 1');
  }, TIMEOUT);

  test('get single schedule — nonexistent returns 404', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/schedules/${fakeId}`);

    expect(status).toBe(404);
    expect(body.error).toContain('not found');
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 4. Update schedule (PATCH)
  // ---------------------------------------------------------------

  test('update schedule — update name and taskTemplate', async () => {
    const scheduleId = scheduleIds[0];
    const newName = `[TEST] updated-${Date.now()}`;

    const { schedule } = await api(`/api/workspaces/${workspaceId}/schedules/${scheduleId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: newName,
        taskTemplate: {
          title: 'Updated title',
          description: 'Updated description',
        },
      }),
    });

    expect(schedule.name).toBe(newName);
    expect(schedule.taskTemplate.title).toBe('Updated title');
    expect(schedule.taskTemplate.description).toBe('Updated description');
    // updatedAt should have changed
    expect(schedule.updatedAt).toBeTruthy();
  }, TIMEOUT);

  test('update schedule — update cron expression recomputes nextRunAt', async () => {
    // First enable the schedule
    const scheduleId = scheduleIds[0];
    const { schedule: enabled } = await api(`/api/workspaces/${workspaceId}/schedules/${scheduleId}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: true, cronExpression: '0 12 * * *' }),
    });

    expect(enabled.enabled).toBe(true);
    expect(enabled.cronExpression).toBe('0 12 * * *');
    expect(enabled.nextRunAt).toBeTruthy();

    const firstNextRun = enabled.nextRunAt;

    // Change cron to a different schedule
    const { schedule: updated } = await api(`/api/workspaces/${workspaceId}/schedules/${scheduleId}`, {
      method: 'PATCH',
      body: JSON.stringify({ cronExpression: '0 6 * * *' }),
    });

    expect(updated.cronExpression).toBe('0 6 * * *');
    expect(updated.nextRunAt).toBeTruthy();
    // nextRunAt should differ (different time of day)
    expect(updated.nextRunAt).not.toBe(firstNextRun);
  }, TIMEOUT);

  test('update schedule — nonexistent schedule returns 404', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/schedules/${fakeId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Should not work' }),
    });

    expect(status).toBe(404);
    expect(body.error).toContain('not found');
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 5. Delete schedule (DELETE)
  // ---------------------------------------------------------------

  test('delete schedule — removes schedule', async () => {
    // Create one specifically to delete
    const { schedule } = await api(`/api/workspaces/${workspaceId}/schedules`, {
      method: 'POST',
      body: JSON.stringify({
        name: `[TEST] to-delete-${Date.now()}`,
        cronExpression: '0 0 * * *',
        enabled: false,
        taskTemplate: { title: 'Delete me', description: 'Will be deleted' },
      }),
    });

    expect(schedule.id).toBeTruthy();

    // Delete it
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/schedules/${schedule.id}`, {
      method: 'DELETE',
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);

    // Verify it's gone
    const { status: getStatus } = await apiRaw(`/api/workspaces/${workspaceId}/schedules/${schedule.id}`);
    expect(getStatus).toBe(404);
  }, TIMEOUT);

  test('delete schedule — nonexistent returns 404', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/schedules/${fakeId}`, {
      method: 'DELETE',
    });

    expect(status).toBe(404);
    expect(body.error).toContain('not found');
  }, TIMEOUT);
});

// ---------------------------------------------------------------
// Cron expression validation
// ---------------------------------------------------------------

describe('Cron expression validation', () => {

  test('create schedule — invalid cron expression returns 400', async () => {
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/schedules`, {
      method: 'POST',
      body: JSON.stringify({
        name: `[TEST] invalid-cron-${Date.now()}`,
        cronExpression: 'not a cron',
        taskTemplate: { title: 'Bad cron' },
      }),
    });

    expect(status).toBe(400);
    expect(body.error).toContain('Invalid cron expression');
  }, TIMEOUT);

  test('create schedule — invalid cron with too many fields returns 400', async () => {
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/schedules`, {
      method: 'POST',
      body: JSON.stringify({
        name: `[TEST] bad-cron-fields-${Date.now()}`,
        cronExpression: '* * * * * * *',
        taskTemplate: { title: 'Too many fields' },
      }),
    });

    // croner may accept 6 fields (with seconds) but 7 should fail
    expect(status).toBe(400);
    expect(body.error).toContain('Invalid cron expression');
  }, TIMEOUT);

  test('update schedule — invalid cron expression returns 400', async () => {
    const scheduleId = scheduleIds[0];
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/schedules/${scheduleId}`, {
      method: 'PATCH',
      body: JSON.stringify({ cronExpression: 'bad cron' }),
    });

    expect(status).toBe(400);
    expect(body.error).toContain('Invalid cron expression');
  }, TIMEOUT);

  test('create schedule — valid complex cron expressions accepted', async () => {
    const expressions = [
      { cron: '*/15 * * * *', desc: 'every 15 minutes' },
      { cron: '0 0 1 * *', desc: 'monthly on the 1st' },
      { cron: '30 4 * * 1-5', desc: 'weekdays at 4:30am' },
    ];

    for (const { cron, desc } of expressions) {
      const { schedule } = await api(`/api/workspaces/${workspaceId}/schedules`, {
        method: 'POST',
        body: JSON.stringify({
          name: `[TEST] cron-${desc}-${Date.now()}`,
          cronExpression: cron,
          enabled: false,
          taskTemplate: { title: `Cron test: ${desc}` },
        }),
      });

      scheduleIds.push(schedule.id);
      expect(schedule.id).toBeTruthy();
      expect(schedule.cronExpression).toBe(cron);
    }
  }, TIMEOUT);
});

// ---------------------------------------------------------------
// Enable/disable toggle
// ---------------------------------------------------------------

describe('Schedule enable/disable toggle', () => {

  test('disable schedule — clears nextRunAt', async () => {
    // Create an enabled schedule
    const { schedule: created } = await api(`/api/workspaces/${workspaceId}/schedules`, {
      method: 'POST',
      body: JSON.stringify({
        name: `[TEST] toggle-${Date.now()}`,
        cronExpression: '0 0 * * *',
        enabled: true,
        taskTemplate: { title: 'Toggle test' },
      }),
    });

    scheduleIds.push(created.id);
    expect(created.enabled).toBe(true);
    expect(created.nextRunAt).toBeTruthy();

    // Disable it
    const { schedule: disabled } = await api(`/api/workspaces/${workspaceId}/schedules/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
    });

    expect(disabled.enabled).toBe(false);
    expect(disabled.nextRunAt).toBeNull();
  }, TIMEOUT);

  test('re-enable schedule — sets nextRunAt and resets failures', async () => {
    // Create disabled schedule
    const { schedule: created } = await api(`/api/workspaces/${workspaceId}/schedules`, {
      method: 'POST',
      body: JSON.stringify({
        name: `[TEST] reenable-${Date.now()}`,
        cronExpression: '0 0 * * *',
        enabled: false,
        taskTemplate: { title: 'Re-enable test' },
      }),
    });

    scheduleIds.push(created.id);
    expect(created.enabled).toBe(false);
    expect(created.nextRunAt).toBeNull();

    // Enable it
    const { schedule: enabled } = await api(`/api/workspaces/${workspaceId}/schedules/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: true }),
    });

    expect(enabled.enabled).toBe(true);
    expect(enabled.nextRunAt).toBeTruthy();
    // Re-enabling resets consecutive failures
    expect(enabled.consecutiveFailures).toBe(0);
    expect(enabled.lastError).toBeNull();
  }, TIMEOUT);
});

// ---------------------------------------------------------------
// Timezone handling
// ---------------------------------------------------------------

describe('Timezone handling', () => {

  test('create schedule with explicit timezone', async () => {
    const { schedule } = await api(`/api/workspaces/${workspaceId}/schedules`, {
      method: 'POST',
      body: JSON.stringify({
        name: `[TEST] tz-tokyo-${Date.now()}`,
        cronExpression: '0 9 * * *',
        timezone: 'Asia/Tokyo',
        enabled: true,
        taskTemplate: { title: 'Tokyo schedule' },
      }),
    });

    scheduleIds.push(schedule.id);

    expect(schedule.timezone).toBe('Asia/Tokyo');
    expect(schedule.nextRunAt).toBeTruthy();
  }, TIMEOUT);

  test('create schedule defaults to UTC timezone', async () => {
    const { schedule } = await api(`/api/workspaces/${workspaceId}/schedules`, {
      method: 'POST',
      body: JSON.stringify({
        name: `[TEST] tz-default-${Date.now()}`,
        cronExpression: '0 9 * * *',
        enabled: false,
        taskTemplate: { title: 'Default timezone' },
      }),
    });

    scheduleIds.push(schedule.id);

    expect(schedule.timezone).toBe('UTC');
  }, TIMEOUT);

  test('update schedule timezone recomputes nextRunAt', async () => {
    // Create schedule in UTC
    const { schedule: created } = await api(`/api/workspaces/${workspaceId}/schedules`, {
      method: 'POST',
      body: JSON.stringify({
        name: `[TEST] tz-update-${Date.now()}`,
        cronExpression: '0 9 * * *',
        timezone: 'UTC',
        enabled: true,
        taskTemplate: { title: 'TZ update test' },
      }),
    });

    scheduleIds.push(created.id);
    const utcNextRun = created.nextRunAt;

    // Change to US Pacific (UTC-8 or UTC-7)
    const { schedule: updated } = await api(`/api/workspaces/${workspaceId}/schedules/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ timezone: 'America/Los_Angeles' }),
    });

    expect(updated.timezone).toBe('America/Los_Angeles');
    expect(updated.nextRunAt).toBeTruthy();
    // nextRunAt should differ since the timezone changed
    expect(updated.nextRunAt).not.toBe(utcNextRun);
  }, TIMEOUT);
});

// ---------------------------------------------------------------
// Workspace access control
// ---------------------------------------------------------------

describe('Workspace access control', () => {

  test('list schedules — unauthenticated returns 401', async () => {
    const { apiRaw: noAuthApi } = createTestApi(SERVER, 'invalid_key_does_not_exist');
    const { status } = await noAuthApi(`/api/workspaces/${workspaceId}/schedules`);

    expect(status).toBe(401);
  }, TIMEOUT);

  test('create schedule — unauthenticated returns 401', async () => {
    const { apiRaw: noAuthApi } = createTestApi(SERVER, 'invalid_key_does_not_exist');
    const { status } = await noAuthApi(`/api/workspaces/${workspaceId}/schedules`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Should not be created',
        cronExpression: '0 0 * * *',
        taskTemplate: { title: 'Unauthorized' },
      }),
    });

    expect(status).toBe(401);
  }, TIMEOUT);

  test('update schedule — unauthenticated returns 401', async () => {
    const scheduleId = scheduleIds[0];
    const { apiRaw: noAuthApi } = createTestApi(SERVER, 'invalid_key_does_not_exist');
    const { status } = await noAuthApi(`/api/workspaces/${workspaceId}/schedules/${scheduleId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Unauthorized update' }),
    });

    expect(status).toBe(401);
  }, TIMEOUT);

  test('delete schedule — unauthenticated returns 401', async () => {
    const scheduleId = scheduleIds[0];
    const { apiRaw: noAuthApi } = createTestApi(SERVER, 'invalid_key_does_not_exist');
    const { status } = await noAuthApi(`/api/workspaces/${workspaceId}/schedules/${scheduleId}`, {
      method: 'DELETE',
    });

    expect(status).toBe(401);
  }, TIMEOUT);

  test('get schedule — wrong workspace returns 404', async () => {
    const scheduleId = scheduleIds[0];
    const fakeWorkspaceId = '00000000-0000-0000-0000-000000000000';
    const { status } = await apiRaw(`/api/workspaces/${fakeWorkspaceId}/schedules/${scheduleId}`);

    // Returns 401 (no access to fake workspace) or 404
    expect([401, 404]).toContain(status);
  }, TIMEOUT);
});

// ---------------------------------------------------------------
// Trigger types (rss, http-json)
// ---------------------------------------------------------------

describe('Schedule trigger types', () => {

  test('create schedule with http-json trigger', async () => {
    const { schedule } = await api(`/api/workspaces/${workspaceId}/schedules`, {
      method: 'POST',
      body: JSON.stringify({
        name: `[TEST] http-json-trigger-${Date.now()}`,
        cronExpression: '0 */6 * * *',
        enabled: false,
        taskTemplate: {
          title: 'New version: {{triggerValue}}',
          description: 'Check for new releases via HTTP JSON',
          trigger: {
            type: 'http-json',
            url: 'https://api.github.com/repos/anthropics/claude-code/releases/latest',
            path: '.tag_name',
          },
        },
      }),
    });

    scheduleIds.push(schedule.id);

    expect(schedule.id).toBeTruthy();
    expect(schedule.taskTemplate.trigger).toBeTruthy();
    expect(schedule.taskTemplate.trigger.type).toBe('http-json');
    expect(schedule.taskTemplate.trigger.url).toBe('https://api.github.com/repos/anthropics/claude-code/releases/latest');
    expect(schedule.taskTemplate.trigger.path).toBe('.tag_name');
    // Trigger columns should have defaults
    expect(schedule.totalChecks).toBe(0);
    expect(schedule.lastCheckedAt).toBeNull();
    expect(schedule.lastTriggerValue).toBeNull();
  }, TIMEOUT);

  test('create schedule with rss trigger', async () => {
    const { schedule } = await api(`/api/workspaces/${workspaceId}/schedules`, {
      method: 'POST',
      body: JSON.stringify({
        name: `[TEST] rss-trigger-${Date.now()}`,
        cronExpression: '*/30 * * * *',
        enabled: false,
        taskTemplate: {
          title: 'New release: {{triggerValue}}',
          description: 'RSS feed trigger test',
          trigger: {
            type: 'rss',
            url: 'https://github.com/anthropics/claude-code/releases.atom',
          },
        },
      }),
    });

    scheduleIds.push(schedule.id);

    expect(schedule.id).toBeTruthy();
    expect(schedule.taskTemplate.trigger.type).toBe('rss');
    expect(schedule.taskTemplate.trigger.url).toBe('https://github.com/anthropics/claude-code/releases.atom');
    expect(schedule.totalChecks).toBe(0);
    expect(schedule.lastCheckedAt).toBeNull();
    expect(schedule.lastTriggerValue).toBeNull();
  }, TIMEOUT);

  test('create schedule with http-json trigger with headers', async () => {
    const { schedule } = await api(`/api/workspaces/${workspaceId}/schedules`, {
      method: 'POST',
      body: JSON.stringify({
        name: `[TEST] http-json-headers-${Date.now()}`,
        cronExpression: '0 0 * * *',
        enabled: false,
        taskTemplate: {
          title: 'API check: {{triggerValue}}',
          description: 'HTTP JSON trigger with custom headers',
          trigger: {
            type: 'http-json',
            url: 'https://api.github.com/repos/anthropics/claude-code/releases/latest',
            path: '.tag_name',
            headers: { Accept: 'application/vnd.github.v3+json' },
          },
        },
      }),
    });

    scheduleIds.push(schedule.id);

    expect(schedule.taskTemplate.trigger.type).toBe('http-json');
    expect(schedule.taskTemplate.trigger.headers).toBeTruthy();
    expect(schedule.taskTemplate.trigger.headers.Accept).toBe('application/vnd.github.v3+json');
  }, TIMEOUT);

  test('create schedule without trigger — no trigger in template', async () => {
    const { schedule } = await api(`/api/workspaces/${workspaceId}/schedules`, {
      method: 'POST',
      body: JSON.stringify({
        name: `[TEST] no-trigger-${Date.now()}`,
        cronExpression: '0 9 * * 1',
        enabled: false,
        taskTemplate: {
          title: 'Simple cron task',
          description: 'No trigger attached',
        },
      }),
    });

    scheduleIds.push(schedule.id);

    expect(schedule.taskTemplate.trigger).toBeUndefined();
    // Trigger columns should still have defaults
    expect(schedule.totalChecks).toBe(0);
    expect(schedule.lastCheckedAt).toBeNull();
    expect(schedule.lastTriggerValue).toBeNull();
  }, TIMEOUT);

  test('update schedule — add trigger to existing schedule', async () => {
    // Create without trigger
    const { schedule: created } = await api(`/api/workspaces/${workspaceId}/schedules`, {
      method: 'POST',
      body: JSON.stringify({
        name: `[TEST] add-trigger-later-${Date.now()}`,
        cronExpression: '0 0 * * *',
        enabled: false,
        taskTemplate: {
          title: 'Will get a trigger',
          description: 'Initially no trigger',
        },
      }),
    });

    scheduleIds.push(created.id);
    expect(created.taskTemplate.trigger).toBeUndefined();

    // Update to add trigger
    const { schedule: updated } = await api(`/api/workspaces/${workspaceId}/schedules/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        taskTemplate: {
          title: 'Now with trigger: {{triggerValue}}',
          description: 'Trigger added via update',
          trigger: {
            type: 'rss',
            url: 'https://github.com/anthropics/claude-code/releases.atom',
          },
        },
      }),
    });

    expect(updated.taskTemplate.trigger).toBeTruthy();
    expect(updated.taskTemplate.trigger.type).toBe('rss');
  }, TIMEOUT);
});
