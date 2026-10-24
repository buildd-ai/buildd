/**
 * Acceptance tests for Living Specs "writing and approving a spec" revision 3,
 * "Retiring a spec" R-76 and R-77. These pin the decisions in the seams:
 *
 *   parseReplaces(raw, supersedes?)     -> string[] | null | undefined | { error }
 *   replacesRefusal(workspaceId, ids, selfId?) -> Promise<string | null>
 *   parseRetireChoice(raw, replaces)    -> RetireChoice | { error }
 *   signSpecApprovalRequest({..., retire}) carries the choice into the link
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
    const { parseReplaces } = await import('../../src/lib/specs/replaces');
    expect(parseReplaces(undefined, B)).toEqual([B]);
    expect(parseReplaces([A, A, C], B)).toEqual([A, C, B]);
    for (const bad of ['not a list', [A, 'checkout'], [1]]) {
      expect(parseReplaces(bad, B)).toMatchObject({ error: expect.any(String) });
    }
    expect(parseReplaces(undefined)).toBeUndefined();
    expect(parseReplaces(null)).toBeNull();
    expect(parseReplaces([])).toBeNull();
  });
});

describe('R-77 and AC-122: approving a replacement offers to retire what it replaces', () => {
  it('AC-122: parseRetireChoice validates the retire list against the specs the revision replaces', async () => {
    const { parseRetireChoice } = await import('../../src/lib/specs/replaces');
    expect(parseRetireChoice([A], [A])).toEqual([{ specId: A }]);
    expect(parseRetireChoice([], [A])).toEqual([]);
    expect(parseRetireChoice([A, C], [A, C])).toEqual([{ specId: A }, { specId: C }]);
    expect(parseRetireChoice([{ specId: A, expectedVersion: 3 }], [A])).toEqual([{ specId: A, expectedVersion: 3 }]);
    // A spec the revision does not replace is rejected
    expect(parseRetireChoice([B], [A])).toMatchObject({ error: expect.any(String) });
    // A bad id or a bad version is rejected
    expect(parseRetireChoice(['x'], [A])).toMatchObject({ error: expect.any(String) });
    expect(parseRetireChoice([{ specId: A, expectedVersion: 'v' }], [A])).toMatchObject({ error: expect.any(String) });
  });

  it('R-77: the confirmation link carries the retire choice with versions read', async () => {
    const { signSpecApprovalRequest, verifySpecApprovalRequest } = await import('../../src/lib/specs/approval-request');
    const token = signSpecApprovalRequest({
      specId: B, workspaceId: WS, revision: 3, expectedVersion: 5, contentHash: 'a'.repeat(64), requestedBy: 'u1',
      retire: [{ specId: A, expectedVersion: 2 }],
    });
    const v = verifySpecApprovalRequest(token);
    expect(v.ok && v.payload.retire).toEqual([{ specId: A, expectedVersion: 2 }]);
    // The choice is part of what is signed and is checked: a list that is not spec ids is a malformed request.
    const bad = signSpecApprovalRequest({
      specId: B, workspaceId: WS, revision: 3, expectedVersion: 5, contentHash: 'a'.repeat(64), requestedBy: 'u1',
      retire: [42 as never],
    });
    expect(verifySpecApprovalRequest(bad)).toEqual({ ok: false, reason: 'malformed' });
  });
});
