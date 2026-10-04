import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';

// The pre-outbox direct-send behaviour (dispatchNewTask / Unblocked / Retried /
// PlanChild) re-expressed per cause. Every rule the old task-dispatch tests
// pinned has a counterpart here; SQL correctness (coalescing, claiming,
// retry backoff) lives in apps/web/tests/db/dispatch-outbox.test.ts.

// ── Mocks ──────────────────────────────────────────────────────────────────

type Sent = 'sent' | 'unconfigured' | 'failed';
let pusherResult: Sent = 'sent';
const mockTriggerEvent = mock(async (..._args: unknown[]) => {});
const mockTriggerEventChecked = mock(async (..._args: unknown[]): Promise<Sent> => pusherResult);
mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  triggerEventChecked: mockTriggerEventChecked,
  channels: { workspace: (id: string) => `workspace-${id}` },
  events: { TASK_CREATED: 'task:created', TASK_ASSIGNED: 'task:assigned' },
}));

let githubConfigured = false;
const mockGitHubDispatch = mock(async (..._args: unknown[]) => true);
mock.module('@/lib/github', () => ({
  dispatchToGitHubActions: mockGitHubDispatch,
  isGitHubAppConfigured: () => githubConfigured,
}));

let taskNotParked = true;
const mockIsTaskNotHeldOrLocal = mock(async (_taskId: string) => taskNotParked);
mock.module('@/app/api/workers/claim/held-gate', () => ({
  isTaskNotHeldOrLocal: mockIsTaskNotHeldOrLocal,
}));

const mockMarkDue = mock(async (..._args: unknown[]) => {});
const mockReseedDue = mock(async (..._args: unknown[]) => {});
const mockClearDue = mock(async (_job: string, _members: string | string[]) => {});
mock.module('@/lib/redis', () => ({ markDue: mockMarkDue, reseedDue: mockReseedDue, clearDue: mockClearDue }));

/** Task rows the delivery loader can see, keyed by id. */
const taskRows = new Map<string, Record<string, unknown>>();

/** The id inside a drizzle `eq(tasks.id, x)`: a param whose value is a known task id. */
function idIn(where: unknown): string | undefined {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): string | undefined => {
    if (typeof v === 'string') return taskRows.has(v) ? v : undefined;
    if (!v || typeof v !== 'object' || seen.has(v)) return undefined;
    seen.add(v);
    for (const child of Object.values(v)) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(where);
}

const mockExecute = mock(async (_q: unknown) => ({ rows: [] }));
mock.module('@buildd/core/db', () => ({
  db: {
    execute: mockExecute,
    query: {
      tasks: { findFirst: mock(async (args: { where: unknown }) => { const id = idIn(args.where); return id ? taskRows.get(id) : undefined; }) },
      githubInstallations: { findFirst: async () => ({ installationId: 42 }) },
      githubRepos: { findFirst: async () => ({ fullName: 'org/repo' }) },
    },
  },
}));

let claimQueue: unknown[] = [];
let futureDispatches: Array<{ id: string; notBefore: Date }> = [];
const mockClaimDue = mock(async (_limit: number) => claimQueue.splice(0));
const mockMarkDelivered = mock(async (_id: string, _via: string) => {});
const mockMarkFailed = mock(async (_id: string, _attempt: number, _err: string) => 'retrying' as const);
const mockEnqueueSql = mock((input: unknown) => ({ enqueue: input }));
const realOutbox = await import('@buildd/core/dispatch-outbox');
mock.module('@buildd/core/dispatch-outbox', () => ({
  ...realOutbox,
  claimDueDispatches: mockClaimDue,
  enqueueDispatchSql: mockEnqueueSql,
  listFutureDispatches: mock(async () => futureDispatches),
  markDispatchDelivered: mockMarkDelivered,
  markDispatchFailed: mockMarkFailed,
}));

/** `after` that throws outside a request scope, like Next's; queues inside one. */
let afterQueue: Array<() => unknown> | null = null;
const realNextServer = await import('next/server');
mock.module('next/server', () => ({
  ...realNextServer,
  after: (task: () => unknown) => {
    if (!afterQueue) throw new Error('`after` was called outside a request scope');
    afterQueue.push(task);
  },
}));

const {
  DISPATCH_CAUSES,
  MAX_DELIVERY_ATTEMPTS,
} = realOutbox;
const {
  deliverTaskDispatch,
  drainDispatchOutbox,
  kickDispatch,
  primaryCause,
  wakeTask,
  wakeTasks,
  announceTaskCreated,
  DRAIN_BATCH,
} = await import('./dispatch-authority');
const { buildWebhookPayload } = await import('./task-dispatch-delivery');
const { routeForCause, webhookWants, TASK_WAKE_ADAPTERS, offerScheduledNotice } = await import('./dispatch-adapters');
type DispatchCause = (typeof DISPATCH_CAUSES)[number];

// ── Fixtures ───────────────────────────────────────────────────────────────

/** A webhook configured before the `events` opt-in existed. */
const LEGACY_WEBHOOK = { url: 'https://hooks.example.test/dispatch', token: 'tok', enabled: true };
/** A webhook that opted into every dispatch event (the cloud runner's deploy). */
const WEBHOOK = {
  ...LEGACY_WEBHOOK,
  events: ['task.created', 'task.unblocked', 'task.retry'] as Array<'task.created' | 'task.unblocked' | 'task.retry'>,
};

/** Causes a legacy (no `events`) webhook received before the outbox. */
const LEGACY_CAUSES: DispatchCause[] = ['task.created', 'review.fix_requested', 'ci.retry', 'conflict.retry', 'dependency.satisfied', 'manual.start'];
const NON_LEGACY_CAUSES = DISPATCH_CAUSES.filter(c => !LEGACY_CAUSES.includes(c));

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
  runnerPreference: null as string | null,
  status: 'pending',
  startAt: null as Date | null,
};

function seed(
  workspace: Record<string, unknown> = {},
  task: Partial<typeof TASK> = {},
): typeof TASK {
  const t = { ...TASK, ...task };
  taskRows.set(t.id, { ...t, workspace: { id: t.workspaceId, name: 'ws', repo: null, ...workspace } });
  return t;
}

let rowSeq = 0;
function row(cause: DispatchCause, opts: { causes?: DispatchCause[]; metadata?: Record<string, unknown>; taskId?: string; attemptCount?: number; intent?: string } = {}) {
  rowSeq++;
  return {
    id: `dispatch-${rowSeq}`,
    intent: (opts.intent ?? 'work_execution') as 'work_execution',
    workspaceId: TASK.workspaceId,
    taskId: opts.taskId ?? TASK.id,
    cause,
    causes: opts.causes ?? [cause],
    notBefore: new Date(),
    attemptCount: opts.attemptCount ?? 1,
    metadata: opts.metadata ?? null,
  };
}

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let fetchStatus = 200;

beforeEach(() => {
  fetchCalls = [];
  fetchStatus = 200;
  taskNotParked = true;
  githubConfigured = false;
  pusherResult = 'sent';
  afterQueue = null;
  claimQueue = [];
  futureDispatches = [];
  taskRows.clear();
  for (const m of [mockTriggerEvent, mockTriggerEventChecked, mockGitHubDispatch, mockIsTaskNotHeldOrLocal, mockMarkDue,
    mockExecute, mockClaimDue, mockMarkDelivered, mockMarkFailed, mockEnqueueSql]) m.mockClear();
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
  return mockTriggerEventChecked.mock.calls.filter(c => c[1] === 'task:assigned');
}
const flush = () => new Promise(r => setTimeout(r, 0));

// ── Policy (pure) ──────────────────────────────────────────────────────────

describe('routeForCause', () => {
  it('maps every cause in the vocabulary', () => {
    for (const c of DISPATCH_CAUSES) expect(routeForCause(c)).toBeDefined();
  });

  it('a legacy webhook default and GitHub Actions cover exactly the pre-outbox new/unblocked paths', () => {
    expect(DISPATCH_CAUSES.filter(c => routeForCause(c).legacyDefault).sort()).toEqual([...LEGACY_CAUSES].sort());
    expect(DISPATCH_CAUSES.filter(c => routeForCause(c).githubActions).sort()).toEqual([...LEGACY_CAUSES].sort());
  });

  it('only the old dispatchUnblockedTask causes keep the unfiltered-runnerPreference quirk', () => {
    expect(DISPATCH_CAUSES.filter(c => routeForCause(c).legacyUnfilteredRunnerPreference).sort())
      .toEqual(['dependency.satisfied', 'manual.start']);
  });

  it('names the webhook event each path always used', () => {
    const event = (c: DispatchCause) => routeForCause(c).event;
    expect(event('task.created')).toBe('task.created');
    expect(event('review.fix_requested')).toBe('task.created');
    expect(event('plan_child.ready')).toBe('task.created');
    expect(event('dependency.satisfied')).toBe('task.unblocked');
    expect(event('path_claim.released')).toBe('task.unblocked');
    expect(event('start_at.reached')).toBe('task.unblocked');
    expect(event('manual.start')).toBe('task.retry');
    expect(event('task.requeued')).toBe('task.retry');
    expect(event('task.reassigned')).toBe('task.retry');
  });
});

describe('primaryCause', () => {
  it('a trigger task.created coalesced with plan_child.ready is a plan child', () => {
    expect(primaryCause(['task.created', 'plan_child.ready'], 'task.created')).toBe('plan_child.ready');
  });

  it('a manual reset (trigger task.requeued + manual.start) is a manual start', () => {
    expect(primaryCause(['task.requeued', 'manual.start'], 'task.requeued')).toBe('manual.start');
  });

  it('falls back when no listed cause is known', () => {
    expect(primaryCause([], 'task.requeued')).toBe('task.requeued');
    expect(primaryCause(['not.a.cause'], 'start_at.reached')).toBe('start_at.reached');
  });
});

describe('webhookWants', () => {
  const r = routeForCause;
  it('needs an enabled webhook with a url', () => {
    expect(webhookWants(null, {}, r('task.created'), true)).toBe(false);
    expect(webhookWants({ ...LEGACY_WEBHOOK, enabled: false }, {}, r('task.created'), true)).toBe(false);
    expect(webhookWants({ ...LEGACY_WEBHOOK, url: '' }, {}, r('task.created'), true)).toBe(false);
    expect(webhookWants(LEGACY_WEBHOOK, {}, r('task.created'), true)).toBe(true);
  });

  it('a legacy config gets legacy-default causes only; an opted-in one gets exactly its list', () => {
    expect(webhookWants(LEGACY_WEBHOOK, {}, r('task.requeued'), true)).toBe(false);
    expect(webhookWants(WEBHOOK, {}, r('task.requeued'), true)).toBe(true);
    const createdOnly = { ...LEGACY_WEBHOOK, events: ['task.created' as const] };
    expect(webhookWants(createdOnly, {}, r('dependency.satisfied'), true)).toBe(false);
    expect(webhookWants(createdOnly, {}, r('plan_child.ready'), true)).toBe(true);
  });

  it('runnerPreference filters, except the legacy unblocked quirk', () => {
    const legacy = { ...LEGACY_WEBHOOK, runnerPreference: 'service' as const };
    const optedIn = { ...WEBHOOK, runnerPreference: 'service' as const };
    const user = { runnerPreference: 'user' };
    expect(webhookWants(legacy, user, r('dependency.satisfied'), true)).toBe(true);
    expect(webhookWants(legacy, user, r('task.created'), true)).toBe(false);
    expect(webhookWants(optedIn, user, r('dependency.satisfied'), true)).toBe(false);
    expect(webhookWants(optedIn, { runnerPreference: 'service' }, r('dependency.satisfied'), true)).toBe(true);
    // An unset task preference is 'any', which a restricted webhook declines.
    expect(webhookWants(optedIn, {}, r('task.requeued'), true)).toBe(false);
    expect(webhookWants({ ...WEBHOOK, runnerPreference: 'any' as const }, user, r('task.requeued'), true)).toBe(true);
  });

  it('a future startAt is deferred; a past one is not', () => {
    const now = 1_000_000;
    expect(webhookWants(WEBHOOK, { startAt: new Date(now + 1) }, r('task.requeued'), true, now)).toBe(false);
    expect(webhookWants(WEBHOOK, { startAt: new Date(now - 1).toISOString() }, r('task.requeued'), true, now)).toBe(true);
  });

  it('a held or local task is not wanted', () => {
    expect(webhookWants(WEBHOOK, {}, r('task.created'), false)).toBe(false);
  });
});

// ── deliverTaskDispatch ────────────────────────────────────────────────────

describe('deliverTaskDispatch: webhook body and exclusivity', () => {
  it('POSTs the structured fields plus cause and dispatchId, with the bearer token and a timeout', async () => {
    seed({ webhookConfig: WEBHOOK });
    const r = row('task.created');
    expect(await deliverTaskDispatch(r)).toBe('webhook');

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(WEBHOOK.url);
    expect((fetchCalls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(fetchCalls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(sentBody()).toEqual({
      ...buildWebhookPayload(TASK, 'task.created'),
      cause: 'task.created',
      dispatchId: r.id,
    });
  });

  it('the webhook cause is the primary one of a coalesced row', async () => {
    seed({ webhookConfig: WEBHOOK });
    await deliverTaskDispatch(row('task.created', { causes: ['task.created', 'plan_child.ready'] }));
    expect(sentBody()).toMatchObject({ event: 'task.created', cause: 'plan_child.ready' });
  });

  it('a successful webhook suppresses the TASK_ASSIGNED broadcast (exclusive)', async () => {
    seed({ webhookConfig: WEBHOOK });
    await deliverTaskDispatch(row('task.created'));
    expect(mockTriggerEventChecked).not.toHaveBeenCalled();
    expect(mockTriggerEvent).not.toHaveBeenCalled();
  });

  it('a failed webhook falls back to the TASK_ASSIGNED broadcast', async () => {
    fetchStatus = 500;
    seed({ webhookConfig: WEBHOOK });
    expect(await deliverTaskDispatch(row('task.created'))).toBe('pusher');
    expect(assignedCalls()).toHaveLength(1);
  });

  it('a timed-out webhook falls back to the TASK_ASSIGNED broadcast', async () => {
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      fetchCalls.push({ url, init });
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }) as unknown as typeof fetch;
    seed({ webhookConfig: WEBHOOK });
    expect(await deliverTaskDispatch(row('dependency.satisfied'))).toBe('pusher');
    expect(assignedCalls()).toHaveLength(1);
  });
});

describe('deliverTaskDispatch: a legacy webhook (no `events`) sees only what it always did', () => {
  for (const cause of LEGACY_CAUSES) {
    it(`${cause} reaches it as ${routeForCause(cause).event}`, async () => {
      seed({ webhookConfig: LEGACY_WEBHOOK });
      expect(await deliverTaskDispatch(row(cause))).toBe('webhook');
      expect(sentBody()).toMatchObject({ event: routeForCause(cause).event, cause });
      expect(assignedCalls()).toHaveLength(0);
    });
  }

  for (const cause of NON_LEGACY_CAUSES) {
    it(`${cause} does not reach it; runners are woken over Pusher`, async () => {
      seed({ webhookConfig: LEGACY_WEBHOOK });
      expect(await deliverTaskDispatch(row(cause))).toBe('pusher');
      expect(fetchCalls).toHaveLength(0);
      expect(assignedCalls()).toHaveLength(1);
    });
  }

  it('unblocked and manual-start ignore runnerPreference for it, as dispatchUnblockedTask did', async () => {
    seed({ webhookConfig: { ...LEGACY_WEBHOOK, runnerPreference: 'service' } }, { runnerPreference: 'user' });
    await deliverTaskDispatch(row('dependency.satisfied'));
    await deliverTaskDispatch(row('manual.start'));
    expect(fetchCalls).toHaveLength(2);
  });

  it('a new task honours runnerPreference, as dispatchNewTask did', async () => {
    seed({ webhookConfig: { ...LEGACY_WEBHOOK, runnerPreference: 'service' } }, { runnerPreference: 'user' });
    await deliverTaskDispatch(row('task.created'));
    expect(fetchCalls).toHaveLength(0);
    expect(assignedCalls()).toHaveLength(1);
  });
});

describe('deliverTaskDispatch: an opted-in webhook gets exactly the events it lists', () => {
  for (const cause of DISPATCH_CAUSES) {
    it(`${cause} reaches a webhook listing every event, as ${routeForCause(cause).event}`, async () => {
      seed({ webhookConfig: WEBHOOK });
      expect(await deliverTaskDispatch(row(cause))).toBe('webhook');
      expect(sentBody().event).toBe(routeForCause(cause).event);
      expect(assignedCalls()).toHaveLength(0);
    });
  }

  it("an approved plan child reaches a webhook that lists only 'task.created', as task.created", async () => {
    seed({ webhookConfig: { ...LEGACY_WEBHOOK, events: ['task.created'] } });
    await deliverTaskDispatch(row('plan_child.ready'));
    expect(sentBody().event).toBe('task.created');
  });

  it('an event left out of the list is not sent', async () => {
    seed({ webhookConfig: { ...LEGACY_WEBHOOK, events: ['task.created'] } });
    await deliverTaskDispatch(row('task.requeued'));
    await deliverTaskDispatch(row('dependency.satisfied'));
    expect(fetchCalls).toHaveLength(0);
    expect(assignedCalls()).toHaveLength(2);
  });

  it('every cause honours runnerPreference, including unblocks', async () => {
    seed({ webhookConfig: { ...WEBHOOK, runnerPreference: 'service' } }, { runnerPreference: 'user' });
    for (const c of ['dependency.satisfied', 'task.requeued', 'plan_child.ready'] as const) await deliverTaskDispatch(row(c));
    expect(fetchCalls).toHaveLength(0);
    seed({ webhookConfig: { ...WEBHOOK, runnerPreference: 'service' } }, { runnerPreference: 'service' });
    await deliverTaskDispatch(row('dependency.satisfied'));
    expect(fetchCalls).toHaveLength(1);
  });
});

describe('deliverTaskDispatch: held, local and deferred work stays off the webhook', () => {
  it('a held task or held / local-executor mission is not sent; Pusher wakes instead', async () => {
    taskNotParked = false;
    seed({ webhookConfig: WEBHOOK });
    expect(await deliverTaskDispatch(row('task.requeued'))).toBe('pusher');
    expect(mockIsTaskNotHeldOrLocal).toHaveBeenCalledWith('task-w1');
    expect(fetchCalls).toHaveLength(0);
    expect(assignedCalls()).toHaveLength(1);
  });

  it('the gate failing to answer keeps the task off the webhook', async () => {
    mockIsTaskNotHeldOrLocal.mockImplementationOnce(async () => { throw new Error('db down'); });
    seed({ webhookConfig: WEBHOOK });
    await deliverTaskDispatch(row('task.created'));
    expect(fetchCalls).toHaveLength(0);
    expect(assignedCalls()).toHaveLength(1);
  });

  it('the gate is not consulted when the webhook would not be called anyway', async () => {
    seed({ webhookConfig: LEGACY_WEBHOOK });
    await deliverTaskDispatch(row('task.requeued'));
    seed({ webhookConfig: { ...WEBHOOK, runnerPreference: 'service' } }, { runnerPreference: 'user' });
    await deliverTaskDispatch(row('task.requeued'));
    seed({});
    await deliverTaskDispatch(row('task.created'));
    expect(mockIsTaskNotHeldOrLocal).not.toHaveBeenCalled();
  });

  it('a task whose startAt is still in the future is skipped, not sent anywhere', async () => {
    seed({ webhookConfig: WEBHOOK }, { startAt: new Date(Date.now() + 60_000) });
    expect(await deliverTaskDispatch(row('task.requeued'))).toBe('skipped:start_at_future');
    expect(fetchCalls).toHaveLength(0);
    expect(assignedCalls()).toHaveLength(0);
  });

  it('a startAt already in the past does not defer', async () => {
    seed({ webhookConfig: WEBHOOK }, { startAt: new Date(Date.now() - 60_000) });
    expect(await deliverTaskDispatch(row('start_at.reached'))).toBe('webhook');
  });
});

describe('deliverTaskDispatch: GitHub Actions', () => {
  const GH = { githubInstallationId: 'inst-1', githubRepoId: 'repo-1' };
  beforeEach(() => { githubConfigured = true; });

  for (const cause of LEGACY_CAUSES) {
    it(`${cause} starts a run alongside the broadcast when no webhook took it`, async () => {
      seed({ ...GH });
      await deliverTaskDispatch(row(cause));
      await flush();
      expect(mockGitHubDispatch).toHaveBeenCalledTimes(1);
      expect(assignedCalls()).toHaveLength(1);
    });
  }

  for (const cause of NON_LEGACY_CAUSES) {
    it(`${cause} never starts a run`, async () => {
      fetchStatus = 500;
      seed({ ...GH, webhookConfig: WEBHOOK });
      await deliverTaskDispatch(row(cause));
      await flush();
      expect(mockGitHubDispatch).not.toHaveBeenCalled();
      expect(assignedCalls()).toHaveLength(1);
    });
  }

  it('a webhook that took the task suppresses it', async () => {
    seed({ ...GH, webhookConfig: WEBHOOK });
    await deliverTaskDispatch(row('task.created'));
    await flush();
    expect(mockGitHubDispatch).not.toHaveBeenCalled();
  });
});

describe('deliverTaskDispatch: GitHub Actions fires once per intent', () => {
  it('a retried delivery does not start another workflow run', async () => {
    githubConfigured = true;
    seed({ githubInstallationId: 'gi', githubRepoId: 'gr' });
    await deliverTaskDispatch(row('task.created', { attemptCount: 1 }));
    await flush();
    const first = mockGitHubDispatch.mock.calls.length;
    expect(first).toBe(1);
    await deliverTaskDispatch(row('task.created', { attemptCount: 2 }));
    await flush();
    expect(mockGitHubDispatch.mock.calls.length).toBe(first);
  });
});

describe('deliverTaskDispatch: targeted local runner', () => {
  it('sends only a targeted TASK_ASSIGNED: no webhook, no GitHub Actions, no broadcast', async () => {
    githubConfigured = true;
    seed({ webhookConfig: WEBHOOK, githubInstallationId: 'i', githubRepoId: 'r' });
    const r = row('task.created', { metadata: { targetLocalUiUrl: 'http://runner.local:8766' } });
    expect(await deliverTaskDispatch(r)).toBe('pusher:targeted');
    await flush();
    expect(fetchCalls).toHaveLength(0);
    expect(mockGitHubDispatch).not.toHaveBeenCalled();
    expect(assignedCalls()).toHaveLength(1);
    expect(assignedCalls()[0][2]).toMatchObject({ targetLocalUiUrl: 'http://runner.local:8766', task: { id: 'task-w1' } });
  });

  it('a failed targeted send throws so the row retries', async () => {
    pusherResult = 'failed';
    seed({});
    await expect(deliverTaskDispatch(row('task.created', { metadata: { targetLocalUiUrl: 'http://x' } }))).rejects.toThrow();
  });

  it('unconfigured Pusher counts as delivered', async () => {
    pusherResult = 'unconfigured';
    seed({});
    expect(await deliverTaskDispatch(row('task.created', { metadata: { targetLocalUiUrl: 'http://x' } }))).toBe('pusher:unconfigured');
  });
});

describe('deliverTaskDispatch: Pusher broadcast', () => {
  it('broadcasts to the workspace channel with the dispatch id and cause, never the description', async () => {
    seed({});
    const r = row('task.requeued', { causes: ['task.requeued', 'task.reassigned'] });
    expect(await deliverTaskDispatch(r)).toBe('pusher');
    const [channel, , data] = assignedCalls()[0] as [string, string, { task: Record<string, unknown>; targetLocalUiUrl: unknown }];
    expect(channel).toBe('workspace-ws-w1');
    expect(data.targetLocalUiUrl).toBeNull();
    expect(data.task).toMatchObject({ id: 'task-w1', backend: 'codex', missionId: 'mission-w1', dispatch: { id: r.id, cause: 'task.reassigned' } });
    expect('description' in data.task).toBe(false);
  });

  it('a failed broadcast throws so the row retries', async () => {
    pusherResult = 'failed';
    seed({});
    await expect(deliverTaskDispatch(row('task.requeued'))).rejects.toThrow('pusher broadcast failed');
  });

  it('unconfigured Pusher counts as delivered', async () => {
    pusherResult = 'unconfigured';
    seed({});
    expect(await deliverTaskDispatch(row('task.requeued'))).toBe('pusher:unconfigured');
  });

  it('never sends the dashboard TASK_CREATED event: a wake is not an announcement', async () => {
    seed({});
    await deliverTaskDispatch(row('task.created'));
    expect(mockTriggerEvent).not.toHaveBeenCalled();
  });
});

describe('deliverTaskDispatch: tasks that are no longer runnable', () => {
  for (const status of ['in_progress', 'completed', 'failed', 'blocked']) {
    it(`a ${status} task is skipped`, async () => {
      seed({ webhookConfig: WEBHOOK }, { status });
      expect(await deliverTaskDispatch(row('task.created'))).toBe(`skipped:status_${status}`);
      expect(fetchCalls).toHaveLength(0);
      expect(mockTriggerEventChecked).not.toHaveBeenCalled();
    });
  }

  it('a deleted task is skipped', async () => {
    expect(await deliverTaskDispatch(row('task.created', { taskId: 'gone' }))).toBe('skipped:task_gone');
  });
});

// ── Invariant: durable dispatch does not imply autonomous execution ────────

describe('deliverTaskDispatch: the dispatcher routes through adapters and owns no destination policy', () => {
  const recording = (outcome: { kind: 'delivered'; via: string } | { kind: 'declined' } | { kind: 'skipped'; why: string }) => {
    const seen: unknown[] = [];
    return { seen, adapter: { name: 'test', offer: async (ctx: unknown) => { seen.push(ctx); return outcome; } } };
  };

  it('a non-runner destination receives the intent and no runner is woken', async () => {
    seed({ webhookConfig: WEBHOOK });
    const dest = recording({ kind: 'delivered', via: 'interactive-session' });
    expect(await deliverTaskDispatch(row('dependency.satisfied'), [dest.adapter])).toBe('interactive-session');
    expect(fetchCalls).toHaveLength(0);
    expect(mockTriggerEventChecked).not.toHaveBeenCalled();
    expect(mockGitHubDispatch).not.toHaveBeenCalled();
  });

  it('the context carries a stable id, the specific cause and the full trail', async () => {
    seed();
    const dest = recording({ kind: 'delivered', via: 'x' });
    const r = row('task.created', { causes: ['task.created', 'ci.retry'], metadata: { hint: 1 } });
    await deliverTaskDispatch(r, [dest.adapter]);
    expect(dest.seen[0]).toMatchObject({
      dispatchId: r.id, cause: 'ci.retry', causes: ['task.created', 'ci.retry'], metadata: { hint: 1 },
      task: { id: TASK.id, status: 'pending' },
    });
  });

  it('"only pending tasks" is runner policy, not dispatcher policy', async () => {
    seed({}, { status: 'in_progress' });
    const dest = recording({ kind: 'delivered', via: 'external-system' });
    expect(await deliverTaskDispatch(row('task.unblocked'), [dest.adapter])).toBe('external-system');
    expect(await deliverTaskDispatch(row('task.unblocked'), TASK_WAKE_ADAPTERS)).toBe('skipped:status_in_progress');
  });

  it('a declined offer passes on; a chain nobody takes closes as no_destination', async () => {
    seed();
    const a = recording({ kind: 'declined' });
    const b = recording({ kind: 'delivered', via: 'b' });
    expect(await deliverTaskDispatch(row('task.created'), [a.adapter, b.adapter])).toBe('b');
    expect(a.seen).toHaveLength(1);
    expect(await deliverTaskDispatch(row('task.created'), [recording({ kind: 'declined' }).adapter])).toBe('skipped:no_destination');
  });

  it('an adapter that throws leaves the intent for retry', async () => {
    seed();
    const boom = { name: 'boom', offer: async () => { throw new Error('down'); } };
    await expect(deliverTaskDispatch(row('task.created'), [boom])).rejects.toThrow('down');
  });
});

describe('typed intents: Buildd decides what should happen; dispatch delivers it', () => {
  it('work_execution uses the runner chain unchanged', async () => {
    seed();
    expect(await deliverTaskDispatch(row('task.created'))).toBe('pusher');
    expect(assignedCalls()).toHaveLength(1);
  });

  for (const intent of ['human_action', 'notification', 'incident', 'external_work']) {
    it(`a ${intent} intent never reaches a runner, and with no adapter registered it is refused`, async () => {
      seed({ webhookConfig: WEBHOOK });
      await expect(deliverTaskDispatch(row('policy.requested', { intent }))).rejects.toThrow(`no_adapter:${intent}`);
      expect(fetchCalls).toHaveLength(0);
      expect(mockTriggerEventChecked).not.toHaveBeenCalled();
    });
  }

  it('an adapter for a non-work intent receives it with its kind (the seam a future destination plugs into)', async () => {
    seed();
    const seen: Array<{ intent: string; cause: string }> = [];
    const approvals = { name: 'approvals', offer: async (ctx: { intent: string; cause: string }) => { seen.push(ctx); return { kind: 'delivered' as const, via: 'approvals' }; } };
    expect(await deliverTaskDispatch(row('policy.requested', { intent: 'human_action' }), [approvals as never])).toBe('approvals');
    expect(seen[0]).toMatchObject({ intent: 'human_action', cause: 'policy.requested' });
    expect(mockTriggerEventChecked).not.toHaveBeenCalled();
  });

  it('the drain parks an unroutable intent at once instead of retrying it', async () => {
    seed();
    const r = row('policy.requested', { intent: 'notification', attemptCount: 1 });
    claimQueue = [r];
    const res = await drainDispatchOutbox();
    expect(res.failed).toBe(1);
    expect(mockMarkFailed).toHaveBeenCalledWith(r.id, MAX_DELIVERY_ATTEMPTS, 'no_adapter:notification');
  });
});

describe('offerScheduledNotice: task.scheduled advance notice (opt-in)', () => {
  const ctxFor = (workspace: Record<string, unknown>, task: Partial<typeof TASK> = {}) => ({
    dispatchId: 'd-1', intent: 'work_execution' as const, attemptCount: 0,
    cause: 'task.requeued' as DispatchCause, causes: ['task.requeued'] as DispatchCause[], metadata: null,
    task: { ...TASK, ...task }, workspace: { id: TASK.workspaceId, ...workspace },
  });
  const inFive = () => new Date(Date.now() + 5 * 60_000);

  it('a webhook listing task.scheduled gets the notice at once, with notBefore', async () => {
    const due = inFive();
    expect(await offerScheduledNotice(ctxFor({ webhookConfig: { ...WEBHOOK, events: ['task.retry', 'task.scheduled'] } }), due)).toBe(true);
    expect(sentBody()).toMatchObject({ event: 'task.scheduled', notBefore: due.toISOString(), dispatchId: 'd-1', cause: 'task.requeued' });
    expect(mockTriggerEventChecked).not.toHaveBeenCalled();
  });

  it('nothing without the opt-in, including a legacy webhook', async () => {
    expect(await offerScheduledNotice(ctxFor({ webhookConfig: { ...WEBHOOK, events: ['task.retry'] } }), inFive())).toBe(false);
    expect(await offerScheduledNotice(ctxFor({ webhookConfig: LEGACY_WEBHOOK }), inFive())).toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });

  it('not beyond the consumer horizon, not in the past, not for a held task or the wrong runner', async () => {
    const cfg = { webhookConfig: { ...WEBHOOK, events: ['task.scheduled'] } };
    expect(await offerScheduledNotice(ctxFor(cfg), new Date(Date.now() + 25 * 3_600_000))).toBe(false);
    expect(await offerScheduledNotice(ctxFor(cfg), new Date(Date.now() - 1000))).toBe(false);
    expect(await offerScheduledNotice(ctxFor({ webhookConfig: { ...WEBHOOK, events: ['task.scheduled'], runnerPreference: 'service' } }, { runnerPreference: 'user' }), inFive())).toBe(false);
    taskNotParked = false;
    expect(await offerScheduledNotice(ctxFor(cfg), inFive())).toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });
});

// ── drainDispatchOutbox ────────────────────────────────────────────────────

describe('drainDispatchOutbox', () => {
  it('claims up to DRAIN_BATCH by default, or the given limit', async () => {
    await drainDispatchOutbox();
    expect(mockClaimDue).toHaveBeenLastCalledWith(DRAIN_BATCH);
    await drainDispatchOutbox({ limit: 3 });
    expect(mockClaimDue).toHaveBeenLastCalledWith(3);
  });

  it('counts delivered, skipped and failed, and marks each row accordingly', async () => {
    seed({}, { id: 'ok' });
    seed({}, { id: 'done', status: 'completed' });
    seed({ webhookConfig: WEBHOOK }, { id: 'hooked' });
    const ok = row('task.created', { taskId: 'ok' });
    const done = row('task.created', { taskId: 'done' });
    const hooked = row('task.created', { taskId: 'hooked' });
    claimQueue = [ok, done, hooked];

    expect(await drainDispatchOutbox()).toEqual({ claimed: 3, delivered: 2, skipped: 1, failed: 0 });
    expect(mockMarkDelivered.mock.calls.sort()).toEqual([
      [done.id, 'skipped:status_completed'],
      [hooked.id, 'webhook'],
      [ok.id, 'pusher'],
    ].sort());
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it('a delivery that throws is marked failed with its attempt count, and the rest still go out', async () => {
    seed({});
    pusherResult = 'failed';
    const bad = row('task.requeued', { attemptCount: 3 });
    claimQueue = [bad, row('task.created', { taskId: 'gone' })];

    expect(await drainDispatchOutbox()).toEqual({ claimed: 2, delivered: 0, skipped: 1, failed: 1 });
    expect(mockMarkFailed).toHaveBeenCalledWith(bad.id, 3, 'pusher broadcast failed');
    expect(mockMarkDelivered).toHaveBeenCalledTimes(1);
  });

  it('a markDispatchFailed error does not escape the drain', async () => {
    seed({});
    pusherResult = 'failed';
    mockMarkFailed.mockImplementationOnce(async () => { throw new Error('db down'); });
    claimQueue = [row('task.requeued')];
    expect(await drainDispatchOutbox()).toMatchObject({ failed: 1 });
  });

  it('a failure republishes the timer so the backoff retry fires on time', async () => {
    seed({});
    pusherResult = 'failed';
    futureDispatches = [{ id: 'later', notBefore: new Date(Date.now() + 15_000) }];
    claimQueue = [row('task.requeued')];
    await drainDispatchOutbox();
    expect(mockMarkDue).toHaveBeenCalledWith('dispatch', 'later', futureDispatches[0].notBefore.getTime());
  });
});

// ── kickDispatch / wakeTask ────────────────────────────────────────────────

describe('lost-kick marker', () => {
  it('a wake publishes a near-future due marker and the kick that drains clears it', async () => {
    seed();
    mockMarkDue.mockClear(); mockClearDue.mockClear();
    const before = Date.now();
    await wakeTask(TASK.id, 'ci.retry');
    const call = mockMarkDue.mock.calls.find(c => String(c[1]).startsWith('kick:'))!;
    expect(call[0]).toBe('dispatch');
    expect(Number(call[2])).toBeGreaterThanOrEqual(before + 30_000);
    for (let i = 0; i < 5 && mockClearDue.mock.calls.length === 0; i++) await flush();
    expect(mockClearDue).toHaveBeenCalledWith('dispatch', call[1]);
  });

  it('a kick whose drain fails leaves the marker for the gated tick', async () => {
    mockMarkDue.mockClear(); mockClearDue.mockClear();
    mockClaimDue.mockImplementationOnce(async () => { throw new Error('db down'); });
    await wakeTask(TASK.id, 'ci.retry');
    for (let i = 0; i < 5; i++) await flush();
    expect(mockClearDue).not.toHaveBeenCalled();
  });
});

describe('kickDispatch', () => {
  it('outside a request scope it drains now, detached', async () => {
    seed({});
    claimQueue = [row('task.created')];
    kickDispatch();
    await flush(); await flush();
    expect(mockClaimDue).toHaveBeenCalledTimes(1);
    expect(mockMarkDelivered).toHaveBeenCalledTimes(1);
  });

  it('inside a request scope it waits for after()', async () => {
    afterQueue = [];
    kickDispatch();
    await flush();
    expect(mockClaimDue).not.toHaveBeenCalled();
    expect(afterQueue).toHaveLength(1);
    await afterQueue[0]();
    expect(mockClaimDue).toHaveBeenCalledTimes(1);
  });

  it('never throws, even when the drain does', async () => {
    mockClaimDue.mockImplementationOnce(async () => { throw new Error('db down'); });
    expect(() => kickDispatch()).not.toThrow();
    await flush();
  });

  it('publishes future due times to the Redis timer index', async () => {
    const at = new Date(Date.now() + 60_000);
    futureDispatches = [{ id: 'f1', notBefore: at }];
    kickDispatch();
    await flush(); await flush();
    expect(mockMarkDue).toHaveBeenCalledWith('dispatch', 'f1', at.getTime());
  });
});

describe('wakeTask / wakeTasks / announceTaskCreated', () => {
  it('wakeTask enqueues the cause with delivery hints and kicks', async () => {
    await wakeTask('task-w1', 'task.created', { targetLocalUiUrl: 'http://x' });
    expect(mockEnqueueSql).toHaveBeenCalledWith({ taskId: 'task-w1', cause: 'task.created', notBefore: undefined, metadata: { targetLocalUiUrl: 'http://x' } });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    await flush();
    expect(mockClaimDue).toHaveBeenCalled();
  });

  it('wakeTask swallows an enqueue failure and still kicks (the trigger row stands)', async () => {
    mockExecute.mockImplementationOnce(async () => { throw new Error('db down'); });
    await wakeTask('task-w1', 'dependency.satisfied');
    await flush();
    expect(mockClaimDue).toHaveBeenCalled();
  });

  it('wakeTasks enqueues each id, tolerates partial failure and kicks once', async () => {
    mockExecute.mockImplementationOnce(async () => { throw new Error('one bad'); });
    await wakeTasks(['a', 'b', 'c'], 'mission.released');
    expect(mockEnqueueSql).toHaveBeenCalledTimes(3);
    await flush();
    expect(mockClaimDue).toHaveBeenCalledTimes(1);
  });

  it('wakeTasks with no ids does nothing', async () => {
    await wakeTasks([], 'mission.released');
    await flush();
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockClaimDue).not.toHaveBeenCalled();
  });

  it('announceTaskCreated sends only the dashboard TASK_CREATED event', async () => {
    await announceTaskCreated(TASK, { name: 'ws' });
    expect(mockTriggerEvent).toHaveBeenCalledTimes(1);
    expect(mockTriggerEvent.mock.calls[0][1]).toBe('task:created');
    expect(mockTriggerEventChecked).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
