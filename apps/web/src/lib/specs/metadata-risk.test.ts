import { beforeEach, describe, expect, it, mock } from 'bun:test';

// `risk: high` (Living Spec b7fc9316 R-32): only a person sets or clears it,
// through the one metadata write path.
const SPEC = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
let specRow: any;
let executed = 0;

mock.module('@buildd/core/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([specRow]) }) }) }),
    execute: () => { executed++; specRow = { ...specRow, metadata: { risk: 'high' } }; return Promise.resolve({ rows: [{ id: 'change-1' }] }); },
  },
}));
mock.module('./store', () => ({
  fail: (status: number, error: string) => ({ ok: false, status, error }),
  reach: () => Promise.resolve(true),
  author: (c: any) => (c.kind === 'user' ? { authorKind: 'user', label: `user:${c.userId}` } : { authorKind: 'agent', label: `account:${c.account.id}` }),
}));
mock.module('./approval', () => ({ specApprovalDeps: { afterResponse: () => {} } }));
mock.module('./areas', () => ({ AREA_GONE_STATUSES: ['retired', 'superseded'] }));
mock.module('@/lib/team-access', () => ({ holdsInWorkspace: async () => true }));

const { updateSpecMetadata } = await import('./metadata');
const person = { kind: 'user' as const, userId: 'u1' };
const agent = { kind: 'account' as const, account: { id: 'acct-1' } as any };

beforeEach(() => {
  specRow = { id: SPEC, workspaceId: WS, scope: 'feature', metadata: {}, approvedRevision: null };
  executed = 0;
});

describe('risk: high is a person\'s flag', () => {
  it('a person sets it', async () => {
    expect((await updateSpecMetadata(person, SPEC, { changes: { risk: 'high' }, reason: 'Touches who may approve' })).ok).toBe(true);
    expect(executed).toBe(1);
  });
  it('an agent run, API key or platform write is refused, and nothing is written', async () => {
    for (const caller of [agent, { kind: 'system' as const, label: 'x' }]) {
      expect(await updateSpecMetadata(caller, SPEC, { changes: { risk: 'high' }, reason: 'agent tries to flag it' })).toMatchObject({ ok: false, status: 403 });
    }
    expect(executed).toBe(0);
  });
  it('takes only high, or null / normal to clear', async () => {
    expect(await updateSpecMetadata(person, SPEC, { changes: { risk: 'severe' }, reason: 'not a level' })).toMatchObject({ ok: false, status: 400 });
  });
});
