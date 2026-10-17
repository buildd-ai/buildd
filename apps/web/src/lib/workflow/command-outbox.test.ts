/**
 * The floor's pass over parked door commands (command-outbox.ts, workflow-kernel-library.md §3 AC-35):
 * the ledger is asked first, each row is re-submitted with its own key, and only an answer settles it.
 * The real-SQL half (the table, the ledger, the control plane down and back) is
 * apps/web/tests/db/kernel-command-host.test.ts.
 */
import { describe, expect, it } from 'bun:test';
import { drainParkedCommands, outcomeOf, PARKED_BATCH, PARKED_LEASE_MS, PARKED_MAX_ATTEMPTS, PARKED_SUBMIT_BUDGET_MS, parkedRetryDelayMs, resubmitOnControlPlane, type CommandOutbox, type ParkedRow, type Resubmitted } from './command-outbox';
import type { CommandLedger, LedgerRow } from './command-ledger';

const WS = '11111111-1111-4111-8111-111111111111';
const row = (key: string, o: Partial<ParkedRow> = {}): ParkedRow => ({
  key, op: 'attempt_ended', input: { workspaceId: WS }, principal: { kind: 'system', id: 'system:runner' }, priorUnknown: false, attempt: 1, ...o,
});

function fakes(rows: ParkedRow[], ledgerRows: Record<string, Partial<LedgerRow>> = {}) {
  const log: string[] = [];
  const outbox: CommandOutbox = {
    park: async () => true,
    claimDue: async () => rows,
    settle: async (r, outcome) => { log.push(`settle ${r.key} ${outcome}`); return true; },
    retry: async (r, p) => { log.push(`retry ${r.key}${p.priorUnknown ? ' unknown' : ''}${p.refund ? ' refund' : ''}`); return true; },
    bury: async (r, error) => { log.push(`bury ${r.key} ${error}`); return true; },
    prune: async () => 0,
  };
  const ledger = { read: async (key: string) => (ledgerRows[key] ? { key, op: 'attempt_ended', principal: 'p', requestHash: 'h', status: 'done', response: null, claimedAt: new Date().toISOString(), ...ledgerRows[key] } as LedgerRow : null) } as unknown as CommandLedger;
  return { log, outbox, ledger };
}

describe('the drain pass', () => {
  it('settles an answered row with what the kernel said, and asks the ledger before submitting', async () => {
    const f = fakes([row('k-a'), row('k-b')], { 'k-b': { status: 'done', response: { status: 200, body: { result: { handled: true, result: { result: 'applied' } } } } } });
    const sent: string[] = [];
    const s = await drainParkedCommands({ ...f, host: () => 'web', resubmit: async (r) => { sent.push(r.key); return { kind: 'answered', outcome: 'stale' }; } });
    // k-b ran on the control plane already: settled from the ledger, never sent again.
    expect(sent).toEqual(['k-a']);
    expect(f.log).toEqual(['settle k-a stale', 'settle k-b replayed:applied']);
    expect(s).toMatchObject({ claimed: 2, done: 2, retried: 0, dead: 0 });
  });

  it('a control plane still down stops the pass at the first row; the rest are retried unsent', async () => {
    const f = fakes([row('k-a'), row('k-b'), row('k-c')]);
    const sent: string[] = [];
    const s = await drainParkedCommands({ ...f, host: () => 'web', resubmit: async (r) => { sent.push(r.key); return { kind: 'unanswered', error: 'unreachable', unreachable: true }; } });
    expect(sent).toEqual(['k-a']);
    // The unsent rows get their attempt back, even one already at the cap: they are never given up for it.
    expect(f.log).toEqual(['retry k-a', 'retry k-b refund', 'retry k-c refund']);
    expect(s).toMatchObject({ retried: 3, done: 0 });
    const capped = fakes([row('k-a'), row('k-b', { attempt: PARKED_MAX_ATTEMPTS })]);
    await drainParkedCommands({ ...capped, host: () => 'web', resubmit: async () => ({ kind: 'unanswered', error: 'unreachable', unreachable: true }) });
    expect(capped.log).toEqual(['retry k-a', 'retry k-b refund']);
  });

  it('a pass\'s lease outlasts its worst case, so a second pass never takes a row over mid-flight', () => {
    expect(PARKED_LEASE_MS).toBeGreaterThan(PARKED_BATCH * PARKED_SUBMIT_BUDGET_MS * 2);
  });

  it('a refusal is given up (asking again cannot change it); attempts past the cap are given up too', async () => {
    const f = fakes([row('k-a'), row('k-b', { attempt: PARKED_MAX_ATTEMPTS })]);
    const s = await drainParkedCommands({ ...f, host: () => 'web', resubmit: async (r): Promise<Resubmitted> => (r.key === 'k-a' ? { kind: 'refused', error: '403 forbidden' } : { kind: 'unanswered', error: 'command_failed' }) });
    expect(f.log).toEqual(['bury k-a 403 forbidden', 'bury k-b command_failed']);
    expect(s.dead).toBe(2);
  });

  it('an earlier submission that may have reached the control plane: the ledger decides', async () => {
    const seen: Array<[string, boolean]> = [];
    const resubmit = async (r: ParkedRow, o: { priorUnknown: boolean }): Promise<Resubmitted> => { seen.push([r.key, o.priorUnknown]); return { kind: 'answered', outcome: 'applied' }; };
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    const f = fakes(
      [row('k-none', { priorUnknown: true }), row('k-dead-claim', { priorUnknown: true }), row('k-live-claim', { priorUnknown: true })],
      { 'k-dead-claim': { status: 'running', claimedAt: stale }, 'k-live-claim': { status: 'running' } },
    );
    await drainParkedCommands({ ...f, host: () => 'web', resubmit });
    // No ledger row: nothing ran under the key, so it may run anywhere. A claim past its lease: still unknown.
    // A live claim: it is running there now; asked about again later, never sent alongside it.
    expect(seen).toEqual([['k-none', false], ['k-dead-claim', true]]);
    expect(f.log).toContain('retry k-live-claim');
  });

  it('a row that throws is retried, and does not stop the rest', async () => {
    const f = fakes([row('k-a'), row('k-b')]);
    const s = await drainParkedCommands({ ...f, host: () => 'web', resubmit: async (r) => { if (r.key === 'k-a') throw new Error('boom'); return { kind: 'answered', outcome: 'applied' }; } });
    expect(f.log).toEqual(['retry k-a', 'settle k-b applied']);
    expect(s).toMatchObject({ retried: 1, done: 1 });
  });

  it('backs off from a minute to a floor period', () => {
    expect(parkedRetryDelayMs(1)).toBe(60_000);
    expect(parkedRetryDelayMs(2)).toBe(120_000);
    expect(parkedRetryDelayMs(30)).toBe(60 * 60_000);
  });
});

describe('the answer\'s outcome', () => {
  it('reads the kernel\'s result wherever the op puts it', () => {
    expect(outcomeOf({ handled: true, result: { result: 'stale' } })).toBe('stale');
    expect(outcomeOf({ result: 'duplicate', reason: 'x' })).toBe('duplicate');
    expect(outcomeOf({ handled: false })).toBe('not_handled');
    expect(outcomeOf({ handled: true, result: null })).toBe('answered');
    expect(outcomeOf(null)).toBe('answered');
  });
});

describe('on the control plane', () => {
  it('applies the row through the same reach check and ledger as a request, and reads its answer', async () => {
    const env = { EXECUTION_MODE: 'own', KERNEL_COMMAND_SECRET: 'k1:s' };
    const ran: string[] = [];
    const ledger = {
      claim: async () => true, renew: async () => true, complete: async () => true, release: async () => {}, read: async () => null, prune: async () => 0,
    } as unknown as CommandLedger;
    const r = row('attempt_ended:k-cp-1', { input: { workspaceId: WS, task: { id: 't', workspaceId: WS } } });
    const ok = await resubmitOnControlPlane(r, {
      env, host: () => 'control-plane', ledger, reaches: async () => true, every: () => () => {},
      run: (async (op: string) => { ran.push(op); return { handled: true, result: { result: 'applied' } }; }) as never, deliveryAfter: async () => null,
    });
    expect(ok).toEqual({ kind: 'answered', outcome: 'applied' });
    expect(ran).toEqual(['attempt_ended']);

    // The principal no longer reaches the workspace: refused, never run.
    const refused = await resubmitOnControlPlane(r, { env, host: () => 'control-plane', ledger, reaches: async () => false, run: (async () => { throw new Error('ran'); }) as never });
    expect(refused.kind).toBe('refused');
    // A malformed row (the web host wrote it, not a signed request): refused before anything.
    expect((await resubmitOnControlPlane(row('k-bad-1', { input: {} }), { env, host: () => 'control-plane' })).kind).toBe('refused');
    // Not the host in this mode (rolled back to shadow): asked again later.
    expect((await resubmitOnControlPlane(r, { env: { ...env, EXECUTION_MODE: 'shadow' }, host: () => 'control-plane' })).kind).toBe('unanswered');
  });
});
