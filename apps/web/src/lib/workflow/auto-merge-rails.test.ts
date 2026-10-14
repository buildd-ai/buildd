/**
 * buildd's merge rails as the kernel's `Rails` port (workflow-kernel-library.md
 * §4): what the `merge_call` effect reads at merge time instead of trusting
 * the door. Fail closed; red CI and protected paths are named as such (never
 * overridable); a person's size override lifts the size cap only.
 */
import { describe, expect, mock, test } from 'bun:test';
import { builddLandingRails, type RailsContext } from './auto-merge-rails';

const D = { id: 'd1', workspaceId: 'ws', ownerTaskId: 't1', repoFullName: 'o/r', prNumber: 7 } as never;
const P = (o: Record<string, unknown> = {}) => ({ headSha: 'H1', live: { state: 'open', merged: false, headSha: 'H1', headRepoFullName: 'o/r', baseRef: 'dev' } as never, door: 'auto_merge', ...o });
const ctx: RailsContext = { gitConfig: null, releaseConfig: null, task: { id: 't1', title: 'feat: x', taskClass: 'work', missionId: null, requiresReview: false, mission: null } };
const repoFor = async () => ({ installationId: 1, repoFullName: 'o/r', gitConfig: null }) as never;

function rails(safety: (...a: any[]) => Promise<{ ok: true } | { ok: false; reason: string }>, missionGate = async () => ({ blocks: false })) {
  const s = mock(safety);
  return { s, r: builddLandingRails({ safety: s as never, repoFor, load: async () => ctx, missionGate }) };
}

describe('builddLandingRails', () => {
  test('reads the rails at the head the effect is about to merge, with base freshness left to the kernel', async () => {
    const { s, r } = rails(async () => ({ ok: true }));
    expect(await r.evaluate(D, P())).toEqual({ passed: true, reasons: [] });
    const [installationId, repo, pr, head, , opts] = s.mock.calls[0] as unknown[];
    expect({ installationId, repo, pr, head }).toEqual({ installationId: 1, repo: 'o/r', pr: 7, head: 'H1' });
    expect(opts).toMatchObject({ skipBaseFreshness: true, workspaceId: 'ws', taskId: 't1' });
  });

  test('red CI and a protected path refuse, named as the rails no override passes', async () => {
    const red = rails(async (_i, _r, _p, _h, _pol, opts) => {
      opts.observed.checkRuns = [{ name: 'unit', status: 'completed', conclusion: 'failure' }];
      return { ok: false, reason: 'CI checks still pending or failed: unit (failure)' };
    });
    expect(await red.r.evaluate(D, P())).toMatchObject({ passed: false, redCi: true });
    const pending = rails(async (_i, _r, _p, _h, _pol, opts) => {
      opts.observed.checkRuns = [{ name: 'unit', status: 'in_progress', conclusion: null }];
      return { ok: false, reason: 'CI checks still pending or failed: unit (in_progress)' };
    });
    const p = await pending.r.evaluate(D, P());
    expect(p.passed).toBe(false);
    expect(p.redCi).toBeUndefined();
    const deny = rails(async () => ({ ok: false, reason: 'touches protected path (infra/main.tf)' }));
    expect(await deny.r.evaluate(D, P())).toMatchObject({ passed: false, denyPaths: true, reasons: ['touches protected path (infra/main.tf)'] });
  });

  test('a person\'s size override lifts the size cap and nothing else', async () => {
    const { s, r } = rails(async () => ({ ok: true }));
    await r.evaluate(D, P({ override: { kinds: ['size'] } }));
    expect((s.mock.calls[0] as any[])[4].threshold?.maxLines).toBe(Number.MAX_SAFE_INTEGER);
    const plain = rails(async () => ({ ok: true }));
    await plain.r.evaluate(D, P());
    expect((plain.s.mock.calls[0] as any[])[4].threshold?.maxLines).not.toBe(Number.MAX_SAFE_INTEGER);
  });

  test('a person\'s door is read with a person\'s rails; an automatic one with all of them', async () => {
    const { s, r } = rails(async () => ({ ok: true }));
    await r.evaluate(D, P({ person: true }));
    await r.evaluate(D, P());
    expect((s.mock.calls[0] as any[])[5].personDecides).toBe(true);
    expect((s.mock.calls[1] as any[])[5].personDecides).toBeUndefined();
  });

  test('lasting refusals (protected path, migration, size) are a person\'s; CI, reads and holds wait', async () => {
    const reading = async (reason: string) => rails(async () => ({ ok: false, reason })).r.evaluate(D, P());
    expect((await reading('touches protected path (infra/main.tf)')).lasting).toBe(true);
    expect((await reading('drops column missions.legacy_mode (destructive migration)')).lasting).toBe(true);
    expect((await reading('auto-threshold tier: diff size 2500 source lines > source limit 800 (0 noise files excluded)')).lasting).toBe(true);
    expect((await reading('CI checks still pending or failed: unit (in_progress)')).lasting).toBeUndefined();
    expect((await reading('could not verify migration safety: GitHub 502')).lasting).toBeUndefined();
    expect((await reading('PR head changed — ignoring stale merge trigger')).lasting).toBeUndefined();
  });

  test('the mission-PR hold is a rail', async () => {
    const { r } = rails(async () => ({ ok: true }), async () => ({ blocks: true, reason: 'two task PRs still open on the integration branch' }));
    expect(await r.evaluate(D, P())).toEqual({ passed: false, reasons: ['two task PRs still open on the integration branch'] });
  });

  test('fail closed: no installation, or a workspace that cannot be read, refuses', async () => {
    const none = builddLandingRails({ safety: (async () => ({ ok: true })) as never, repoFor: async () => null, load: async () => ctx, missionGate: async () => ({ blocks: false }) });
    expect((await none.evaluate(D, P())).passed).toBe(false);
    const unread = builddLandingRails({ safety: (async () => ({ ok: true })) as never, repoFor, load: async () => null, missionGate: async () => ({ blocks: false }) });
    expect((await unread.evaluate(D, P())).passed).toBe(false);
  });
});
