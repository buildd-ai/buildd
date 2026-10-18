/**
 * AC-13 (workflow-kernel-library.md §4): a PR with no delivery is adopted
 * before a worker door merges it, and a PR nothing can adopt is refused, never
 * merged on a legacy arm.
 */
import { describe, expect, mock, test } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));

const { adoptBeforeMerge } = await import('./merge-adoption');

const BASE = { workspaceId: 'ws', installationId: 1, repoFullName: 'acme/w', prNumber: 7, taskId: 'task-1', door: 'dashboard' };
const CALL = { principal: { kind: 'user' as const, id: 'u1' } };

/** A store answering the one resolver read with `row` (or none). */
const execOf = (row: { delivery_id: string; authority: string } | null) => mock(async () => ({ rows: row ? [row] : [] }));

describe('adoptBeforeMerge (AC-13)', () => {
  test('a PR the kernel already owns: nothing opened, the door lands through the kernel', async () => {
    const open = mock(async () => ({ owned: true, deliveryId: 'x' }));
    const r = await adoptBeforeMerge(BASE, CALL, { exec: execOf({ delivery_id: 'd1', authority: 'kernel' }), open });
    expect(r).toEqual({ kind: 'kernel', deliveryId: 'd1', adopted: false });
    expect(open).not.toHaveBeenCalled();
  });

  test('a delivery released to legacy stays legacy (sticky release, kill switch)', async () => {
    const open = mock(async () => ({ owned: true, deliveryId: 'x' }));
    const r = await adoptBeforeMerge(BASE, CALL, { exec: execOf({ delivery_id: 'd1', authority: 'legacy' }), open });
    expect(r).toEqual({ kind: 'legacy', reason: 'released' });
    expect(open).not.toHaveBeenCalled();
  });

  test('a PR with no delivery is opened with the owner task, under the door\'s principal, and lands through the kernel', async () => {
    const open = mock(async () => ({ owned: true, deliveryId: 'd2' }));
    const ownerOf = mock(async () => 'owner-task');
    const r = await adoptBeforeMerge(BASE, CALL, { exec: execOf(null), open, ownerOf });
    expect(r).toEqual({ kind: 'kernel', deliveryId: 'd2', adopted: true });
    expect(ownerOf).toHaveBeenCalledWith('task-1');
    expect(open).toHaveBeenCalledWith(
      { workspaceId: 'ws', ownerTaskId: 'owner-task', repoFullName: 'acme/w', prNumber: 7, installationId: 1, source: 'dashboard:adopt' },
      CALL,
    );
  });

  test('the kill switch off: the legacy arm, as designed', async () => {
    const r = await adoptBeforeMerge(BASE, CALL, { exec: execOf(null), open: async () => ({ owned: false, reason: 'kernel_off' }), ownerOf: async (t) => t });
    expect(r).toEqual({ kind: 'legacy', reason: 'kernel_off' });
  });

  test.each([
    ['review_task'], ['attempt_task'], ['owner_bound_to_other_pr'], ['no_task'], ['released'], ['bind_fork'], ['open_rejected'],
  ])('adoption answered %s: the merge is refused, naming it', async (reason) => {
    const r = await adoptBeforeMerge(BASE, CALL, { exec: execOf(null), open: async () => ({ owned: false, reason }), ownerOf: async (t) => t });
    expect(r.kind).toBe('refused');
    expect(r.kind === 'refused' && r.reason).toBe(`adoption_failed:${reason}`);
    expect(r.kind === 'refused' && r.message).toContain('nothing was merged');
  });

  test('no task owns the PR: refused without asking the kernel', async () => {
    const open = mock(async () => ({ owned: true, deliveryId: 'x' }));
    const r = await adoptBeforeMerge({ ...BASE, taskId: null }, CALL, { exec: execOf(null), open });
    expect(r.kind === 'refused' && r.reason).toBe('adoption_failed:no_owner_task');
    expect(open).not.toHaveBeenCalled();
  });

  test('the control plane does not answer: refused, never the legacy arm', async () => {
    const r = await adoptBeforeMerge(BASE, CALL, { exec: execOf(null), open: async () => { throw new Error('control plane unavailable'); }, ownerOf: async (t) => t });
    expect(r.kind === 'refused' && r.reason).toBe('adoption_failed:adoption_unavailable');
  });

  test('the resolver read fails: refused, never the legacy arm', async () => {
    const exec = mock(async () => { throw new Error('db down'); });
    const r = await adoptBeforeMerge(BASE, CALL, { exec, open: async () => ({ owned: true, deliveryId: 'x' }) });
    expect(r.kind === 'refused' && r.reason).toBe('adoption_failed:adoption_unavailable');
  });

  test('an unreadable owner walk falls back to the door\'s own task', async () => {
    const open = mock(async () => ({ owned: true, deliveryId: 'd3' }));
    await adoptBeforeMerge(BASE, CALL, { exec: execOf(null), open, ownerOf: async () => { throw new Error('x'); } });
    expect((open.mock.calls[0] as unknown as [{ ownerTaskId: string }])[0].ownerTaskId).toBe('task-1');
  });
});
