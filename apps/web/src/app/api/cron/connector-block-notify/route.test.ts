import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── DB mocks ────────────────────────────────────────────────────────────────

const mockTaskFindMany = mock(() => [] as any[]);
const mockSecretFindMany = mock(() => [] as any[]);
const mockConnectorFindMany = mock(() => [] as any[]);
let secretUpdates: any[] = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findMany: mockTaskFindMany },
      secrets: { findMany: mockSecretFindMany },
      connectors: { findMany: mockConnectorFindMany },
    },
    update: mock((_table: any) => ({
      set: mock((values: any) => ({
        where: mock(() => {
          secretUpdates.push(values);
          return Promise.resolve();
        }),
      })),
    })),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (f: any, v: any) => ({ f, v, type: 'eq' }),
  and: (...c: any[]) => ({ c, type: 'and' }),
  inArray: (f: any, v: any) => ({ f, v, type: 'inArray' }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: any[]) => ({ raw: strings.join(''), values }),
    { raw: (s: string) => s },
  ),
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'id', status: 'status', context: 'context' },
  secrets: { id: 'id', purpose: 'purpose' },
  connectors: { id: 'id' },
}));

const mockNotifyExpiry = mock((_ctx: any) => Promise.resolve(true));
const mockNotifyReminder = mock(() => Promise.resolve(false));

mock.module('../../workers/claim/connector-block-notify', () => ({
  notifyConnectorBlockReminder: mockNotifyReminder,
  notifyConnectorExpiry: mockNotifyExpiry,
}));

const { POST } = await import('./route');

// ── Helpers ─────────────────────────────────────────────────────────────────

const CRON_SECRET = 'test-cron-secret';
const TEAM_ID = 'team-1';

function makeRequest(token = CRON_SECRET): NextRequest {
  return new NextRequest('http://localhost/api/cron/connector-block-notify', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
}

const hoursFromNow = (n: number) => new Date(Date.now() + n * 3_600_000);

function credential(over: Record<string, unknown> = {}) {
  return {
    id: 'secret-1',
    teamId: TEAM_ID,
    label: 'connector-1',
    tokenExpiresAt: hoursFromNow(-1),
    lastVerificationError: null,
    expiryNotifiedAt: null,
    ...over,
  };
}

beforeEach(() => {
  process.env.CRON_SECRET = CRON_SECRET;
  mockTaskFindMany.mockReset();
  mockTaskFindMany.mockReturnValue([]);
  mockSecretFindMany.mockReset();
  mockSecretFindMany.mockReturnValue([]);
  mockConnectorFindMany.mockReset();
  mockConnectorFindMany.mockReturnValue([{ id: 'connector-1', name: 'Cue' }]);
  mockNotifyExpiry.mockClear();
  mockNotifyReminder.mockClear();
  secretUpdates = [];
});

describe('connector-block-notify cron — expiry scan', () => {
  it('rejects a request without the cron secret', async () => {
    const res = await POST(makeRequest('wrong'));
    expect(res.status).toBe(401);
  });

  it('alerts on an expired connector credential and stamps the dedup column', async () => {
    mockSecretFindMany.mockReturnValue([credential()]);

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(body.expiryAlerted).toBe(1);
    expect(mockNotifyExpiry).toHaveBeenCalledTimes(1);
    expect(mockNotifyExpiry.mock.calls[0][0]).toMatchObject({
      teamId: TEAM_ID,
      connectorName: 'Cue',
      expiringSoon: false,
    });
    expect(secretUpdates).toHaveLength(1);
    expect(secretUpdates[0].expiryNotifiedAt).toBeInstanceOf(Date);
  });

  it('runs the expiry scan even when no task is blocked', async () => {
    mockTaskFindMany.mockReturnValue([]);
    mockSecretFindMany.mockReturnValue([credential()]);

    const body = await (await POST(makeRequest())).json();

    // Regression: the reminder pass used to early-return on an empty task list,
    // which skipped the scan entirely.
    expect(body.expiryAlerted).toBe(1);
  });

  it('warns ahead of expiry for a credential inside the window', async () => {
    mockSecretFindMany.mockReturnValue([credential({ tokenExpiresAt: hoursFromNow(4) })]);

    await POST(makeRequest());

    expect(mockNotifyExpiry.mock.calls[0][0]).toMatchObject({ expiringSoon: true });
  });

  it('stays quiet for a healthy credential', async () => {
    mockSecretFindMany.mockReturnValue([credential({ tokenExpiresAt: hoursFromNow(72) })]);

    const body = await (await POST(makeRequest())).json();

    expect(body.expiryAlerted).toBe(0);
    expect(mockNotifyExpiry).not.toHaveBeenCalled();
  });

  it('does not re-alert a credential already stamped', async () => {
    mockSecretFindMany.mockReturnValue([credential({ expiryNotifiedAt: hoursFromNow(-0.5) })]);

    const body = await (await POST(makeRequest())).json();

    expect(body.expiryAlerted).toBe(0);
    expect(mockNotifyExpiry).not.toHaveBeenCalled();
  });

  it('alerts on a credential the refresher marked dead (expiry nulled + error)', async () => {
    mockSecretFindMany.mockReturnValue([
      credential({ tokenExpiresAt: null, lastVerificationError: 'invalid_grant' }),
    ]);

    const body = await (await POST(makeRequest())).json();

    expect(body.expiryAlerted).toBe(1);
    expect(mockNotifyExpiry.mock.calls[0][0]).toMatchObject({ expiringSoon: false });
  });

  it('skips an orphaned credential whose connector was deleted', async () => {
    mockSecretFindMany.mockReturnValue([credential()]);
    mockConnectorFindMany.mockReturnValue([]);

    const body = await (await POST(makeRequest())).json();

    expect(body.expiryAlerted).toBe(0);
    expect(secretUpdates).toHaveLength(0);
  });
});
