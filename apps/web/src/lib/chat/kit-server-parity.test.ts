/**
 * buildd's approval primitives (approvals.ts) and the kit's
 * (`@builddai/ai-kit/chat/server`, which `createChatTurn` uses) must agree
 * while both exist (P6 moves buildd's turn onto the kit):
 *  - the same input hash, so an approval row written by one verifies in the other;
 *  - the same approval-request rows from a message;
 *  - the same reconcile outcome for every answer shape.
 */
import { describe, expect, it, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));

const buildd = await import('./approvals');
const kit = await import('@builddai/ai-kit/chat/server');
const { encodeApprovalPreview } = await import('@buildd/shared');

const input = { action: 'create', title: 'Bill in local currency', goalCriteria: [{ type: 'description', description: 'x' }], extra: undefined };
const preview = {
  v: 1 as const, verb: 'Delete workspace', target: { kind: 'workspace', id: 'w', label: 'billing' },
  changes: [{ label: 'Workspace', before: 'billing', after: null }], confirmText: 'billing', fingerprint: 'fp',
};
const requested = (over: Record<string, unknown> = {}) => ({
  type: 'tool-manage_missions', toolCallId: 'call-1', state: 'approval-requested', input, approval: { id: 'appr-1' }, ...over,
});
const responded = (approved: boolean, over: Record<string, unknown> = {}) => ({
  ...requested(), state: 'approval-responded', approval: { id: 'appr-1', approved }, ...over,
});

async function both(stored: any[], incoming: any[], wins = true) {
  const decide = async () => wins;
  const a = await buildd.reconcileApprovals(stored, incoming, decide);
  const b = await kit.reconcileApprovals(stored, incoming, decide);
  return { a, b };
}

describe('buildd ↔ kit approval parity', () => {
  it('hashes inputs identically (sha256 of the same canonical JSON)', async () => {
    for (const v of [input, { b: 1, a: [2, { d: null, c: 'x' }] }, null, 'x', []]) {
      expect(kit.canonicalJson(v)).toBe(buildd.canonicalJson(v));
      expect(await kit.hashToolInput(v)).toBe(buildd.hashToolInput(v));
    }
  });

  it('reads the same approval-request rows from a message', async () => {
    const parts = [requested(), { type: 'text', text: 'hi' }, requested({ toolCallId: 'call-2', approval: { id: 'appr-2' }, input: { a: 1 } })];
    expect(await kit.approvalRequestsIn(parts as never)).toEqual(buildd.approvalRequestsIn(parts as never));
  });

  const cases: Array<[string, any[], any[], boolean?]> = [
    ['approve', [requested()], [responded(true)]],
    ['deny', [requested()], [responded(false)]],
    ['edited input', [requested()], [responded(true, { input: { ...input, title: 'other' } })]],
    ['lost race', [requested()], [responded(true)], false],
    ['unknown approval id', [requested()], [responded(true, { approval: { id: 'nope', approved: true } })]],
    ['admin write, name missing', [requested({ approval: { id: 'appr-1', requestReason: encodeApprovalPreview(preview) } })], [responded(true)]],
    ['admin write, name typed', [requested({ approval: { id: 'appr-1', requestReason: encodeApprovalPreview(preview) } })], [responded(true, { approval: { id: 'appr-1', approved: true, reason: 'billing' } })]],
  ];
  for (const [name, stored, incoming, wins] of cases) {
    it(`reconciles identically: ${name}`, async () => {
      const { a, b } = await both(stored, incoming, wins ?? true);
      expect(b.decided).toBe(a.decided);
      expect([...b.authorizedToolCallIds]).toEqual([...a.authorizedToolCallIds]);
      expect([...b.approvedPreviews]).toEqual([...a.approvedPreviews]);
      expect(b.parts).toEqual(a.parts as never);
    });
  }
});
