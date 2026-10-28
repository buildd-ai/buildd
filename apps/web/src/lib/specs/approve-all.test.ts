import { describe, expect, it } from 'bun:test';
import { approveAll, approveAllSummary, type ApproveAllItem, type ConfirmReply } from './approve-all';

// Review all's Approve all (spec b7fc9316 R-24 to R-26, AC-25, AC-26): one
// signed request per revision, each confirmed on its own; a stale one is
// named, the rest still approved.

const item = (n: number, title: string): ApproveAllItem => ({ specId: `spec-${n}`, title, revision: n + 1, request: `token-${n}` });
const ITEMS = [item(1, 'Checkout'), item(2, 'Refunds'), item(3, 'Receipts'), item(4, 'Totals')];

describe('Approve all', () => {
  it('confirms each revision under its own request, one call per revision (AC-25)', async () => {
    const calls: ApproveAllItem[] = [];
    const r = await approveAll(ITEMS, async (i) => { calls.push(i); return { status: 200, body: {} }; });
    expect(calls).toEqual(ITEMS);
    expect(new Set(calls.map((c) => c.request)).size).toBe(4);
    expect(r).toMatchObject({ approved: 4, stale: 0, other: 0 });
  });

  it('one stale request: the other three are approved and the stale one is named with its new head (AC-26)', async () => {
    const r = await approveAll(ITEMS, async (i): Promise<ConfirmReply> => (i.specId === 'spec-2'
      ? { status: 409, body: { code: 'request_stale', error: 'The spec changed since this approval was asked for.', currentVersion: 9, headRevision: 4 } }
      : { status: 200, body: {} }));
    expect(r.approved).toBe(3);
    expect(r.stale).toBe(1);
    expect(r.outcomes.filter((o) => o.outcome === 'approved').map((o) => o.item.title)).toEqual(['Checkout', 'Receipts', 'Totals']);
    expect(r.outcomes.find((o) => o.outcome === 'stale')).toMatchObject({ item: { title: 'Refunds' }, headRevision: 4 });
    expect(approveAllSummary(r)).toBe('3 approved, 1 stale. Refunds changed since this page loaded (now at revision 4): read it again before approving.');
  });

  it('a gate refusal is not approved: it needs its own override reason; a passkey team needs the passkey', async () => {
    const r = await approveAll(ITEMS.slice(0, 3), async (i): Promise<ConfirmReply> => (
      i.specId === 'spec-1' ? { status: 409, body: { code: 'gate_refused', error: 'refused' } }
        : i.specId === 'spec-2' ? { status: 403, body: { code: 'presence_required', error: 'passkey' } }
          : { status: 200, body: {} }));
    expect(r.outcomes.map((o) => o.outcome)).toEqual(['needs_reason', 'needs_passkey', 'approved']);
    expect(r).toMatchObject({ approved: 1, stale: 0, other: 2 });
    expect(approveAllSummary(r)).toContain('Checkout needs an override reason');
    expect(approveAllSummary(r)).toContain('Refunds needs your passkey');
  });

  it('a request that throws (network) is reported and does not stop the rest', async () => {
    const r = await approveAll(ITEMS.slice(0, 2), async (i) => { if (i.specId === 'spec-1') throw new Error('offline'); return { status: 200, body: {} }; });
    expect(r.outcomes.map((o) => o.outcome)).toEqual(['failed', 'approved']);
    expect(approveAllSummary(r)).toContain('Checkout could not be approved: offline');
  });

  it('an already-approved revision reads as approved, not stale', async () => {
    const r = await approveAll(ITEMS.slice(0, 1), async () => ({ status: 200, body: { already: true } }));
    expect(r).toMatchObject({ approved: 1, stale: 0 });
  });
});
