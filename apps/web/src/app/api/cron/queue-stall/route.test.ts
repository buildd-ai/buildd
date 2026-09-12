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

// ── Fleet-idle pass (?scope=fleet-idle) fixtures ────────────────────────────
//
// The second pass reads different tables entirely, so it gets its own
// fixtures. Its pending-task query is the only `and(...)` on tasks that carries
// an `or(...)` child (the deferred-start clause), which is how the dispatcher
// below tells it apart from the gate pass's candidate scan.
let fleetHeartbeats: any[] = [];
let fleetPendingTasks: any[] = [];
let fleetWorkspaces: any[] = [];
let fleetAccountLinks: any[] = [];
let fleetLastStarts: Record<string, any[]> = {};

const mockTasksFindMany = mock((args: any) => {
  const where = args?.where;
  if (where?.type !== 'inArray') {
    return (where?.c ?? []).some((c: any) => c?.type === 'or') ? fleetPendingTasks : candidateTasks;
  }
  // inArray(tasks.missionId, ...) → the advisory-manifest peer probe.
  // inArray(tasks.id, ...)        → the dependency lookup.
  return where.f === 'missionId' ? missionPeerTasks : depTasks;
});
const mockWorkersFindMany = mock((args: any) => {
  const where = args?.where;
  if (where?.type === 'inArray') return candidateWorkers;
  // and(eq(workers.accountId, id), isNotNull(startedAt)) → the fleet pass's
  // per-account last-start probe. Keyed by account so per-account isolation is
  // actually observable.
  const acct = (where?.c ?? []).find((c: any) => c?.type === 'eq' && c?.f === 'accountId');
  if (acct) return fleetLastStarts[acct.v] ?? [];
  return depPrWorkers;
});
const mockHeartbeatsFindMany = mock(() => fleetHeartbeats);
const mockWorkspacesFindMany = mock(() => fleetWorkspaces);
const mockAccountLinksFindMany = mock(() => fleetAccountLinks);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findMany: mockTasksFindMany },
      workers: { findMany: mockWorkersFindMany },
      workerHeartbeats: { findMany: mockHeartbeatsFindMany },
      workspaces: { findMany: mockWorkspacesFindMany },
      accountWorkspaces: { findMany: mockAccountLinksFindMany },
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
  // Operators withCronRun imports. mock.module is process-global, so a
  // partial stub removes them for every other importer too.
  desc: (a: any) => ({ a, op: 'desc' }),
  gt: (a: any, b: any) => ({ a, b, op: 'gt' }),
  // `sql` is not used by this route, but lib/bypass-flags.ts imports it at
  // module scope for bypassFlagCondition(); a partial stub without it fails the
  // import outright.
  sql: (strings: any, ...values: any[]) => ({ strings, values, type: 'sql' }),
  eq: (f: any, v: any) => ({ f, v, type: 'eq' }),
  and: (...c: any[]) => ({ c, type: 'and' }),
  or: (...c: any[]) => ({ c, type: 'or' }),
  lt: (f: any, v: any) => ({ f, v, type: 'lt' }),
  lte: (f: any, v: any) => ({ f, v, type: 'lte' }),
  inArray: (f: any, v: any) => ({ f, v, type: 'inArray' }),
  isNull: (f: any) => ({ f, type: 'isNull' }),
  isNotNull: (f: any) => ({ f, type: 'isNotNull' }),
  asc: (f: any) => ({ f, type: 'asc' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  // withCronRun imports this; mock.module replaces the whole module, so a
  // partial stub deletes the export for every other importer in the process.
  cronRuns: { id: 'id', job: 'job', startedAt: 'startedAt', alertedAt: 'alertedAt' },
  tasks: { id: 'id', status: 'status', createdAt: 'createdAt', missionId: 'missionId', startAt: 'startAt' },
  workers: {
    taskId: 'taskId',
    prUrl: 'prUrl',
    mergedAt: 'mergedAt',
    accountId: 'accountId',
    startedAt: 'startedAt',
  },
  workerHeartbeats: { accountId: 'accountId', lastHeartbeatAt: 'lastHeartbeatAt' },
  workspaces: { id: 'id' },
  accountWorkspaces: { accountId: 'accountId', workspaceId: 'workspaceId' },
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

// OAuth budget pacing (lib/pacing-stall.ts) reads the team's OAuth accounts and
// their learned window capacity; stub it to the verdict each case is about, the
// same way the backend probe above is stubbed.
let pacingVerdict: { pct: number } | null = null;
const mockPacingCheck = mock((_task: any) => Promise.resolve(pacingVerdict));
mock.module('@/lib/pacing-stall', () => ({
  createPacingProbe: () => ({ check: mockPacingCheck }),
}));

const mockNotify = mock((_opts: any) => undefined);
mock.module('@/lib/pushover', () => ({ notify: mockNotify }));

// The fleet-idle pass alerts through reportOps (transport-level dedupe), not
// through notify: a fleet-level alarm has no task row to stamp a context key on.
const mockReportOps = mock((_input: any) => Promise.resolve(true));
mock.module('@buildd/core/report-ops', () => ({ reportOps: mockReportOps }));

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
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
const minutesFromNow = (n: number) => new Date(Date.now() + n * 60_000);

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
    priority: 0,
    kind: null,
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
  pacingVerdict = null;
  mockStrandCheck.mockClear();
  mockPacingCheck.mockClear();
  mockNotify.mockClear();
  fleetHeartbeats = [];
  fleetPendingTasks = [];
  fleetWorkspaces = [];
  fleetAccountLinks = [];
  fleetLastStarts = {};
  mockReportOps.mockClear();
  mockHeartbeatsFindMany.mockClear();
  mockWorkspacesFindMany.mockClear();
  mockAccountLinksFindMany.mockClear();
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

describe('OAuth budget pacing', () => {
  // Regression: a task the claim route defers as `routing_paused` used to be
  // reported as `no_gate_identified` ("no runner is offering role X"), which
  // sends the operator to look at runners when the answer is spend.
  it('names routing_paused for a task held by budget pacing', async () => {
    candidateTasks = [task({ roleSlug: 'builder', priority: 0 })];
    pacingVerdict = { pct: 0.97 };

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled[0].gate).toBe('routing_paused');
  });

  it('explains how to get the task moving instead of blaming the runner', async () => {
    candidateTasks = [task({ roleSlug: 'builder', priority: 0 })];
    pacingVerdict = { pct: 0.97 };

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled[0].detail).toContain('pacing');
    expect(body.stalled[0].detail).not.toContain('no runner');
  });

  it('reports the measured pressure, not a hardcoded threshold', async () => {
    candidateTasks = [task({ roleSlug: 'builder', priority: 0 })];
    pacingVerdict = { pct: 0.97 };

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled[0].detail).toContain('97%');
  });

  it('falls through to no_gate_identified when pacing is not holding it', async () => {
    candidateTasks = [task({ roleSlug: 'builder', priority: 0 })];
    pacingVerdict = null;

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled[0].gate).toBe('no_gate_identified');
  });

  it('passes the task team, priority and kind to the probe', async () => {
    candidateTasks = [task({ roleSlug: 'builder', priority: 0, kind: 'coordination' })];
    pacingVerdict = null;

    await (await POST(makeRequest())).json();

    const arg = mockPacingCheck.mock.calls.at(-1)?.[0] as any;
    // teamId is the input whose loss silently disables the whole gate
    // (`if (!task.teamId) return null`), and it depends on teamId staying in the
    // candidate query's workspace columns — the same failure class this file
    // warns about for `backend` and `pathManifest`.
    expect(arg.teamId).toBe('team-1');
    expect(arg.priority).toBe(0);
    expect(arg.kind).toBe('coordination');
  });

  it('does not blame pacing for a task carrying an explicit model', async () => {
    // The router returns `explicit_override` before the pause gate, so such a
    // task can never be paced. The claim route writes `context.model` onto every
    // task it claims and the requeue paths do not clear it, so this is the
    // common re-queued-task shape — not an exotic one.
    candidateTasks = [task({ roleSlug: 'builder', priority: 0, context: { model: 'claude-opus-4-6' } })];
    pacingVerdict = { pct: 0.97 };

    await (await POST(makeRequest())).json();

    const arg = mockPacingCheck.mock.calls.at(-1)?.[0] as any;
    expect(arg.explicitModel).toBe('claude-opus-4-6');
  });

  it('does not assert pacing as the sole cause of an hours-old stall', async () => {
    candidateTasks = [task({ roleSlug: 'builder', priority: 0 })];
    pacingVerdict = { pct: 0.97 };

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled[0].detail).toContain('verify');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Fleet-idle pass — ?scope=fleet-idle
//
// The condition: a runner is heartbeating with spare capacity, claimable work
// is queued, and NOTHING has started. That is what a tripped claim circuit
// breaker looks like from the server: the heartbeat of a fully-paused runner is
// byte-identical to a healthy idle one, and the refusal reason never leaves the
// host. It is deliberately NOT "runner offline" (the heartbeat-stale rule owns
// that) and NOT "no work queued" (normal idle).
// ════════════════════════════════════════════════════════════════════════════

function fleetRequest(token: string | null = CRON_SECRET): NextRequest {
  return new NextRequest('http://localhost/api/cron/queue-stall?scope=fleet-idle', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function heartbeat(over: Record<string, unknown> = {}) {
  return {
    accountId: 'acct-1',
    lastHeartbeatAt: minutesAgo(1),
    activeWorkerCount: 0,
    maxConcurrentWorkers: 3,
    ...over,
  };
}

function pendingTask(over: Record<string, unknown> = {}) {
  return {
    id: 'pending-1',
    workspaceId: 'ws-1',
    startAt: null,
    createdAt: hoursAgo(2),
    dependsOn: [],
    context: {},
    ...over,
  };
}

function workspaceRow(over: Record<string, unknown> = {}) {
  return { id: 'ws-1', name: 'Platform', accessMode: 'open', ...over };
}

describe('fleet-idle pass — alive but claiming nothing', () => {
  it('alarms when a heartbeating fleet has claimable work and has started nothing', async () => {
    fleetHeartbeats = [heartbeat()];
    fleetPendingTasks = [pendingTask()];
    fleetWorkspaces = [workspaceRow()];
    fleetLastStarts = { 'acct-1': [{ startedAt: hoursAgo(3) }] };

    const body = await (await POST(fleetRequest())).json();

    expect(body.scope).toBe('fleet-idle');
    expect(body.alarms).toBe(1);
    expect(body.findings[0].accountId).toBe('acct-1');
    expect(mockReportOps).toHaveBeenCalledTimes(1);

    const arg = mockReportOps.mock.calls[0][0] as any;
    expect(arg.source).toBe('fleet-idle');
    // Names the cause, the volume and the duration — not a guess about roles.
    expect(arg.message).toContain('1 claimable');
    expect(arg.message).toContain('180m');
    expect(`${arg.message} ${arg.detail}`).not.toContain('no runner is offering');
  });

  it('reports "never started" rather than an idle duration when there is no start at all', async () => {
    // workers.startedAt is the load-bearing column: no row at all is a
    // different sentence from "the last one was a while ago".
    fleetHeartbeats = [heartbeat()];
    fleetPendingTasks = [pendingTask()];
    fleetWorkspaces = [workspaceRow()];
    fleetLastStarts = {};

    const body = await (await POST(fleetRequest())).json();

    expect(body.alarms).toBe(1);
    expect(body.findings[0].idleMinutes).toBeNull();
    const arg = mockReportOps.mock.calls[0][0] as any;
    expect(arg.message).toContain('no worker has ever started');
    expect(arg.message).not.toMatch(/\d+m\b/);
  });

  it('stays quiet on a normal idle fleet with nothing queued', async () => {
    // The test that stops this detector paging every night on an empty queue.
    fleetHeartbeats = [heartbeat()];
    fleetPendingTasks = [];
    fleetWorkspaces = [];
    fleetLastStarts = { 'acct-1': [{ startedAt: hoursAgo(9) }] };

    const body = await (await POST(fleetRequest())).json();

    expect(body.alarms).toBe(0);
    expect(mockReportOps).not.toHaveBeenCalled();
  });

  it('stays quiet when a worker started minutes ago (the fleet is transacting)', async () => {
    fleetHeartbeats = [heartbeat()];
    fleetPendingTasks = [pendingTask(), pendingTask({ id: 'pending-2' })];
    fleetWorkspaces = [workspaceRow()];
    fleetLastStarts = { 'acct-1': [{ startedAt: minutesAgo(4) }] };

    const body = await (await POST(fleetRequest())).json();

    expect(body.alarms).toBe(0);
    expect(mockReportOps).not.toHaveBeenCalled();
  });

  it('stays quiet for an offline runner — that is the heartbeat-stale rule, not this one', async () => {
    // Double-paging one outage as two alarms is how alerts get muted.
    fleetHeartbeats = [heartbeat({ lastHeartbeatAt: hoursAgo(3) })];
    fleetPendingTasks = [pendingTask()];
    fleetWorkspaces = [workspaceRow()];
    fleetLastStarts = {};

    const body = await (await POST(fleetRequest())).json();

    expect(body.alarms).toBe(0);
    expect(mockReportOps).not.toHaveBeenCalled();
  });

  it('stays quiet when every runner is at capacity (a full runner refuses work correctly)', async () => {
    fleetHeartbeats = [heartbeat({ activeWorkerCount: 3, maxConcurrentWorkers: 3 })];
    fleetPendingTasks = [pendingTask()];
    fleetWorkspaces = [workspaceRow()];
    fleetLastStarts = { 'acct-1': [{ startedAt: hoursAgo(3) }] };

    const body = await (await POST(fleetRequest())).json();

    expect(body.alarms).toBe(0);
    expect(mockReportOps).not.toHaveBeenCalled();
  });
});

describe('fleet-idle pass — what is not claimable work', () => {
  it('does not count a task deferred to a future startAt', async () => {
    fleetHeartbeats = [heartbeat()];
    fleetPendingTasks = [pendingTask({ startAt: minutesFromNow(90) })];
    fleetWorkspaces = [workspaceRow()];
    fleetLastStarts = { 'acct-1': [{ startedAt: hoursAgo(3) }] };

    const body = await (await POST(fleetRequest())).json();

    expect(body.claimablePending).toBe(0);
    expect(body.alarms).toBe(0);
    expect(mockReportOps).not.toHaveBeenCalled();
  });

  it('does not count a dependency-blocked task', async () => {
    fleetHeartbeats = [heartbeat()];
    fleetPendingTasks = [pendingTask({ dependsOn: ['dep-1'] })];
    depTasks = [{ id: 'dep-1', title: 'Upstream', status: 'in_progress' }];
    fleetWorkspaces = [workspaceRow()];
    fleetLastStarts = { 'acct-1': [{ startedAt: hoursAgo(3) }] };

    const body = await (await POST(fleetRequest())).json();

    expect(body.claimablePending).toBe(0);
    expect(body.alarms).toBe(0);
    expect(mockReportOps).not.toHaveBeenCalled();
  });

  it('does not count a task whose completed dependency still has an unmerged PR', async () => {
    // Same dep-gate contract the claim query enforces: a completed dep with an
    // open PR keeps blocking, so this is not work the fleet is refusing.
    fleetHeartbeats = [heartbeat()];
    fleetPendingTasks = [pendingTask({ dependsOn: ['dep-1'] })];
    depTasks = [{ id: 'dep-1', title: 'Upstream', status: 'completed' }];
    depPrWorkers = [
      { taskId: 'dep-1', prUrl: 'https://x/pull/12', prNumber: 12, prLifecycleStatus: 'pr_open' },
    ];
    fleetWorkspaces = [workspaceRow()];
    fleetLastStarts = { 'acct-1': [{ startedAt: hoursAgo(3) }] };

    const body = await (await POST(fleetRequest())).json();

    expect(body.claimablePending).toBe(0);
    expect(mockReportOps).not.toHaveBeenCalled();
  });

  it('counts a dependency-blocked task once a human force-started past the gate', async () => {
    fleetHeartbeats = [heartbeat()];
    fleetPendingTasks = [pendingTask({ dependsOn: ['dep-1'], context: { bypassDepsGate: true } })];
    depTasks = [{ id: 'dep-1', title: 'Upstream', status: 'in_progress' }];
    fleetWorkspaces = [workspaceRow()];
    fleetLastStarts = { 'acct-1': [{ startedAt: hoursAgo(3) }] };

    const body = await (await POST(fleetRequest())).json();

    expect(body.claimablePending).toBe(1);
    expect(body.alarms).toBe(1);
  });

  it('does not count work in a restricted workspace the account cannot claim from', async () => {
    fleetHeartbeats = [heartbeat()];
    fleetPendingTasks = [pendingTask({ workspaceId: 'ws-locked' })];
    fleetWorkspaces = [workspaceRow({ id: 'ws-locked', accessMode: 'restricted' })];
    fleetAccountLinks = [];
    fleetLastStarts = { 'acct-1': [{ startedAt: hoursAgo(3) }] };

    const body = await (await POST(fleetRequest())).json();

    expect(body.alarms).toBe(0);
    expect(mockReportOps).not.toHaveBeenCalled();
  });

  it('counts restricted-workspace work the account does hold a claim grant for', async () => {
    fleetHeartbeats = [heartbeat()];
    fleetPendingTasks = [pendingTask({ workspaceId: 'ws-locked' })];
    fleetWorkspaces = [workspaceRow({ id: 'ws-locked', accessMode: 'restricted' })];
    fleetAccountLinks = [{ accountId: 'acct-1', workspaceId: 'ws-locked', canClaim: true }];
    fleetLastStarts = { 'acct-1': [{ startedAt: hoursAgo(3) }] };

    const body = await (await POST(fleetRequest())).json();

    expect(body.alarms).toBe(1);
  });

  it('does not count a task that only just became claimable', async () => {
    // Pusher delivers assignments in seconds; a task queued a minute ago has
    // not waited long enough for its absence of a start to mean anything.
    fleetHeartbeats = [heartbeat()];
    fleetPendingTasks = [pendingTask({ createdAt: minutesAgo(2) })];
    fleetWorkspaces = [workspaceRow()];
    fleetLastStarts = { 'acct-1': [{ startedAt: hoursAgo(3) }] };

    const body = await (await POST(fleetRequest())).json();

    expect(body.claimablePending).toBe(0);
    expect(body.alarms).toBe(0);
  });
});

describe('fleet-idle pass — per-account isolation and dedupe', () => {
  it('alarms only for the frozen account when another account is transacting', async () => {
    // One tenant freezing must not hide behind another's healthy fleet.
    fleetHeartbeats = [
      heartbeat({ accountId: 'acct-frozen' }),
      heartbeat({ accountId: 'acct-busy' }),
    ];
    fleetPendingTasks = [pendingTask()];
    fleetWorkspaces = [workspaceRow()];
    fleetLastStarts = {
      'acct-frozen': [{ startedAt: hoursAgo(6) }],
      'acct-busy': [{ startedAt: minutesAgo(3) }],
    };

    const body = await (await POST(fleetRequest())).json();

    expect(body.alarms).toBe(1);
    expect(body.findings.map((f: any) => f.accountId)).toEqual(['acct-frozen']);
    expect(mockReportOps).toHaveBeenCalledTimes(1);
    const arg = mockReportOps.mock.calls[0][0] as any;
    expect(arg.dedupeKey).toContain('acct-frozen');
    expect(arg.detail).toContain('acct-frozen');
  });

  it('uses a stable per-account dedupe key across runs', async () => {
    // Suppression itself is reportOps' tested behaviour (atomic system_cache
    // slot); what this route owes is a key that does not move between runs.
    fleetHeartbeats = [heartbeat()];
    fleetPendingTasks = [pendingTask()];
    fleetWorkspaces = [workspaceRow()];
    fleetLastStarts = { 'acct-1': [{ startedAt: hoursAgo(3) }] };

    await POST(fleetRequest());
    await POST(fleetRequest());

    expect(mockReportOps).toHaveBeenCalledTimes(2);
    const keys = mockReportOps.mock.calls.map((c: any) => c[0].dedupeKey);
    expect(keys[0]).toBe('fleet-idle:acct-1');
    expect(keys[1]).toBe(keys[0]);
  });
});

describe('fleet-idle pass — scope isolation', () => {
  it('never runs the gate ladder, so it costs no connector probe', async () => {
    // This is what earns the pass 24-hour coverage: the daytime-only
    // restriction on the gate pass exists because that one HTTP-probes
    // connectors. Folding the two together would re-import that cost.
    fleetHeartbeats = [heartbeat()];
    fleetPendingTasks = [pendingTask()];
    fleetWorkspaces = [workspaceRow()];
    fleetLastStarts = { 'acct-1': [{ startedAt: hoursAgo(3) }] };
    candidateTasks = [task({ roleSlug: 'researcher' })];

    const body = await (await POST(fleetRequest())).json();

    expect(body.alarms).toBe(1);
    expect(mockCheckConnectorRouting).not.toHaveBeenCalled();
    expect(mockCheckMissionHeld).not.toHaveBeenCalled();
    expect(mockCheckWorkspaceCap).not.toHaveBeenCalled();
    expect(mockStrandCheck).not.toHaveBeenCalled();
    expect(mockPacingCheck).not.toHaveBeenCalled();
    expect(body.stalled).toBeUndefined();
  });

  it('leaves the gate pass unchanged — the default scope does not fleet-alarm', async () => {
    candidateTasks = [task({ dependsOn: ['dep-1'] })];
    depTasks = [{ id: 'dep-1', title: 'Upstream migration', status: 'failed' }];
    fleetHeartbeats = [heartbeat()];
    fleetPendingTasks = [pendingTask()];
    fleetWorkspaces = [workspaceRow()];
    fleetLastStarts = {};

    const body = await (await POST(makeRequest())).json();

    expect(body.stalled[0].gate).toBe('dep_failed');
    expect(mockReportOps).not.toHaveBeenCalled();
  });

  it('requires the cron secret on the fleet pass too', async () => {
    const res = await POST(fleetRequest(null));
    expect(res.status).toBe(401);
    expect(mockReportOps).not.toHaveBeenCalled();
  });
});
