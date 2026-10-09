import { describe, expect, mock, test } from 'bun:test';
import { collisionFromReason, dispatchLandingFix } from './landing-fix-dispatch';
import type { FixDispatchInput } from './pr-landing';

const base: FixDispatchInput = {
  kind: 'ci_fix', workspaceId: 'w1', installationId: 9, repoFullName: 'acme/widgets', prNumber: 12, headSha: 'h1',
  owner: { taskId: 't1', workerId: 'wk1' }, reason: 'CI failing',
};
const COLLISION = 'migration number collision: 0281_a.sql conflicts with open PR #10 migration 0281_b.sql';

describe('collisionFromReason', () => {
  test('reads the file pair and the other PR back from migration-safety\'s reason', () => {
    expect(collisionFromReason(COLLISION)).toEqual({ file: '0281_a.sql', otherFile: '0281_b.sql', otherPrNumber: 10 });
  });
  test('any other wording is null', () => {
    expect(collisionFromReason('migration number collision: 0281_a.sql is at or below 0281, already on the base')).toBeNull();
    expect(collisionFromReason('CI failing')).toBeNull();
  });
});

describe('dispatchLandingFix', () => {
  test('ci_fix goes to the shared CI retry, pinned to the head, on the landing surface', async () => {
    const retryCi = mock(async (_i: any): Promise<any> => ({ kind: 'dispatched', taskId: 'fix1' }));
    expect(await dispatchLandingFix(base, { retryCi })).toEqual({ taskId: 'fix1' });
    expect(retryCi.mock.calls[0]![0]).toEqual({ repoFullName: 'acme/widgets', prNumber: 12, headSha: 'h1', installationId: 9, surface: 'landing' });
  });

  test('a skip names its reason; an in-flight fix is the owner', async () => {
    expect(await dispatchLandingFix(base, { retryCi: async () => ({ kind: 'skipped', reason: 'retries_exhausted' }) })).toEqual({ skipped: 'retries_exhausted' });
    expect(await dispatchLandingFix(base, { retryCi: async () => ({ kind: 'skipped', reason: 'fix_in_flight', inFlightTaskId: 'f0' }) })).toEqual({ taskId: 'f0' });
    expect(await dispatchLandingFix(base, { retryCi: async () => ({ kind: 'not_ours' }) })).toEqual({ skipped: 'not_ours' });
  });

  test('renumber_migration files the collision renumber for the owner task', async () => {
    const renumber = mock(async (_p: any): Promise<any> => ({ handled: true }));
    expect(await dispatchLandingFix({ ...base, kind: 'renumber_migration', reason: COLLISION }, { renumber })).toEqual({});
    expect(renumber.mock.calls[0]![0]).toMatchObject({
      collision: { file: '0281_a.sql', otherFile: '0281_b.sql', otherPrNumber: 10 }, workerId: 'wk1', taskId: 't1', prNumber: 12, headSha: 'h1', workspaceId: 'w1', installationId: 9,
    });
  });

  test('renumber is skipped, with why, when nothing can be filed', async () => {
    const renumber = mock(async (_p: any): Promise<any> => ({ handled: false }));
    expect(await dispatchLandingFix({ ...base, kind: 'renumber_migration', reason: COLLISION }, { renumber })).toEqual({ skipped: 'renumber_not_filed' });
    expect(await dispatchLandingFix({ ...base, kind: 'renumber_migration', reason: 'odd words' }, { renumber })).toEqual({ skipped: 'collision_unreadable' });
    expect(await dispatchLandingFix({ ...base, kind: 'renumber_migration', reason: COLLISION, owner: { taskId: null, workerId: null } }, { renumber })).toEqual({ skipped: 'no_owner' });
  });

  test('re_review is not this module\'s', async () => {
    expect(await dispatchLandingFix({ ...base, kind: 're_review' })).toBeNull();
  });
});
