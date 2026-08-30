import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── Module mocks (must be before import) ────────────────────────────────────
const mockTriggerEvent = mock(() => Promise.resolve());

mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: {
    workspace: (id: string) => `workspace-${id}`,
  },
  events: {
    RELEASE_UPDATED: 'release:updated',
  },
}));

const schemaMock = {
  releases: { id: 'id', state: 'state', verificationStrategy: 'verificationStrategy', workspaceId: 'workspaceId' },
  workspaces: { id: 'id', releaseConfig: 'releaseConfig' },
};
mock.module('@buildd/core/db/schema', () => schemaMock);
mock.module('@buildd/core/db', () => ({ db: {} }));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

// Import AFTER mocks
import { verifyReleaseDeployment, _setSleeper } from './release-verification';

// ── Test state ───────────────────────────────────────────────────────────────
let selectResults: any[][];
let updateCalls: Array<{ setValues: any }>;
const noopSleeper = () => Promise.resolve();

function makeMockDb(): any {
  let selectCallCount = 0;
  return {
    select: (_cols?: any) => ({
      from: (_table: any) => ({
        where: (_cond: any) => ({
          limit: (_n: any) => Promise.resolve(selectResults[selectCallCount++] ?? []),
        }),
      }),
    }),
    update: (_table: any) => ({
      set: (values: any) => {
        updateCalls.push({ setValues: values });
        return { where: (_cond: any) => Promise.resolve() };
      },
    }),
  };
}

function resetAll() {
  mockTriggerEvent.mockClear();
  selectResults = [];
  updateCalls = [];
  _setSleeper(noopSleeper);
  globalThis.fetch = undefined as any;
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe('verifyReleaseDeployment', () => {
  beforeEach(resetAll);

  it('no-ops when verificationStrategy is not http', async () => {
    selectResults = [
      [{ id: 'rel-1', state: 'deploying', verificationStrategy: 'none', workspaceId: 'ws-1' }],
    ];
    await verifyReleaseDeployment('rel-1', makeMockDb());
    expect(updateCalls).toHaveLength(0);
    expect(mockTriggerEvent.mock.calls).toHaveLength(0);
  });

  it('no-ops when release state is already healthy (idempotency)', async () => {
    selectResults = [
      [{ id: 'rel-2', state: 'healthy', verificationStrategy: 'http', workspaceId: 'ws-1' }],
    ];
    await verifyReleaseDeployment('rel-2', makeMockDb());
    expect(updateCalls).toHaveLength(0);
    expect(mockTriggerEvent.mock.calls).toHaveLength(0);
  });

  it('advances to healthy when first probe returns 2xx', async () => {
    selectResults = [
      [{ id: 'rel-3', state: 'deploying', verificationStrategy: 'http', workspaceId: 'ws-1' }],
      [{ releaseConfig: { verificationUrl: 'https://example.com/health' } }],
    ];
    globalThis.fetch = mock(() =>
      Promise.resolve({ ok: true, status: 200 } as Response)
    ) as any;
    await verifyReleaseDeployment('rel-3', makeMockDb());

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].setValues.state).toBe('healthy');
    expect(updateCalls[0].setValues.healthyAt).toBeInstanceOf(Date);

    const pusherCall = mockTriggerEvent.mock.calls.find(
      ([, event, data]: any[]) => event === 'release:updated' && data?.state === 'healthy',
    );
    expect(pusherCall).toBeDefined();
    expect(pusherCall![0]).toBe('workspace-ws-1');
    expect(pusherCall![2].releaseId).toBe('rel-3');
  });

  it('advances to failed when all probes exhaust without 2xx', async () => {
    selectResults = [
      [{ id: 'rel-4', state: 'deploying', verificationStrategy: 'http', workspaceId: 'ws-2' }],
      [{ releaseConfig: { verificationUrl: 'https://example.com/health' } }],
    ];
    globalThis.fetch = mock(() =>
      Promise.resolve({ ok: false, status: 503 } as Response)
    ) as any;
    await verifyReleaseDeployment('rel-4', makeMockDb());

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].setValues.state).toBe('failed');
    expect(updateCalls[0].setValues.failureReason).toBe(
      'verificationUrl did not respond 2xx after 5 attempts',
    );

    const pusherCall = mockTriggerEvent.mock.calls.find(
      ([, event, data]: any[]) => event === 'release:updated' && data?.state === 'failed',
    );
    expect(pusherCall).toBeDefined();
    expect(pusherCall![0]).toBe('workspace-ws-2');
  });
});
