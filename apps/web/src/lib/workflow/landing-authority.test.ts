/**
 * AC-30 / AC-33 / AC-34: one landing authority at every merge door.
 * `mergeWithAuthority` is the one way a door reaches `PUT .../merge`; these
 * tests drive it for every door name in the §13.13 inventory.
 */
import { describe, expect, mock, test } from 'bun:test';

const gateEvents: Array<Record<string, unknown>> = [];
mock.module('@/lib/gate-ledger', () => ({
  fireGateEvent: (e: Record<string, unknown>) => { gateEvents.push(e); return 'sig'; },
  GATE_SLUGS: { REVIEW_VERDICT: 'review_verdict' },
}));
mock.module('@/lib/github', () => ({ mergePullRequest: async () => ({ merged: true, message: 'merged', status: 200 }) }));

const { judgeLanding, landingAuthority, mergeWithAuthority } = await import('./landing-authority');
type Door = Parameters<typeof landingAuthority>[0]['door'];

const open = { id: 'f1', roundId: 'r', round: 1, reviewedHeadSha: 'H', path: 'a.ts', line: 2, text: 'fix me', fingerprint: 'x', status: 'open' as const };
const delivery = (state: string, stateReason: string | null = null) => ({ id: 'd', state, stateReason }) as never;

const DOORS: Door[] = ['kernel_merge_call', 'land_pr', 'landing_sweep', 'auto_merge', 'merge_pr_mcp', 'dashboard_merge', 'release_pr_ci', 'release_executor_pr', 'release_executor_prod', 'compose_release', 'policy_rule_merge'];

describe('judgeLanding', () => {
  test('open finding blocks whatever the state says', () => {
    expect(judgeLanding({ delivery: delivery('APPROVED'), findings: [open] })).toMatchObject({ blocks: true, kind: 'open_findings' });
  });
  test('unresolved review states block; landing_needs_human is not a review state', () => {
    for (const s of ['CHANGES_REQUESTED', 'FIXING']) expect(judgeLanding({ delivery: delivery(s), findings: [] }).blocks).toBe(true);
    expect(judgeLanding({ delivery: delivery('ESCALATED', 'review_exhausted'), findings: [] }).blocks).toBe(true);
    expect(judgeLanding({ delivery: delivery('ESCALATED', 'landing_needs_human'), findings: [] }).blocks).toBe(false);
  });
  test('closed findings and a clean delivery pass', () => {
    expect(judgeLanding({ delivery: delivery('APPROVED'), findings: [{ ...open, status: 'waived' }] }).blocks).toBe(false);
  });
});

describe('AC-30: every door asks, no merge call is made on a refusal', () => {
  for (const door of DOORS) {
    test(`${door}: refused, names the door in a review_verdict row, never calls GitHub`, async () => {
      gateEvents.length = 0;
      let called = 0;
      const res = await mergeWithAuthority(
        { door, installationId: 1, repoFullName: 'a/b', prNumber: 7, method: 'squash', headSha: 'H' },
        { viewForPr: async () => ({ delivery: delivery('APPROVED'), findings: [open] }), merge: async () => { called++; return { merged: true, message: 'x' }; } },
      );
      expect(res.merged).toBe(false);
      expect(res.message).toContain('Merge refused');
      expect(called).toBe(0);
      expect(gateEvents).toHaveLength(1);
      expect(gateEvents[0]).toMatchObject({ gate: 'review_verdict', surface: door, outcome: 'rejected' });
    });
  }
  test('a PR with no delivery has nothing to ask and merges', async () => {
    const res = await mergeWithAuthority(
      { door: 'auto_merge', installationId: 1, repoFullName: 'a/b', prNumber: 7, method: 'squash', headSha: 'H' },
      { viewForPr: async () => null, merge: async () => ({ merged: true, message: 'ok' }) },
    );
    expect(res.merged).toBe(true);
  });
});

describe('AC-33: admin force is not an override; a person override is recorded', () => {
  test('no override argument: refused (force with an admin token adds none)', async () => {
    const res = await mergeWithAuthority(
      { door: 'merge_pr_mcp', installationId: 1, repoFullName: 'a/b', prNumber: 7, method: 'squash', headSha: 'H' },
      { viewForPr: async () => ({ delivery: delivery('CHANGES_REQUESTED'), findings: [open] }), merge: async () => ({ merged: true, message: 'x' }) },
    );
    expect(res.merged).toBe(false);
  });
  test('an agent actor cannot override', async () => {
    const res = await mergeWithAuthority(
      { door: 'dashboard_merge', installationId: 1, repoFullName: 'a/b', prNumber: 7, method: 'squash', headSha: 'H', override: { actor: 'agent:t', reason: 'yes' } },
      { viewForPr: async () => ({ delivery: delivery('APPROVED'), findings: [open] }), merge: async () => ({ merged: true, message: 'x' }) },
    );
    expect(res.merged).toBe(false);
  });
  test('a person with a reason passes, as a recorded bypass row', async () => {
    gateEvents.length = 0;
    const res = await mergeWithAuthority(
      { door: 'dashboard_merge', installationId: 1, repoFullName: 'a/b', prNumber: 7, method: 'squash', headSha: 'H', override: { actor: 'human:u', reason: 'accepted' } },
      { viewForPr: async () => ({ delivery: delivery('APPROVED'), findings: [open] }), merge: async () => ({ merged: true, message: 'x' }) },
    );
    expect(res.merged).toBe(true);
    expect(gateEvents.map((e) => e.outcome)).toEqual(['rejected', 'bypassed']);
  });
});

describe('fail closed', () => {
  test('an unreadable ledger refuses, and a person cannot override an unread finding', async () => {
    const res = await mergeWithAuthority(
      { door: 'dashboard_merge', installationId: 1, repoFullName: 'a/b', prNumber: 7, method: 'squash', headSha: 'H', override: { actor: 'human:u', reason: 'x' } },
      { viewForPr: async () => { throw new Error('db down'); }, merge: async () => ({ merged: true, message: 'x' }) },
    );
    expect(res.merged).toBe(false);
    expect(res.refusedByLandingAuthority?.kind).toBe('unreadable');
  });
});

describe('AC-34: COMMENTED is never approval', () => {
  test('the gate reads findings and delivery state only, so a COMMENTED mirror of a verdict cannot clear or grant anything', () => {
    // buildd posts its own request-changes as COMMENTED. Nothing in the landing authority reads GitHub review states at all.
    expect(judgeLanding({ delivery: delivery('CHANGES_REQUESTED'), findings: [open] }).blocks).toBe(true);
    expect(Object.keys(judgeLanding({ delivery: delivery('APPROVED'), findings: [] }))).toEqual(['blocks']);
  });
});
