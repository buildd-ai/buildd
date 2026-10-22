import { describe, expect, it, mock } from 'bun:test';

/**
 * The pin boundary for registered `verify:` declarations: a revision stored
 * before they were checked on write (./store.ts) is never pinned, by a task or
 * by a mission's outcome selection (both go through pinSpecSource).
 */

const SPEC = '00000000-0000-4000-8000-0000000000a1';
const REV = '00000000-0000-4000-8000-0000000000a2';
const WS = '00000000-0000-4000-8000-0000000000a3';
const HASH = 'h'.repeat(64);
const STATE = JSON.stringify({ id: 'ui.actions_match_state', version: 1, profile: 'buildd.enterprise@1', mode: 'required' });

let reads: unknown[][];
let body: string;
const chain: any = { from: () => chain, innerJoin: () => chain, leftJoin: () => chain, where: () => chain, limit: async () => reads.shift() ?? [] };
mock.module('@buildd/core/db', () => ({ db: { select: () => chain } }));
mock.module('@/lib/artifact-revisions', () => ({
  getArtifactRevision: async () => ({ content: body, contentHash: HASH }),
  getArtifactRevisions: async () => new Map(),
}));
mock.module('./criteria', () => ({ pinCriterionHashes: async () => undefined }));

const { pinSpecSource } = await import('./pin');

const rev = { id: REV, specId: SPEC, revision: 3, contentHash: HASH, approvedAt: new Date(), artifactRevision: 1, design: null };
/** The spec, its approved revision, then that revision's body, as pinSpecSource reads them. */
const pin = (b: string) => {
  body = b;
  reads = [[{ id: SPEC, workspaceId: WS, approvedRevision: 3, headRevision: 3 }], [rev], [{ rev, title: 'Card', bodyArtifactId: 'art' }]];
  return pinSpecSource(WS, { specSource: { specId: SPEC } });
};

describe('pinning a revision with verification declarations', () => {
  it('R-3: a stored revision whose verify cannot be read, or names no captures, is refused', async () => {
    for (const b of [`- AC-1: Card.\n  verify: ${STATE}`, '- AC-1: Card.\n  verify: {"id":"ui.gone"}\n  scenarios: closed-pr@mobile']) {
      const r = await pin(b);
      expect(r).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('Revision 3 has an invalid verification declaration (AC-1') });
    }
  });

  it('a declared revision, and a revision with no verify at all, pin as before', async () => {
    for (const b of [`- AC-1: Card.\n  verify: ${STATE}\n  scenarios: closed-pr@mobile`, '- AC-1: Card.\n  check: bun test']) {
      const r = await pin(b);
      expect(r).toMatchObject({ ok: true, context: { specSource: { specId: SPEC, specRevisionId: REV, revision: 3, contentHash: HASH } } });
    }
  });
});

