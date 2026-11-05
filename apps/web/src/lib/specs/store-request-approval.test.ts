import { describe, expect, it, mock, beforeEach } from 'bun:test';

/**
 * The approvers are asked where the revision is written (b7fc9316 R-10), once,
 * and only when a person still has to approve it. The database is a fake that
 * answers every query with one plausible row; the seams under test are the
 * injected specStoreDeps.
 */
const row = {
  id: '00000000-0000-4000-8000-0000000000a2', workspaceId: '00000000-0000-4000-8000-0000000000a1', title: 'Card',
  revision: 2, currentRevision: 1, artifactRevision: 1, contentHash: 'h-old', version: 1, headRevision: 1,
  bodyArtifactId: '00000000-0000-4000-8000-0000000000a3', status: 'draft', scope: 'workspace', metadata: null, repoRefs: null,
};
const chain: any = new Proxy(function () {}, {
  get: (_t, k) => (k === 'execute' ? async () => ({ rows: [{ hash: 'h-new', id: 'rev-2' }] }) : k === 'then' ? (res: (v: unknown) => void) => res(k === 'then' ? [row] : []) : k === 'rows' ? [{ id: 'rev-2' }] : chain),
  apply: () => chain,
});
mock.module('@buildd/core/db', () => ({ db: chain }));

const { createSpecDraft, reviseSpecDraft, specStoreDeps } = await import('./store');

const user = { kind: 'user' as const, userId: 'u1' };
const WS = row.workspaceId;
const calls: Array<[string, number]> = [];
const original = { ...specStoreDeps };
let autoApproved = false;

beforeEach(() => {
  calls.length = 0;
  autoApproved = false;
  Object.assign(specStoreDeps, original, {
    afterRevisionInsert: async () => {},
    recordAuthored: async () => {},
    autoApprove: async () => ({ approved: autoApproved, reason: 'x' }),
    requestApproval: async (s: { title: string }, r: number) => { calls.push([s.title, r]); },
  });
});

describe('approval is requested when the revision is written', () => {
  it('createSpecDraft asks once for a draft a person must approve', async () => {
    const r = await createSpecDraft(user, { workspaceId: WS, title: 'Card', body: '- AC-1: Plain.\n  check: bun test' }, { duplicates: false } as any);
    expect(r).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it('createSpecDraft does not ask for an import or a metadata-carrying draft', async () => {
    const body = '- AC-1: Plain.\n  check: bun test';
    await createSpecDraft(user, { workspaceId: WS, title: 'Card', body }, { duplicates: false, metadata: { kind: 'x' } } as any);
    await createSpecDraft(user, { workspaceId: WS, title: 'Card', body }, { duplicates: false, imported: { path: 'docs/specs/a.md', importedAt: new Date().toISOString() } } as any);
    expect(calls).toEqual([]);
  });

  it('createSpecDraft still writes when the ask rejects', async () => {
    specStoreDeps.requestApproval = async () => { throw new Error('push down'); };
    const r = await createSpecDraft(user, { workspaceId: WS, title: 'Card', body: '- AC-1: Plain.\n  check: bun test' }, { duplicates: false } as any);
    expect(r).toMatchObject({ ok: true });
  });

  const revise = (opts: Record<string, unknown> = {}) =>
    reviseSpecDraft(user, row.id, { expectedVersion: 1, body: '- AC-1: Changed.\n  check: bun test' }, { duplicates: false, ...opts } as any);

  it('reviseSpecDraft asks when auto-approval does not approve', async () => {
    expect(await revise()).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it('reviseSpecDraft does not ask when auto-approval approves, is off, or the write is an import', async () => {
    autoApproved = true;
    await revise();
    autoApproved = false;
    await revise({ autoApprove: false });
    await revise({ imported: { path: 'docs/specs/a.md', importedAt: new Date().toISOString() } });
    expect(calls).toEqual([]);
  });

  it('reviseSpecDraft still writes when the ask rejects', async () => {
    specStoreDeps.requestApproval = async () => { throw new Error('push down'); };
    expect(await revise()).toMatchObject({ ok: true });
  });
});
