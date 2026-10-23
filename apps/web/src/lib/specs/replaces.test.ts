/**
 * The pure halves of "a draft names the specs it replaces" (R-76) and the
 * retire choice an approval carries (R-77): what a request may send, before
 * any spec is read. The database rules (live, same workspace, the approval
 * superseding each) are real-Postgres tested in tests/db/spec-replaces.test.ts.
 * The signed link carrying the choice is pinned here too: it needs no row.
 */
import { describe, expect, it } from 'bun:test';

process.env.AUTH_SECRET ||= 'replaces-unit-test-secret';
const { parseReplaces, parseRetireChoice, MAX_REPLACES } = await import('./replaces');
const { signSpecApprovalRequest, verifySpecApprovalRequest } = await import('./approval-request');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('parseReplaces', () => {
  it('absent is undefined (revise keeps the head\'s); null or [] clears', () => {
    expect(parseReplaces(undefined)).toBeUndefined();
    expect(parseReplaces(null)).toBeNull();
    expect(parseReplaces([])).toBeNull();
  });
  it('ids, de-duplicated and lower-cased, in order', () => {
    expect(parseReplaces([B, A, B.toUpperCase()])).toEqual([B, A]);
  });
  it('supersedes (create_draft) is written to the same field', () => {
    expect(parseReplaces(undefined, A)).toEqual([A]);
    expect(parseReplaces([B], A)).toEqual([B, A]);
    expect(parseReplaces([A], A)).toEqual([A]);
  });
  it('anything but a list of spec ids is an error, and so is too many', () => {
    for (const bad of ['x', A, [1], ['not-a-uuid'], [{ id: A }]]) expect(parseReplaces(bad)).toHaveProperty('error');
    const many = Array.from({ length: MAX_REPLACES + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(parseReplaces(many)).toHaveProperty('error');
  });
});

describe('parseRetireChoice', () => {
  it('ids or { specId, expectedVersion }, among the specs the revision replaces', () => {
    expect(parseRetireChoice([A, { specId: B, expectedVersion: 3 }], [A, B])).toEqual([{ specId: A }, { specId: B, expectedVersion: 3 }]);
    expect(parseRetireChoice([], [A])).toEqual([]);
  });
  it('a spec the revision does not replace, a bad id or a bad version is an error', () => {
    expect(parseRetireChoice([B], [A])).toHaveProperty('error');
    expect(parseRetireChoice(['x'], [A])).toHaveProperty('error');
    expect(parseRetireChoice([{ specId: A, expectedVersion: 'v' }], [A])).toHaveProperty('error');
    expect(parseRetireChoice(A, [A])).toHaveProperty('error');
  });
});

describe('the confirmation link carries the choice (R-77)', () => {
  const base = { specId: A, workspaceId: B, revision: 2, expectedVersion: 5, contentHash: 'h', requestedBy: 'u' };
  it('signs and verifies the retire choice with the versions read', () => {
    const token = signSpecApprovalRequest({ ...base, retire: [{ specId: B, expectedVersion: 4 }] })!;
    const v = verifySpecApprovalRequest(token);
    expect(v.ok && v.payload.retire).toEqual([{ specId: B, expectedVersion: 4 }]);
  });
  it('an empty choice (approve only) survives as []; a link made before the choice reads as absent', () => {
    const none = verifySpecApprovalRequest(signSpecApprovalRequest({ ...base, retire: [] })!);
    expect(none.ok && none.payload.retire).toEqual([]);
    const old = verifySpecApprovalRequest(signSpecApprovalRequest(base)!);
    expect(old.ok && old.payload.retire).toBeUndefined();
  });
});
