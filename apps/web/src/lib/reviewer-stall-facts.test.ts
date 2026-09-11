import { beforeEach, describe, expect, it, mock } from 'bun:test';

const count = mock(() => Promise.resolve([{ count: 0 }]));
const accounts = mock(() => Promise.resolve([] as any[]));
const pauses = mock(() => Promise.resolve([] as any[]));
const tenants = mock(() => Promise.resolve([] as any[]));
mock.module('@buildd/core/db', () => ({ db: {
  select: () => ({ from: () => ({ where: count }) }),
  query: { accounts: { findMany: accounts }, backendPauses: { findMany: pauses }, tenantBudgets: { findMany: tenants } },
} }));
import { createReviewerStallFactsLoader } from './reviewer-stall-facts';
import { resolveReviewerGate } from './reviewer-gate';
const now = new Date('2026-09-01T12:00:00Z');
const workspace = { id: 'workspace-test', teamId: 'team-test', maxConcurrentTasks: 4 };
beforeEach(() => {
  count.mockReset(); count.mockResolvedValue([{ count: 0 }]);
  accounts.mockReset(); accounts.mockResolvedValue([]);
  pauses.mockReset(); pauses.mockResolvedValue([]);
  tenants.mockReset(); tenants.mockResolvedValue([]);
});
describe('render-time reviewer stall facts', () => {
  it('loads free seats and no pauses and passes the claim stamp through the gate', async () => {
    const facts = await createReviewerStallFactsLoader(now).load(workspace, {});
    const gate = resolveReviewerGate({ policyTier: 'agent-review', escalationReason: null, approvalSummary: null,
      prOpenedAt: null, now, stallFacts: facts, reviewerTask: {
        status: 'pending', hasLiveWorker: false, createdAt: new Date('2026-09-01T11:00:00Z'),
        context: { lastClaimAttemptReason: 'no_pending_tasks' },
      },
    });
    expect(gate.reason).toContain('seats 0/4');
    expect(gate.reason).toContain('no recorded budget pause');
    expect(gate.reason).toContain('no_pending_tasks');
    expect(gate.reason).not.toMatch(/contention|backoff/i);
  });
  it('does not turn a failed budget or seats query into a negative fact', async () => {
    accounts.mockRejectedValue(new Error('unavailable'));
    count.mockRejectedValue(new Error('unavailable'));
    expect(await createReviewerStallFactsLoader(now).load(workspace, {})).toEqual({ seats: null, budgetPauses: null });
  });
  it('reads active provider and account pauses, excluding expired ones', async () => {
    pauses.mockResolvedValue([
      { backend: 'codex', reason: 'budget', resetsAt: new Date('2026-09-01T13:00:00Z') },
      { backend: 'codex', reason: 'budget', resetsAt: new Date('2026-09-01T12:30:00Z') },
      { backend: 'claude', reason: 'budget', resetsAt: new Date('2026-09-01T11:00:00Z') },
    ]);
    accounts.mockResolvedValue([{ budgetExhaustedAt: now, budgetResetsAt: new Date('2026-09-01T14:00:00Z') }]);
    const facts = await createReviewerStallFactsLoader(now).load(workspace, {});
    expect(facts.budgetPauses).toEqual([
      'codex budget pause until 2026-09-01T13:00:00.000Z',
      'team account budget pause until 2026-09-01T14:00:00.000Z',
    ]);
  });
  it('scopes tenant pauses to the task tenant and reports its mission budget state', async () => {
    tenants.mockResolvedValue([{ tenantId: 'tenant-a', budgetResetsAt: new Date('2026-09-01T13:00:00Z') }]);
    const loader = createReviewerStallFactsLoader(now);
    expect((await loader.load(workspace, { context: { tenantContext: { tenantId: 'tenant-b' } } })).budgetPauses).toEqual([]);
    expect((await loader.load(workspace, { context: { tenantContext: { tenantId: 'tenant-a' } }, mission: { status: 'budget_exhausted' } })).budgetPauses).toEqual([
      'tenant budget pause until 2026-09-01T13:00:00.000Z', 'mission budget exhausted',
    ]);
    expect(tenants).toHaveBeenCalledTimes(1);
    expect(count).toHaveBeenCalledTimes(1);
  });
});
