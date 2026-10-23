import { beforeEach, describe, expect, it, mock } from 'bun:test';

// The standard mark (Living Specs D-43) through the one metadata write path:
// only an owner or admin from their own session sets or clears it.
const SPEC = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
let specRow: any;
let executed = 0;
let ownerOrAdmin = true;

mock.module('@buildd/core/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([specRow]) }) }) }),
    execute: () => {
      executed++;
      specRow = { ...specRow, metadata: { standard: true } };
      return Promise.resolve({ rows: [{ id: 'change-1' }] });
    },
  },
}));
mock.module('./store', () => ({
  fail: (status: number, error: string) => ({ ok: false, status, error }),
  reach: () => Promise.resolve(true),
  author: (c: any) => (c.kind === 'user' ? { authorKind: 'user', label: `user:${c.userId}` } : { authorKind: 'agent', label: `account:${c.account.id}` }),
}));
mock.module('./approval', () => ({ specApprovalDeps: { afterResponse: () => {} } }));
mock.module('./areas', () => ({ AREA_GONE_STATUSES: ['retired', 'superseded'] }));
const holds = mock(async (_u: string, _w: string, _p: string) => ownerOrAdmin);
mock.module('@/lib/team-access', () => ({ holdsInWorkspace: holds }));

const { updateSpecMetadata } = await import('./metadata');
const person = { kind: 'user' as const, userId: 'u1' };
const agent = { kind: 'account' as const, account: { id: 'acct-1' } as any };

beforeEach(() => {
  specRow = { id: SPEC, workspaceId: WS, scope: 'feature', metadata: {}, approvedRevision: null };
  executed = 0;
  ownerOrAdmin = true;
  holds.mockClear();
});

describe('standard: true is a person\'s mark', () => {
  it('an owner or admin from their own session marks a spec a standard', async () => {
    const r = await updateSpecMetadata(person, SPEC, { changes: { standard: true }, reason: 'Product voice applies to every change' });
    expect(r.ok).toBe(true);
    expect(executed).toBe(1);
    expect(holds).toHaveBeenCalledWith('u1', WS, 'approve_specs');
  });

  it('a member who is not an owner or admin is refused, and nothing is written', async () => {
    ownerOrAdmin = false;
    const r = await updateSpecMetadata(person, SPEC, { changes: { standard: true }, reason: 'wants it everywhere' });
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(executed).toBe(0);
  });

  it('an agent run or API key is refused, setting or clearing', async () => {
    for (const standard of [true, false]) {
      const r = await updateSpecMetadata(agent, SPEC, { changes: { standard }, reason: 'agent tries to mark it' });
      expect(r).toMatchObject({ ok: false, status: 403 });
    }
    expect(executed).toBe(0);
    expect(holds).not.toHaveBeenCalled();
  });

  it('a platform write cannot set it either', async () => {
    const r = await updateSpecMetadata({ kind: 'system', label: 'import' }, SPEC, { changes: { standard: true }, reason: 'import sets it' });
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it('takes only true or false', async () => {
    const r = await updateSpecMetadata(person, SPEC, { changes: { standard: 'yes' }, reason: 'a string is not a mark' });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('other fields stay open to an agent: the rule is the mark\'s alone', async () => {
    const r = await updateSpecMetadata(agent, SPEC, { changes: { last_verified: '2026-10-22' }, reason: 'verified today' });
    expect(r.ok).toBe(true);
  });
});
