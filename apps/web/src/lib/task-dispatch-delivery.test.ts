import { describe, it, expect, beforeEach, afterEach } from 'bun:test';


import {
  buildTaskPayload,
  buildWebhookPayload,
  dispatchResumedTask,
  dispatchToWebhook,
  WEBHOOK_DISPATCH_TIMEOUT_MS,
} from './task-dispatch-delivery';

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

// ── Webhook ────────────────────────────────────────────────────────────────

/** A webhook configured before the `events` opt-in existed. */
const LEGACY_WEBHOOK = { url: 'https://hooks.example.test/dispatch', token: 'tok', enabled: true };
const WEBHOOK = {
  ...LEGACY_WEBHOOK,
  events: ['task.created', 'task.unblocked', 'task.retry'] as Array<'task.created' | 'task.unblocked' | 'task.retry'>,
};

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

  it('cause and dispatchId are additive and present only when given', () => {
    const bare = buildWebhookPayload(TASK, 'task.unblocked');
    expect('cause' in bare).toBe(false);
    expect('dispatchId' in bare).toBe(false);
    expect('workerId' in bare).toBe(false);
    const withCause = buildWebhookPayload(TASK, 'task.unblocked', { cause: 'dependency.satisfied', dispatchId: 'd-1' });
    expect(withCause).toEqual({ ...bare, cause: 'dependency.satisfied', dispatchId: 'd-1' });
  });
});

describe('dispatchToWebhook', () => {
  it('POSTs the payload with the bearer token and an abort signal', async () => {
    expect(await dispatchToWebhook(WEBHOOK, TASK, 'task.created', undefined, { cause: 'task.created', dispatchId: 'd-1' })).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(WEBHOOK.url);
    expect(fetchCalls[0].init.method).toBe('POST');
    expect((fetchCalls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(fetchCalls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(sentBody()).toEqual(buildWebhookPayload(TASK, 'task.created', { cause: 'task.created', dispatchId: 'd-1' }));
  });

  it('a non-2xx answer counts as not dispatched', async () => {
    fetchStatus = 500;
    expect(await dispatchToWebhook(WEBHOOK, TASK, 'task.created')).toBe(false);
  });

  it('a disabled webhook or one without a url sends nothing', async () => {
    expect(await dispatchToWebhook({ ...WEBHOOK, enabled: false }, TASK, 'task.created')).toBe(false);
    expect(await dispatchToWebhook({ ...WEBHOOK, url: '' }, TASK, 'task.created')).toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('webhook fetch timeout', () => {
  it('defaults to ten seconds', () => {
    expect(WEBHOOK_DISPATCH_TIMEOUT_MS).toBe(10_000);
  });

  it('a webhook that never answers counts as not dispatched', async () => {
    globalThis.fetch = ((url: string, init: RequestInit) => {
      fetchCalls.push({ url, init });
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    }) as unknown as typeof fetch;
    expect(await dispatchToWebhook(WEBHOOK, TASK, 'task.created', 20)).toBe(false);
  });

  it('a fetch that rejects the way AbortSignal.timeout does counts as not dispatched', async () => {
    globalThis.fetch = (async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }) as unknown as typeof fetch;
    expect(await dispatchToWebhook(WEBHOOK, TASK, 'task.created')).toBe(false);
  });
});

describe('dispatchResumedTask (cloud runner park → answer)', () => {
  const RESUME_WEBHOOK = { ...LEGACY_WEBHOOK, events: ['task.retry', 'task.resume'] as Array<'task.retry' | 'task.resume'> };

  it("POSTs event 'task.resume' with the parked worker's id", async () => {
    expect(await dispatchResumedTask(TASK, { webhookConfig: RESUME_WEBHOOK }, 'worker-parked-1')).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(sentBody()).toMatchObject({ event: 'task.resume', taskId: 'task-w1', workspaceId: 'ws-w1', workerId: 'worker-parked-1' });
  });

  it('only when the webhook lists task.resume: legacy and retry-only configs are not woken', async () => {
    expect(await dispatchResumedTask(TASK, { webhookConfig: LEGACY_WEBHOOK }, 'w')).toBe(false);
    expect(await dispatchResumedTask(TASK, { webhookConfig: WEBHOOK }, 'w')).toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });

  it('a failed resume or a workspace without a webhook reports false (no fallback here)', async () => {
    fetchStatus = 500;
    expect(await dispatchResumedTask(TASK, { webhookConfig: RESUME_WEBHOOK }, 'w')).toBe(false);
    expect(await dispatchResumedTask(TASK, {}, 'w')).toBe(false);
  });

  it('a disabled webhook or a runnerPreference mismatch sends nothing', async () => {
    await dispatchResumedTask(TASK, { webhookConfig: { ...RESUME_WEBHOOK, enabled: false } }, 'w');
    await dispatchResumedTask({ ...TASK, runnerPreference: 'user' }, { webhookConfig: { ...RESUME_WEBHOOK, runnerPreference: 'service' as const } }, 'w');
    expect(fetchCalls).toHaveLength(0);
  });
});
