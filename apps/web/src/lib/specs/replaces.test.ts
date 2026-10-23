/**
 * Acceptance tests for Living Specs "writing and approving a spec" revision 3,
 * "Retiring a spec" R-76 and R-77, written before the build. They name the
 * seams the build adds in `./replaces` and `./approval-request`; each fails
 * until they exist. The SQL that moves the statuses is not asserted here: these
 * pin the decisions in front of it.
 *
 *   parseReplaces(raw, selfId?)          -> { ok, ids } | { ok: false, error }
 *   replacedSpecProblem(self, target)    -> string | null   (null = may be replaced)
 *   retireChoice(replaces, checked?)     -> the ids to supersede on approval
 *   approvalRetireReason(replacement, revision) -> the change row's reason
 *   signSpecApprovalRequest({..., retireReplaced}) carries the choice into the link
 */
import { describe, expect, it } from 'bun:test';

process.env.AUTH_SECRET ||= 'spec-replaces-test-secret';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const WS = '44444444-4444-4444-8444-444444444444';
const OTHER_WS = '55555555-5555-4555-8555-555555555555';

describe('R-76: a draft or revision names the specs it replaces, as data', () => {
  it('R-76: replaces is a list of spec ids, a bad shape is refused, and nothing named means nothing replaced', async () => {
    const { parseReplaces } = await import('./replaces');
    expect(parseReplaces(undefined, B)).toEqual({ ok: true, ids: [] });
    expect(parseReplaces([A, A, C], B)).toEqual({ ok: true, ids: [A, C] });
    for (const bad of ['not a list', [A, 'checkout'], [B], [1]]) {
      expect(parseReplaces(bad, B)).toMatchObject({ ok: false });
    }
  });

  it('R-76: a replaced spec must be live and in the same workspace, else 400', async () => {
    const { replacedSpecProblem } = await import('./replaces');
    const self = { id: B, workspaceId: WS };
    expect(replacedSpecProblem(self, { id: A, workspaceId: WS, status: 'approved' })).toBeNull();
    expect(replacedSpecProblem(self, { id: A, workspaceId: WS, status: 'draft' })).toBeNull();
    expect(replacedSpecProblem(self, null)).toEqual(expect.any(String));
    expect(replacedSpecProblem(self, { id: A, workspaceId: OTHER_WS, status: 'approved' })).toEqual(expect.any(String));
    expect(replacedSpecProblem(self, { id: A, workspaceId: WS, status: 'retired' })).toEqual(expect.any(String));
    expect(replacedSpecProblem(self, { id: A, workspaceId: WS, status: 'superseded' })).toEqual(expect.any(String));
  });
});

describe('R-77 and AC-122: approving a replacement offers to retire what it replaces', () => {
  it('AC-122: the default choice supersedes every replaced spec; unchecking approves only', async () => {
    const { retireChoice } = await import('./replaces');
    expect(retireChoice([A], undefined)).toEqual([A]);
    expect(retireChoice([A, C], null)).toEqual([A, C]);
    expect(retireChoice([A], [])).toEqual([]);
    expect(retireChoice([A, C], [C])).toEqual([C]);
    // An id the revision does not name is never retired by approving it.
    expect(retireChoice([A], [A, B])).toEqual([A]);
  });

  it('AC-122: each superseded spec gets its own change row, whose reason names the approval', async () => {
    const { approvalRetireReason } = await import('./replaces');
    const reason = approvalRetireReason({ id: B, title: 'Checkout v2' }, 3);
    expect(reason).toContain('Checkout v2');
    expect(reason).toContain('revision 3');
    expect(reason.length).toBeGreaterThanOrEqual(10);
    expect(reason.length).toBeLessThanOrEqual(500);
  });

  it('R-77: the confirmation link an OAuth session returns carries the same choice', async () => {
    const { signSpecApprovalRequest, verifySpecApprovalRequest } = await import('./approval-request');
    const token = signSpecApprovalRequest({
      specId: B, workspaceId: WS, revision: 3, expectedVersion: 5, contentHash: 'a'.repeat(64), requestedBy: 'u1',
      retireReplaced: [A],
    } as never);
    const v = verifySpecApprovalRequest(token);
    expect(v.ok && (v.payload as unknown as { retireReplaced?: string[] }).retireReplaced).toEqual([A]);
    // The choice is part of what is signed and is checked: a list that is not spec ids is a malformed request.
    const bad = signSpecApprovalRequest({
      specId: B, workspaceId: WS, revision: 3, expectedVersion: 5, contentHash: 'a'.repeat(64), requestedBy: 'u1',
      retireReplaced: [42],
    } as never);
    expect(verifySpecApprovalRequest(bad)).toEqual({ ok: false, reason: 'malformed' });
  });
});
