import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';

const mockTriggerEvent = mock((..._args: unknown[]) => Promise.resolve());
mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { workspace: (id: string) => `workspace-${id}` },
  events: { TASK_CREATED: 'task:created', TASK_ASSIGNED: 'task:assigned' },
}));
const mockGitHubDispatch = mock((..._args: unknown[]) => Promise.resolve(true));
mock.module('@/lib/github', () => ({
  dispatchToGitHubActions: mockGitHubDispatch,
  isGitHubAppConfigured: () => false,
}));
mock.module('@buildd/core/db', () => ({ db: { query: {} } }));

import {
  buildTaskPayload,
  buildWebhookPayload,
  dispatchNewTask,
  dispatchUnblockedTask,
  dispatchRetriedTask,
} from './task-dispatch';

describe('buildTaskPayload', () => {
  it('includes missionId when present', () => {
    const payload = buildTaskPayload(
      { id: 'task-1', title: 'Test', workspaceId: 'ws-1', mode: 'planning', priority: 5, missionId: 'mission-1' },
      { name: 'test-ws', repo: 'org/repo' },
    );

    expect(payload.id).toBe('task-1');
    expect(payload.missionId).toBe('mission-1');
    expect(payload.workspace).toEqual({ name: 'test-ws', repo: 'org/repo' });
  });

  it('omits missionId when not present', () => {
    const payload = buildTaskPayload(
      { id: 'task-2', title: 'Standalone', workspaceId: 'ws-1' },
      { name: 'test-ws', repo: null },
    );

    expect(payload.missionId).toBeUndefined();
    expect(payload.workspace).toEqual({ name: 'test-ws', repo: null });
  });

  it('omits missionId when null', () => {
    const payload = buildTaskPayload(
      { id: 'task-3', title: 'Task', workspaceId: 'ws-1', missionId: null },
      { name: 'ws' },
    );

    expect(payload.missionId).toBeUndefined();
  });

  it('omits workspace when name not provided', () => {
    const payload = buildTaskPayload(
      { id: 'task-4', title: 'Task', workspaceId: 'ws-1' },
      {},
    );

    expect(payload.workspace).toBeUndefined();
  });

  it('carries backend so the runner can key its per-backend claim breaker', () => {
    const payload = buildTaskPayload(
      { id: 'task-5', title: 'Codex work', workspaceId: 'ws-1', backend: 'codex' },
      { name: 'ws' },
    );

    // Without this the runner evaluates every Pusher nudge against the Claude
    // key, so a Codex wall silently drops Codex nudges (or vice versa).
    expect(payload.backend).toBe('codex');
  });

  it('omits backend when the task does not set one', () => {
    const payload = buildTaskPayload(
      { id: 'task-6', title: 'Default', workspaceId: 'ws-1' },
      { name: 'ws' },
    );

    expect('backend' in payload).toBe(false);
  });

  it('includes compact task fields in payload — no description', () => {
    const payload = buildTaskPayload(
      { id: 't1', title: 'Full', workspaceId: 'ws-1', mode: 'execution', priority: 10, missionId: 'm1' },
      { name: 'ws', repo: 'org/repo' },
    );

    expect(payload).toEqual({
      id: 't1',
      title: 'Full',
      workspaceId: 'ws-1',
      mode: 'execution',
      priority: 10,
      missionId: 'm1',
      workspace: { name: 'ws', repo: 'org/repo' },
    });
    // description must NOT be present — it can be multi-KB for heartbeat tasks
    expect('description' in payload).toBe(false);
  });
});

// ── Webhook dispatch ───────────────────────────────────────────────────────

const WEBHOOK = { url: 'https://hooks.example.test/dispatch', token: 'tok', enabled: true };

const TASK = {
  id: 'task-w1',
  title: 'Ship it',
  description: 'Do the thing',
  workspaceId: 'ws-w1',
  mode: 'execution',
  priority: 3,
  missionId: 'mission-w1',
  backend: 'codex',
  roleSlug: 'builder',
};

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let fetchStatus = 200;

beforeEach(() => {
  fetchCalls = [];
  fetchStatus = 200;
  mockTriggerEvent.mockClear();
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, init });
    return new Response('ok', { status: fetchStatus });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function sentBody(i = 0): Record<string, unknown> {
  return JSON.parse(fetchCalls[i].init.body as string);
}
function assignedCalls() {
  return mockTriggerEvent.mock.calls.filter((c) => c[1] === 'task:assigned');
}

describe('buildWebhookPayload', () => {
  it('keeps the original chat-shaped fields exactly as before', () => {
    const p = buildWebhookPayload(TASK, 'task.created');
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev';
    expect(p.message).toBe(
      `Work on Buildd task: Ship it\n\nDo the thing\n\n---\nTask ID: task-w1\nReport progress: POST ${appUrl}/api/workers/{workerId}`,
    );
    expect(p.sessionKey).toBe('buildd-task-w1');
    expect(p.name).toBe('buildd');
    // Original fields lead the object, so their serialisation is a prefix of
    // what an existing consumer saw before.
    expect(Object.keys(p).slice(0, 3)).toEqual(['message', 'sessionKey', 'name']);
  });

  it('falls back to the placeholder description', () => {
    expect(buildWebhookPayload({ ...TASK, description: null }, 'task.created').message)
      .toContain('No description provided.');
  });

  it('nulls structured fields the task does not carry', () => {
    const p = buildWebhookPayload({ id: 't', title: 'x', description: null, workspaceId: 'w' }, 'task.retry');
    expect(p).toMatchObject({ event: 'task.retry', taskId: 't', workspaceId: 'w', missionId: null, backend: null, roleSlug: null });
  });
});

describe('dispatchNewTask webhook', () => {
  it('POSTs the structured fields alongside the chat fields, with the bearer token', async () => {
    await dispatchNewTask(TASK, { id: 'ws-w1', webhookConfig: WEBHOOK });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(WEBHOOK.url);
    expect((fetchCalls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(sentBody()).toEqual({
      ...buildWebhookPayload(TASK, 'task.created'),
      event: 'task.created',
      taskId: 'task-w1',
      workspaceId: 'ws-w1',
      missionId: 'mission-w1',
      backend: 'codex',
      roleSlug: 'builder',
    });
  });

  it('a successful webhook suppresses the TASK_ASSIGNED broadcast (exclusive)', async () => {
    await dispatchNewTask(TASK, { webhookConfig: WEBHOOK });
    expect(mockTriggerEvent.mock.calls.map((c) => c[1])).toEqual(['task:created']);
  });

  it('a failed webhook falls back to the TASK_ASSIGNED broadcast', async () => {
    fetchStatus = 500;
    await dispatchNewTask(TASK, { webhookConfig: WEBHOOK });
    expect(assignedCalls()).toHaveLength(1);
  });
});

describe('dispatchUnblockedTask webhook', () => {
  it("sends event 'task.unblocked' by default", async () => {
    await dispatchUnblockedTask(TASK, { webhookConfig: WEBHOOK });
    expect(sentBody()).toMatchObject({ event: 'task.unblocked', taskId: 'task-w1', roleSlug: 'builder' });
    expect(assignedCalls()).toHaveLength(0);
  });

  it('sends the event the caller names', async () => {
    await dispatchUnblockedTask(TASK, { webhookConfig: WEBHOOK }, { event: 'task.retry' });
    expect(sentBody().event).toBe('task.retry');
  });
});

describe('dispatchRetriedTask', () => {
  it("reaches the webhook with event 'task.retry' and skips the broadcast", async () => {
    await dispatchRetriedTask(TASK, { webhookConfig: WEBHOOK });
    expect(fetchCalls).toHaveLength(1);
    expect(sentBody()).toMatchObject({ event: 'task.retry', taskId: 'task-w1', workspaceId: 'ws-w1', backend: 'codex' });
    expect(assignedCalls()).toHaveLength(0);
  });

  it('broadcasts TASK_ASSIGNED when the workspace has no webhook', async () => {
    await dispatchRetriedTask(TASK, {});
    expect(fetchCalls).toHaveLength(0);
    expect(assignedCalls()).toHaveLength(1);
    expect(assignedCalls()[0][2]).toMatchObject({ task: { id: 'task-w1' }, targetLocalUiUrl: null });
  });

  it('does not wake the webhook for a task deferred to a future startAt', async () => {
    await dispatchRetriedTask({ ...TASK, startAt: new Date(Date.now() + 60_000) }, { webhookConfig: WEBHOOK });
    expect(fetchCalls).toHaveLength(0);
    expect(assignedCalls()).toHaveLength(1);
  });

  it('a startAt already in the past does not defer', async () => {
    await dispatchRetriedTask({ ...TASK, startAt: new Date(Date.now() - 60_000) }, { webhookConfig: WEBHOOK });
    expect(fetchCalls).toHaveLength(1);
  });

  it("applies the task's runnerPreference the way creation did", async () => {
    const restricted = { ...WEBHOOK, runnerPreference: 'service' as const };
    await dispatchRetriedTask({ ...TASK, runnerPreference: 'user' }, { webhookConfig: restricted });
    expect(fetchCalls).toHaveLength(0);
    await dispatchRetriedTask({ ...TASK, runnerPreference: 'service' }, { webhookConfig: restricted });
    expect(fetchCalls).toHaveLength(1);
  });

  it('never starts a GitHub Actions run', async () => {
    fetchStatus = 500;
    await dispatchRetriedTask(TASK, { webhookConfig: WEBHOOK, githubInstallationId: 'i', githubRepoId: 'r' });
    expect(mockGitHubDispatch).not.toHaveBeenCalled();
    expect(assignedCalls()).toHaveLength(1);
  });
});
