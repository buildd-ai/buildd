import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';

// Resolve and relay, and the parity table: for every AC-10…AC-18 case of
// docs/specs/task-dispatch-authority.md, the Dispatch transport (routeFor →
// resolve per step → relay for the wake) reaches the same outcome as the
// in-app chain (deliverTaskDispatch). Both go through the same decision
// functions in dispatch-adapters.ts; this proves the wiring.

type Sent = 'sent' | 'unconfigured' | 'failed';
let pusherResult: Sent = 'sent';
const mockTriggerEventChecked = mock(async (..._args: unknown[]): Promise<Sent> => pusherResult);
mock.module('@/lib/pusher', () => ({
  triggerEvent: async () => {},
  triggerEventChecked: mockTriggerEventChecked,
  channels: { workspace: (id: string) => `workspace-${id}` },
  events: { TASK_CREATED: 'task:created', TASK_ASSIGNED: 'task:assigned' },
}));

let heldGate: 'open' | 'held' | 'throws' = 'open';
mock.module('@/app/api/workers/claim/held-gate', () => ({
  isTaskNotHeldOrLocal: async () => {
    if (heldGate === 'throws') throw new Error('gate down');
    return heldGate === 'open';
  },
}));
mock.module('@/lib/redis', () => ({ markDue: async () => {}, reseedDue: async () => {}, clearDue: async () => {}, tryLock: async () => true }));

let taskRow: Record<string, unknown> | null = null;
mock.module('@buildd/core/db', () => ({
  db: {
    execute: async () => ({ rows: [] }),
    query: {
      tasks: { findFirst: async () => taskRow, findMany: async () => (taskRow ? [taskRow] : []) },
    },
  },
}));

const { DISPATCH_CAUSES } = await import('@buildd/core/dispatch-outbox');
const { deliverTaskDispatch } = await import('./dispatch-authority');
const { routeFor } = await import('./dispatch-transport');
const { resolveDispatch, relayDispatch, RESOLVE_DEPS } = await import('./dispatch-resolve');
type DispatchCause = (typeof DISPATCH_CAUSES)[number];
type ResolveDeps = typeof RESOLVE_DEPS;

// ── Fixtures ───────────────────────────────────────────────────────────────

const WS = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const ROW_ID = '33333333-3333-4333-8333-333333333333';
const HOOK_URL = 'https://hooks.example.test/dispatch';
const LEGACY_WEBHOOK = { url: HOOK_URL, token: 'hook-token', enabled: true };
const WEBHOOK = { ...LEGACY_WEBHOOK, events: ['task.created', 'task.unblocked', 'task.retry'] };
const T = (type: string) => `buildd:ws:${WS}:${type}`;

interface Case {
  name: string;
  cause?: DispatchCause;
  workspace?: Record<string, unknown>;
  task?: Record<string, unknown>;
  metadata?: Record<string, unknown> | null;
  webhookStatus?: number;
  held?: typeof heldGate;
  pusher?: Sent;
}

function seed(c: Case) {
  fetchCalls = [];
  mockTriggerEventChecked.mockClear();
  heldGate = c.held ?? 'open';
  pusherResult = c.pusher ?? 'sent';
  fetchStatus = c.webhookStatus ?? 200;
  taskRow = {
    id: TASK_ID, title: 'Ship it', description: 'Do it', workspaceId: WS, mode: 'execution', priority: 3,
    missionId: null, backend: 'codex', roleSlug: null, runnerPreference: null, status: 'pending', startAt: null,
    ...c.task,
    workspace: { id: WS, name: 'ws', repo: null, webhookConfig: null, githubInstallationId: null, githubRepoId: null, ...c.workspace },
  };
}

function custodyRow(c: Case) {
  const cause = c.cause ?? 'task.created';
  return {
    id: ROW_ID, intent: 'work_execution' as const, workspaceId: WS, taskId: TASK_ID, cause, causes: [cause],
    notBefore: new Date(), attemptCount: 0, metadata: c.metadata ?? null, status: 'handed_off', transport: 'dispatch',
    handedOffAt: new Date(),
  };
}

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let fetchStatus = 200;
beforeEach(() => {
  fetchCalls = [];
  mockTriggerEventChecked.mockClear();
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    return new Response('ok', { status: fetchStatus });
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });

/** What happened, transport-neutral. */
interface Outcome {
  webhookBodies: unknown[];
  /** Requests to anything but the webhook (there were GitHub dispatches here once). */
  otherRequests: number;
  wake: 'broadcast' | 'targeted' | null;
  /** delivered | closed_unsent (Pusher unconfigured) | skipped:<why> | retry */
  closed: string;
}

function wakeKind(): Outcome['wake'] {
  const calls = mockTriggerEventChecked.mock.calls.filter(c => c[1] === 'task:assigned');
  if (calls.length === 0) return null;
  expect(calls).toHaveLength(1);
  return (calls[0][2] as { targetLocalUiUrl: string | null }).targetLocalUiUrl ? 'targeted' : 'broadcast';
}

async function inAppOutcome(c: Case): Promise<Outcome> {
  seed(c);
  const r = custodyRow(c);
  let closed: string;
  try {
    const via = await deliverTaskDispatch({ ...r, attemptCount: 1 });
    closed = via === 'pusher:unconfigured' ? 'closed_unsent' : via.startsWith('skipped:') ? via : 'delivered';
  } catch {
    closed = 'retry';
  }
  return {
    webhookBodies: fetchCalls.filter(f => f.url === HOOK_URL && f.init.method === 'POST').map(f => JSON.parse(f.init.body as string)),
    otherRequests: fetchCalls.filter(f => f.url !== HOOK_URL).length,
    wake: wakeKind(),
    closed,
  };
}

const testDeps = (c: Case): ResolveDeps => ({
  ...RESOLVE_DEPS,
  loadRow: async () => custodyRow(c),
  claimCustody: async () => false,
  grantOnce: async () => true,
});

/**
 * Dispatch's side, simulated: walk routeFor's steps the way the Worker's
 * alarm loop does. A resolve `deliver` POSTs the payload with the grant (a
 * non-2xx is a decline, as the in-app webhook adapter treats it); the
 * runner wake goes through relay. No route has `also` steps any more.
 */
async function dispatchOutcome(c: Case): Promise<Outcome> {
  seed(c);
  const deps = testDeps(c);
  const r = custodyRow(c);
  const loaded = taskRow as Record<string, unknown> & { workspace: Record<string, unknown> };
  const { workspace, ...task } = loaded;
  const route = routeFor({ ...r, dedupeKey: 'now', mode: 'dispatch' }, task as never, workspace as never)!;
  expect(route.steps.filter(s => s.mode === 'also')).toEqual([]);
  let closed = 'delivered_nowhere';
  for (const step of route.steps.filter(s => s.mode === 'first')) {
    if (step.resolve) {
      const res = await resolveDispatch({ id: ROW_ID, attempt: 1, target: step.target }, deps);
      const body = res.body as { decision: string; why?: string; payload?: unknown; grant?: { url: string; headers: Record<string, string> } };
      if (body.decision === 'skip') { closed = `skipped:${body.why}`; break; }
      if (body.decision === 'reschedule') { closed = 'rescheduled'; break; }
      if (body.decision === 'deliver') {
        const resp = await fetch(body.grant!.url, { method: 'POST', headers: body.grant!.headers, body: JSON.stringify(body.payload) });
        if (resp.ok) { closed = 'delivered'; break; }
      }
      continue;
    }
    const res = await relayDispatch({ id: ROW_ID, attempt: 1, target: step.target, payload: route.payload }, deps);
    if (res.status === 502) { closed = 'retry'; break; }
    const body = res.body as { outcome: string; why?: string };
    closed = body.outcome === 'delivered' ? 'delivered'
      : body.why === 'pusher_unconfigured' ? 'closed_unsent'
      : `skipped:${body.why}`;
    break;
  }
  return {
    webhookBodies: fetchCalls.filter(f => f.url === HOOK_URL && f.init.method === 'POST').map(f => JSON.parse(f.init.body as string)),
    otherRequests: fetchCalls.filter(f => f.url !== HOOK_URL).length,
    wake: wakeKind(),
    closed,
  };
}

// ── The parity table ───────────────────────────────────────────────────────

const LEGACY_CAUSES: DispatchCause[] = ['task.created', 'review.fix_requested', 'ci.retry', 'conflict.retry', 'dependency.satisfied', 'manual.start'];
const LINKED = { githubInstallationId: 'inst', githubRepoId: 'repo' };

const CASES: Case[] = [
  // AC-10: a legacy webhook sees only the legacy causes; the rest broadcast.
  ...DISPATCH_CAUSES.map(cause => ({ name: `AC-10 legacy webhook, ${cause}`, cause, workspace: { webhookConfig: LEGACY_WEBHOOK } })),
  // AC-11: an opted-in webhook gets exactly the events it lists.
  ...DISPATCH_CAUSES.map(cause => ({ name: `AC-11 opted-in (task.created only), ${cause}`, cause, workspace: { webhookConfig: { ...LEGACY_WEBHOOK, events: ['task.created'] } } })),
  ...DISPATCH_CAUSES.map(cause => ({ name: `AC-11 opted-in (all), ${cause}`, cause, workspace: { webhookConfig: WEBHOOK } })),
  // AC-12: runnerPreference filters, except the legacy unblocked quirk.
  ...DISPATCH_CAUSES.map(cause => ({ name: `AC-12 service webhook, user task, legacy, ${cause}`, cause, workspace: { webhookConfig: { ...LEGACY_WEBHOOK, runnerPreference: 'service' } }, task: { runnerPreference: 'user' } })),
  ...DISPATCH_CAUSES.map(cause => ({ name: `AC-12 service webhook, user task, opted-in, ${cause}`, cause, workspace: { webhookConfig: { ...WEBHOOK, runnerPreference: 'service' } }, task: { runnerPreference: 'user' } })),
  // AC-13: held, or a gate that throws, keeps the task off the webhook.
  { name: 'AC-13 held task', workspace: { webhookConfig: WEBHOOK }, held: 'held' },
  { name: 'AC-13 held gate throws', workspace: { webhookConfig: WEBHOOK }, held: 'throws' },
  { name: 'AC-13 policy rules webhook out, gate irrelevant', cause: 'task.requeued', workspace: { webhookConfig: LEGACY_WEBHOOK }, held: 'throws' },
  // AC-14: a webhook non-2xx falls back to the broadcast.
  { name: 'AC-14 webhook 500', workspace: { webhookConfig: WEBHOOK }, webhookStatus: 500 },
  // AC-15: a targeted local runner gets only the targeted wake.
  { name: 'AC-15 targeted', metadata: { targetLocalUiUrl: 'http://runner.test' }, workspace: { webhookConfig: WEBHOOK, ...LINKED } },
  // AC-16: Pusher failed → retried; unconfigured → closed with nothing sent.
  { name: 'AC-16 pusher failed', pusher: 'failed' },
  { name: 'AC-16 pusher failed, targeted', pusher: 'failed', metadata: { targetLocalUiUrl: 'http://runner.test' } },
  { name: 'AC-16 pusher unconfigured', pusher: 'unconfigured' },
  // AC-17: the webhook body carries cause and dispatchId (compared whole).
  { name: 'AC-17 webhook body', cause: 'ci.retry', workspace: { webhookConfig: WEBHOOK } },
  // AC-18: a task that is no longer pending is skipped, nothing sent.
  ...['assigned', 'in_progress', 'completed', 'failed'].flatMap(status => [
    { name: `AC-18 ${status}, webhook`, task: { status }, workspace: { webhookConfig: WEBHOOK } },
    { name: `AC-18 ${status}, no webhook`, task: { status } },
  ]),
  // A GitHub-linked repo changes nothing: no transport sends anything to GitHub.
  ...LEGACY_CAUSES.map(cause => ({ name: `GitHub-linked, no webhook, ${cause}`, cause, workspace: LINKED })),
  { name: 'GitHub-linked, webhook 500', workspace: { webhookConfig: WEBHOOK, ...LINKED }, webhookStatus: 500 },
];

describe('parity: Dispatch transport outcome equals the in-app chain (AC-10…AC-18)', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const inApp = await inAppOutcome(c);
      const viaDispatch = await dispatchOutcome(c);
      expect(viaDispatch).toEqual(inApp);
    });
  }

  it('the table covers every cause for the webhook policy cases', () => {
    expect(CASES.filter(c => c.name.startsWith('AC-10')).length).toBe(DISPATCH_CAUSES.length);
  });
});

describe('known, intended differences', () => {
  it('a future startAt: resolve skips like in-app (the start_at row delivers it), so the webhook fires once', async () => {
    const startAt = new Date(Date.now() + 3_600_000);
    const c: Case = { name: 'deferred', task: { startAt }, workspace: { webhookConfig: WEBHOOK } };
    expect((await inAppOutcome(c)).closed).toBe('skipped:start_at_future');
    seed(c);
    const res = await resolveDispatch({ id: ROW_ID, attempt: 1, target: T('webhook') }, testDeps(c));
    expect(res.body).toEqual({ decision: 'skip', why: 'start_at_future' });
    // The relayed runner wake skips, as in-app does: the claim would refuse it.
    expect((await relayDispatch({ id: ROW_ID, attempt: 1, target: T('runner-wake') }, testDeps(c))).body)
      .toEqual({ outcome: 'skipped', why: 'start_at_future' });
  });
});

// ── Resolve and relay details ──────────────────────────────────────────────

describe('resolveDispatch', () => {
  const base: Case = { name: 'base', workspace: { webhookConfig: WEBHOOK } };

  it('a webhook deliver carries the payload and a bearer grant, and nothing else of the config', async () => {
    seed(base);
    const res = await resolveDispatch({ id: ROW_ID, attempt: 1, target: T('webhook') }, testDeps(base));
    expect(res.status).toBe(200);
    const body = res.body as { decision: string; payload: Record<string, unknown>; grant: { url: string; headers: Record<string, string> } };
    expect(body.decision).toBe('deliver');
    expect(body.payload).toMatchObject({ event: 'task.created', taskId: TASK_ID, cause: 'task.created', dispatchId: ROW_ID });
    expect(body.grant).toEqual({ url: HOOK_URL, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer hook-token' } });
  });

  it('a github-actions target, from an intent queued before that type was removed, is an unknown target', async () => {
    seed({ name: 'old', workspace: LINKED });
    const res = await resolveDispatch({ id: ROW_ID, attempt: 1, target: T('github-actions') }, testDeps({ name: 'old', workspace: LINKED }));
    expect(res).toEqual({ status: 400, body: { error: 'unknown target' } });
    expect(fetchCalls).toHaveLength(0);
  });

  it('a second grant for the same (id, attempt, target) inside the window is refused; Redis down fails open', async () => {
    seed(base);
    const keys: string[] = [];
    const refused = await resolveDispatch({ id: ROW_ID, attempt: 1, target: T('webhook') },
      { ...testDeps(base), grantOnce: async (k: string) => { keys.push(k); return false; } });
    expect(refused.body).toEqual({ decision: 'decline', why: 'grant_already_issued' });
    expect(keys).toEqual([`buildd:dispatch:grant:${ROW_ID}:1:${T('webhook')}`]);
    const open = await resolveDispatch({ id: ROW_ID, attempt: 1, target: T('webhook') }, { ...testDeps(base), grantOnce: async () => null });
    expect((open.body as { decision: string }).decision).toBe('deliver');
  });

  it('refuses a runner-wake target, an unknown target, a foreign workspace, and an unknown id', async () => {
    seed(base);
    const d = testDeps(base);
    expect((await resolveDispatch({ id: ROW_ID, attempt: 1, target: T('runner-wake') }, d)).status).toBe(400);
    expect((await resolveDispatch({ id: ROW_ID, attempt: 1, target: 'buildd:ws:x:webhook' }, d)).status).toBe(400);
    expect((await resolveDispatch({ id: ROW_ID, attempt: 1, target: 'buildd:ws:99999999-9999-4999-8999-999999999999:webhook' }, d)).status).toBe(403);
    expect((await resolveDispatch({ id: ROW_ID, attempt: 1, target: T('webhook') }, { ...d, loadRow: async () => null })).status).toBe(404);
    expect((await resolveDispatch({ id: ROW_ID, attempt: -1, target: T('webhook') } as never, d)).status).toBe(400);
  });

  it('a callback that outran its publish ack takes custody and proceeds instead of losing the wake', async () => {
    seed(base);
    const d = testDeps(base);
    const row = custodyRow(base);
    let acked = false;
    const claimed: string[] = [];
    const deps: ResolveDeps = {
      ...d,
      loadRow: async () => (acked ? row : { ...row, status: 'pending', handedOffAt: null }),
      claimCustody: async id => { claimed.push(id); acked = true; return true; },
    };
    expect((await resolveDispatch({ id: ROW_ID, attempt: 1, target: T('webhook') }, deps)).body).toMatchObject({ decision: 'deliver' });
    expect(claimed).toEqual([ROW_ID]);
    // The relayed runner wake takes the same path.
    acked = false;
    expect((await relayDispatch({ id: ROW_ID, attempt: 1, target: T('runner-wake') }, deps)).body).toMatchObject({ outcome: 'delivered' });
    // When the claim is refused (taken back, never published, in-app took it) the answer stays not_in_custody.
    const refused: ResolveDeps = { ...d, loadRow: async () => ({ ...row, status: 'pending', handedOffAt: null }), claimCustody: async () => false };
    expect((await resolveDispatch({ id: ROW_ID, attempt: 1, target: T('webhook') }, refused)).body)
      .toEqual({ decision: 'skip', why: 'not_in_custody:pending' });
  });

  it('a row out of custody, a non-work intent, or a gone task answers skip so Dispatch closes it', async () => {
    seed(base);
    const d = testDeps(base);
    const row = custodyRow(base);
    expect((await resolveDispatch({ id: ROW_ID, attempt: 1, target: T('webhook') }, { ...d, loadRow: async () => ({ ...row, status: 'delivered' }) })).body)
      .toEqual({ decision: 'skip', why: 'not_in_custody:delivered' });
    expect((await resolveDispatch({ id: ROW_ID, attempt: 1, target: T('webhook') }, { ...d, loadRow: async () => ({ ...row, status: 'pending', handedOffAt: null }) })).body)
      .toEqual({ decision: 'skip', why: 'not_in_custody:pending' });
    expect((await resolveDispatch({ id: ROW_ID, attempt: 1, target: T('webhook') }, { ...d, loadRow: async () => ({ ...row, intent: 'notification' as never }) })).body)
      .toEqual({ decision: 'skip', why: 'no_adapter:notification' });
    // A shadow row Dispatch acked and the in-app drain has not delivered is in custody.
    expect((await resolveDispatch({ id: ROW_ID, attempt: 1, target: T('webhook') }, { ...d, loadRow: async () => ({ ...row, status: 'pending', transport: 'in_app' }) })).body)
      .toMatchObject({ decision: 'deliver' });
    taskRow = null;
    expect((await resolveDispatch({ id: ROW_ID, attempt: 1, target: T('webhook') }, d)).body).toEqual({ decision: 'skip', why: 'task_gone' });
  });
});

describe('relayDispatch', () => {
  const base: Case = { name: 'relay' };

  it('broadcasts with the dispatch id, via relay:pusher', async () => {
    seed(base);
    const res = await relayDispatch({ id: ROW_ID, attempt: 1, target: T('runner-wake') }, testDeps(base));
    expect(res).toEqual({ status: 200, body: { outcome: 'delivered', via: 'relay:pusher' } });
    const [, event, data] = mockTriggerEventChecked.mock.calls[0];
    expect(event).toBe('task:assigned');
    expect(data).toMatchObject({ targetLocalUiUrl: null, task: { id: TASK_ID, dispatch: { id: ROW_ID, cause: 'task.created' } } });
  });

  it('targets the local runner named in the payload', async () => {
    seed(base);
    const res = await relayDispatch({ id: ROW_ID, attempt: 1, target: T('runner-wake'), payload: { targetLocalUiUrl: 'http://r.test' } }, testDeps(base));
    expect(res.body).toEqual({ outcome: 'delivered', via: 'relay:pusher:targeted' });
    expect((mockTriggerEventChecked.mock.calls[0][2] as { targetLocalUiUrl: string }).targetLocalUiUrl).toBe('http://r.test');
  });

  it('Pusher failed → 502 (Dispatch retries); unconfigured → skipped', async () => {
    seed({ ...base, pusher: 'failed' });
    expect((await relayDispatch({ id: ROW_ID, attempt: 1, target: T('runner-wake') }, testDeps(base))).status).toBe(502);
    seed({ ...base, pusher: 'unconfigured' });
    expect((await relayDispatch({ id: ROW_ID, attempt: 1, target: T('runner-wake') }, testDeps(base))).body)
      .toEqual({ outcome: 'skipped', why: 'pusher_unconfigured' });
  });

  it('only relays the runner-wake target', async () => {
    seed(base);
    expect((await relayDispatch({ id: ROW_ID, attempt: 1, target: T('webhook') }, testDeps(base))).status).toBe(400);
  });
});
