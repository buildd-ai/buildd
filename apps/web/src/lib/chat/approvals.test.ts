import { describe, it, expect, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));

const { reconcileApprovals, hashToolInput, canonicalJson, approvalRequestsIn } = await import('./approvals');
const { encodeApprovalPreview } = await import('@buildd/shared');

const input = { action: 'create', title: 'Bill in local currency', goalCriteria: [{ type: 'description', description: 'x' }] };

function requested(over: Record<string, unknown> = {}) {
  return {
    type: 'tool-manage_missions', toolCallId: 'call-1', state: 'approval-requested', input,
    approval: { id: 'appr-1' }, ...over,
  };
}
function responded(approved: boolean, over: Record<string, unknown> = {}) {
  return { ...requested(), state: 'approval-responded', approval: { id: 'appr-1', approved }, ...over };
}

/** In-memory stand-in for the atomic UPDATE … WHERE status='pending'. */
function fakeStore() {
  const rows = new Map([['appr-1', { status: 'pending', inputHash: hashToolInput(input) }]]);
  const decide = mock(async ({ approvalId, inputHash, approved }: any) => {
    const r = rows.get(approvalId);
    if (!r || r.status !== 'pending' || r.inputHash !== inputHash) return false;
    r.status = approved ? 'approved' : 'denied';
    return true;
  });
  return { rows, decide };
}

describe('canonicalJson / hashToolInput', () => {
  it('ignores key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(hashToolInput({ b: 1, a: 2 })).toBe(hashToolInput({ a: 2, b: 1 }));
    expect(hashToolInput({ a: 1 })).not.toBe(hashToolInput({ a: 2 }));
  });
});

describe('approvalRequestsIn', () => {
  it('finds exactly the pending approval cards', () => {
    const rows = approvalRequestsIn([
      { type: 'text', text: 'Here is the draft.' },
      requested(),
      { type: 'tool-list_tasks', toolCallId: 'c0', state: 'output-available', input: {}, output: {} },
    ]);
    expect(rows).toEqual([{ approvalId: 'appr-1', toolCallId: 'call-1', toolName: 'manage_missions', inputHash: hashToolInput(input) }]);
  });
});

describe('reconcileApprovals', () => {
  it('confirming authorizes exactly that tool call once', async () => {
    const { decide } = fakeStore();
    const r = await reconcileApprovals([requested()], [responded(true)], decide);
    expect([...r.authorizedToolCallIds]).toEqual(['call-1']);
    expect(r.decided).toBe(1);
    expect((r.parts[0] as any).state).toBe('approval-responded');
    expect((r.parts[0] as any).approval.approved).toBe(true);
  });

  it('replaying the same approval id authorizes nothing', async () => {
    const { decide } = fakeStore();
    await reconcileApprovals([requested()], [responded(true)], decide);
    const replay = await reconcileApprovals([requested()], [responded(true)], decide);
    expect(replay.authorizedToolCallIds.size).toBe(0);
    expect(replay.decided).toBe(0);
    expect((replay.parts[0] as any).state).toBe('approval-requested');
  });

  it('two concurrent confirmations: exactly one wins', async () => {
    const { decide } = fakeStore();
    const [a, b] = await Promise.all([
      reconcileApprovals([requested()], [responded(true)], decide),
      reconcileApprovals([requested()], [responded(true)], decide),
    ]);
    expect(a.authorizedToolCallIds.size + b.authorizedToolCallIds.size).toBe(1);
  });

  it('denying authorizes nothing and records the denial', async () => {
    const { decide, rows } = fakeStore();
    const r = await reconcileApprovals([requested()], [responded(false)], decide);
    expect(r.authorizedToolCallIds.size).toBe(0);
    expect(r.decided).toBe(1);
    expect(rows.get('appr-1')!.status).toBe('denied');
    expect((r.parts[0] as any).approval.approved).toBe(false);
  });

  it('an edited input decides nothing', async () => {
    const { decide, rows } = fakeStore();
    const r = await reconcileApprovals(
      [requested()],
      [responded(true, { input: { ...input, title: 'Something else entirely' } })],
      decide,
    );
    expect(r.authorizedToolCallIds.size).toBe(0);
    expect(decide).not.toHaveBeenCalled();
    expect(rows.get('appr-1')!.status).toBe('pending');
  });

  it('an answer for a part that is no longer pending in storage is ignored', async () => {
    const { decide } = fakeStore();
    const done = { ...requested(), state: 'output-available', output: { data: 'ok', objects: [] } };
    const r = await reconcileApprovals([done], [responded(true)], decide);
    expect(decide).not.toHaveBeenCalled();
    expect(r.parts[0]).toEqual(done);
  });

  it('an approval id attached to a different tool call is ignored', async () => {
    const { decide } = fakeStore();
    const r = await reconcileApprovals([requested()], [responded(true, { toolCallId: 'call-other' })], decide);
    expect(decide).not.toHaveBeenCalled();
    expect(r.authorizedToolCallIds.size).toBe(0);
  });
});

describe('stored previews: typed confirmation and what execution checks against', () => {
  const preview = (confirmText?: string) => encodeApprovalPreview({
    v: 1, verb: 'Delete mission', target: { kind: 'mission', id: 'm-1', label: 'Multi-currency checkout' },
    changes: [], fingerprint: 'fp-1', ...(confirmText ? { confirmText } : {}),
  });
  const storedWith = (reason: string) => requested({ approval: { id: 'appr-1', requestReason: reason } });

  it('an admin card decides nothing until the target\'s name is typed exactly', async () => {
    const { decide } = fakeStore();
    const stored = [storedWith(preview('Multi-currency checkout'))];
    const none = await reconcileApprovals(stored, [responded(true)], decide);
    const wrong = await reconcileApprovals(stored, [responded(true, { approval: { id: 'appr-1', approved: true, reason: 'multi-currency' } })], decide);
    expect(none.decided + wrong.decided).toBe(0);
    expect(decide).not.toHaveBeenCalled();
    const right = await reconcileApprovals(stored, [responded(true, { approval: { id: 'appr-1', approved: true, reason: 'Multi-currency checkout' } })], decide);
    expect(right.authorizedToolCallIds.has('call-1')).toBe(true);
  });

  it('denying an admin card needs no typing', async () => {
    const { decide } = fakeStore();
    const r = await reconcileApprovals([storedWith(preview('Multi-currency checkout'))], [responded(false)], decide);
    expect(r.decided).toBe(1);
    expect(r.authorizedToolCallIds.size).toBe(0);
  });

  it('the preview execution checks is the STORED one, never the client\'s copy', async () => {
    const { decide } = fakeStore();
    const forged = encodeApprovalPreview({ v: 1, verb: 'x', target: { kind: 'mission', id: 'other', label: 'x' }, changes: [], fingerprint: 'forged' });
    const r = await reconcileApprovals(
      [storedWith(preview())],
      [responded(true, { approval: { id: 'appr-1', approved: true, requestReason: forged } })],
      decide,
    );
    expect(r.approvedPreviews.get('call-1')?.fingerprint).toBe('fp-1');
  });
});
