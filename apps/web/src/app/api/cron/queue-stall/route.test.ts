import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── DB mocks ────────────────────────────────────────────────────────────────
//
// The route issues two shapes of `tasks.findMany` (candidates, then the
// dependency lookup) and two shapes of `workers.findMany` (candidate workers,
// then dep open-PR workers). Sequencing mocks by call order is brittle, so the
// mocks dispatch on the *shape* of the mocked `where` clause instead:
//   where.type === 'inArray'  → the id-list lookup (deps / candidate workers)
//   where.type === 'and'      → the filtered scan (candidates / dep PRs)

let candidateTasks: any[] = [];
let depTasks: any[] = [];
let candidateWorkers: any[] = [];
let depPrWorkers: any[] = [];
let missionPeerTasks: any[] = [];
let taskUpdates: Array<{ values: any }> = [];

const mockTasksFindMany = mock((args: any) => {
  const where = args?.where;
  if (where?.type !== 'inArray') return candidateTasks;
  // inArray(tasks.missionId, ...) → the advisory-manifest peer probe.
  // inArray(tasks.id, ...)        → the dependency lookup.
  return where.f === 'missionId' ? missionPeerTasks : depTasks;
});
const mockWorkersFindMany = mock((args: any) =>
  args?.where?.type === 'inArray' ? candidateWorkers : depPrWorkers,
);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findMany: mockTasksFindMany },
      workers: { findMany: mockWorkersFindMany },
    },
    update: mock(() => ({
      set: mock((values: any) => ({
        where: mock(() => {
          taskUpdates.push({ values });
          return Promise.resolve();
        }),
      })),
    })),
  },
}));

mock.module('drizzle-orm', () => ({
  // `sql` is not used by this route, but lib/bypass-flags.ts imports it at
  // module scope for bypassFlagCondition(); a partial stub without it fails the
  // import outright.
  sql: (strings: any, ...values: any[]) => ({ strings, values, type: 'sql' }),
  eq: (f: any, v: any) => ({ f, v, type: 'eq' }),
  and: (...c: any[]) => ({ c, type: 'and' }),
  lt: (f: any, v: any) => ({ f, v, type: 'lt' }),
  inArray: (f: any, v: any) => ({ f, v, type: 'inArray' }),
  isNull: (f: any) => ({ f, type: 'isNull' }),
  isNotNull: (f: any) => ({ f, type: 'isNotNull' }),
  asc: (f: any) => ({ f, type: 'asc' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'id', status: 'status', createdAt: 'createdAt', missionId: 'missionId' },
  workers: { taskId: 'taskId', prUrl: 'prUrl', mergedAt: 'mergedAt' },
}));

// ── Gate helper mocks (the real ones do DB + HTTP probes) ───────────────────

const mockCheckConnectorRouting = mock(() => Promise.resolve(null as any));
const mockCheckMissionHeld = mock(() => Promise.resolve(false));
const mockCheckWorkspaceCap = mock(() => Promise.resolve(null as any));
const mockCheckMissionBudgetExhausted = mock(() => Promise.resolve(false));

mock.module('@/app/api/workers/claim/connector-gate', () => ({
  checkConnectorRouting: mockCheckConnectorRouting,
}));
mock.module('@/app/api/workers/claim/held-gate', () => ({
  checkMissionHeld: mockCheckMissionHeld,
}));
mock.module('@/app/api/workers/claim/mission-budget-gate', () => ({
  checkMissionBudgetExhausted: mockCheckMissionBudgetExhausted,
}));
mock.module('@/app/api/workers/claim/workspace-cap-gate', () => ({
  checkWorkspaceCap: mockCheckWorkspaceCap,
}));

// The backend-credential probe (lib/backend-strand.ts) reads secrets + the team
// provider mask; stub it to the verdict each case is about.
let strandVerdict: { backend: string; label: string } | null = null;
const mockStrandCheck = mock((_task: any) => Promise.resolve(strandVerdict));
mock.module('@/lib/backend-strand', () => ({
  createBackendStrandProbe: () => ({ check: mockStrandCheck }),
}));

const mockNotify = mock((_opts: any) => undefined);
mock.module('@/lib/pushover', () => ({ notify: mockNotify }));

const { POST } = await import('./route');

// ── Helpers ─────────────────────────────────────────────────────────────────

const CRON_SECRET = 'test-cron-secret';

function makeRequest(token: string | null = CRON_SECRET): NextRequest {
  return new NextRequest('http://localhost/api/cron/queue-stall', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000);
const hoursFromNow = (n: number) => new Date(Date.now() + n * 3_600_000);

function task(over: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    title: 'Fix the thing',
    workspaceId: 'ws-1',
    backend: 'claude',
    roleSlug: null,
    missionId: null,
    dependsOn: [],
    startAt: null,
    createdAt: hoursAgo(30),
    context: {},
    subjectKind: null,
    subjectPrNumber: null,
    subjectResolution: null,
    subjectAnchor: null,
    pathManifest: ['apps/web/src/lib/foo.ts'],
    workspace: {
      id: 'ws-1',
      name: 'buildd',
      teamId: 'team-1',
      repo: null,
      maxConcurrentTasks: 3,
    },
    ...over,
  };
}

beforeEach(() => {
  process.env.CRON_SECRET = CRON_SECRET;
  candidateTasks = [];
  depTasks = [];
  candidateWorkers = [];
  depPrWorkers = [];
  missionPeerTasks = [];
  taskUpdates = [];
  mockTasksFindMany.mockClear();
  mockWorkersFindMany.mockClear();
  mockCheckConnectorRouting.mockClear();
  mockCheckConnectorRouting.mockResolvedValue(null);
  mockCheckMissionHeld.mockClear();
  mockCheckMissionHeld.mockResolvedValue(false);
  mockCheckWorkspaceCap.mockClear();
  mockCheckWorkspaceCap.mockResolvedValue(null);
  mockCheckMissionBudgetExhausted.mockClear();
  mockCheckMissionBudgetExhausted.mockResolvedValue(false);
  strandVerdict = null;
  mockStrandCheck.mockClear();
  mockNotify.mockClear();
});

describe('queue-stall cron — auth', () => {
  it('rejects a request without the cron secret', async () => {
    const res = await POST(makeRequest(null));
    expect(res.status).toBe(401);
  });

  it('rejects a request with the wrong cron secret', async () => {
    const res = await POST(makeRequest('nope'));
    expect(res.status).toBe(401);
  });

  it('fails closed when CRON_SECRET is not configured', async () => {
    delete process.env.CRON_SECRET;
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
  });
});

describe('queue-stall cron — never-claimed detection', () => {
  it('catches a task whose only worker failed (the incident shape)', async () => {
    // The incident task had a worker row — it just never produced anything.
    // "no worker" is NOT the same as "never successfully claimed".
    candidateTasks = [
      task({
        subjectKind: 'pull_request',
        subjectPrNumber: 1789,
        subjectResolution: 'reconciled',
        subjectAnchor: { source: 'system' },
      }),
    ];
    candidateWorkers = [{ taskId: 'task-1', status: 'failed' }];

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled).toHaveLength(1);
    expect(body.stalled[0].gate).toBe('subject_dead');
  });

  it('skips a task that has a live worker (it is progressing)', async () => {
    candidateTasks = [task()];
    candidateWorkers = [{ taskId: 'task-1', status: 'running' }];

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled).toHaveLength(0);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('skips a task that has already been claimed successfully once', async () => {
    // A re-queued loop task with a completed worker has been claimed before —
    // it is not a never-claimed queue stall.
    candidateTasks = [task()];
    candidateWorkers = [{ taskId: 'task-1', status: 'completed' }];

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled).toHaveLength(0);
  });
});

describe('queue-stall cron — names the blocking gate', () => {
  it('names dep_failed when a dependency failed and will never complete', async () => {
    // The exact shape produced when a terminal-failure writer skips the
    // dependency cascade: dep is failed, dependent sits pending forever.
    candidateTasks = [task({ dependsOn: ['dep-1'] })];
    depTasks = [{ id: 'dep-1', title: 'Upstream migration', status: 'failed' }];

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled).toHaveLength(1);
    expect(body.stalled[0].gate).toBe('dep_failed');
    expect(body.stalled[0].detail).toContain('Upstream migration');
  });

  it('names dep_missing for a dangling dependency id', async () => {
    candidateTasks = [task({ dependsOn: ['ghost-1'] })];
    depTasks = [];

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled[0].gate).toBe('dep_missing');
  });

  it('names unmerged_dep_pr when a completed dependency still has an open PR', async () => {
    candidateTasks = [task({ dependsOn: ['dep-1'] })];
    depTasks = [{ id: 'dep-1', title: 'Upstream migration', status: 'completed' }];
    depPrWorkers = [
      { taskId: 'dep-1', prUrl: 'https://x/pull/12', prNumber: 12, prLifecycleStatus: 'pr_open' },
    ];

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled[0].gate).toBe('unmerged_dep_pr');
    expect(body.stalled[0].detail).toContain('Upstream migration');
  });

  it('treats a closed dependency PR as unblocking (dep-gate contract)', async () => {
    candidateTasks = [task({ dependsOn: ['dep-1'] })];
    depTasks = [{ id: 'dep-1', title: 'Upstream migration', status: 'completed' }];
    depPrWorkers = [
      { taskId: 'dep-1', prUrl: 'https://x/pull/12', prNumber: 12, prLifecycleStatus: 'closed' },
    ];

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled[0].gate).not.toBe('unmerged_dep_pr');
  });

  it('names connector_routing_mismatch and the connector', async () => {
    candidateTasks = [task({ roleSlug: 'researcher' })];
    mockCheckConnectorRouting.mockResolvedValue([
      { connectorId: 'c-1', connectorName: 'Linear', mode: 'expired_or_revoked' },
    ]);

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled[0].gate).toBe('connector_routing_mismatch');
    expect(body.stalled[0].detail).toContain('Linear');
  });

  it('names mission_held', async () => {
    candidateTasks = [task({ missionId: 'mission-1' })];
    mockCheckMissionHeld.mockResolvedValue(true);

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled[0].gate).toBe('mission_held');
  });

  it('names workspace_cap_reached for a repo-backed workspace at its cap', async () => {
    candidateTasks = [
      task({
        workspace: { id: 'ws-1', name: 'buildd', teamId: 'team-1', repo: 'org/repo', maxConcurrentTasks: 3 },
      }),
    ];
    mockCheckWorkspaceCap.mockResolvedValue({ active: 3, cap: 3 });

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled[0].gate).toBe('workspace_cap_reached');
    expect(body.stalled[0].detail).toContain('3/3');
  });

  it('names mission_budget_exhausted — the widest-blast-radius gate', async () => {
    // budget_exhausted is a one-way door: nothing clears it but a human raising
    // costBudgetUsd, and it strands EVERY task in the mission at once. The
    // watchdog was blind to it entirely.
    candidateTasks = [task({ missionId: 'mission-1' })];
    mockCheckMissionBudgetExhausted.mockResolvedValue(true);

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled[0].gate).toBe('mission_budget_exhausted');
    expect(body.stalled[0].detail).toContain('mission-1');
  });

  it('ranks mission_held above mission_budget_exhausted (matches /start order)', async () => {
    candidateTasks = [task({ missionId: 'mission-1' })];
    mockCheckMissionHeld.mockResolvedValue(true);
    mockCheckMissionBudgetExhausted.mockResolvedValue(true);

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled[0].gate).toBe('mission_held');
  });

  it('ranks mission_budget_exhausted above subject_dead (matches /start order)', async () => {
    candidateTasks = [task({
      missionId: 'mission-1',
      subjectKind: 'pull_request',
      subjectPrNumber: 1789,
      subjectResolution: 'reconciled',
      subjectAnchor: { source: 'system' },
    })];
    mockCheckMissionBudgetExhausted.mockResolvedValue(true);

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled[0].gate).toBe('mission_budget_exhausted');
  });

  it('honors bypassMissionBudget without even probing the gate', async () => {
    candidateTasks = [task({ missionId: 'mission-1', context: { bypassMissionBudget: true } })];
    mockCheckMissionBudgetExhausted.mockResolvedValue(true);

    const body = await (await POST(makeRequest())).json();

    expect(mockCheckMissionBudgetExhausted).not.toHaveBeenCalled();
    expect(body.stalled[0].gate).toBe('no_gate_identified');
  });

  it('accepts the string form of a bypass flag (shared hasBypassFlag contract)', async () => {
    // context->>key renders JSON true and JSON "true" identically, so the TS
    // side must accept both or the watchdog disagrees with the SQL prefilter.
    candidateTasks = [task({ missionId: 'mission-1', context: { bypassMissionBudget: 'true' } })];
    mockCheckMissionBudgetExhausted.mockResolvedValue(true);

    const body = await (await POST(makeRequest())).json();

    expect(mockCheckMissionBudgetExhausted).not.toHaveBeenCalled();
    expect(body.stalled[0].gate).toBe('no_gate_identified');
  });

  it('names advisory_manifest when a scope-undeclared sibling holds the mission slot', async () => {
    candidateTasks = [task({ missionId: 'mission-1', pathManifest: ['**'] })];
    missionPeerTasks = [
      {
        id: 'peer-1',
        title: 'Refactor the planner',
        missionId: 'mission-1',
        pathManifest: ['**'],
        workers: [{ status: 'waiting_input' }],
      },
    ];

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled[0].gate).toBe('advisory_manifest');
    // Names the blocker, not its id (see #1867).
    expect(body.stalled[0].detail).toContain('Refactor the planner');
  });

  it('catches the null-manifest form of the same block', async () => {
    candidateTasks = [task({ missionId: 'mission-1', pathManifest: null })];
    missionPeerTasks = [
      { id: 'peer-1', title: 'Peer', missionId: 'mission-1', pathManifest: null, workers: [{ status: 'running' }] },
    ];

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled[0].gate).toBe('advisory_manifest');
  });

  it('does not report advisory_manifest when the peer declared concrete scope', async () => {
    candidateTasks = [task({ missionId: 'mission-1', pathManifest: ['**'] })];
    missionPeerTasks = [
      { id: 'peer-1', title: 'Peer', missionId: 'mission-1', pathManifest: ['a.ts'], workers: [{ status: 'running' }] },
    ];

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled[0].gate).toBe('no_gate_identified');
  });

  it('does not report advisory_manifest when the peer has no live worker', async () => {
    candidateTasks = [task({ missionId: 'mission-1', pathManifest: ['**'] })];
    missionPeerTasks = [
      { id: 'peer-1', title: 'Peer', missionId: 'mission-1', pathManifest: ['**'], workers: [{ status: 'completed' }] },
    ];

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled[0].gate).toBe('no_gate_identified');
  });

  it('does not report advisory_manifest against itself', async () => {
    candidateTasks = [task({ missionId: 'mission-1', pathManifest: ['**'] })];
    missionPeerTasks = [
      { id: 'task-1', title: 'Fix the thing', missionId: 'mission-1', pathManifest: ['**'], workers: [{ status: 'running' }] },
    ];

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled[0].gate).toBe('no_gate_identified');
  });

  it('ranks every permanent gate above advisory_manifest (it is the only self-clearing one)', async () => {
    candidateTasks = [task({
      missionId: 'mission-1',
      pathManifest: ['**'],
      subjectKind: 'pull_request',
      subjectPrNumber: 1789,
      subjectResolution: 'reconciled',
      subjectAnchor: { source: 'system' },
    })];
    missionPeerTasks = [
      { id: 'peer-1', title: 'Peer', missionId: 'mission-1', pathManifest: ['**'], workers: [{ status: 'running' }] },
    ];

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled[0].gate).toBe('subject_dead');
  });

  it('skips the peer probe entirely when no examined task has an undeclared scope', async () => {
    // The probe is an extra round trip; a concrete-manifest queue must not pay
    // for it. (Fixture manifests are concrete by default.)
    candidateTasks = [task({ missionId: 'mission-1' })];

    await POST(makeRequest());

    const probeCalls = mockTasksFindMany.mock.calls.filter(
      (c: any) => c[0]?.where?.type === 'inArray' && c[0]?.where?.f === 'missionId',
    );
    expect(probeCalls).toHaveLength(0);
  });

  it('reports no_gate_identified rather than a generic "stuck" message', async () => {
    candidateTasks = [task({ roleSlug: 'builder' })];

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled[0].gate).toBe('no_gate_identified');
    expect(body.stalled[0].detail).toContain('builder');
  });

  it('honors force-start bypass flags instead of re-reporting a bypassed gate', async () => {
    candidateTasks = [
      task({
        missionId: 'mission-1',
        context: { bypassHeldGate: true },
      }),
    ];
    mockCheckMissionHeld.mockResolvedValue(true);

    const body = await (await POST(makeRequest())).json();

    expect(mockCheckMissionHeld).not.toHaveBeenCalled();
    expect(body.stalled[0].gate).toBe('no_gate_identified');
  });
});

describe('queue-stall cron — what is NOT a stall', () => {
  it('stays quiet for a task deferred to a future startAt', async () => {
    candidateTasks = [task({ startAt: hoursFromNow(6) })];

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled).toHaveLength(0);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('stays quiet for a deferred task even with a stray bypassStartGate key', async () => {
    // bypassStartGate was deleted as a dead key: nothing ever wrote it, and
    // /start expresses the deferred-start override by clearing startAt outright.
    // Honoring it here made the watchdog report gates for a task that is simply
    // scheduled — a third, drifted copy of the gate ladder.
    candidateTasks = [task({ startAt: hoursFromNow(6), context: { bypassStartGate: true } })];

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled).toHaveLength(0);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('stays quiet for a task waiting on an in-flight dependency', async () => {
    // The upstream task is the one that would be reported if IT stalls.
    candidateTasks = [task({ dependsOn: ['dep-1'] })];
    depTasks = [{ id: 'dep-1', title: 'Upstream', status: 'assigned' }];

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled).toHaveLength(0);
  });
});

describe('queue-stall cron — notification and dedupe', () => {
  it('sends one Pushover alert that names the gate, and stamps the task', async () => {
    candidateTasks = [task({ dependsOn: ['dep-1'] })];
    depTasks = [{ id: 'dep-1', title: 'Upstream migration', status: 'failed' }];

    const body = await (await POST(makeRequest())).json();

    expect(body.notified).toBe(1);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    const payload = mockNotify.mock.calls[0][0] as any;
    expect(payload.app).toBe('alerts');
    expect(payload.message).toContain('dep_failed');
    expect(payload.message).toContain('Fix the thing');

    expect(taskUpdates).toHaveLength(1);
    expect(taskUpdates[0].values.context.queueStallGate).toBe('dep_failed');
    expect(typeof taskUpdates[0].values.context.queueStallNotifiedAt).toBe('string');
  });

  it('does not re-alert a task already stamped inside the renotify window', async () => {
    candidateTasks = [
      task({
        dependsOn: ['dep-1'],
        context: { queueStallNotifiedAt: hoursAgo(1).toISOString(), queueStallGate: 'dep_failed' },
      }),
    ];
    depTasks = [{ id: 'dep-1', title: 'Upstream migration', status: 'failed' }];

    const body = await (await POST(makeRequest())).json();

    expect(body.notified).toBe(0);
    expect(body.deduped).toBe(1);
    expect(mockNotify).not.toHaveBeenCalled();
    expect(taskUpdates).toHaveLength(0);
  });

  it('re-alerts once the renotify window has elapsed', async () => {
    candidateTasks = [
      task({
        dependsOn: ['dep-1'],
        context: { queueStallNotifiedAt: hoursAgo(48).toISOString(), queueStallGate: 'dep_failed' },
      }),
    ];
    depTasks = [{ id: 'dep-1', title: 'Upstream migration', status: 'failed' }];

    const body = await (await POST(makeRequest())).json();

    expect(body.notified).toBe(1);
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it('preserves existing context keys when stamping', async () => {
    candidateTasks = [task({ dependsOn: ['dep-1'], context: { manualStartAt: 'earlier' } })];
    depTasks = [{ id: 'dep-1', title: 'Upstream migration', status: 'failed' }];

    await POST(makeRequest());

    expect(taskUpdates[0].values.context.manualStartAt).toBe('earlier');
  });

  it('sends a single digest alert for many stalled tasks', async () => {
    candidateTasks = Array.from({ length: 7 }, (_, i) =>
      task({ id: `task-${i}`, title: `Task ${i}`, dependsOn: ['dep-1'] }),
    );
    depTasks = [{ id: 'dep-1', title: 'Upstream migration', status: 'failed' }];

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled).toHaveLength(7);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(taskUpdates).toHaveLength(7);
  });

  it('sends nothing when the queue is healthy', async () => {
    candidateTasks = [];

    const body = await (await POST(makeRequest())).json();

    expect(body.ok).toBe(true);
    expect(body.stalled).toHaveLength(0);
    expect(mockNotify).not.toHaveBeenCalled();
  });
});

describe('queue-stall cron — missing backend credential', () => {
  it('names the missing credential instead of falling through to no_gate_identified', async () => {
    // The population this gate exists for: a Codex task in a team with no Codex
    // credential. The claim route drops it from the candidate set entirely, so
    // no runner will ever ask for it — the most permanent block available, and
    // previously reported as "no runner is polling this workspace".
    candidateTasks = [task({ backend: 'codex' })];
    strandVerdict = { backend: 'codex', label: 'Codex' };

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled).toHaveLength(1);
    expect(body.stalled[0].gate).toBe('backend_credential_missing');
    expect(body.stalled[0].detail).toContain('Codex');
    expect(mockStrandCheck).toHaveBeenCalledWith({
      backend: 'codex',
      workspaceId: 'ws-1',
      teamId: 'team-1',
    });
  });

  it('passes the stored backend through so the probe applies the team mask itself', async () => {
    // A task nominally on a disabled backend is masked onto an enabled one at
    // dispatch, so the watchdog must not decide from tasks.backend alone.
    candidateTasks = [task({ backend: 'codex' })];
    strandVerdict = null; // probe: masked onto Claude, nothing stranded

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled[0].gate).toBe('no_gate_identified');
  });

  it('stays silent for the common case (Claude runs on the caller\'s own auth)', async () => {
    candidateTasks = [task()];

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled[0].gate).toBe('no_gate_identified');
  });

  it('keeps /start\'s gate order: a gate /start can name still wins', async () => {
    // Every reason shared with /api/tasks/[id]/start is reported in /start's
    // order, so an operator who clicks Start sees the same answer.
    candidateTasks = [task({ workspace: { ...task().workspace, repo: 'buildd-ai/buildd' } })];
    mockCheckWorkspaceCap.mockResolvedValue({ active: 3, cap: 3 });
    strandVerdict = { backend: 'codex', label: 'Codex' };

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled[0].gate).toBe('workspace_cap_reached');
  });

  it('outranks advisory_manifest — permanent beats self-clearing', async () => {
    candidateTasks = [task({ backend: 'codex', missionId: 'mission-1', pathManifest: ['**'] })];
    missionPeerTasks = [
      { id: 'peer-1', title: 'Peer', missionId: 'mission-1', pathManifest: ['**'], workers: [{ status: 'running' }] },
    ];
    strandVerdict = { backend: 'codex', label: 'Codex' };

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled[0].gate).toBe('backend_credential_missing');
  });

  it('dedupes through the shared context key rather than re-alerting hourly', async () => {
    candidateTasks = [task({ backend: 'codex' })];
    strandVerdict = { backend: 'codex', label: 'Codex' };

    const first = await (await POST(makeRequest())).json();
    expect(first.notified).toBe(1);
    expect(taskUpdates[0].values.context.queueStallGate).toBe('backend_credential_missing');

    // Second run, with the stamp the first run wrote.
    candidateTasks = [task({
      backend: 'codex',
      context: { queueStallNotifiedAt: new Date().toISOString(), queueStallGate: 'backend_credential_missing' },
    })];
    mockStrandCheck.mockClear();

    const second = await (await POST(makeRequest())).json();
    expect(second.deduped).toBe(1);
    expect(second.notified).toBe(0);
    // Dedupe skips gate evaluation entirely — no credential lookups either.
    expect(mockStrandCheck).not.toHaveBeenCalled();
  });
});
