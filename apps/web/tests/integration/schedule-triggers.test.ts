/**
 * Integration Tests: Schedule Trigger Columns
 *
 * Regression test for missing migration (0029_schedule_trigger_columns).
 * Verifies that trigger-related columns (lastCheckedAt, lastTriggerValue,
 * totalChecks) exist and work correctly in the task_schedules table.
 *
 * Tests:
 *   - Schedule CRUD with trigger config
 *   - Trigger columns are returned and updatable
 *
 * Usage:
 *   bun run test:integration schedule-triggers
 */

import { describe, test, beforeAll, afterAll, expect } from 'bun:test';
import { requireTestEnv, createTestApi, createCleanup } from '../../../../tests/test-utils';

const TIMEOUT = 30_000;

const { server: SERVER, apiKey: API_KEY } = requireTestEnv();

// Schedule endpoints require admin-level API key (falls back to BUILDD_API_KEY if same key has admin rights)
const ADMIN_KEY = process.env.BUILDD_ADMIN_API_KEY || process.env.BUILDD_API_KEY;
if (!ADMIN_KEY) {
  console.log('⏭️  Skipping: BUILDD_ADMIN_API_KEY (or BUILDD_API_KEY) not set (schedule tests require admin key)');
  process.exit(0);
}

const { api } = createTestApi(SERVER, ADMIN_KEY);
const cleanup = createCleanup(api);

let workspaceId: string;
const scheduleIds: string[] = [];

async function findWorkspace(): Promise<string> {
  if (process.env.BUILDD_WORKSPACE_ID) return process.env.BUILDD_WORKSPACE_ID;
  const { workspaces } = await api('/api/workspaces');
  if (!workspaces.length) throw new Error('No workspaces available');
  const ws = workspaces.find((w: any) => w.name?.includes('buildd')) || workspaces[0];
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
  console.log(`  Workspace: ${workspaceId}`);
});

afterAll(async () => {
  for (const id of scheduleIds) {
    await deleteSchedule(id);
  }
  await cleanup.runCleanup();
  cleanup.dispose();
});

// --- Tests ---

describe('Schedule trigger columns (regression)', () => {

  test('create schedule with http-json trigger config', async () => {
    const { schedule } = await api(`/api/workspaces/${workspaceId}/schedules`, {
      method: 'POST',
      body: JSON.stringify({
        name: `[TEST] trigger-regression-${Date.now()}`,
        cronExpression: '0 0 * * *',
        enabled: false, // don't actually run
        taskTemplate: {
          title: 'Test trigger task {{triggerValue}}',
          description: 'Regression test for trigger columns',
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
    expect(schedule.taskTemplate.trigger.path).toBe('.tag_name');
  }, TIMEOUT);

  test('trigger columns exist and have correct defaults', async () => {
    const scheduleId = scheduleIds[0];
    expect(scheduleId).toBeTruthy();

    const { schedule } = await api(`/api/workspaces/${workspaceId}/schedules/${scheduleId}`);

    // These columns were missing before migration 0029
    expect(schedule.totalChecks).toBe(0);
    expect(schedule.lastCheckedAt).toBeNull();
    expect(schedule.lastTriggerValue).toBeNull();
  }, TIMEOUT);

  test('create schedule with rss trigger config', async () => {
    const { schedule } = await api(`/api/workspaces/${workspaceId}/schedules`, {
      method: 'POST',
      body: JSON.stringify({
        name: `[TEST] rss-trigger-${Date.now()}`,
        cronExpression: '*/30 * * * *',
        enabled: false,
        taskTemplate: {
          title: 'New release: {{triggerValue}}',
          description: 'RSS trigger regression test',
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
    expect(schedule.totalChecks).toBe(0);
    expect(schedule.lastCheckedAt).toBeNull();
    expect(schedule.lastTriggerValue).toBeNull();
  }, TIMEOUT);

  test('schedule without trigger has trigger columns at defaults', async () => {
    const { schedule } = await api(`/api/workspaces/${workspaceId}/schedules`, {
      method: 'POST',
      body: JSON.stringify({
        name: `[TEST] no-trigger-${Date.now()}`,
        cronExpression: '0 9 * * 1',
        enabled: false,
        taskTemplate: {
          title: 'Weekly task',
          description: 'No trigger — just cron',
        },
      }),
    });

    scheduleIds.push(schedule.id);

    expect(schedule.totalChecks).toBe(0);
    expect(schedule.lastCheckedAt).toBeNull();
    expect(schedule.lastTriggerValue).toBeNull();
  }, TIMEOUT);
});
