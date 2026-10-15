import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { capturedWhere } from '@buildd/core/db/relational-sql';

const mockBackendPausesFindMany = mock(() => Promise.resolve([] as any[]));
const mockAccountsFindFirst = mock(() => Promise.resolve(null as any));
const mockTenantBudgetsFindFirst = mock(() => Promise.resolve(null as any));
let insertedPauses: any[] = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      backendPauses: { findMany: mockBackendPausesFindMany },
      accounts: { findFirst: mockAccountsFindFirst },
      tenantBudgets: { findFirst: mockTenantBudgetsFindFirst },
    },
    insert: () => ({ values: (vals: any) => { insertedPauses.push(vals); return Promise.resolve(); } }),
    delete: () => ({ where: () => Promise.resolve() }),
  },
}));

// Mock hasCodexCredential directly to avoid relying on transitive @buildd/core/db
// mock resolution — Bun 1.4.0 (CI) uses per-file module registries so transitive
// mocks from @buildd/core/db don't propagate into codex-credential.ts's imports.
const mockHasCodexCredential = mock(() => Promise.resolve(false));
mock.module('@/lib/codex-credential', () => ({
  hasCodexCredential: mockHasCodexCredential,
}));

// Same reasoning for the plain-API-key sibling: either credential is enough
// to make Codex configured.
const mockHasOpenAiApiKey = mock(() => Promise.resolve(false));
mock.module('@/lib/openai-credential', () => ({
  hasOpenAiApiKey: mockHasOpenAiApiKey,
}));

const {
  getActiveBackendPauses,
  isBackendConfigured,
  recordBackendPause,
  resolveFailoverBackend,
} = await import('./backend-failover');

const HOUR = 60 * 60 * 1000;
const scope = { teamId: 'team-1', accountId: 'account-1', workspaceId: 'ws-1' };

beforeEach(() => {
  insertedPauses = [];
  mockBackendPausesFindMany.mockResolvedValue([]);
  mockAccountsFindFirst.mockResolvedValue(null);
  mockTenantBudgetsFindFirst.mockResolvedValue(null);
  mockHasCodexCredential.mockResolvedValue(false);
  mockHasOpenAiApiKey.mockResolvedValue(false);
});

describe('recordBackendPause', () => {
  it('writes the wall against the backend that hit it', async () => {
    const resetsAt = new Date(Date.now() + HOUR);
    await recordBackendPause({ backend: 'codex', scope, resetsAt, reason: 'budget', sourceWorkerId: 'worker-1' });
    expect(insertedPauses).toHaveLength(1);
    expect(insertedPauses[0]).toMatchObject({
      teamId: 'team-1', workspaceId: 'ws-1', backend: 'codex', reason: 'budget', sourceWorkerId: 'worker-1',
    });
  });

  it('is a no-op without a team, and for a backend that cannot be dispatched', async () => {
    await recordBackendPause({ backend: 'codex', scope: {}, resetsAt: new Date() });
    await recordBackendPause({ backend: 'openrouter', scope, resetsAt: new Date() });
    expect(insertedPauses).toHaveLength(0);
  });
});

describe('getActiveBackendPauses', () => {
  it('keeps the furthest-out row per backend and ignores nothing else', async () => {
    const soon = new Date(Date.now() + HOUR);
    const later = new Date(Date.now() + 4 * HOUR);
    mockBackendPausesFindMany.mockResolvedValue([
      { backend: 'codex', resetsAt: later, reason: 'budget' },
      { backend: 'codex', resetsAt: soon, reason: 'budget' },
      { backend: 'claude', resetsAt: soon, reason: 'budget' },
    ]);
    const pauses = await getActiveBackendPauses(scope);
    expect(pauses.get('codex')?.resetsAt).toEqual(later);
    expect(pauses.get('claude')?.resetsAt).toEqual(soon);
  });

  it('folds in the legacy per-account Claude session flag', async () => {
    const resetsAt = new Date(Date.now() + 2 * HOUR);
    mockAccountsFindFirst.mockResolvedValue({ budgetExhaustedAt: new Date(), budgetResetsAt: resetsAt });
    const pauses = await getActiveBackendPauses(scope);
    expect(pauses.get('claude')?.resetsAt).toEqual(resetsAt);
  });

  it('ignores an account flag whose reset has already passed', async () => {
    mockAccountsFindFirst.mockResolvedValue({
      budgetExhaustedAt: new Date(Date.now() - 6 * HOUR),
      budgetResetsAt: new Date(Date.now() - HOUR),
    });
    expect((await getActiveBackendPauses(scope)).size).toBe(0);
  });

  for (const budgetResetsAt of [null, 'invalid-reset']) {
    it(`parks failover during the fallback session window when reset is ${budgetResetsAt}`, async () => {
      const exhaustedAt = new Date(Date.now() - HOUR);
      const fallbackReset = new Date(exhaustedAt.getTime() + 5 * HOUR);
      mockAccountsFindFirst.mockResolvedValue({ budgetExhaustedAt: exhaustedAt, budgetResetsAt });

      const decision = await resolveFailoverBackend({ from: 'codex', scope });
      expect(decision.backend).toBeNull();
      expect(decision.blocked).toEqual([
        { backend: 'claude', reason: 'paused', pausedUntil: fallbackReset },
      ]);
    });

    it(`allows failover after the fallback session window when reset is ${budgetResetsAt}`, async () => {
      mockAccountsFindFirst.mockResolvedValue({
        budgetExhaustedAt: new Date(Date.now() - 6 * HOUR),
        budgetResetsAt,
      });
      expect((await resolveFailoverBackend({ from: 'codex', scope })).backend).toBe('claude');
    });
  }

  it('uses the tenant budget row instead of the account flag in multi-tenant mode', async () => {
    const resetsAt = new Date(Date.now() + 3 * HOUR);
    mockTenantBudgetsFindFirst.mockResolvedValue({ budgetResetsAt: resetsAt });
    mockAccountsFindFirst.mockResolvedValue({ budgetExhaustedAt: new Date(), budgetResetsAt: new Date(Date.now() + 9 * HOUR) });
    const pauses = await getActiveBackendPauses({ ...scope, tenantId: 'tenant-9' });
    expect(pauses.get('claude')?.resetsAt).toEqual(resetsAt);
  });
});

describe('isBackendConfigured', () => {
  it('treats Claude as always available — it runs on the account credentials', async () => {
    expect(await isBackendConfigured('claude', scope)).toBe(true);
  });

  it('requires a stored credential for Codex', async () => {
    expect(await isBackendConfigured('codex', scope)).toBe(false);
    mockHasCodexCredential.mockResolvedValue(true);
    expect(await isBackendConfigured('codex', scope)).toBe(true);
  });

  // A plain team/workspace OpenAI API key is the simpler sibling of
  // `codex_credential` (ChatGPT connect) — either one configures Codex.
  it('also treats a plain OpenAI API key as a configured Codex credential', async () => {
    mockHasCodexCredential.mockResolvedValue(false);
    mockHasOpenAiApiKey.mockResolvedValue(false);
    expect(await isBackendConfigured('codex', scope)).toBe(false);

    mockHasOpenAiApiKey.mockResolvedValue(true);
    expect(await isBackendConfigured('codex', scope)).toBe(true);
  });

  it('refuses a backend the runner cannot execute yet', async () => {
    expect(await isBackendConfigured('openrouter', scope)).toBe(false);
  });

  it('passes the claiming account through by default', async () => {
    await isBackendConfigured('codex', scope);
    expect(mockHasCodexCredential).toHaveBeenLastCalledWith({
      teamId: 'team-1', accountId: 'account-1', workspaceId: 'ws-1',
    });
  });

  it("anyAccount asks whether ANY runner in the team could run it", async () => {
    // Read-only reporting has no claiming account; an account-scoped credential
    // still means the backend works for someone, so it must not read as absent.
    await isBackendConfigured('codex', { teamId: 'team-1', workspaceId: 'ws-1', anyAccount: true });
    expect(mockHasCodexCredential).toHaveBeenLastCalledWith({
      teamId: 'team-1', accountId: 'any', workspaceId: 'ws-1',
    });
  });
});

describe('resolveFailoverBackend', () => {
  it('moves a Codex-walled task to Claude', async () => {
    mockBackendPausesFindMany.mockResolvedValue([
      { backend: 'codex', resetsAt: new Date(Date.now() + HOUR), reason: 'budget' },
    ]);
    expect((await resolveFailoverBackend({ from: 'codex', scope })).backend).toBe('claude');
  });

  it('moves a Claude-walled task to Codex when a credential exists', async () => {
    mockHasCodexCredential.mockResolvedValue(true);
    expect((await resolveFailoverBackend({ from: 'claude', scope })).backend).toBe('codex');
  });

  it('reports the reason when the only alternative is walled as well', async () => {
    const claudeReset = new Date(Date.now() + 4 * HOUR);
    mockBackendPausesFindMany.mockResolvedValue([{ backend: 'claude', resetsAt: claudeReset, reason: 'budget' }]);
    const decision = await resolveFailoverBackend({ from: 'codex', scope });
    expect(decision.backend).toBeNull();
    expect(decision.blocked).toEqual([{ backend: 'claude', reason: 'paused', pausedUntil: claudeReset }]);
  });

  it('respects a busy provider slot the caller reports', async () => {
    mockHasCodexCredential.mockResolvedValue(true);
    const decision = await resolveFailoverBackend({ from: 'claude', scope, busy: { codex: true } });
    expect(decision.backend).toBeNull();
    expect(decision.blocked[0]).toMatchObject({ backend: 'codex', reason: 'busy' });
  });
});

// A runner on its own machine login hits a wall that is its own, not the
// team's (task e68327a1). The pause row carries that runner's seat key; a
// reader with a different key must not see it, a reader with no key must.
describe('seat-scoped pauses', () => {
  const dialect = new PgDialect();
  const renderedWhere = () => {
    const call = mockBackendPausesFindMany.mock.calls.at(-1) as any[] | undefined;
    return dialect.sqlToQuery(capturedWhere(call?.[0]?.where));
  };
  const soon = () => new Date(Date.now() + HOUR);

  it('records the seat key a runner-scoped wall carries, and none for a shared wall', async () => {
    await recordBackendPause({ backend: 'claude', scope, resetsAt: soon(), seatKey: 'runner:aaa' });
    await recordBackendPause({ backend: 'claude', scope, resetsAt: soon() });
    expect(insertedPauses[0]).toMatchObject({ backend: 'claude', seatKey: 'runner:aaa' });
    expect(insertedPauses[1].seatKey ?? null).toBeNull();
  });

  it("ignores another runner's seat wall but keeps its own and every shared one", async () => {
    const shared = soon();
    mockBackendPausesFindMany.mockResolvedValue([
      { backend: 'claude', resetsAt: new Date(Date.now() + 40 * HOUR), reason: 'budget', seatKey: 'runner:other' },
    ]);
    expect((await getActiveBackendPauses({ ...scope, seatKey: 'runner:mine' })).has('claude')).toBe(false);

    mockBackendPausesFindMany.mockResolvedValue([
      { backend: 'claude', resetsAt: new Date(Date.now() + 40 * HOUR), reason: 'budget', seatKey: 'runner:mine' },
    ]);
    const own = await getActiveBackendPauses({ ...scope, seatKey: 'runner:mine' });
    expect(own.get('claude')?.seatKey).toBe('runner:mine');

    mockBackendPausesFindMany.mockResolvedValue([
      { backend: 'claude', resetsAt: shared, reason: 'budget', seatKey: null },
    ]);
    expect((await getActiveBackendPauses({ ...scope, seatKey: 'runner:mine' })).get('claude')?.resetsAt).toEqual(shared);
  });

  it('scopes the query itself: shared rows or this seat only', async () => {
    await getActiveBackendPauses({ ...scope, seatKey: 'runner:mine' });
    const q = renderedWhere();
    expect(q.sql).toContain('"seat_key" is null');
    expect(q.sql).toMatch(/"seat_key" = \$\d+/);
    expect(q.params).toContain('runner:mine');
  });

  // Fail-safe: a reader that cannot say which login it runs on is held by
  // every wall, seat-scoped or not.
  it('reads every wall, seat-scoped ones included, for a reader with no seat key', async () => {
    mockBackendPausesFindMany.mockResolvedValue([
      { backend: 'claude', resetsAt: soon(), reason: 'budget', seatKey: 'runner:other' },
    ]);
    expect((await getActiveBackendPauses(scope)).has('claude')).toBe(true);
    expect(renderedWhere().sql).not.toContain('seat_key');
  });
});
