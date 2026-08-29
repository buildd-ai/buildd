import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── DB mock ─────────────────────────────────────────────────────────────────
//
// Two query shapes, distinguished by the columns the caller selects:
//   select({ workspaceId, backend, count }) → the exact per-pair count rollup
//   select({ id, title, workspaceName })    → the sample rows for one backend
let countRows: any[] = [];
let sampleRowsByCall: any[][] = [];
let sampleCalls = 0;
let selectedShapes: string[] = [];

const chain = (rows: any[]) => {
  const self: any = {
    from: () => self,
    leftJoin: () => self,
    innerJoin: () => self,
    where: () => self,
    groupBy: () => Promise.resolve(rows),
    orderBy: () => self,
    limit: () => Promise.resolve(rows),
    then: (fn: any) => Promise.resolve(rows).then(fn),
  };
  return self;
};

const mockSelect = mock((shape: any) => {
  const keys = Object.keys(shape ?? {});
  selectedShapes.push(keys.join(','));
  if (keys.includes('count')) return chain(countRows);
  const rows = sampleRowsByCall[sampleCalls] ?? [];
  sampleCalls++;
  return chain(rows);
});

mock.module('@buildd/core/db', () => ({ db: { select: mockSelect } }));

mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'id', title: 'title', status: 'status', backend: 'backend', workspaceId: 'workspaceId', createdAt: 'createdAt' },
  workspaces: { id: 'ws.id', name: 'ws.name' },
}));

mock.module('drizzle-orm', () => ({
  sql: (strings: any, ...values: any[]) => ({ strings, values, type: 'sql' }),
  eq: (f: any, v: any) => ({ f, v, type: 'eq' }),
  and: (...c: any[]) => ({ c, type: 'and' }),
  inArray: (f: any, v: any) => ({ f, v, type: 'inArray' }),
  asc: (f: any) => ({ f, type: 'asc' }),
}));

// The credential/mask reads are exercised by backend-failover.test.ts; here they
// are the inputs whose combinations we care about.
const mockIsBackendConfigured = mock((backend: string, _scope: any) =>
  Promise.resolve(configuredBackends.has(backend)),
);
const mockTeamEnabledBackends = mock(() => Promise.resolve(enabledMask));

mock.module('@/lib/backend-failover', () => ({
  isBackendConfigured: mockIsBackendConfigured,
  teamEnabledBackends: mockTeamEnabledBackends,
}));

let configuredBackends = new Set<string>(['claude']);
let enabledMask: string[] | null = null;

const { getBackendStrandSummary, createBackendStrandProbe } = await import('./backend-strand');

const stat = (summary: any, backend: string) =>
  summary.backends.find((b: any) => b.backend === backend);

beforeEach(() => {
  countRows = [];
  sampleRowsByCall = [];
  sampleCalls = 0;
  selectedShapes = [];
  configuredBackends = new Set<string>(['claude']);
  enabledMask = null;
  mockSelect.mockClear();
  mockIsBackendConfigured.mockClear();
  // mockClear() keeps a previous mockImplementation, so restore the default
  // explicitly — otherwise one test's per-workspace stub silently rewrites the
  // credential answer for every test after it.
  mockIsBackendConfigured.mockImplementation((backend: string, _scope: any) =>
    Promise.resolve(configuredBackends.has(backend)),
  );
  mockTeamEnabledBackends.mockClear();
});

describe('getBackendStrandSummary — the common case is silent', () => {
  it('reports nothing when every pending task is on the implicitly-configured backend', async () => {
    countRows = [{ workspaceId: 'ws-1', backend: 'claude', count: 12 }];

    const summary = await getBackendStrandSummary({ teamId: 'team-1', workspaceIds: ['ws-1'] });

    expect(summary.totalStranded).toBe(0);
    expect(stat(summary, 'claude')).toMatchObject({ configured: true, strandedPending: 0 });
    expect(stat(summary, 'codex')).toMatchObject({ configured: false, strandedPending: 0 });
    // No credential is missing for any *routed* backend, so no sample query ran.
    expect(sampleCalls).toBe(0);
  });

  it('short-circuits a team with no workspaces without touching the task table', async () => {
    const summary = await getBackendStrandSummary({ teamId: 'team-1', workspaceIds: [] });
    expect(summary.totalStranded).toBe(0);
    expect(mockSelect).not.toHaveBeenCalled();
  });
});

describe('getBackendStrandSummary — counting stranded work', () => {
  it('counts pending tasks routed to a backend with no credential', async () => {
    countRows = [
      { workspaceId: 'ws-1', backend: 'claude', count: 5 },
      { workspaceId: 'ws-1', backend: 'codex', count: 3 },
      { workspaceId: 'ws-2', backend: 'codex', count: 4 },
    ];
    sampleRowsByCall = [[
      { id: 't-1', title: 'Codex thing', workspaceName: 'alpha' },
    ]];

    const summary = await getBackendStrandSummary({ teamId: 'team-1', workspaceIds: ['ws-1', 'ws-2'] });

    expect(stat(summary, 'codex')).toMatchObject({
      backend: 'codex',
      label: 'Codex',
      configured: false,
      enabledForTeam: true,
      strandedPending: 7,
    });
    expect(stat(summary, 'codex').sampleTasks).toEqual([
      { id: 't-1', title: 'Codex thing', workspaceName: 'alpha' },
    ]);
    expect(stat(summary, 'claude').strandedPending).toBe(0);
    expect(summary.totalStranded).toBe(7);
  });

  it('stops counting once the credential exists', async () => {
    configuredBackends = new Set(['claude', 'codex']);
    countRows = [{ workspaceId: 'ws-1', backend: 'codex', count: 9 }];

    const summary = await getBackendStrandSummary({ teamId: 'team-1', workspaceIds: ['ws-1'] });

    expect(summary.totalStranded).toBe(0);
    expect(stat(summary, 'codex')).toMatchObject({ configured: true, strandedPending: 0 });
  });

  it('resolves configured-ness per workspace — a workspace-scoped credential covers only its own', async () => {
    countRows = [
      { workspaceId: 'ws-1', backend: 'codex', count: 2 },
      { workspaceId: 'ws-2', backend: 'codex', count: 6 },
    ];
    mockIsBackendConfigured.mockImplementation((backend: string, scope: any) =>
      Promise.resolve(backend === 'claude' || scope.workspaceId === 'ws-1'),
    );
    sampleRowsByCall = [[]];

    const summary = await getBackendStrandSummary({ teamId: 'team-1', workspaceIds: ['ws-1', 'ws-2'] });

    expect(stat(summary, 'codex').strandedPending).toBe(6);
    // `configured` is the team-wide headline: partially configured is not "configured".
    expect(stat(summary, 'codex').configured).toBe(false);
  });
});

describe('getBackendStrandSummary — the team mask', () => {
  it('does not report a task nominally on a disabled backend: the mask reroutes it', async () => {
    // Codex disabled team-wide → its tasks dispatch on Claude, credential or not.
    enabledMask = ['claude'];
    countRows = [{ workspaceId: 'ws-1', backend: 'codex', count: 8 }];

    const summary = await getBackendStrandSummary({ teamId: 'team-1', workspaceIds: ['ws-1'] });

    expect(summary.totalStranded).toBe(0);
    expect(stat(summary, 'codex')).toMatchObject({ enabledForTeam: false, strandedPending: 0 });
  });

  it('reports Claude tasks stranded on an unconfigured Codex when Claude is disabled', async () => {
    // The worst configuration mistake available: mask everything onto a backend
    // that has no credential and the whole queue is unclaimable.
    enabledMask = ['codex'];
    countRows = [
      { workspaceId: 'ws-1', backend: 'claude', count: 10 },
      { workspaceId: 'ws-1', backend: 'codex', count: 1 },
    ];
    sampleRowsByCall = [[]];

    const summary = await getBackendStrandSummary({ teamId: 'team-1', workspaceIds: ['ws-1'] });

    expect(stat(summary, 'codex')).toMatchObject({
      enabledForTeam: true,
      receivesMaskedWork: true,
      strandedPending: 11,
    });
    expect(stat(summary, 'claude')).toMatchObject({ enabledForTeam: false, strandedPending: 0 });
    expect(summary.totalStranded).toBe(11);
  });
});

describe('createBackendStrandProbe', () => {
  it('names the backend for a task whose effective backend has no credential', async () => {
    const probe = createBackendStrandProbe();
    const verdict = await probe.check({ backend: 'codex', workspaceId: 'ws-1', teamId: 'team-1' });
    expect(verdict).toEqual({ backend: 'codex', label: 'Codex' });
  });

  it('returns null for the configured / implicitly-configured case', async () => {
    const probe = createBackendStrandProbe();
    expect(await probe.check({ backend: 'claude', workspaceId: 'ws-1', teamId: 'team-1' })).toBeNull();
    expect(await probe.check({ backend: null, workspaceId: 'ws-1', teamId: 'team-1' })).toBeNull();
  });

  it('follows the team mask rather than the stored backend', async () => {
    enabledMask = ['claude'];
    const probe = createBackendStrandProbe();
    // Stored codex, but the mask sends it to Claude — not stranded.
    expect(await probe.check({ backend: 'codex', workspaceId: 'ws-1', teamId: 'team-1' })).toBeNull();
  });

  it('asks the fleet-wide credential question, not the per-account one', async () => {
    const probe = createBackendStrandProbe();
    await probe.check({ backend: 'codex', workspaceId: 'ws-1', teamId: 'team-1' });
    expect(mockIsBackendConfigured).toHaveBeenLastCalledWith('codex', {
      teamId: 'team-1',
      workspaceId: 'ws-1',
      anyAccount: true,
    });
  });

  it('returns null when the task has no team (nothing to check a credential against)', async () => {
    const probe = createBackendStrandProbe();
    expect(await probe.check({ backend: 'codex', workspaceId: 'ws-1', teamId: null })).toBeNull();
  });

  it('memoizes the mask and credential lookups across tasks', async () => {
    const probe = createBackendStrandProbe();
    for (let i = 0; i < 5; i++) {
      await probe.check({ backend: 'codex', workspaceId: 'ws-1', teamId: 'team-1' });
    }
    expect(mockTeamEnabledBackends).toHaveBeenCalledTimes(1);
    expect(mockIsBackendConfigured).toHaveBeenCalledTimes(1);
  });

  it('is fail-open: a credential lookup that throws does not report a stall', async () => {
    mockIsBackendConfigured.mockImplementation(() => Promise.reject(new Error('db down')));
    const probe = createBackendStrandProbe();
    expect(await probe.check({ backend: 'codex', workspaceId: 'ws-1', teamId: 'team-1' })).toBeNull();
  });
});
