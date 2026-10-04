import { describe, it, expect, mock, beforeEach } from 'bun:test';

const PROJECT = {
  id: 'wp-1',
  workspaceId: 'ws-1',
  repo: 'acme/widgets',
  roleSlug: 'ops',
  pushoverApp: 'alerts',
  inFlightWindowMin: 0,
  releasePrFilter: {},
  vercelProjectId: null,
};

const mockNotifyTeamOf = mock((_subject: any, _event: any, _payload: any) => {});
const mockNotifyOperator = mock((_opts: any) => {});

mock.module('@/lib/notify', () => ({
  notifyTeamOf: async (subject: any, event: any, payload: any) => {
    mockNotifyTeamOf(subject, event, payload);
  },
}));
mock.module('@/lib/pushover', () => ({ notifyOperator: mockNotifyOperator }));

mock.module('@/lib/github', () => ({
  githubApi: mock(async (_id: number, path: string) => {
    if (path.includes('/pulls?')) {
      return [{
        number: 7,
        title: 'Release v1',
        html_url: 'https://github.com/acme/widgets/pull/7',
        head: { sha: 'abc123' },
        base: { ref: 'main' },
        labels: [],
        updated_at: '2020-01-01T00:00:00Z',
      }];
    }
    return { check_runs: [{ name: 'build', status: 'completed', conclusion: 'failure', html_url: null }] };
  }),
}));
// The dispatch authority's full surface: mock.module is process-global.
const mockWakeTask = mock(async (_taskId: string, _cause: string, _opts?: unknown) => {});
mock.module('@/lib/dispatch-authority', () => ({
  announceTaskCreated: mock(async () => {}),
  wakeTask: mockWakeTask,
  wakeTasks: mock(async () => {}),
  kickDispatch: () => {},
  enqueueTaskDispatch: async () => {},
  drainDispatchOutbox: async () => ({ claimed: 0, delivered: 0, skipped: 0, failed: 0 }),
  deliverTaskDispatch: async () => 'pusher',
  routeForCause: () => ({ event: 'task.created', legacyDefault: true, githubActions: true, legacyUnfilteredRunnerPreference: false }),
  webhookWants: () => false,
  primaryCause: (_causes: string[], fallback: string) => fallback,
  DISPATCH_DUE_QUEUE: 'dispatch',
  DRAIN_BATCH: 25,
  reseedDispatchTimer: async () => {},
}));
mock.module('@/lib/subject-anchor-observer', () => ({
  prepareSubjectFiling: async () => ({ taskValues: {}, anchor: null, match: null }),
  recordSubjectMatchObserved: async () => {},
}));
mock.module('@/lib/release/dispatch', () => ({ isPostMergeIntegrationCheck: () => false }));
mock.module('@/lib/health-watcher-vercel', () => ({
  listProdDeployments: async () => [],
  evaluateDeploymentHealth: () => ({ status: 'healthy' }),
}));
mock.module('@buildd/core/secrets', () => ({ getSecretsProvider: () => ({ get: async () => null }) }));

const chain = (rows: any[]): any => {
  const c: any = {
    from: () => c,
    where: () => c,
    limit: async () => rows,
    then: (res: any) => Promise.resolve(rows).then(res),
  };
  return c;
};

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      watchedProjects: { findFirst: async () => PROJECT },
      workspaces: { findFirst: async () => ({ id: 'ws-1', teamId: 'team-1', gitConfig: null }) },
    },
    select: (fields?: any) =>
      chain(fields && 'installationId' in fields ? [{ installationId: 1 }] : []),
    insert: () => ({
      values: () => ({
        returning: async () => [{ id: 'task-new' }],
        onConflictDoNothing: async () => {},
        then: (res: any) => Promise.resolve().then(res),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
    delete: () => ({ where: async () => {} }),
  },
}));
mock.module('@buildd/core/db/schema', () => ({
  watchedProjects: { id: 'id', enabled: 'enabled', lastCheckedAt: 'lastCheckedAt' },
  watcherEvents: {},
  workspaces: { id: 'id' },
  workspaceSkills: {},
  tasks: { id: 'id', workspaceId: 'workspaceId', status: 'status', context: 'context' },
  githubInstallations: { installationId: 'installationId', accountLogin: 'accountLogin' },
}));

const { runWatcherForProject } = await import('./health-watcher');

describe('health watcher alerts route to the owning workspace team', () => {
  beforeEach(() => {
    mockNotifyTeamOf.mockClear();
    mockNotifyOperator.mockClear();
  });

  it('a failing release PR pages the project workspace team, not the operator', async () => {
    const { fired } = await runWatcherForProject('wp-1');

    expect(fired).toBe(1);
    expect(mockNotifyOperator).not.toHaveBeenCalled();
    expect(mockNotifyTeamOf).toHaveBeenCalledTimes(1);
    const [subject, event, payload] = mockNotifyTeamOf.mock.calls[0] as any[];
    expect(subject).toEqual({ workspaceId: 'ws-1' });
    expect(event).toBe('needsAttention');
    expect(payload.title).toContain('acme/widgets');
  });
});
