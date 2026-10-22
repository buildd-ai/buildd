import { describe, expect, it, mock } from 'bun:test';

/**
 * Registered `verify:` declarations are checked where a revision is written
 * (create and revise), before anything is read or stored. The pin boundary
 * (a revision stored before this check) is proven against real Postgres in
 * apps/web/tests/db/registered-verification-store.test.ts.
 */

const touched: string[] = [];
const db = new Proxy({}, { get: (_t, k) => { touched.push(String(k)); throw new Error(`db.${String(k)} touched`); } });
mock.module('@buildd/core/db', () => ({ db }));

const { createSpecDraft, reviseSpecDraft } = await import('./store');

const WS = '00000000-0000-4000-8000-0000000000a1';
const SPEC = '00000000-0000-4000-8000-0000000000a2';
const user = { kind: 'user' as const, userId: 'u1' };
const STATE = JSON.stringify({ id: 'ui.actions_match_state', version: 1, profile: 'buildd.enterprise@1', mode: 'required' });

describe('verification declarations on write', () => {
  it('R-2/R-3: a verify with no declared captures, a malformed binding or an orphan scenarios line is refused before any write', async () => {
    for (const body of [
      `- AC-1: The card matches the PR.\n  verify: ${STATE}`,
      '- AC-1: The card matches the PR.\n  verify: {"id":"ui.invented","version":1,"profile":"buildd.enterprise@1","mode":"required"}\n  scenarios: closed-pr@mobile',
      '- AC-1: The card matches the PR.\n  scenarios: closed-pr@mobile',
      `- AC-1: The card matches the PR.\n  verify: ${STATE}\n  scenarios: closed-pr@tablet`,
    ]) {
      const created = await createSpecDraft(user, { workspaceId: WS, title: 'Card', body });
      expect(created).toMatchObject({ ok: false, status: 400, code: 'invalid_verification_declaration', error: expect.stringContaining('AC-1') });
      const revised = await reviseSpecDraft(user, SPEC, { expectedVersion: 1, body });
      expect(revised).toMatchObject({ ok: false, status: 400, code: 'invalid_verification_declaration' });
    }
    expect(touched).toEqual([]);
  });

  it('a body with no registered declarations passes the check (and reaches the database)', async () => {
    const r = createSpecDraft(user, { workspaceId: WS, title: 'Card', body: '- AC-1: Plain.\n  check: bun test' });
    await expect(r).rejects.toThrow(/db\.\w+ touched/);
  });
});
