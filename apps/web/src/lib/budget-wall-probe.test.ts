import { describe, it, expect, beforeEach, mock } from 'bun:test';

const updates: Array<{ table: string; set: any }> = [];
let pauseRows = [{ id: 'p1' }, { id: 'p2' }];
let accountRows = [{ id: 'a1' }];

const mockUpdate = mock((table: any) => ({
  set: (set: any) => {
    const name = table === 'accounts_t' ? 'accounts' : 'backend_pauses';
    updates.push({ table: name, set });
    return { where: () => ({ returning: async () => (name === 'accounts' ? accountRows : pauseRows) }) };
  },
}));
const gateEvents: any[] = [];
const pauses: any[] = [];

mock.module('@buildd/core/db', () => ({ db: { update: mockUpdate } }));
mock.module('@buildd/core/db/schema', () => ({
  accounts: 'accounts_t',
  backendPauses: { seatKey: 'seat', teamId: 't', backend: 'b', resetsAt: 'r', id: 'id' },
}));
mock.module('@buildd/core/gate-events', () => ({
  GATE_SLUGS: { BUDGET_WALL_PROBE: 'budget_wall_probe' },
  recordGateEvent: async (e: any) => { gateEvents.push(e); return 'g1'; },
}));
mock.module('./backend-failover', () => ({ recordBackendPause: async (p: any) => { pauses.push(p); } }));

const { applyBudgetWallProbe, requestBudgetWallProbe } = await import('./budget-wall-probe');
const account = { id: 'a1', teamId: 't1' };

beforeEach(() => {
  updates.length = 0; gateEvents.length = 0; pauses.length = 0;
  pauseRows = [{ id: 'p1' }, { id: 'p2' }];
  accountRows = [{ id: 'a1' }];
});

describe('applyBudgetWallProbe', () => {
  it('capacity: expires the pause rows and account flag, and records the clear in the gate ledger', async () => {
    const r = await applyBudgetWallProbe({ account, backend: 'claude', outcome: 'capacity', trigger: 'cli', runner: 'http://localhost:3000' });
    expect(r.cleared).toBe(3);
    expect(updates.find(u => u.table === 'backend_pauses')!.set.resetsAt).toBeInstanceOf(Date);
    expect(updates.find(u => u.table === 'accounts')!.set).toMatchObject({ budgetExhaustedAt: null, budgetResetsAt: null });
    expect(gateEvents).toHaveLength(1);
    expect(gateEvents[0]).toMatchObject({ gate: 'budget_wall_probe', outcome: 'accepted' });
    expect(gateEvents[0].detail).toMatchObject({ trigger: 'cli', cleared: 3 });
  });

  it('limited: keeps the wall, refreshes the reset time, records a warning', async () => {
    const resetsAt = new Date(Date.now() + 3 * 3600_000);
    const r = await applyBudgetWallProbe({ account, backend: 'claude', outcome: 'limited', trigger: 'auto', resetsAt, runner: 'http://localhost:3000' });
    expect(r.cleared).toBe(0);
    expect(r.resetsAt).toBe(resetsAt.toISOString());
    expect(pauses).toHaveLength(1);
    expect(pauses[0].resetsAt).toEqual(resetsAt);
    expect(pauses[0].seatKey).toMatch(/^runner:/);
    expect(updates.some(u => u.table === 'backend_pauses')).toBe(false); // nothing expired
    expect(gateEvents[0]).toMatchObject({ outcome: 'warned' });
  });

  it('limited with no usable reset: wall untouched', async () => {
    await applyBudgetWallProbe({ account, backend: 'claude', outcome: 'limited', trigger: 'auto', resetsAt: new Date(Date.now() - 1000) });
    expect(pauses).toHaveLength(0);
  });

  it('error: changes nothing and writes no ledger row', async () => {
    const r = await applyBudgetWallProbe({ account, backend: 'claude', outcome: 'error', trigger: 'nudge' });
    expect(r.cleared).toBe(0);
    expect(updates).toHaveLength(0);
    expect(gateEvents).toHaveLength(0);
  });
});

describe('requestBudgetWallProbe', () => {
  it('only raises the request timestamp; it never expires a wall', async () => {
    const n = await requestBudgetWallProbe('t1');
    expect(n).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe('accounts');
    expect(Object.keys(updates[0].set)).toEqual(['budgetProbeRequestedAt']);
  });
});
