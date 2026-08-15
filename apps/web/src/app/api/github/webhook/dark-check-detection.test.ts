process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── Mock functions ─────────────────────────────────────────────────────────
const mockGithubApi = mock(() => Promise.resolve(null) as any);
const mockNotify = mock(() => {});
const mockTriggerEvent = mock(() => Promise.resolve());

const mockDarkCheckAlertsFindFirst = mock(() => null as any);

let updateCalls: Array<{ table: any; setValues: any }> = [];
let insertCalls: Array<{ table: any; values: any }> = [];

// ── Module mocks ───────────────────────────────────────────────────────────
mock.module('@/lib/github', () => ({
  githubApi: mockGithubApi,
}));

mock.module('@/lib/pushover', () => ({
  notify: mockNotify,
}));

mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { workspace: (id: string) => `workspace-${id}` },
  events: {},
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      darkCheckAlerts: { findFirst: mockDarkCheckAlertsFindFirst },
      workspaces: { findFirst: mock(() => null as any) },
    },
    insert: (table: any) => ({
      values: (values: any) => {
        insertCalls.push({ table, values });
        return Promise.resolve();
      },
    }),
    update: (table: any) => ({
      set: (values: any) => {
        const call = { table, setValues: values };
        updateCalls.push(call);
        return {
          where: () => Promise.resolve(),
        };
      },
    }),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...conditions: any[]) => ({ conditions, type: 'and' }),
}));

const schemaMock = {
  darkCheckAlerts: {
    workspaceId: 'workspaceId',
    checkName: 'checkName',
    consecutiveSkips: 'consecutiveSkips',
    lastAlertedAt: 'lastAlertedAt',
    updatedAt: 'updatedAt',
  },
  workspaces: { id: 'id', repo: 'repo' },
};
mock.module('@buildd/core/db/schema', () => schemaMock);

import { detectDarkChecks } from './dark-check-detection';

// ── Helpers ────────────────────────────────────────────────────────────────
function makeCheckRuns(runs: Array<{ name: string; conclusion: string | null }>) {
  return {
    check_runs: runs.map(r => ({ name: r.name, conclusion: r.conclusion })),
  };
}

function makeBranchProtection(contexts: string[]) {
  return {
    required_status_checks: { contexts },
  };
}

const BASE_PARAMS = {
  workspaceId: 'ws-1',
  workspaceName: 'my-workspace',
  installationId: 12345,
  repoFullName: 'org/repo',
  headSha: 'abc123',
  threshold: 3,
};

beforeEach(() => {
  updateCalls = [];
  insertCalls = [];
  mockGithubApi.mockReset();
  mockNotify.mockReset();
  mockTriggerEvent.mockReset();
  mockDarkCheckAlertsFindFirst.mockReset();
});

// ── Tests ──────────────────────────────────────────────────────────────────
describe('detectDarkChecks', () => {
  describe('consecutive skips tracking', () => {
    it('inserts a new row with consecutiveSkips=1 on first skipped PR', async () => {
      mockGithubApi.mockImplementation((_, path: string) => {
        if (path.includes('/protection')) return Promise.resolve(makeBranchProtection(['ci/test']));
        if (path.includes('/check-runs')) return Promise.resolve(makeCheckRuns([{ name: 'ci/test', conclusion: 'skipped' }]));
        return Promise.resolve(null);
      });
      mockDarkCheckAlertsFindFirst.mockReturnValue(Promise.resolve(null));

      await detectDarkChecks(BASE_PARAMS);

      const insert = insertCalls.find(c => c.values?.checkName === 'ci/test');
      expect(insert).toBeDefined();
      expect(insert!.values.consecutiveSkips).toBe(1);
    });

    it('increments consecutiveSkips on each subsequent skipped PR', async () => {
      mockGithubApi.mockImplementation((_, path: string) => {
        if (path.includes('/protection')) return Promise.resolve(makeBranchProtection(['ci/test']));
        if (path.includes('/check-runs')) return Promise.resolve(makeCheckRuns([{ name: 'ci/test', conclusion: 'skipped' }]));
        return Promise.resolve(null);
      });
      mockDarkCheckAlertsFindFirst.mockReturnValue(
        Promise.resolve({ consecutiveSkips: 2, lastAlertedAt: null }),
      );

      await detectDarkChecks(BASE_PARAMS);

      const update = updateCalls.find(c => c.setValues?.consecutiveSkips === 3);
      expect(update).toBeDefined();
    });

    it('resets consecutiveSkips to 0 when check passes', async () => {
      mockGithubApi.mockImplementation((_, path: string) => {
        if (path.includes('/protection')) return Promise.resolve(makeBranchProtection(['ci/test']));
        if (path.includes('/check-runs')) return Promise.resolve(makeCheckRuns([{ name: 'ci/test', conclusion: 'success' }]));
        return Promise.resolve(null);
      });
      mockDarkCheckAlertsFindFirst.mockReturnValue(
        Promise.resolve({ consecutiveSkips: 4, lastAlertedAt: null }),
      );

      await detectDarkChecks(BASE_PARAMS);

      const update = updateCalls.find(c => c.setValues?.consecutiveSkips === 0);
      expect(update).toBeDefined();
      expect(mockNotify).not.toHaveBeenCalled();
    });

    it('treats null conclusion as skipped', async () => {
      mockGithubApi.mockImplementation((_, path: string) => {
        if (path.includes('/protection')) return Promise.resolve(makeBranchProtection(['ci/test']));
        if (path.includes('/check-runs')) return Promise.resolve(makeCheckRuns([{ name: 'ci/test', conclusion: null }]));
        return Promise.resolve(null);
      });
      mockDarkCheckAlertsFindFirst.mockReturnValue(Promise.resolve(null));

      await detectDarkChecks(BASE_PARAMS);

      const insert = insertCalls.find(c => c.values?.checkName === 'ci/test');
      expect(insert).toBeDefined();
      expect(insert!.values.consecutiveSkips).toBe(1);
    });
  });

  describe('alert firing', () => {
    it('fires Pushover alert when threshold is reached', async () => {
      mockGithubApi.mockImplementation((_, path: string) => {
        if (path.includes('/protection')) return Promise.resolve(makeBranchProtection(['ci/test']));
        if (path.includes('/check-runs')) return Promise.resolve(makeCheckRuns([{ name: 'ci/test', conclusion: 'skipped' }]));
        return Promise.resolve(null);
      });
      // 2 prior skips → this makes 3 → threshold=3 → fire
      mockDarkCheckAlertsFindFirst.mockReturnValue(
        Promise.resolve({ consecutiveSkips: 2, lastAlertedAt: null }),
      );

      await detectDarkChecks(BASE_PARAMS);

      expect(mockNotify).toHaveBeenCalledTimes(1);
      const call = mockNotify.mock.calls[0][0];
      expect(call.app).toBe('alerts');
      expect(call.message).toContain('ci/test');
      expect(call.message).toContain('3');
    });

    it('does NOT fire alert when below threshold', async () => {
      mockGithubApi.mockImplementation((_, path: string) => {
        if (path.includes('/protection')) return Promise.resolve(makeBranchProtection(['ci/test']));
        if (path.includes('/check-runs')) return Promise.resolve(makeCheckRuns([{ name: 'ci/test', conclusion: 'skipped' }]));
        return Promise.resolve(null);
      });
      // 1 prior skip → this makes 2 → threshold=3 → no fire
      mockDarkCheckAlertsFindFirst.mockReturnValue(
        Promise.resolve({ consecutiveSkips: 1, lastAlertedAt: null }),
      );

      await detectDarkChecks(BASE_PARAMS);

      expect(mockNotify).not.toHaveBeenCalled();
    });

    it('does NOT fire alert within 24h dedup window', async () => {
      const recentAlert = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
      mockGithubApi.mockImplementation((_, path: string) => {
        if (path.includes('/protection')) return Promise.resolve(makeBranchProtection(['ci/test']));
        if (path.includes('/check-runs')) return Promise.resolve(makeCheckRuns([{ name: 'ci/test', conclusion: 'skipped' }]));
        return Promise.resolve(null);
      });
      mockDarkCheckAlertsFindFirst.mockReturnValue(
        Promise.resolve({ consecutiveSkips: 5, lastAlertedAt: recentAlert }),
      );

      await detectDarkChecks(BASE_PARAMS);

      expect(mockNotify).not.toHaveBeenCalled();
    });

    it('fires alert again after 24h dedup window expires', async () => {
      const oldAlert = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h ago
      mockGithubApi.mockImplementation((_, path: string) => {
        if (path.includes('/protection')) return Promise.resolve(makeBranchProtection(['ci/test']));
        if (path.includes('/check-runs')) return Promise.resolve(makeCheckRuns([{ name: 'ci/test', conclusion: 'skipped' }]));
        return Promise.resolve(null);
      });
      mockDarkCheckAlertsFindFirst.mockReturnValue(
        Promise.resolve({ consecutiveSkips: 5, lastAlertedAt: oldAlert }),
      );

      await detectDarkChecks(BASE_PARAMS);

      expect(mockNotify).toHaveBeenCalledTimes(1);
    });

    it('emits triggerEvent with dark_check_detected metadata', async () => {
      mockGithubApi.mockImplementation((_, path: string) => {
        if (path.includes('/protection')) return Promise.resolve(makeBranchProtection(['ci/test']));
        if (path.includes('/check-runs')) return Promise.resolve(makeCheckRuns([{ name: 'ci/test', conclusion: 'skipped' }]));
        return Promise.resolve(null);
      });
      mockDarkCheckAlertsFindFirst.mockReturnValue(
        Promise.resolve({ consecutiveSkips: 2, lastAlertedAt: null }),
      );

      await detectDarkChecks(BASE_PARAMS);

      expect(mockTriggerEvent).toHaveBeenCalledTimes(1);
      const [channel, eventType, metadata] = mockTriggerEvent.mock.calls[0];
      expect(channel).toBe('workspace-ws-1');
      expect(eventType).toBe('workspace:dark_check_detected');
      expect(metadata).toMatchObject({
        workspaceId: 'ws-1',
        checkName: 'ci/test',
        consecutiveSkips: 3,
      });
    });
  });

  describe('required checks filtering', () => {
    it('only tracks required checks when branch protection is available', async () => {
      // Branch protection only requires 'ci/required'
      mockGithubApi.mockImplementation((_, path: string) => {
        if (path.includes('/protection')) return Promise.resolve(makeBranchProtection(['ci/required']));
        if (path.includes('/check-runs')) {
          return Promise.resolve(makeCheckRuns([
            { name: 'ci/required', conclusion: 'skipped' },
            { name: 'ci/optional', conclusion: 'skipped' },
          ]));
        }
        return Promise.resolve(null);
      });
      mockDarkCheckAlertsFindFirst.mockReturnValue(Promise.resolve(null));

      await detectDarkChecks(BASE_PARAMS);

      // Only 'ci/required' should be inserted
      expect(insertCalls.length).toBe(1);
      expect(insertCalls[0].values.checkName).toBe('ci/required');
    });

    it('tracks all checks when branch protection is unavailable', async () => {
      mockGithubApi.mockImplementation((_, path: string) => {
        if (path.includes('/protection')) return Promise.reject(new Error('403 Forbidden'));
        if (path.includes('/check-runs')) {
          return Promise.resolve(makeCheckRuns([
            { name: 'ci/test', conclusion: 'skipped' },
            { name: 'ci/lint', conclusion: 'skipped' },
          ]));
        }
        return Promise.resolve(null);
      });
      mockDarkCheckAlertsFindFirst.mockReturnValue(Promise.resolve(null));

      await detectDarkChecks(BASE_PARAMS);

      expect(insertCalls.length).toBe(2);
    });
  });

  describe('error handling', () => {
    it('is non-fatal when check runs API fails', async () => {
      mockGithubApi.mockImplementation((_, path: string) => {
        if (path.includes('/protection')) return Promise.resolve(makeBranchProtection(['ci/test']));
        if (path.includes('/check-runs')) return Promise.reject(new Error('GitHub API error'));
        return Promise.resolve(null);
      });

      // Should not throw
      await expect(detectDarkChecks(BASE_PARAMS)).resolves.toBeUndefined();
      expect(mockNotify).not.toHaveBeenCalled();
    });

    it('returns early when no check runs found', async () => {
      mockGithubApi.mockImplementation((_, path: string) => {
        if (path.includes('/protection')) return Promise.resolve(makeBranchProtection(['ci/test']));
        if (path.includes('/check-runs')) return Promise.resolve({ check_runs: [] });
        return Promise.resolve(null);
      });

      await detectDarkChecks(BASE_PARAMS);

      expect(insertCalls.length).toBe(0);
      expect(mockNotify).not.toHaveBeenCalled();
    });

    it('does not alert for non-skipped conclusions', async () => {
      const nonSkippedConclusions = ['success', 'failure', 'neutral', 'cancelled', 'timed_out', 'action_required'];

      for (const conclusion of nonSkippedConclusions) {
        updateCalls = [];
        insertCalls = [];
        mockNotify.mockReset();

        mockGithubApi.mockImplementation((_, path: string) => {
          if (path.includes('/protection')) return Promise.resolve(makeBranchProtection(['ci/test']));
          if (path.includes('/check-runs')) return Promise.resolve(makeCheckRuns([{ name: 'ci/test', conclusion }]));
          return Promise.resolve(null);
        });
        mockDarkCheckAlertsFindFirst.mockReturnValue(
          Promise.resolve({ consecutiveSkips: 10, lastAlertedAt: null }),
        );

        await detectDarkChecks(BASE_PARAMS);

        expect(mockNotify).not.toHaveBeenCalled();

        const resetUpdate = updateCalls.find(c => c.setValues?.consecutiveSkips === 0);
        expect(resetUpdate).toBeDefined();
      }
    });
  });
});
