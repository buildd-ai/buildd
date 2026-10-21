import { describe, it, expect, mock } from 'bun:test';
import { checkForeignClose, closesForeignPr, foreignCloseComment } from './pr-close-guard';

const ACCOUNT = { id: 'account-1' };
const worker = (o: Record<string, unknown> = {}) => ({
  accountId: 'account-1', taskId: 'task-sweep', prNumber: null as number | null,
  task: { id: 'task-sweep', context: { prReach: { prNumbers: [7], grantedBy: 'system:mission-invariants', grantedAt: 'x' } } },
  ...o,
});

describe('closesForeignPr', () => {
  it('is a foreign close when an agent run closes a PR its own worker did not open', () => {
    expect(closesForeignPr(ACCOUNT, worker(), 7)).toBe(true);
  });

  it('is not foreign for the worker that opened the PR', () => {
    expect(closesForeignPr(ACCOUNT, worker({ prNumber: 7 }), 7)).toBe(false);
  });

  it('is not foreign for a retry bound to the PR', () => {
    expect(closesForeignPr(ACCOUNT, worker({ task: { id: 't', conflictRetryPrNumber: 7 } }), 7)).toBe(false);
  });

  it('leaves a person alone: a session user or a teammate on another account', () => {
    expect(closesForeignPr({ ...ACCOUNT, sessionUserId: 'user-1' }, worker(), 7)).toBe(false);
    expect(closesForeignPr({ id: 'person-1' }, worker(), 7)).toBe(false);
  });
});

describe('checkForeignClose', () => {
  const deps = (o: Partial<Parameters<typeof checkForeignClose>[1]> = {}) => ({
    deliveryOf: mock(async () => ({ state: 'AWAITING_REVIEW', needsPerson: false })),
    successorMerged: mock(async () => true),
    ...o,
  });

  it.each([
    ['ESCALATED', { state: 'ESCALATED', needsPerson: true }],
    ['ESCALATED (needsPerson unread)', { state: 'ESCALATED', needsPerson: false }],
    ['approved, waiting on a person to merge', { state: 'APPROVED', needsPerson: true }],
  ])('refuses a PR that waits on a person (%s), whatever reason and successor it names', async (_l, delivery) => {
    const d = deps({ deliveryOf: mock(async () => delivery) });
    const v = await checkForeignClose({ prNumber: 7, reason: 'outpaced by base', supersedingPrNumber: 9 }, d);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reasonCode).toBe('pr_awaiting_person');
    expect(v.status).toBe(409);
    expect(v.hint).toContain('ask_human');
    expect(d.successorMerged).not.toHaveBeenCalled();
  });

  it('fails closed when the delivery cannot be read', async () => {
    const v = await checkForeignClose({ prNumber: 7, reason: 'r', supersedingPrNumber: 9 }, deps({ deliveryOf: mock(async () => { throw new Error('db down'); }) }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reasonCode).toBe('pr_state_unreadable');
  });

  it.each([undefined, '', '   ', 42])('requires a reason (%p)', async (reason) => {
    const v = await checkForeignClose({ prNumber: 7, reason, supersedingPrNumber: 9 }, deps());
    expect(v.ok).toBe(false);
    if (!v.ok) { expect(v.reasonCode).toBe('close_reason_required'); expect(v.status).toBe(400); }
  });

  it('requires a successor: an agent cannot record an abandonment, and a bare close reads as closed for an unknown cause', async () => {
    const v = await checkForeignClose({ prNumber: 7, reason: 'stale', supersedingPrNumber: undefined }, deps());
    expect(v.ok).toBe(false);
    if (!v.ok) { expect(v.reasonCode).toBe('close_successor_required'); expect(v.hint).toContain('ask_human'); }
  });

  it('refuses a successor that is the PR itself', async () => {
    const v = await checkForeignClose({ prNumber: 7, reason: 'dup', supersedingPrNumber: 7 }, deps());
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reasonCode).toBe('close_successor_required');
  });

  it('refuses a successor that has not merged', async () => {
    const v = await checkForeignClose({ prNumber: 7, reason: 'dup', supersedingPrNumber: 9 }, deps({ successorMerged: mock(async () => false) }));
    expect(v.ok).toBe(false);
    if (!v.ok) { expect(v.reasonCode).toBe('successor_not_merged'); expect(v.status).toBe(409); }
  });

  it('allows a reasoned close naming a merged successor, trimming the reason', async () => {
    const d = deps();
    const v = await checkForeignClose({ prNumber: 7, reason: '  landed in #9  ', supersedingPrNumber: 9 }, d);
    expect(v).toEqual({ ok: true, reason: 'landed in #9', supersedingPrNumber: 9 });
    expect(d.successorMerged).toHaveBeenCalledWith(9);
  });

  it('allows a PR with no delivery on record', async () => {
    const v = await checkForeignClose({ prNumber: 7, reason: 'dup', supersedingPrNumber: 9 }, deps({ deliveryOf: mock(async () => null) }));
    expect(v.ok).toBe(true);
  });
});

describe('foreignCloseComment', () => {
  it('names the closing task by short id, the reason and the successor', () => {
    // Built at run time so this file carries no UUID literal itself.
    const closerTaskId = ['0a1b2c3d', '4e5f', '4a6b', '8c7d', '9e0f1a2b3c4d'].join('-');
    const c = foreignCloseComment({ closerTaskId, reason: 'landed elsewhere', supersedingPrNumber: 9 });
    expect(c).toContain('`0a1b2c3d`');
    expect(c).not.toContain(closerTaskId);
    expect(c).toContain('landed elsewhere');
    expect(c).toContain('#9');
  });
});
